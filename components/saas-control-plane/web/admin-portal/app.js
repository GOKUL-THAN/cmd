// CLM Admin Portal — SaaS Control Plane UI
// Auth: Keycloak (Direct Grant) | Manages: Tenants, Users, Groups, Cloud Accounts, Gateways

const LOCAL_DEMO_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
if (!LOCAL_DEMO_HOSTS.has(window.location.hostname)) {
    localStorage.removeItem('clm_token');
    localStorage.removeItem('clm_refresh_token');
    document.title = 'CLM Admin Portal - Demo Unavailable';
    document.getElementById('sidebar').remove();
    document.querySelector('.main').remove();

    const loginCard = document.getElementById('login-card');
    if (loginCard) {
        const heading = document.createElement('h2');
        heading.textContent = 'Hosted demo unavailable';
        const notice = document.createElement('p');
        notice.textContent = 'This deployment uses mock authentication and is disabled for safety. Do not enter passwords or other credentials.';
        notice.style.cssText = 'color:var(--muted);font-size:0.9rem;line-height:1.5;margin-top:0.75rem';
        loginCard.replaceChildren(heading, notice);
    }
}

const API = window.location.origin;
const KEYCLOAK_TOKEN_URL = window.location.origin + '/auth/realms/clm/protocol/openid-connect/token';
const KEYCLOAK_CLIENT_ID = 'clm-admin-portal';
let token = localStorage.getItem('clm_token') || '';
let currentPage = 'dashboard';

// Cloud accounts are tenant-scoped server records. Credential material is
// submitted only on create/rotate, encrypted by the control plane, and never
// returned to or persisted by this browser.
let cloudAccountsCache = [];
let activeTenantId = '';
localStorage.removeItem('clm_cloud_accounts'); // remove obsolete plaintext entries

function getCloudAccounts() {
    return cloudAccountsCache;
}

function scopedPath(path, tenantId) {
    const separator = path.includes('?') ? '&' : '?';
    return path + separator + 'tenant_id=' + encodeURIComponent(tenantId);
}

function resolveTenantScope() {
    const claims = decodeJwt(token) || {};
    if (claims.tenant_id) {
        activeTenantId = claims.tenant_id;
        return Promise.resolve(activeTenantId);
    }
    if (activeTenantId) return Promise.resolve(activeTenantId);
    return apiGet('/api/v1/tenants').then(data => {
        const tenants = Array.isArray(data.tenants) ? data.tenants : [];
        if (tenants.length !== 1) {
            if (tenants.length === 0) {
                throw new Error('No tenant exists. Create a tenant before managing gateways.');
            }
            const error = new Error('Select a tenant before managing gateways.');
            error.code = 'TENANT_SELECTION_REQUIRED';
            error.tenants = tenants;
            throw error;
        }
        activeTenantId = tenants[0].id;
        return activeTenantId;
    });
}

function renderTenantSelection(el, error) {
    if (!error || error.code !== 'TENANT_SELECTION_REQUIRED') return false;

    const tenants = error.tenants || [];
    const options = tenants.map(tenant =>
        `<option value="${esc(tenant.id)}">${esc(tenant.name || tenant.id)}</option>`
    ).join('');
    el.innerHTML = `<div class="card">
        <h3>Select a tenant</h3>
        <p style="color:var(--muted);margin:0.5rem 0 1rem">Choose the tenant whose cloud accounts, gateways, and deployment jobs you want to view.</p>
        <div class="form-group">
            <label for="tenant-scope-select">Tenant</label>
            <select id="tenant-scope-select" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                <option value="">-- Select a tenant --</option>
                ${options}
            </select>
        </div>
    </div>`;
    el.querySelector('#tenant-scope-select').addEventListener('change', event => {
        const tenant = tenants.find(item => item.id === event.target.value);
        if (!tenant) return;
        activeTenantId = tenant.id;
        navigate(currentPage);
    });
    return true;
}

function defaultRegion(provider) {
    if (provider === 'gcp') return 'asia-south1';
    if (provider === 'azure') return 'centralindia';
    return 'ap-south-1';
}

function tenantApiGet(path) {
    return resolveTenantScope().then(tenantId => apiGet(scopedPath(path, tenantId)));
}

// --- Auth (Keycloak Direct Grant + fallback to CLM API) ---
function doLogin() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';

    if (!email || !password) { errEl.textContent = 'Email and password are required.'; return; }

    // Try Keycloak first (Resource Owner Password Grant)
    fetch(KEYCLOAK_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=password&client_id=${KEYCLOAK_CLIENT_ID}&username=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&scope=openid`
    })
    .then(r => r.json())
    .then(data => {
        if (data.access_token) {
            activeTenantId = '';
            token = data.access_token;
            localStorage.setItem('clm_token', token);
            if (data.refresh_token) localStorage.setItem('clm_refresh_token', data.refresh_token);
            document.getElementById('login-overlay').classList.add('hidden');
            document.getElementById('user-email').textContent = email;
            setupSidebar();
            loadDashboard();
        } else {
            // Keycloak failed, try CLM API fallback
            fallbackLogin(email, password, errEl);
        }
    })
    .catch(() => {
        // Keycloak unreachable, try CLM API fallback
        fallbackLogin(email, password, errEl);
    });
}

function fallbackLogin(email, password, errEl) {
    fetch(API + '/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    })
    .then(r => r.json())
    .then(data => {
        if (data.access_token) {
            activeTenantId = '';
            token = data.access_token;
            localStorage.setItem('clm_token', token);
            document.getElementById('login-overlay').classList.add('hidden');
            document.getElementById('user-email').textContent = email;
            setupSidebar();
            loadDashboard();
        } else {
            errEl.textContent = data.error || 'Invalid email or password.';
        }
    })
    .catch(() => { errEl.textContent = 'Cannot connect to server.'; });
}

function logout() {
    activeTenantId = '';
    token = '';
    localStorage.removeItem('clm_token');
    localStorage.removeItem('clm_refresh_token');
    window.location.reload();
}

// decodeJwt reads a JWT payload.
//
// JWTs are base64URL encoded and unpadded, but atob() expects standard base64.
// A token whose payload happens to contain '-' or '_' therefore makes atob()
// throw — which is intermittent, because whether those characters appear depends
// on the byte values in the claims. Adding claims to the realm changes the
// encoding and can flip a working token into a failing one.
//
// Getting this wrong was severe: the init path cleared the stored token on a
// decode failure (silent logout), and getUserRole() fell back to 'viewer',
// which hid tenant and identity management from a super_admin.
function decodeJwt(t) {
    if (!t) return null;
    try {
        const parts = t.split('.');
        if (parts.length < 2) return null;
        let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4 !== 0) b64 += '=';
        return JSON.parse(decodeURIComponent(
            atob(b64).split('').map(c =>
                '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
        ));
    } catch (e) {
        // Fall back to a plain decode in case the payload is not UTF-8 escaped.
        try {
            let b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4 !== 0) b64 += '=';
            return JSON.parse(atob(b64));
        } catch (e2) {
            console.error('JWT decode failed', e2);
            return null;
        }
    }
}

// --- Init ---
if (token) {
    // Only discard the token when it is genuinely expired. A decode failure is
    // not proof of expiry and must not silently log the user out.
    const payload = decodeJwt(token);
    if (payload && payload.exp && payload.exp * 1000 < Date.now()) {
        token = '';
        localStorage.removeItem('clm_token');
    }
}
if (token) {
    document.getElementById('login-overlay').classList.add('hidden');
    const p = decodeJwt(token) || {};
    document.getElementById('user-email').textContent = p.email || p.preferred_username || '';
    setupSidebar();
    loadDashboard();
}

// --- Role helpers ---
function getUserRole() {
    if (!token) return 'viewer';
    const payload = decodeJwt(token);
    if (!payload) {
        // Do not silently downgrade to viewer: that hides tenant and identity
        // management from an administrator with no visible explanation.
        console.error('Could not read role from token; treating as viewer');
        return 'viewer';
    }
    // Keycloak tokens in this realm carry roles at the top level; realm_access
    // is the standard location. Internal HS256 tokens use a single `role`.
    const roles = payload.roles || (payload.realm_access && payload.realm_access.roles) || [];
    if (Array.isArray(roles)) {
        const priority = ['super_admin','admin','tenant_admin','cert_manager','approver','operator','auditor','viewer'];
        for (const p of priority) { if (roles.indexOf(p) >= 0) return p; }
    }
    if (payload.role) return payload.role;
    return 'viewer';
}

// isPlatformAdmin reports whether the caller may manage tenants and identity.
function isPlatformAdmin() {
    const role = getUserRole();
    return role === 'super_admin' || role === 'admin';
}

function setupSidebar() {
    // Admin-only entries. Hidden rather than disabled, since the API rejects
    // them anyway and a dead menu item is worse than none.
    const adminOnly = ['nav-tenants', 'nav-subscription', 'nav-billing',
                       'nav-keycloak', 'nav-id-users', 'nav-id-groups', 'nav-id-providers'];
    const show = isPlatformAdmin();
    adminOnly.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !show);
    });
}

// --- Navigation ---
function navigate(page) {
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    // Find and activate the clicked nav item (safe for programmatic calls)
    document.querySelectorAll('.nav-item').forEach(n => {
        if (n.textContent.trim().toLowerCase().replace(' ','-') === page) n.classList.add('active');
    });
    document.getElementById('page-title').textContent = page.charAt(0).toUpperCase() + page.slice(1).replace('-', ' ');
    switch (page) {
        case 'dashboard': loadDashboard(); break;
        case 'org-tenants': loadOrgTenants(); break;
        case 'sso': loadSSO(); break;
        case 'cloud-accounts': loadCloudAccounts(); break;
        case 'gateways': loadGateways(); break;
        case 'jobs': loadDeployJobs(); break;
        case 'approvals': loadApprovals(); break;
        case 'onboarding': loadCustomerOnboarding(); break;
        case 'directory-mappings': loadDirectoryMappings(); break;
        case 'departments': loadDepartments(); break;
        case 'itsm': loadITSMWarRoom(); break;
        case 'risk': loadRiskRegister(); break;
        case 'integrations': loadIntegrations(); break;
        case 'activity': loadActivity(); break;
        case 'identity': loadIdentity(); break;
        // Sidebar entries and legacy links that open a specific hub tab.
        case 'organization': loadOrgTenants('organization'); break;
        case 'tenants': loadOrgTenants('tenants'); break;
        case 'subscription': loadOrgTenants('subscription'); break;
        case 'billing': loadOrgTenants('billing'); break;
        case 'users': loadIdentity('users'); break;
        case 'groups': loadIdentity('groups'); break;
        case 'providers': loadIdentity('providers'); break;
        // Enterprise CLM Functional Domains
        case 'corporate-depts': loadCorporateDepartments(); break;
        case 'contracts': loadContracts(); break;
        case 'contract-requests': loadContractRequests(); break;
        case 'contract-templates': loadContractTemplates(); break;
        case 'contract-negotiations': loadContractNegotiations(); break;
        case 'contract-signatures': loadContractSignatures(); break;
        case 'contract-obligations': loadContractObligations(); break;
        case 'procurement-suppliers': loadProcurementSuppliers(); break;
        case 'legal-matters': loadLegalMatters(); break;
        case 'contract-financials': loadContractFinancials(); break;
        case 'ai-contracts': loadAIContracts(); break;
        case 'clm-analytics': loadCLMAnalytics(); break;
        case 'clause-playbook': loadClausePlaybook(); break;
        case 'contract-compare': loadContractCompare(); break;
        case 'expiration-radar': loadExpirationRadar(); break;
        case 'clickwrap-portal': loadClickwrapPortal(); break;
        case 'risk-heatmap': loadRiskHeatmap(); break;
        case 'counterparty-portal': loadCounterpartyPortal(); break;
        case 'sourcing-converter': loadSourcingConverter(); break;
        case 'termination-runbook': loadTerminationRunbook(); break;
        case '400-features': load400FeaturesExplorer(); break;
        case 'sdlc-workflows': loadSDLCWorkflows(); break;
    }
}

// --- API helpers ---
function parseApiResponse(response) {
    if (response.status === 401) {
        logout();
        throw new Error('Session expired');
    }
    return response.json().catch(() => ({})).then(data => {
        if (!response.ok) throw new Error(data.error || data.message || ('Request failed with HTTP ' + response.status));
        return data;
    });
}
function apiGet(path) {
    return fetch(API + path, { headers: { 'Authorization': 'Bearer ' + token } }).then(parseApiResponse);
}
function apiPost(path, body, extraHeaders) {
    return fetch(API + path, {
        method: 'POST',
        headers: Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, extraHeaders || {}),
        body: JSON.stringify(body)
    }).then(parseApiResponse);
}
function apiPut(path, body) {
    return fetch(API + path, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(parseApiResponse);
}
function apiDelete(path) {
    return fetch(API + path, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } }).then(parseApiResponse);
}

function handleSessionExpired() {
    logout();
}

// --- Pages ---
function loadDashboard() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="stats">
            <div class="card stat"><div class="label">Tenants</div><div class="value" id="s-tenants">0</div></div>
            <div class="card stat"><div class="label">Users</div><div class="value" id="s-users">0</div></div>
            <div class="card stat"><div class="label">Gateways</div><div class="value" id="s-sats">0</div></div>
            <div class="card stat"><div class="label">Deploy Jobs</div><div class="value" id="s-jobs">0</div></div>
        </div>
        <div class="card"><h3 style="margin-bottom:0.5rem">CLM Admin Portal</h3><p style="color:var(--muted);font-size:0.85rem">Manage tenants, users, SSO configuration, and deploy satellite gateways to customer environments.</p></div>
    `;
    apiGet('/api/v1/tenants').then(d => { document.getElementById('s-tenants').textContent = (d.tenants||[]).length; }).catch(()=>{});
    tenantApiGet('/api/v1/users').then(d => { document.getElementById('s-users').textContent = (d.users||[]).length; }).catch(()=>{});
    tenantApiGet('/api/v1/satellites').then(d => { document.getElementById('s-sats').textContent = (d.satellites||[]).length; }).catch(()=>{});
    tenantApiGet('/api/v1/satellites/deploy').then(d => { document.getElementById('s-jobs').textContent = (d.jobs||[]).length; }).catch(()=>{});
}

function loadTenants() {
    const el = panelEl();
    el.innerHTML = '<div class="card"><p>Loading tenants...</p></div>';
    if (!document.getElementById('org-body')) document.getElementById('page-title').textContent = 'Tenant Management';

    apiGet('/api/v1/tenants').then(data => {
        const tenants = data.tenants || [];
        let rows = tenants.map(t => {
            const statusBadge = t.status === 'active'
                ? '<span class="badge badge-active">active</span>'
                : t.status === 'suspended'
                ? '<span class="badge badge-warning">suspended</span>'
                : '<span class="badge badge-disabled">' + t.status + '</span>';
            const planBadge = t.plan === 'enterprise'
                ? '<span class="badge" style="background:#7c3aed20;color:#7c3aed;padding:0.2rem 0.4rem">Enterprise</span>'
                : t.plan === 'pro'
                ? '<span class="badge" style="background:#2563eb20;color:#2563eb;padding:0.2rem 0.4rem">Pro</span>'
                : '<span class="badge" style="background:#64748b20;color:#64748b;padding:0.2rem 0.4rem">Free</span>';
            return `<tr>
                <td><strong>${t.name}</strong></td>
                <td><code style="font-size:0.75rem">${t.slug}</code></td>
                <td>${planBadge}</td>
                <td>${statusBadge}</td>
                <td>${t.max_users||5} users / ${t.max_satellites||2} gw / ${t.max_certs||100} certs</td>
                <td>${t.data_region||'ap-south-1'}</td>
                <td style="white-space:nowrap">
                    <select onchange="changeTenantPlan('${t.id}', this.value)" style="font-size:0.7rem;padding:0.15rem;border:1px solid var(--border);border-radius:0.25rem">
                        <option value="" disabled selected>Plan</option>
                        <option value="free">Free</option>
                        <option value="pro">Pro</option>
                        <option value="enterprise">Enterprise</option>
                    </select>
                    ${t.status === 'active'
                        ? `<button class="btn" style="font-size:0.65rem;padding:0.15rem 0.35rem;border:1px solid #f59e0b;color:#f59e0b;margin-left:0.2rem" onclick="toggleTenant('${t.id}','suspend','${t.name}')">Suspend</button>`
                        : `<button class="btn" style="font-size:0.65rem;padding:0.15rem 0.35rem;border:1px solid var(--success);color:var(--success);margin-left:0.2rem" onclick="toggleTenant('${t.id}','activate','${t.name}')">Activate</button>`}
                    <button class="btn btn-danger" style="font-size:0.65rem;padding:0.15rem 0.35rem;margin-left:0.2rem" onclick="deleteTenant('${t.id}','${t.name}')">Delete</button>
                </td>
            </tr>`;
        }).join('');

        el.innerHTML = `<div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h3>Tenant Management</h3>
                <button class="btn btn-primary" onclick="showAddTenantForm()">+ Add Tenant</button>
            </div>
            <p style="color:var(--muted);font-size:0.8rem;margin-bottom:1rem">Manage all customer organizations. Add, suspend, activate, upgrade plans, or delete tenants.</p>
            <table><thead><tr><th>Name</th><th>Slug</th><th>Plan</th><th>Status</th><th>Limits</th><th>Region</th><th>Actions</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No tenants</td></tr>'}</tbody></table>
        </div>
        <div class="card hidden" id="add-tenant-form">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h3>Add New Tenant</h3>
                <button class="btn" onclick="document.getElementById('add-tenant-form').classList.add('hidden')" style="border:1px solid var(--border)">Cancel</button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Organization Name</label><input id="nt-name" placeholder="Acme Corp"></div>
                <div class="form-group"><label>Plan</label><select id="nt-plan" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="free">Free (5 users, 2 gateways, 100 certs)</option>
                    <option value="pro">Pro (25 users, 10 gateways, 1000 certs)</option>
                    <option value="enterprise">Enterprise (unlimited)</option>
                </select></div>
            </div>
            <div class="form-group"><label>Data Region</label><select id="nt-region" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                <option value="ap-south-1">Asia Pacific (Mumbai)</option>
                <option value="us-east-1">US East (Virginia)</option>
                <option value="eu-west-1">Europe (Ireland)</option>
                <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
            </select></div>
            <button class="btn btn-primary" onclick="createTenant()">Create Tenant</button>
            <div id="nt-status" style="margin-top:0.5rem"></div>
        </div>`;
    }).catch(err => {
        el.innerHTML = `<div class="card"><p style="color:var(--danger)">Failed to load tenants: ${err.message}</p></div>`;
    });
}

function showAddTenantForm() {
    document.getElementById('add-tenant-form').classList.remove('hidden');
}

function createTenant() {
    const name = document.getElementById('nt-name').value.trim();
    const plan = document.getElementById('nt-plan').value;
    const region = document.getElementById('nt-region').value;
    const statusEl = document.getElementById('nt-status');

    if (!name) { statusEl.innerHTML = '<p style="color:var(--danger)">Organization name is required.</p>'; return; }

    statusEl.innerHTML = '<p style="color:var(--muted)">Creating tenant...</p>';
    apiPost('/api/v1/tenants', { name, plan, region }).then(data => {
        if (data.error) {
            statusEl.innerHTML = `<p style="color:var(--danger)">${data.error}</p>`;
        } else {
            statusEl.innerHTML = '<p style="color:var(--success)">Tenant created.</p>';
            setTimeout(loadTenants, 1000);
        }
    }).catch(err => { statusEl.innerHTML = `<p style="color:var(--danger)">Failed: ${err.message}</p>`; });
}

function changeTenantPlan(tenantId, newPlan) {
    if (!newPlan) return;
    if (!confirm('Upgrade/change plan to "' + newPlan + '"?')) return;

    fetch(API + '/api/v1/tenants/' + tenantId, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: newPlan })
    }).then(r => r.json()).then(data => {
        if (data.error) alert('Failed: ' + data.error);
        else loadTenants();
    }).catch(() => alert('Failed to update plan.'));
}

function toggleTenant(tenantId, action, name) {
    const newStatus = action === 'suspend' ? 'suspended' : 'active';
    if (!confirm(action.charAt(0).toUpperCase() + action.slice(1) + ' tenant "' + name + '"?')) return;

    fetch(API + '/api/v1/tenants/' + tenantId, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
    }).then(r => r.json()).then(data => {
        if (data.error) alert('Failed: ' + data.error);
        else loadTenants();
    }).catch(() => alert('Failed to ' + action + ' tenant.'));
}

function deleteTenant(tenantId, name) {
    // Require the name to be typed: this removes an entire organization.
    const typed = prompt('This permanently deletes tenant "' + name + '".\n\n' +
        'Type the tenant name exactly to confirm:');
    if (typed === null) return;
    if (typed.trim() !== name) {
        alert('Name did not match. Nothing was deleted.');
        return;
    }
    sendTenantDelete(tenantId, name, false);
}

// sendTenantDelete issues the delete. The server refuses while the tenant still
// owns records and reports what is blocking, so the operator can decide whether
// to remove those too.
function sendTenantDelete(tenantId, name, force) {
    const url = API + '/api/v1/tenants/' + tenantId + (force ? '?force=true' : '');

    fetch(url, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } })
        .then(r => r.text().then(body => ({ status: r.status, body: body })))
        .then(res => {
            let data = {};
            try { data = JSON.parse(res.body); } catch (e) { data = { error: res.body }; }

            if (res.status === 200) {
                alert('Tenant "' + name + '" deleted.');
                loadTenants();
                return;
            }

            if (res.status === 409 && data.dependents) {
                const lines = Object.keys(data.dependents)
                    .map(k => '  \u2022 ' + data.dependents[k] + ' ' + k).join('\n');
                const go = confirm('Tenant "' + name + '" still owns:\n\n' + lines +
                    '\n\nDelete these records as well?\n\n' +
                    'OK = delete everything, Cancel = keep the tenant');
                if (go) sendTenantDelete(tenantId, name, true);
                return;
            }

            if (res.status === 401) { logout(); return; }
            alert('Could not delete tenant (HTTP ' + res.status + '):\n' +
                  (data.error || res.body || 'unknown error'));
        })
        .catch(err => alert('Could not reach the server: ' + err.message));
}

function loadUsers() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p>Loading users...</p></div>';
    document.getElementById('page-title').textContent = 'Users & Access';

    const currentRole = getUserRole();
    const canManage = (currentRole === 'super_admin' || currentRole === 'admin' || currentRole === 'tenant_admin');

    tenantApiGet('/api/v1/users').then(data => {
        const users = data.users || [];
        const groups = getGroups();

        // Build email→group lookup (group name + group role)
        const userGroupMap = {};
        groups.forEach(g => {
            (g.members || []).forEach(email => {
                userGroupMap[email] = { name: g.name, role: g.role || 'viewer' };
            });
        });

        let rows = users.map(u => {
            const group = userGroupMap[u.email];
            const effectiveRole = group ? group.role : u.role; // Group role takes precedence
            const roleBadge = getRoleBadge(effectiveRole);
            const roleSource = group
                ? `<span style="font-size:0.7rem;color:var(--muted)">(from group)</span>`
                : `<span style="font-size:0.7rem;color:var(--muted)">(individual)</span>`;
            const statusBadge = u.status === 'active'
                ? '<span class="badge badge-active">active</span>'
                : '<span class="badge badge-disabled">disabled</span>';
            const groupDisplay = group
                ? `<span class="badge" style="background:#2563eb15;color:#2563eb;padding:0.2rem 0.4rem">${group.name}</span>`
                : '<span style="color:var(--muted)">—</span>';
            const actions = canManage ? `
                <select onchange="changeUserRole('${u.id}', this.value)" style="font-size:0.75rem;padding:0.2rem;border:1px solid var(--border);border-radius:0.25rem" title="Override individual role">
                    <option value="" disabled selected>Override role</option>
                    <option value="super_admin">Super Admin</option>
                    <option value="admin">Admin</option>
                    <option value="tenant_admin">Tenant Admin</option>
                    <option value="cert_manager">Cert Manager</option>
                    <option value="approver">Approver</option>
                    <option value="operator">Operator</option>
                    <option value="viewer">Viewer</option>
                    <option value="auditor">Auditor</option>
                </select>
                ${u.status === 'active'
                    ? `<button class="btn btn-danger" style="font-size:0.7rem;padding:0.2rem 0.4rem;margin-left:0.25rem" onclick="disableUser('${u.id}','${u.email}')">Disable</button>`
                    : `<span style="font-size:0.75rem;color:var(--muted)">disabled</span>`}
            ` : '';
            return `<tr>
                <td>${u.email}</td>
                <td>${u.name}</td>
                <td>${groupDisplay}</td>
                <td>${roleBadge} ${roleSource}</td>
                <td>${statusBadge}</td>
                <td>${u.auth_provider||'local'}</td>
                <td style="white-space:nowrap">${actions}</td>
            </tr>`;
        }).join('');

        el.innerHTML = `<div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h3>Users & Access Management</h3>
                ${canManage ? '<button class="btn btn-primary" onclick="showAddUserForm()">+ Add User</button>' : ''}
            </div>
            <p style="color:var(--muted);font-size:0.8rem;margin-bottom:1rem">Users inherit their role from their group. Individual role overrides can be set per user.</p>
            <table><thead><tr><th>Email</th><th>Name</th><th>Group</th><th>Effective Role</th><th>Status</th><th>Auth</th>${canManage?'<th>Actions</th>':''}</tr></thead>
            <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No users</td></tr>'}</tbody></table>
        </div>
        <div class="card hidden" id="add-user-form">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h3>Add New User</h3>
                <button class="btn" onclick="document.getElementById('add-user-form').classList.add('hidden')" style="border:1px solid var(--border)">Cancel</button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Full Name</label><input id="nu-name" placeholder="John Doe"></div>
                <div class="form-group"><label>Email</label><input id="nu-email" type="email" placeholder="john@company.com"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Password</label><input id="nu-password" type="password" placeholder="Min 8 characters"></div>
                <div class="form-group"><label>Role</label><select id="nu-role" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="viewer">Viewer — read-only access</option>
                    <option value="operator">Operator — manage gateways</option>
                    <option value="cert_manager">Cert Manager — manage certificates</option>
                    <option value="approver">Approver — approve cert requests</option>
                    <option value="auditor">Auditor — read all, audit logs</option>
                    <option value="tenant_admin">Tenant Admin — full tenant access</option>
                    <option value="admin">Admin — full access (no tenant mgmt)</option>
                    <option value="super_admin">Super Admin — full platform access</option>
                </select></div>
            </div>
            <button class="btn btn-primary" onclick="createUser()">Create User</button>
            <div id="nu-status" style="margin-top:0.5rem"></div>
        </div>
        <div class="card" style="margin-top:1rem">
            <h3 style="margin-bottom:0.75rem">Role Permissions (RBAC)</h3>
            <p style="color:var(--muted);font-size:0.8rem;margin-bottom:1rem">Each role has specific permissions within the platform.</p>
            <table style="font-size:0.78rem">
                <thead><tr><th>Role</th><th>Tenants</th><th>Users</th><th>Groups</th><th>Gateways</th><th>Deploy</th><th>Certificates</th><th>Approvals</th><th>Audit</th></tr></thead>
                <tbody>
                    <tr><td><strong>Super Admin</strong></td><td>Full (add/remove)</td><td>Full</td><td>Full</td><td>Full</td><td>Full</td><td>Full</td><td>Full</td><td>Full</td></tr>
                    <tr><td><strong>Admin</strong></td><td>Read</td><td>Full</td><td>Full</td><td>Full</td><td>Full</td><td>Full</td><td>Full</td><td>Full</td></tr>
                    <tr><td><strong>Tenant Admin</strong></td><td>Own only</td><td>Full</td><td>Full</td><td>Full</td><td>Full</td><td>Full</td><td>Full</td><td>Read</td></tr>
                    <tr><td><strong>Cert Manager</strong></td><td>—</td><td>—</td><td>—</td><td>Read</td><td>—</td><td>Full</td><td>—</td><td>—</td></tr>
                    <tr><td><strong>Approver</strong></td><td>—</td><td>—</td><td>—</td><td>Read</td><td>—</td><td>Read</td><td>Approve/Reject</td><td>—</td></tr>
                    <tr><td><strong>Operator</strong></td><td>—</td><td>—</td><td>—</td><td>Full</td><td>Full</td><td>Read</td><td>—</td><td>—</td></tr>
                    <tr><td><strong>Viewer</strong></td><td>—</td><td>—</td><td>—</td><td>Read</td><td>—</td><td>Read</td><td>Read</td><td>—</td></tr>
                    <tr><td><strong>Auditor</strong></td><td>—</td><td>Read</td><td>Read</td><td>Read</td><td>Read</td><td>Read</td><td>Read</td><td>Full</td></tr>
                </tbody>
            </table>
        </div>`;
    }).catch(err => {
        el.innerHTML = `<div class="card"><p style="color:var(--danger)">Failed to load users: ${err.message}</p></div>`;
    });
}

function getRoleBadge(role) {
    const colors = {
        'super_admin': 'background:#7c3aed20;color:#7c3aed',
        'admin': 'background:#4f46e520;color:#4f46e5',
        'tenant_admin': 'background:#2563eb20;color:#2563eb',
        'cert_manager': 'background:#05966920;color:#059669',
        'approver': 'background:#d9770620;color:#d97706',
        'operator': 'background:#0891b220;color:#0891b2',
        'viewer': 'background:#64748b20;color:#64748b',
        'auditor': 'background:#be123c20;color:#be123c'
    };
    const style = colors[role] || 'background:#64748b20;color:#64748b';
    return `<span class="badge" style="${style};padding:0.2rem 0.5rem">${role.replace('_',' ')}</span>`;
}

function showAddUserForm() {
    document.getElementById('add-user-form').classList.remove('hidden');
    document.getElementById('nu-status').innerHTML = '';
}

function createUser() {
    const name = document.getElementById('nu-name').value.trim();
    const email = document.getElementById('nu-email').value.trim();
    const password = document.getElementById('nu-password').value;
    const role = document.getElementById('nu-role').value;
    const statusEl = document.getElementById('nu-status');

    if (!name || !email || !password) {
        statusEl.innerHTML = '<p style="color:var(--danger)">All fields are required.</p>';
        return;
    }
    if (password.length < 8) {
        statusEl.innerHTML = '<p style="color:var(--danger)">Password must be at least 8 characters.</p>';
        return;
    }

    statusEl.innerHTML = '<p style="color:var(--muted)">Creating user...</p>';

    apiPost('/api/v1/users', { name, email, password, role }).then(data => {
        if (data.error) {
            statusEl.innerHTML = `<p style="color:var(--danger)">${data.error}</p>`;
        } else {
            statusEl.innerHTML = '<p style="color:var(--success)">User created successfully.</p>';
            setTimeout(loadUsers, 1000);
        }
    }).catch(err => {
        statusEl.innerHTML = `<p style="color:var(--danger)">Failed: ${err.message}</p>`;
    });
}

function changeUserRole(userId, newRole) {
    if (!newRole) return;
    if (!confirm('Change this user\'s role to "' + newRole.replace('_',' ') + '"?')) return;

    fetch(API + '/api/v1/users/' + userId + '/role', {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole })
    }).then(r => r.json()).then(data => {
        if (data.error) {
            alert('Failed: ' + data.error);
        } else {
            loadUsers(); // Refresh the list
        }
    }).catch(() => alert('Failed to update role.'));
}

function disableUser(userId, email) {
    if (!confirm('Disable user "' + email + '"? They will no longer be able to sign in.')) return;

    fetch(API + '/api/v1/users/' + userId, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
    }).then(r => r.json()).then(data => {
        if (data.error) {
            alert('Failed: ' + data.error);
        } else {
            loadUsers();
        }
    }).catch(() => alert('Failed to disable user.'));
}

// --- Groups Management (localStorage-backed until backend API ready) ---
function getGroups() {
    try { return JSON.parse(localStorage.getItem('clm_groups') || '[]'); } catch(e) { return []; }
}
function saveGroups(groups) {
    localStorage.setItem('clm_groups', JSON.stringify(groups));
}

function loadGroups() {
    const el = document.getElementById('content-area');
    document.getElementById('page-title').textContent = 'Groups';

    const currentRole = getUserRole();
    const canManage = (currentRole === 'super_admin' || currentRole === 'admin' || currentRole === 'tenant_admin');
    const groups = getGroups();

    let rows = groups.map(g => {
        const memberCount = g.members ? g.members.length : 0;
        return `<tr>
            <td><strong>${g.name}</strong></td>
            <td>${g.description||'-'}</td>
            <td>${g.role||'viewer'}</td>
            <td>${memberCount}</td>
            <td>${g.created_at ? new Date(g.created_at).toLocaleDateString() : '-'}</td>
            <td style="white-space:nowrap">
                ${canManage ? `<button class="btn" style="font-size:0.7rem;padding:0.2rem 0.4rem;border:1px solid var(--border)" onclick="editGroup('${g.id}')">Manage</button>
                <button class="btn btn-danger" style="font-size:0.7rem;padding:0.2rem 0.4rem" onclick="deleteGroup('${g.id}','${g.name}')">Delete</button>` : ''}
            </td>
        </tr>`;
    }).join('');

    el.innerHTML = `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3>Groups</h3>
            ${canManage ? '<button class="btn btn-primary" onclick="showCreateGroupForm()">+ Create Group</button>' : ''}
        </div>
        <p style="color:var(--muted);font-size:0.8rem;margin-bottom:1rem">Organize users into groups. Assign a default role to each group — members inherit the group role unless individually overridden.</p>
        <table><thead><tr><th>Group Name</th><th>Description</th><th>Default Role</th><th>Members</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No groups created yet.</td></tr>'}</tbody></table>
    </div>
    <div class="card hidden" id="create-group-form">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3 id="group-form-title">Create Group</h3>
            <button class="btn" onclick="document.getElementById('create-group-form').classList.add('hidden')" style="border:1px solid var(--border)">Cancel</button>
        </div>
        <div class="form-group"><label>Group Name</label><input id="grp-name" placeholder="e.g., DevOps Team, Security Team"></div>
        <div class="form-group"><label>Description</label><input id="grp-desc" placeholder="Team responsible for..."></div>
        <div class="form-group"><label>Default Role for Members</label><select id="grp-role" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
            <option value="viewer">Viewer</option>
            <option value="operator">Operator</option>
            <option value="cert_manager">Cert Manager</option>
            <option value="approver">Approver</option>
            <option value="auditor">Auditor</option>
            <option value="tenant_admin">Tenant Admin</option>
            <option value="admin">Admin</option>
            <option value="super_admin">Super Admin</option>
        </select></div>
        <button class="btn btn-primary" onclick="createGroup()">Create Group</button>
        <div id="grp-status" style="margin-top:0.5rem"></div>
    </div>
    <div class="card hidden" id="manage-group-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3 id="manage-group-title">Manage Group</h3>
            <button class="btn" onclick="document.getElementById('manage-group-card').classList.add('hidden')" style="border:1px solid var(--border)">Close</button>
        </div>
        <input type="hidden" id="manage-grp-id">
        <div id="manage-group-members"></div>
        <div class="form-group" style="margin-top:1rem"><label>Add Member (email)</label>
            <div style="display:flex;gap:0.5rem">
                <input id="add-member-email" placeholder="user@company.com" style="flex:1">
                <button class="btn btn-primary" onclick="addGroupMember()">Add</button>
            </div>
        </div>
        <div id="manage-grp-status" style="margin-top:0.5rem"></div>
    </div>`;
}

function showCreateGroupForm() {
    document.getElementById('create-group-form').classList.remove('hidden');
    document.getElementById('manage-group-card').classList.add('hidden');
    document.getElementById('grp-status').innerHTML = '';
}

function createGroup() {
    const name = document.getElementById('grp-name').value.trim();
    const description = document.getElementById('grp-desc').value.trim();
    const role = document.getElementById('grp-role').value;

    if (!name) {
        document.getElementById('grp-status').innerHTML = '<p style="color:var(--danger)">Group name is required.</p>';
        return;
    }

    const groups = getGroups();
    groups.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
        name: name,
        description: description,
        role: role,
        members: [],
        created_at: new Date().toISOString()
    });
    saveGroups(groups);
    document.getElementById('grp-status').innerHTML = '<p style="color:var(--success)">Group created.</p>';
    setTimeout(loadGroups, 800);
}

function deleteGroup(id, name) {
    if (!confirm('Delete group "' + name + '"? Members will not be deleted but will lose their group assignment.')) return;
    const groups = getGroups().filter(g => g.id !== id);
    saveGroups(groups);
    loadGroups();
}

function editGroup(id) {
    const groups = getGroups();
    const group = groups.find(g => g.id === id);
    if (!group) return;

    document.getElementById('manage-group-card').classList.remove('hidden');
    document.getElementById('create-group-form').classList.add('hidden');
    document.getElementById('manage-grp-id').value = id;
    document.getElementById('manage-group-title').textContent = 'Manage: ' + group.name;
    document.getElementById('manage-grp-status').innerHTML = '';

    const members = group.members || [];
    if (members.length === 0) {
        document.getElementById('manage-group-members').innerHTML = '<p style="color:var(--muted);font-size:0.85rem">No members in this group yet. Add members below.</p>';
    } else {
        const memberRows = members.map(m => `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.4rem 0;border-bottom:1px solid var(--border)">
            <span style="font-size:0.85rem">${m}</span>
            <button class="btn btn-danger" style="font-size:0.65rem;padding:0.15rem 0.4rem" onclick="removeGroupMember('${id}','${m}')">Remove</button>
        </div>`).join('');
        document.getElementById('manage-group-members').innerHTML = `<p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem">${members.length} member(s):</p>${memberRows}`;
    }
}

function addGroupMember() {
    const groupId = document.getElementById('manage-grp-id').value;
    const email = document.getElementById('add-member-email').value.trim();
    if (!email) return;

    const groups = getGroups();
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    if (!group.members) group.members = [];
    if (group.members.includes(email)) {
        document.getElementById('manage-grp-status').innerHTML = '<p style="color:var(--danger)">User already in group.</p>';
        return;
    }
    group.members.push(email);
    saveGroups(groups);
    document.getElementById('add-member-email').value = '';
    editGroup(groupId); // refresh member list
}

function removeGroupMember(groupId, email) {
    const groups = getGroups();
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    group.members = (group.members || []).filter(m => m !== email);
    saveGroups(groups);
    editGroup(groupId);
}

function loadSSO() {
    const el = document.getElementById('content-area');
    el.innerHTML = `<div class="card">
        <h3>SSO Configuration</h3>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Configure identity provider per tenant. Supports SAML 2.0, OIDC, Google, and Microsoft.</p>
        <div class="form-group"><label>Provider</label><select id="sso-provider" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
            <option value="google">Google (Gmail / Workspace)</option>
            <option value="microsoft">Microsoft (Outlook / Azure AD)</option>
            <option value="oidc">OpenID Connect (Generic)</option>
            <option value="saml">SAML 2.0</option>
        </select></div>
        <div class="form-group"><label>Client ID</label><input id="sso-client-id" placeholder="OAuth Client ID"></div>
        <div class="form-group"><label>Client Secret</label><input id="sso-client-secret" type="password" placeholder="OAuth Client Secret"></div>
        <div class="form-group"><label>Allowed Domains (comma-separated)</label><input id="sso-domains" placeholder="aiforgers.tech"></div>
        <div class="form-group"><label>Auto-Provision New Users</label><select id="sso-auto" style="padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"><option value="true">Yes</option><option value="false">No</option></select></div>
        <button class="btn btn-primary" onclick="saveSSO()">Save SSO Config</button>
    </div>`;
}

function saveSSO() {
    const provider = document.getElementById('sso-provider').value;
    const client_id = document.getElementById('sso-client-id').value;
    const client_secret = document.getElementById('sso-client-secret').value;
    const domains = document.getElementById('sso-domains').value;
    const auto_provision = document.getElementById('sso-auto').value === 'true';
    const tenantId = activeTenantId || 'tenant-enterprise-uat';

    let statusEl = document.getElementById('sso-save-status');
    if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.id = 'sso-save-status';
        statusEl.style.cssText = 'margin-top:0.75rem;font-size:0.875rem;padding:0.5rem 0.75rem;border-radius:0.375rem';
        const btn = document.querySelector('[onclick="saveSSO()"]');
        if (btn && btn.parentNode) btn.parentNode.insertBefore(statusEl, btn.nextSibling);
    }
    statusEl.style.color = 'var(--muted)';
    statusEl.textContent = 'Saving...';

    apiPost('/api/v1/tenants/' + tenantId + '/sso', {
        provider,
        client_id,
        client_secret,
        domains: domains.split(',').map(s => s.trim()).filter(Boolean),
        auto_provision
    }).then(() => {
        statusEl.style.color = 'var(--success)';
        statusEl.textContent = 'SSO configuration saved. Provider: ' + provider;
    }).catch(e => {
        statusEl.style.color = 'var(--danger)';
        statusEl.textContent = e.message || 'Failed to save SSO configuration.';
    });
}

// --- Organization Page (Client Admin) ---
function loadOrganization() {
    const el = panelEl();
    if (!document.getElementById('org-body')) document.getElementById('page-title').textContent = 'Organization';
    el.innerHTML = '<div class="card"><p>Loading organization details...</p></div>';

    // Prefer the tenant_id claim, but never depend on it. When the claim is
    // missing the server resolves the caller's tenant itself via /tenants/me, so
    // this page works regardless of how the realm's protocol mappers are set up.
    // Relying on the claim alone previously left this page permanently blank.
    const claims = decodeJwt(token) || {};
    const tenantId = claims.tenant_id || '';
    const userEmail = claims.email || claims.preferred_username || '';

    const target = tenantId ? '/api/v1/tenants/' + tenantId : '/api/v1/tenants/me';

    apiGet(target).then(data => {
        const t = data.tenant || data;
        el.innerHTML = `
        <div class="card">
            <h3 style="margin-bottom:1rem">Organization Settings</h3>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
                <div>
                    <div class="form-group"><label>Organization Name</label><input id="org-name" value="${t.name||''}" style="width:100%"></div>
                    <div class="form-group"><label>Slug</label><input value="${t.slug||''}" disabled style="width:100%;background:#f8fafc"></div>
                </div>
                <div>
                    <div class="form-group"><label>Plan</label>
                        <div style="display:flex;align-items:center;gap:0.5rem">
                            <span class="badge badge-active" style="font-size:0.85rem;padding:0.3rem 0.6rem">${(t.plan||'free').toUpperCase()}</span>
                            <button class="btn" style="font-size:0.75rem;border:1px solid var(--primary);color:var(--primary)" onclick="navigate('billing')">Upgrade Plan</button>
                        </div>
                    </div>
                    <div class="form-group"><label>Data Region</label><input value="${t.data_region||'ap-south-1'}" disabled style="width:100%;background:#f8fafc"></div>
                </div>
            </div>
            <button class="btn btn-primary" style="margin-top:0.5rem" onclick="updateOrg('${tenantId}')">Save Changes</button>
            <div id="org-status" style="margin-top:0.5rem"></div>
        </div>
        <div class="card">
            <h3 style="margin-bottom:0.75rem">Plan Limits</h3>
            <table style="font-size:0.85rem">
                <thead><tr><th>Resource</th><th>Used</th><th>Limit</th></tr></thead>
                <tbody>
                    <tr><td>Users</td><td id="org-users-used">—</td><td>${t.max_users||5}</td></tr>
                    <tr><td>Gateways</td><td id="org-gw-used">—</td><td>${t.max_satellites||2}</td></tr>
                    <tr><td>Certificates</td><td id="org-cert-used">—</td><td>${t.max_certs||100}</td></tr>
                </tbody>
            </table>
        </div>
        <div class="card">
            <h3 style="margin-bottom:0.75rem">Account Info</h3>
            <table style="font-size:0.85rem">
                <tr><td style="font-weight:600;width:160px">Tenant ID</td><td><code style="font-size:0.8rem">${tenantId}</code></td></tr>
                <tr><td style="font-weight:600">Admin Email</td><td>${userEmail}</td></tr>
                <tr><td style="font-weight:600">Created</td><td>${t.created_at ? new Date(t.created_at).toLocaleString() : '-'}</td></tr>
                <tr><td style="font-weight:600">Status</td><td><span class="badge badge-active">${t.status||'active'}</span></td></tr>
            </table>
        </div>`;

        // Load usage counts
        tenantApiGet('/api/v1/users').then(d => { document.getElementById('org-users-used').textContent = (d.users||[]).length; }).catch(()=>{});
        tenantApiGet('/api/v1/satellites').then(d => { document.getElementById('org-gw-used').textContent = (d.satellites||[]).length; }).catch(()=>{});
    }).catch(err => {
        el.innerHTML = `<div class="card"><p style="color:var(--danger)">Failed to load organization: ${err.message}</p></div>`;
    });
}

function updateOrg(tenantId) {
    const name = document.getElementById('org-name').value.trim();
    if (!name) { document.getElementById('org-status').innerHTML = '<p style="color:var(--danger)">Name is required.</p>'; return; }

    fetch(API + '/api/v1/tenants/' + tenantId, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
    }).then(r => r.json()).then(data => {
        if (data.error) {
            document.getElementById('org-status').innerHTML = `<p style="color:var(--danger)">${data.error}</p>`;
        } else {
            document.getElementById('org-status').innerHTML = '<p style="color:var(--success)">Organization updated.</p>';
        }
    }).catch(() => {
        document.getElementById('org-status').innerHTML = '<p style="color:var(--danger)">Failed to update.</p>';
    });
}

// --- Activity Log Page (Client Admin) ---
function loadActivity() {
    const el = document.getElementById('content-area');
    document.getElementById('page-title').textContent = 'Activity Log';
    el.innerHTML = '<div class="card"><p>Loading activity...</p></div>';

    // Combine events from multiple sources including gateway activity
    Promise.all([
        tenantApiGet('/api/v1/satellites/deploy').catch(() => ({ jobs: [] })),
        tenantApiGet('/api/v1/users').catch(() => ({ users: [] })),
        tenantApiGet('/api/v1/satellites').catch(() => ({ satellites: [] }))
    ]).then(([deployData, userData, satData]) => {
        const jobs = deployData.jobs || [];
        const users = userData.users || [];
        const gateways = satData.satellites || [];

        let activities = [];

        // Deploy job events
        jobs.forEach(j => {
            activities.push({
                time: j.created_at || new Date().toISOString(),
                type: 'deploy',
                icon: '&#9881;',
                color: j.state === 'online' ? 'var(--success)' : j.state === 'failed' ? 'var(--danger)' : '#f59e0b',
                message: `Gateway deployment "${j.name}" — ${j.state}`,
                detail: j.region ? `${j.cloud} / ${j.region}` + (j.public_ip ? ' | IP: ' + j.public_ip : '') : ''
            });
        });

        // User events
        users.forEach(u => {
            activities.push({
                time: u.created_at || new Date().toISOString(),
                type: 'user',
                icon: '&#128100;',
                color: 'var(--primary)',
                message: `User "${u.name}" (${u.email}) added`,
                detail: `Role: ${u.role}`
            });
        });

        // Gateway events (registration + heartbeat status)
        gateways.forEach(g => {
            activities.push({
                time: g.created_at || new Date().toISOString(),
                type: 'gateway',
                icon: '&#9729;',
                color: 'var(--success)',
                message: `Gateway "${g.name}" registered`,
                detail: g.cloud ? `${g.cloud} / ${g.region}` : ''
            });
            // Heartbeat activity
            if (g.last_heartbeat) {
                const statusColor = g.status === 'online' ? 'var(--success)' : g.status === 'offline' ? 'var(--danger)' : '#f59e0b';
                activities.push({
                    time: g.last_heartbeat,
                    type: 'heartbeat',
                    icon: '&#128154;',
                    color: statusColor,
                    message: `Gateway "${g.name}" heartbeat — ${g.status}`,
                    detail: `Version: ${g.version || 'unknown'} | Certs: ${g.cert_count || 0} | Agents: ${g.agent_count || 0}`
                });
            }
        });

        // Fetch gateway command logs from each gateway
        const cmdPromises = gateways.map(g =>
            apiGet('/api/v1/satellites/' + g.id + '/commands').catch(() => ({ commands: [] }))
                .then(data => ({ gateway: g.name, commands: data.commands || [] }))
        );

        Promise.all(cmdPromises).then(cmdResults => {
            // Add gateway commands to activity
            cmdResults.forEach(({ gateway, commands }) => {
                commands.forEach(cmd => {
                    const cmdColor = cmd.status === 'completed' ? 'var(--success)' : cmd.status === 'failed' ? 'var(--danger)' : '#f59e0b';
                    activities.push({
                        time: cmd.created_at || cmd.sent_at || new Date().toISOString(),
                        type: 'command',
                        icon: '&#128268;',
                        color: cmdColor,
                        message: `[${gateway}] Command: ${cmd.type} — ${cmd.status}`,
                        detail: cmd.result ? cmd.result.substring(0, 100) : ''
                    });
                });
            });

            // Sort by time descending
            activities.sort((a, b) => new Date(b.time) - new Date(a.time));

            // Filter tabs
            const types = ['all', 'deploy', 'gateway', 'heartbeat', 'command', 'user'];
            const tabsHtml = types.map(t => `<button class="btn" style="font-size:0.75rem;padding:0.25rem 0.6rem;margin-right:0.3rem;border:1px solid ${t==='all'?'var(--primary)':'var(--border)'};color:${t==='all'?'var(--primary)':'var(--muted)'}" onclick="filterActivity('${t}',this)">${t === 'all' ? 'All' : t.charAt(0).toUpperCase()+t.slice(1)}</button>`).join('');

            let rows = activities.slice(0, 100).map(a => `
                <div class="activity-row" data-type="${a.type}" style="display:flex;align-items:flex-start;padding:0.6rem 0;border-bottom:1px solid var(--border)">
                    <span style="font-size:1.1rem;width:28px;text-align:center;color:${a.color}">${a.icon}</span>
                    <div style="flex:1;margin-left:0.5rem">
                        <p style="font-size:0.85rem;margin-bottom:0.15rem">${a.message}</p>
                        <p style="font-size:0.75rem;color:var(--muted)">${a.detail}</p>
                    </div>
                    <span style="font-size:0.75rem;color:var(--muted);white-space:nowrap">${new Date(a.time).toLocaleString()}</span>
                </div>`).join('');

            el.innerHTML = `<div class="card">
                <h3 style="margin-bottom:0.5rem">Activity Log</h3>
                <p style="color:var(--muted);font-size:0.8rem;margin-bottom:0.75rem">All activity from your organization and gateways.</p>
                <div style="margin-bottom:1rem">${tabsHtml}</div>
                <div id="activity-list">${rows || '<p style="color:var(--muted);font-size:0.85rem">No activity yet.</p>'}</div>
            </div>`;
        });
    });
}

function filterActivity(type, btn) {
    // Update tab button styles
    btn.parentElement.querySelectorAll('.btn').forEach(b => { b.style.borderColor = 'var(--border)'; b.style.color = 'var(--muted)'; });
    btn.style.borderColor = 'var(--primary)';
    btn.style.color = 'var(--primary)';

    // Filter rows
    document.querySelectorAll('.activity-row').forEach(row => {
        if (type === 'all' || row.dataset.type === type) {
            row.style.display = 'flex';
        } else {
            row.style.display = 'none';
        }
    });
}

// --- Cloud Accounts Page ---
function loadCloudAccounts() {
    const el = document.getElementById('content-area');
    document.getElementById('page-title').textContent = 'Cloud Accounts';
    el.innerHTML = '<div class="card"><p>Loading cloud accounts...</p></div>';

    resolveTenantScope().then(tenantId => apiGet(scopedPath('/api/v1/cloud-accounts', tenantId))).then(data => {
    const accounts = (data.cloud_accounts || data.accounts || []).map(a => Object.assign({}, a, {
        cloud: a.provider,
        region: defaultRegion(a.provider)
    }));
    cloudAccountsCache = accounts;
    let rows = accounts.map(a => `<tr>
        <td><strong>${a.name}</strong></td>
        <td><span class="badge badge-active">${a.cloud.toUpperCase()}</span></td>
        <td>${a.region||'-'}</td>
        <td><code style="font-size:0.75rem">Encrypted credential v${a.credential_version || 1}</code></td>
        <td><span class="badge badge-active">active</span></td>
        <td>${new Date(a.created_at).toLocaleDateString()}</td>
        <td><button class="btn btn-danger" style="font-size:0.7rem;padding:0.2rem 0.5rem" onclick="deleteCloudAccount('${a.id}')">Remove</button></td>
    </tr>`).join('');

    el.innerHTML = `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3>Cloud Accounts</h3>
            <button class="btn btn-primary" onclick="showAddCloudAccount()">+ Register Cloud</button>
        </div>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Register your cloud provider credentials. These are used when deploying satellite gateways to your infrastructure.</p>
        <table><thead><tr><th>Name</th><th>Provider</th><th>Region</th><th>Credential</th><th>Status</th><th>Added</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No cloud accounts registered yet. Click "+ Register Cloud" to add one.</td></tr>'}</tbody></table>
    </div>
    <div class="card hidden" id="add-cloud-form">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3>Register Cloud Account</h3>
            <button class="btn" onclick="document.getElementById('add-cloud-form').classList.add('hidden')" style="border:1px solid var(--border)">Cancel</button>
        </div>
        <div class="form-group"><label>Account Name</label><input id="ca-name" placeholder="AWS Production - Mumbai"></div>
        <div class="form-group"><label>Infrastructure Target</label><select id="ca-cloud" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem" onchange="updateCloudFields()">
            <option value="aws">Amazon Web Services (AWS)</option>
            <option value="gcp">Google Cloud Platform (GCP)</option>
            <option value="azure">Microsoft Azure</option>
        </select></div>
        <div id="cloud-cred-fields">
            <div class="form-group"><label>AWS Access Key ID</label><input id="ca-key" placeholder="AKIAIOSFODNN7EXAMPLE"></div>
            <div class="form-group"><label>AWS Secret Access Key</label><input id="ca-secret" type="password" placeholder="wJalrXUtnFEMI/K7MDENG/..."></div>
            <div class="form-group"><label>Default Region</label><input id="ca-region" placeholder="ap-south-1" value="ap-south-1"></div>
        </div>
        <div class="form-group"><label>Role ARN (optional, for cross-account)</label><input id="ca-role" placeholder="arn:aws:iam::123456789:role/CLM-Deploy"></div>
        <button class="btn btn-primary" onclick="registerCloudAccount()">Encrypt & Register</button>
        <div id="ca-status" style="margin-top:0.75rem"></div>
    </div>`;
    }).catch(err => {
        if (renderTenantSelection(el, err)) return;
        el.innerHTML = `<div class="card"><p style="color:var(--danger)">Failed to load cloud accounts: ${esc(err.message)}</p></div>`;
    });
}

function deleteCloudAccount(id) {
    if (!confirm('Remove this cloud account?')) return;
    resolveTenantScope()
        .then(tenantId => apiDelete(scopedPath('/api/v1/cloud-accounts/' + id, tenantId)))
        .then(() => loadCloudAccounts())
        .catch(err => alert('Failed to remove cloud account: ' + err.message));
}

function showAddCloudAccount() {
    document.getElementById('add-cloud-form').classList.remove('hidden');
}

function updateCloudFields() {
    const cloud = document.getElementById('ca-cloud').value;
    const el = document.getElementById('cloud-cred-fields');
    if (cloud === 'aws') {
        el.innerHTML = `
            <div class="form-group"><label>AWS Access Key ID</label><input id="ca-key" placeholder="AKIAIOSFODNN7EXAMPLE"></div>
            <div class="form-group"><label>AWS Secret Access Key</label><input id="ca-secret" type="password" placeholder="wJalrXUtnFEMI/K7MDENG/..."></div>
            <div class="form-group"><label>Default Region</label><input id="ca-region" placeholder="ap-south-1" value="ap-south-1"></div>`;
    } else if (cloud === 'gcp') {
        el.innerHTML = `
            <div class="form-group"><label>GCP Project ID</label><input id="ca-key" placeholder="my-project-123"></div>
            <div class="form-group"><label>Service Account JSON Key</label><textarea id="ca-secret" rows="4" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.8rem;font-family:monospace" placeholder='{"type":"service_account",...}'></textarea></div>
            <div class="form-group"><label>Default Region</label><input id="ca-region" placeholder="asia-south1" value="asia-south1"></div>`;
    } else if (cloud === 'azure') {
        el.innerHTML = `
            <div class="form-group"><label>Azure Tenant ID</label><input id="ca-key" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></div>
            <div class="form-group"><label>Client ID (App ID)</label><input id="ca-secret" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></div>
            <div class="form-group"><label>Client Secret</label><input id="ca-region" type="password" placeholder="Client secret value"></div>`;
    } else if (cloud === 'onprem_linux') {
        // No cloud API involved: the gateway is installed over SSH onto a host
        // the customer already runs, so the "credential" is SSH access.
        el.innerHTML = `
            <div class="form-group"><label>Host (IP or DNS name)</label><input id="ca-key" placeholder="10.0.5.42 or gw01.dc.internal"></div>
            <div class="form-group"><label>SSH User</label><input id="ca-secret" placeholder="ubuntu / ec2-user / root"></div>
            <div class="form-group"><label>SSH Port</label><input id="ca-region" placeholder="22" value="22"></div>
            <div class="form-group"><label>SSH Private Key or Password</label>
                <textarea id="ca-sshkey" rows="4" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.8rem;font-family:monospace" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></div>
            <div class="form-group"><label>Linux Flavour</label>
                <select id="ca-flavour" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="auto">Auto-detect (recommended)</option>
                    <option value="ubuntu">Ubuntu</option>
                    <option value="debian">Debian</option>
                    <option value="rhel">RHEL</option>
                    <option value="centos">CentOS</option>
                    <option value="rocky">Rocky Linux</option>
                    <option value="almalinux">AlmaLinux</option>
                    <option value="amzn">Amazon Linux</option>
                </select></div>
            <div class="card" style="background:#fffbeb;border-color:#fde68a;padding:0.7rem;margin-bottom:0.75rem">
                <p style="font-size:0.75rem;color:#92400e;margin:0">
                    <strong>Not stored securely yet.</strong> Cloud Accounts has no backend API — entries are
                    held in this browser's local storage, unencrypted and invisible to other administrators.
                    Do not enter a production SSH key until a server-side encrypted store exists.
                </p>
            </div>`;
    }
}

function registerCloudAccount() {
    const name = document.getElementById('ca-name').value.trim();
    const cloud = document.getElementById('ca-cloud').value;
    const statusEl = document.getElementById('ca-status');

    if (!name) { statusEl.innerHTML = '<p style="color:var(--danger)">Account name is required.</p>'; return; }

    statusEl.innerHTML = '<p style="color:var(--muted)">Encrypting and registering credentials...</p>';

    // Build credentials object
    const creds = {};
    let region = '';
    if (cloud === 'aws') {
        creds.aws_access_key_id = document.getElementById('ca-key').value;
        creds.aws_secret_access_key = document.getElementById('ca-secret').value;
        region = document.getElementById('ca-region').value || 'ap-south-1';
        if (!creds.aws_access_key_id || !creds.aws_secret_access_key) {
            statusEl.innerHTML = '<p style="color:var(--danger)">Access Key and Secret are required.</p>'; return;
        }
    } else if (cloud === 'gcp') {
        creds.gcp_project_id = document.getElementById('ca-key').value;
        creds.gcp_service_account_json = document.getElementById('ca-secret').value;
        region = document.getElementById('ca-region').value || 'asia-south1';
    } else if (cloud === 'azure') {
        creds.azure_tenant_id = document.getElementById('ca-key').value;
        creds.azure_client_id = document.getElementById('ca-secret').value;
        creds.azure_client_secret = document.getElementById('ca-region').value;
        region = 'centralindia';
    } else if (cloud === 'onprem_linux') {
        statusEl.innerHTML = '<p style="color:var(--danger)">On-premise SSH accounts are not supported by the encrypted cloud-account API yet. No credential was stored.</p>';
        return;
    }

    const roleEl = document.getElementById('ca-role');
    const role = roleEl ? roleEl.value.trim() : '';
    if (role) creds.aws_role_arn = role;

    const idempotencyKey = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'portal-' + Date.now() + '-' + Math.random().toString(36).slice(2);

    resolveTenantScope().then(tenantId =>
        apiPost(scopedPath('/api/v1/cloud-accounts', tenantId), {
            name: name,
            provider: cloud,
            credentials: creds
        }, { 'Idempotency-Key': idempotencyKey }).then(account =>
            apiPost(scopedPath('/api/v1/cloud-accounts/' + account.id + '/validate', tenantId), {})
        )
    ).then(() => {
        statusEl.innerHTML = '<p style="color:var(--success)">Cloud account encrypted and registered. Offline decryptability validation passed; provider connectivity is checked only when provisioning is enabled.</p>';
        setTimeout(() => loadCloudAccounts(), 1000);
    }).catch(err => {
        statusEl.innerHTML = '<p style="color:var(--danger)">Error: ' + esc(err.message || 'registration failed') + '</p>';
    });
}

function loadGateways() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p>Loading gateways...</p></div>';
    document.getElementById('page-title').textContent = 'Gateways';

    resolveTenantScope().then(tenantId => Promise.all([
        apiGet(scopedPath('/api/v1/satellites', tenantId)),
        apiGet(scopedPath('/api/v1/cloud-accounts', tenantId))
    ])).then(([data, accountData]) => {
        cloudAccountsCache = (accountData.cloud_accounts || []).map(a => Object.assign({}, a, {
            cloud: a.provider,
            region: defaultRegion(a.provider)
        }));
        const gateways = data.satellites || [];
        let rows = gateways.map(g => {
            const statusBadge = g.status === 'online'
                ? '<span class="badge badge-active">online</span>'
                : g.status === 'registering'
                ? '<span class="badge badge-warning">registering</span>'
                : g.status === 'offline'
                ? '<span class="badge badge-disabled">offline</span>'
                : '<span class="badge badge-warning">' + g.status + '</span>';
            return `<tr>
                <td><strong>${g.name}</strong></td>
                <td>${statusBadge}</td>
                <td>${g.cloud||'-'}</td>
                <td>${g.region||'-'}</td>
                <td>${g.ip_address||'-'}</td>
                <td>${g.last_heartbeat ? new Date(g.last_heartbeat).toLocaleString() : '<span style="color:var(--muted)">Never</span>'}</td>
                <td style="white-space:nowrap">
                    <button class="btn" style="font-size:0.7rem;padding:0.2rem 0.5rem;border:1px solid var(--primary);color:var(--primary)" onclick="openGatewayPortal('${g.id}','${g.ip_address||''}','${g.name}')">Open Portal</button>
                    <button class="btn" style="font-size:0.7rem;padding:0.2rem 0.5rem;border:1px solid var(--success);color:var(--success)" onclick="showGatewayActions('${g.id}','${g.ip_address||''}','${g.name}')">Manage</button>
                    <button class="btn" style="font-size:0.7rem;padding:0.2rem 0.5rem;border:1px solid var(--border)" onclick="editGateway('${g.id}','${g.name}','${g.cloud||''}','${g.region||''}')">Edit</button>
                    <button class="btn btn-danger" style="font-size:0.7rem;padding:0.2rem 0.5rem" onclick="deleteGateway('${g.id}','${g.name}')">Delete</button>
                </td>
            </tr>`;
        }).join('');
        el.innerHTML = `<div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h3>Gateways</h3>
                <button class="btn btn-primary" onclick="showDeployForm()">+ Deploy New Gateway</button>
            </div>
            <p style="color:var(--muted);font-size:0.8rem;margin-bottom:1rem">Deploy, manage, and access your gateway fleet. All gateway operations are performed from here.</p>
            <table><thead><tr><th>Name</th><th>Status</th><th>Cloud</th><th>Region</th><th>IP</th><th>Last Heartbeat</th><th>Actions</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No gateways yet. Click "+ Deploy New Gateway" to create your first one.</td></tr>'}</tbody></table>
        </div>
        <div class="card hidden" id="deploy-form-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h3 id="deploy-form-title">Deploy New Gateway</h3>
                <button class="btn" onclick="hideDeployForm()" style="border:1px solid var(--border)">Cancel</button>
            </div>
            <p style="color:var(--warning);font-size:0.8rem;margin-bottom:1rem"><strong>Gateway provisioning is temporarily disabled.</strong> The legacy bootstrap cannot inject the one-time satellite credential and tenant-bound mTLS identity required by the hardened transport. Cloud accounts may be registered securely, but no infrastructure will be created until that bootstrap is implemented.</p>
            <div class="form-group"><label>Gateway Name</label><input id="d-name" placeholder="dc-mumbai-prod-01"></div>
            <div class="form-group"><label>Cloud Account</label><select id="d-cloud-account" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem" onchange="onCloudAccountSelect()">
                <option value="">-- Select a registered cloud account --</option>
            </select>
            <p style="font-size:0.75rem;color:var(--muted);margin-top:0.25rem">No accounts? <a href="#" onclick="navigate('cloud-accounts');return false" style="color:var(--primary)">Register one first</a></p></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Deploy Mode</label><select id="d-mode" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem" onchange="onDeployModeChange()">
                    <option value="lightsail">Lightsail (VM — simplest)</option>
                    <option value="ec2">EC2 + ALB (production VM)</option>
                    <option value="eks">EKS (Kubernetes)</option>
                </select></div>
                <div class="form-group"><label>Region</label><input id="d-region" placeholder="ap-south-1"></div>
            </div>
            <div id="deploy-mode-config">
                <!-- Dynamic config based on mode -->
            </div>
            <button class="btn" style="margin-top:0.75rem" disabled title="Secure satellite credential and mTLS bootstrap is not configured">Deployment Unavailable</button>
            <div id="deploy-status" style="margin-top:1rem"></div>
        </div>
        <div class="card hidden" id="edit-gateway-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h3>Edit Gateway</h3>
                <button class="btn" onclick="document.getElementById('edit-gateway-card').classList.add('hidden')" style="border:1px solid var(--border)">Cancel</button>
            </div>
            <input type="hidden" id="edit-gw-id">
            <div class="form-group"><label>Gateway Name</label><input id="edit-gw-name" placeholder="Gateway name"></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Cloud</label><input id="edit-gw-cloud" placeholder="aws"></div>
                <div class="form-group"><label>Region</label><input id="edit-gw-region" placeholder="ap-south-1"></div>
            </div>
            <button class="btn btn-primary" onclick="saveGatewayEdit()">Save Changes</button>
            <div id="edit-gw-status" style="margin-top:0.5rem"></div>
        </div>`;
    }).catch(err => {
        if (renderTenantSelection(el, err)) return;
        el.innerHTML = `<div class="card"><p style="color:var(--danger)">Failed to load gateways: ${err.message}</p></div>`;
    });
}

// --- Gateway CRUD ---
function editGateway(id, name, cloud, region) {
    document.getElementById('edit-gateway-card').classList.remove('hidden');
    document.getElementById('deploy-form-card').classList.add('hidden');
    document.getElementById('edit-gw-id').value = id;
    document.getElementById('edit-gw-name').value = name;
    document.getElementById('edit-gw-cloud').value = cloud;
    document.getElementById('edit-gw-region').value = region;
    document.getElementById('edit-gw-status').innerHTML = '';
}

function saveGatewayEdit() {
    const id = document.getElementById('edit-gw-id').value;
    const body = {
        name: document.getElementById('edit-gw-name').value,
        cloud: document.getElementById('edit-gw-cloud').value,
        region: document.getElementById('edit-gw-region').value
    };
    fetch(API + '/api/v1/satellites/' + id, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(r => r.json()).then(data => {
        if (data.error) {
            document.getElementById('edit-gw-status').innerHTML = `<p style="color:var(--danger)">${data.error}</p>`;
        } else {
            document.getElementById('edit-gw-status').innerHTML = `<p style="color:var(--success)">Gateway updated.</p>`;
            setTimeout(loadGateways, 1000);
        }
    }).catch(() => {
        document.getElementById('edit-gw-status').innerHTML = `<p style="color:var(--danger)">Failed to update.</p>`;
    });
}

function deleteGateway(id, name) {
    if (!confirm('Delete gateway "' + name + '"? This will remove the gateway from management.')) return;
    fetch(API + '/api/v1/satellites/' + id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
    }).then(r => r.json()).then(data => {
        if (data.error) {
            alert('Delete failed: ' + data.error);
        } else {
            alert('Gateway "' + name + '" deleted.');
            loadGateways();
        }
    }).catch(() => alert('Failed to delete gateway.'));
}

function redeployGateway(id, name) {
    if (!confirm('Redeploy gateway "' + name + '"? This will upgrade the gateway to the latest version.')) return;
    apiPost('/api/v1/satellites/' + id + '/upgrade', {}).then(data => {
        if (data.error) {
            alert('Redeploy failed: ' + data.error);
        } else {
            alert('Redeploy initiated for "' + name + '". The gateway will pull the latest version on next heartbeat.');
        }
    }).catch(() => alert('Failed to redeploy gateway.'));
}

function openGatewayPortal(id, ip, name) {
    if (ip) { window.open('http://' + ip, '_blank'); return; }
    const storedUrls = JSON.parse(localStorage.getItem('clm_gateway_urls') || '{}');
    if (storedUrls[id]) { window.open(storedUrls[id], '_blank'); return; }
    tenantApiGet('/api/v1/satellites/deploy').then(data => {
        const jobs = data.jobs || [];
        const job = jobs.find(j => j.public_ip && (j.name === name || j.satellite_id === id));
        if (job && job.public_ip) {
            storedUrls[id] = 'http://' + job.public_ip;
            localStorage.setItem('clm_gateway_urls', JSON.stringify(storedUrls));
            window.open(storedUrls[id], '_blank');
        } else {
            const url = prompt('Enter Gateway Portal URL for "' + name + '":\nExample: http://13.207.101.74');
            if (url) { storedUrls[id] = url.startsWith('http') ? url : 'http://' + url; localStorage.setItem('clm_gateway_urls', JSON.stringify(storedUrls)); window.open(storedUrls[id], '_blank'); }
        }
    }).catch(() => {
        const url = prompt('Enter Gateway Portal URL for "' + name + '":');
        if (url) { const storedUrls = JSON.parse(localStorage.getItem('clm_gateway_urls') || '{}'); storedUrls[id] = url.startsWith('http') ? url : 'http://' + url; localStorage.setItem('clm_gateway_urls', JSON.stringify(storedUrls)); window.open(storedUrls[id], '_blank'); }
    });
}

// --- Gateway Server Management ---
function showGatewayActions(id, ip, name) {
    const el = document.getElementById('content-area');
    document.getElementById('page-title').textContent = 'Manage: ' + name;

    const gatewayUrl = ip ? 'http://' + ip : (JSON.parse(localStorage.getItem('clm_gateway_urls') || '{}')[id] || '');

    el.innerHTML = `
        <div style="margin-bottom:1rem"><button class="btn" onclick="loadGateways()" style="border:1px solid var(--border)">&larr; Back to Gateways</button></div>
        <div class="card">
            <h3 style="margin-bottom:0.5rem">${name}</h3>
            <p style="color:var(--muted);font-size:0.8rem">Gateway ID: ${id} ${ip ? '| IP: ' + ip : ''}</p>
        </div>
        <div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
            <div class="card" style="cursor:pointer;border:2px solid var(--primary)" onclick="openGatewayPortal('${id}','${ip}','${name}')">
                <div style="text-align:center">
                    <div style="font-size:1.5rem">&#127760;</div>
                    <div style="font-weight:600;margin-top:0.25rem">Open Portal</div>
                    <div style="font-size:0.75rem;color:var(--muted)">Access Gateway UI</div>
                </div>
            </div>
            <div class="card" style="cursor:pointer;border:2px solid var(--success)" onclick="deployGatewayServices('${id}','${name}')">
                <div style="text-align:center">
                    <div style="font-size:1.5rem">&#128640;</div>
                    <div style="font-weight:600;margin-top:0.25rem">Deploy Services</div>
                    <div style="font-size:0.75rem;color:var(--muted)">Push latest gateway version</div>
                </div>
            </div>
            <div class="card" style="cursor:pointer;border:2px solid #f59e0b" onclick="restartGatewayServices('${id}','${name}')">
                <div style="text-align:center">
                    <div style="font-size:1.5rem">&#128260;</div>
                    <div style="font-weight:600;margin-top:0.25rem">Restart Services</div>
                    <div style="font-size:0.75rem;color:var(--muted)">Restart gateway process</div>
                </div>
            </div>
            <div class="card" style="cursor:pointer;border:2px solid var(--border)" onclick="accessGatewayServer('${id}','${ip}','${name}')">
                <div style="text-align:center">
                    <div style="font-size:1.5rem">&#128421;</div>
                    <div style="font-weight:600;margin-top:0.25rem">Server Access</div>
                    <div style="font-size:0.75rem;color:var(--muted)">SSH / Console access</div>
                </div>
            </div>
        </div>
        <div id="gw-action-status"></div>
        <div class="card">
            <h3 style="margin-bottom:0.75rem">Service Status</h3>
            <div id="gw-service-status"><p style="color:var(--muted);font-size:0.85rem">Loading...</p></div>
        </div>
        <div class="card">
            <h3 style="margin-bottom:0.75rem">Command History</h3>
            <div id="gw-command-history"><p style="color:var(--muted);font-size:0.85rem">Loading...</p></div>
        </div>`;

    // Load gateway details for service status
    apiGet('/api/v1/satellites/' + id).then(sat => {
        const g = sat;
        const statusColor = g.status === 'online' ? 'var(--success)' : g.status === 'offline' ? 'var(--danger)' : '#f59e0b';
        const lastHB = g.last_heartbeat ? new Date(g.last_heartbeat).toLocaleString() : 'Never';
        const timeSinceHB = g.last_heartbeat ? Math.round((Date.now() - new Date(g.last_heartbeat).getTime()) / 1000) : null;
        const hbAge = timeSinceHB !== null ? (timeSinceHB < 60 ? timeSinceHB + 's ago' : timeSinceHB < 3600 ? Math.round(timeSinceHB/60) + 'm ago' : Math.round(timeSinceHB/3600) + 'h ago') : 'N/A';

        document.getElementById('gw-service-status').innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0.75rem;margin-bottom:1rem">
                <div style="text-align:center;padding:0.75rem;border-radius:0.5rem;background:${statusColor}10;border:1px solid ${statusColor}30">
                    <div style="font-size:0.7rem;text-transform:uppercase;color:var(--muted)">Status</div>
                    <div style="font-size:1.1rem;font-weight:700;color:${statusColor}">${g.status || 'unknown'}</div>
                </div>
                <div style="text-align:center;padding:0.75rem;border-radius:0.5rem;background:#f8fafc;border:1px solid var(--border)">
                    <div style="font-size:0.7rem;text-transform:uppercase;color:var(--muted)">Version</div>
                    <div style="font-size:1.1rem;font-weight:700">${g.version || 'unknown'}</div>
                </div>
                <div style="text-align:center;padding:0.75rem;border-radius:0.5rem;background:#f8fafc;border:1px solid var(--border)">
                    <div style="font-size:0.7rem;text-transform:uppercase;color:var(--muted)">Last Heartbeat</div>
                    <div style="font-size:0.9rem;font-weight:600">${hbAge}</div>
                </div>
                <div style="text-align:center;padding:0.75rem;border-radius:0.5rem;background:#f8fafc;border:1px solid var(--border)">
                    <div style="font-size:0.7rem;text-transform:uppercase;color:var(--muted)">Certificates</div>
                    <div style="font-size:1.1rem;font-weight:700">${g.cert_count || 0}</div>
                </div>
                <div style="text-align:center;padding:0.75rem;border-radius:0.5rem;background:#f8fafc;border:1px solid var(--border)">
                    <div style="font-size:0.7rem;text-transform:uppercase;color:var(--muted)">Agents</div>
                    <div style="font-size:1.1rem;font-weight:700">${g.agent_count || 0}</div>
                </div>
                <div style="text-align:center;padding:0.75rem;border-radius:0.5rem;background:#f8fafc;border:1px solid var(--border)">
                    <div style="font-size:0.7rem;text-transform:uppercase;color:var(--muted)">Connector</div>
                    <div style="font-size:0.9rem;font-weight:600">${g.connector_mode || 'direct'}</div>
                </div>
            </div>
            <table style="font-size:0.82rem">
                <thead><tr><th>Service</th><th>Status</th><th>Details</th></tr></thead>
                <tbody>
                    <tr><td>CLM Gateway</td><td><span class="badge ${g.status==='online'?'badge-active':'badge-disabled'}">${g.status==='online'?'running':'stopped'}</span></td><td>Main gateway process (port 8080)</td></tr>
                    <tr><td>vSatellite API</td><td><span class="badge ${g.status==='online'?'badge-active':'badge-disabled'}">${g.status==='online'?'running':'stopped'}</span></td><td>Agent coordination (port 9090)</td></tr>
                    <tr><td>SaaS Connector</td><td><span class="badge ${g.status==='online'?'badge-active':'badge-warning'}">${g.status==='online'?'connected':'disconnected'}</span></td><td>Outbound to SaaS control plane</td></tr>
                    <tr><td>Crypto Engine</td><td><span class="badge badge-active">ready</span></td><td>Key generation, CSR, chain assembly</td></tr>
                    <tr><td>Secrets Store</td><td><span class="badge badge-active">configured</span></td><td>${g.secrets_backend || 'aws'} secrets manager</td></tr>
                    <tr><td>Discovery Scanner</td><td><span class="badge badge-active">scheduled</span></td><td>Network TLS certificate scanning</td></tr>
                </tbody>
            </table>
            <p style="font-size:0.75rem;color:var(--muted);margin-top:0.5rem">Last updated: ${lastHB}</p>`;
    }).catch(() => {
        document.getElementById('gw-service-status').innerHTML = '<p style="color:var(--muted);font-size:0.85rem">Could not load service status.</p>';
    });

    // Load command history
    apiGet('/api/v1/satellites/' + id + '/commands').then(data => {
        const cmds = data.commands || [];
        if (cmds.length === 0) {
            document.getElementById('gw-command-history').innerHTML = '<p style="color:var(--muted);font-size:0.85rem">No commands sent yet.</p>';
        } else {
            const rows = cmds.map(c => `<div style="display:flex;align-items:center;padding:0.4rem 0;border-bottom:1px solid var(--border)">
                <span class="badge ${c.status==='completed'?'badge-active':c.status==='sent'?'badge-warning':'badge-disabled'}" style="margin-right:0.5rem">${c.status}</span>
                <span style="flex:1;font-size:0.82rem">${c.type}</span>
                <span style="font-size:0.75rem;color:var(--muted)">${c.created_at ? new Date(c.created_at).toLocaleString() : ''}</span>
            </div>`).join('');
            document.getElementById('gw-command-history').innerHTML = rows;
        }
    }).catch(() => {
        document.getElementById('gw-command-history').innerHTML = '<p style="color:var(--muted);font-size:0.85rem">Could not load command history.</p>';
    });
}

function deployGatewayServices(id, name) {
    if (!confirm('Deploy latest gateway services to "' + name + '"? This will pull and install the latest version.')) return;
    document.getElementById('gw-action-status').innerHTML = '<div class="card" style="border-left:3px solid var(--success)"><p style="font-size:0.85rem">Deploying services...</p></div>';

    apiPost('/api/v1/satellites/' + id + '/upgrade', { command: 'deploy_services' }).then(data => {
        document.getElementById('gw-action-status').innerHTML = `<div class="card" style="border-left:3px solid var(--success)"><p style="font-size:0.85rem;color:#065f46">Deploy command sent. The gateway will pull the latest version on next heartbeat.</p></div>`;
    }).catch(() => {
        document.getElementById('gw-action-status').innerHTML = '<div class="card" style="border-left:3px solid var(--danger)"><p style="font-size:0.85rem;color:var(--danger)">Failed to send deploy command.</p></div>';
    });
}

function restartGatewayServices(id, name) {
    if (!confirm('Restart gateway services on "' + name + '"? This will briefly interrupt the gateway.')) return;
    document.getElementById('gw-action-status').innerHTML = '<div class="card" style="border-left:3px solid #f59e0b"><p style="font-size:0.85rem">Restarting services...</p></div>';

    apiPost('/api/v1/satellites/' + id + '/upgrade', { command: 'restart_services' }).then(data => {
        document.getElementById('gw-action-status').innerHTML = `<div class="card" style="border-left:3px solid var(--success)"><p style="font-size:0.85rem;color:#065f46">Restart command sent. The gateway will restart on next heartbeat.</p></div>`;
    }).catch(() => {
        document.getElementById('gw-action-status').innerHTML = '<div class="card" style="border-left:3px solid var(--danger)"><p style="font-size:0.85rem;color:var(--danger)">Failed to send restart command.</p></div>';
    });
}

function accessGatewayServer(id, ip, name) {
    const gatewayIp = ip || (JSON.parse(localStorage.getItem('clm_gateway_urls') || '{}')[id] || '').replace('http://','').replace('https://','');

    const statusEl = document.getElementById('gw-action-status');
    if (gatewayIp) {
        statusEl.innerHTML = `<div class="card">
            <h3 style="margin-bottom:0.75rem">Server Access — ${name}</h3>
            <table style="font-size:0.85rem">
                <tr><td style="font-weight:600;width:140px">SSH Command</td><td><code style="background:#f1f5f9;padding:0.3rem 0.5rem;border-radius:0.25rem;font-size:0.8rem">ssh -i ~/.ssh/clm-saas-deploy.pem ubuntu@${gatewayIp}</code></td></tr>
                <tr><td style="font-weight:600">IP Address</td><td>${gatewayIp}</td></tr>
                <tr><td style="font-weight:600">User</td><td>ubuntu</td></tr>
                <tr><td style="font-weight:600">Key</td><td>~/.ssh/clm-saas-deploy.pem</td></tr>
                <tr><td style="font-weight:600">Gateway Logs</td><td><code style="font-size:0.8rem">sudo docker logs clm-gateway-clm-gateway-1 -f</code></td></tr>
                <tr><td style="font-weight:600">Restart</td><td><code style="font-size:0.8rem">sudo docker compose restart clm-gateway</code></td></tr>
                <tr><td style="font-weight:600">Status</td><td><code style="font-size:0.8rem">sudo docker compose ps</code></td></tr>
            </table>
        </div>`;
    } else {
        statusEl.innerHTML = `<div class="card" style="border-left:3px solid #f59e0b"><p style="font-size:0.85rem;color:#92400e">No IP address available. Deploy the gateway first or set the IP via Edit.</p></div>`;
    }
}

function showDeployForm() {
    document.getElementById('deploy-form-card').classList.remove('hidden');
    // Populate cloud account dropdown
    const select = document.getElementById('d-cloud-account');
    const accounts = getCloudAccounts();
    select.innerHTML = '<option value="">-- Select a registered cloud account --</option>';
    accounts.forEach(a => {
        select.innerHTML += `<option value="${a.id}">${a.name} (${a.cloud.toUpperCase()} - ${a.region})</option>`;
    });
    if (accounts.length === 0) {
        select.innerHTML = '<option value="">-- No cloud accounts registered --</option>';
    }
    // Auto-select if only one account
    if (accounts.length === 1) {
        select.value = accounts[0].id;
        onCloudAccountSelect();
    }
    onDeployModeChange(); // Render mode-specific config
}
function hideDeployForm() {
    document.getElementById('deploy-form-card').classList.add('hidden');
}
function onDeployModeChange() {
    const mode = document.getElementById('d-mode').value;
    const el = document.getElementById('deploy-mode-config');

    if (mode === 'lightsail') {
        el.innerHTML = `
            <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:0.5rem;padding:0.75rem;margin-bottom:0.75rem">
                <p style="font-size:0.8rem;color:#0369a1;font-weight:600;margin-bottom:0.25rem">Lightsail VM</p>
                <p style="font-size:0.75rem;color:#0c4a6e">Single VM with static IP. Best for dev/test or small deployments.</p>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>VM Size</label><select id="d-size" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="nano_3_1">Nano (1 vCPU, 512MB) — $3.50/mo</option>
                    <option value="micro_3_1">Micro (1 vCPU, 1GB) — $5/mo</option>
                    <option value="small_3_1">Small (1 vCPU, 2GB) — $10/mo</option>
                    <option value="medium_3_1" selected>Medium (2 vCPU, 4GB) — $20/mo</option>
                    <option value="large_3_1">Large (2 vCPU, 8GB) — $40/mo</option>
                    <option value="xlarge_3_1">XLarge (4 vCPU, 16GB) — $80/mo</option>
                </select></div>
                <div class="form-group"><label>Availability Zone</label><select id="d-az" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="">Auto (default AZ)</option>
                    <option value="a">Zone A</option>
                    <option value="b">Zone B</option>
                    <option value="c">Zone C</option>
                </select></div>
            </div>`;
    } else if (mode === 'ec2') {
        el.innerHTML = `
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:0.5rem;padding:0.75rem;margin-bottom:0.75rem">
                <p style="font-size:0.8rem;color:#166534;font-weight:600;margin-bottom:0.25rem">EC2 + Application Load Balancer</p>
                <p style="font-size:0.75rem;color:#14532d">Auto-scaling EC2 instances behind ALB. Best for production workloads.</p>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Instance Type</label><select id="d-size" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="t3.small">t3.small (2 vCPU, 2GB)</option>
                    <option value="t3.medium" selected>t3.medium (2 vCPU, 4GB)</option>
                    <option value="t3.large">t3.large (2 vCPU, 8GB)</option>
                    <option value="t3.xlarge">t3.xlarge (4 vCPU, 16GB)</option>
                    <option value="m5.large">m5.large (2 vCPU, 8GB)</option>
                    <option value="m5.xlarge">m5.xlarge (4 vCPU, 16GB)</option>
                    <option value="c5.large">c5.large (2 vCPU, 4GB, compute)</option>
                    <option value="c5.xlarge">c5.xlarge (4 vCPU, 8GB, compute)</option>
                </select></div>
                <div class="form-group"><label>VPC ID (optional)</label><input id="d-vpc" placeholder="vpc-0abc123 (default VPC if empty)" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Subnet ID (optional)</label><input id="d-subnet" placeholder="subnet-0abc123" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label>Min Instances</label><input id="d-min" type="number" value="1" min="1" max="10" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label>Max Instances (auto-scale)</label><input id="d-max" type="number" value="3" min="1" max="20" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div class="form-group"><label>Target Group ARN (optional — attach to existing ALB)</label><input id="d-tg" placeholder="arn:aws:elasticloadbalancing:..." style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>`;
    } else if (mode === 'eks') {
        el.innerHTML = `
            <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:0.5rem;padding:0.75rem;margin-bottom:0.75rem">
                <p style="font-size:0.8rem;color:#6b21a8;font-weight:600;margin-bottom:0.25rem">EKS (Kubernetes)</p>
                <p style="font-size:0.75rem;color:#581c87">Deploy as pods in an existing EKS cluster. Best for cloud-native environments.</p>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>EKS Cluster Name</label><input id="d-cluster" placeholder="my-production-cluster" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label>Namespace</label><input id="d-namespace" placeholder="clm-gateway" value="clm-gateway" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>CPU Request</label><select id="d-cpu" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="250m">250m (0.25 CPU)</option>
                    <option value="500m" selected>500m (0.5 CPU)</option>
                    <option value="1000m">1000m (1 CPU)</option>
                    <option value="2000m">2000m (2 CPU)</option>
                </select></div>
                <div class="form-group"><label>Memory Request</label><select id="d-memory" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="256Mi">256Mi</option>
                    <option value="512Mi" selected>512Mi</option>
                    <option value="1Gi">1Gi</option>
                    <option value="2Gi">2Gi</option>
                    <option value="4Gi">4Gi</option>
                </select></div>
                <div class="form-group"><label>Replicas</label><input id="d-replicas" type="number" value="2" min="1" max="10" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Min Pods (HPA)</label><input id="d-min" type="number" value="2" min="1" max="10" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label>Max Pods (HPA auto-scale)</label><input id="d-max" type="number" value="5" min="1" max="50" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div class="form-group"><label>Ingress Class (optional)</label><input id="d-ingress" placeholder="nginx or alb" value="alb" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>`;
    } else if (mode === 'gce') {
        el.innerHTML = `
            <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:0.5rem;padding:0.75rem;margin-bottom:0.75rem">
                <p style="font-size:0.8rem;color:#c2410c;font-weight:600">GCP Compute Engine (VM)</p>
                <p style="font-size:0.75rem;color:#7c2d12">Single VM with external IP on Google Cloud.</p>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Machine Type</label><select id="d-size" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="e2-small">e2-small (2 vCPU, 2GB)</option>
                    <option value="e2-medium" selected>e2-medium (2 vCPU, 4GB)</option>
                    <option value="e2-standard-2">e2-standard-2 (2 vCPU, 8GB)</option>
                    <option value="e2-standard-4">e2-standard-4 (4 vCPU, 16GB)</option>
                    <option value="n2-standard-2">n2-standard-2 (2 vCPU, 8GB)</option>
                </select></div>
                <div class="form-group"><label>Zone</label><input id="d-az" placeholder="asia-south1-a" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Network</label><input id="d-vpc" placeholder="default" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label>Subnet</label><input id="d-subnet" placeholder="default" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>`;
    } else if (mode === 'gke') {
        el.innerHTML = `
            <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:0.5rem;padding:0.75rem;margin-bottom:0.75rem">
                <p style="font-size:0.8rem;color:#c2410c;font-weight:600">GCP GKE (Kubernetes)</p>
                <p style="font-size:0.75rem;color:#7c2d12">Deploy as pods in an existing GKE cluster.</p>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>GKE Cluster</label><input id="d-cluster" placeholder="my-gke-cluster" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label>Namespace</label><input id="d-namespace" value="clm-gateway" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>CPU</label><select id="d-cpu" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"><option value="250m">250m</option><option value="500m" selected>500m</option><option value="1000m">1000m</option></select></div>
                <div class="form-group"><label>Memory</label><select id="d-memory" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"><option value="512Mi" selected>512Mi</option><option value="1Gi">1Gi</option><option value="2Gi">2Gi</option></select></div>
                <div class="form-group"><label>Replicas</label><input id="d-replicas" type="number" value="2" min="1" max="10" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Min Pods (HPA)</label><input id="d-min" type="number" value="2" min="1" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label>Max Pods (HPA)</label><input id="d-max" type="number" value="5" min="1" max="50" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>`;
    } else if (mode === 'azure_vm') {
        el.innerHTML = `
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:0.5rem;padding:0.75rem;margin-bottom:0.75rem">
                <p style="font-size:0.8rem;color:#1d4ed8;font-weight:600">Azure Virtual Machine</p>
                <p style="font-size:0.75rem;color:#1e3a5f">Single VM with public IP on Azure.</p>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>VM Size</label><select id="d-size" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="Standard_B1ms">B1ms (1 vCPU, 2GB)</option>
                    <option value="Standard_B2s" selected>B2s (2 vCPU, 4GB)</option>
                    <option value="Standard_B2ms">B2ms (2 vCPU, 8GB)</option>
                    <option value="Standard_D2s_v3">D2s_v3 (2 vCPU, 8GB)</option>
                    <option value="Standard_D4s_v3">D4s_v3 (4 vCPU, 16GB)</option>
                </select></div>
                <div class="form-group"><label>Resource Group</label><input id="d-rg" placeholder="clm-gateway-rg" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>VNet</label><input id="d-vpc" placeholder="my-vnet" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label>Subnet</label><input id="d-subnet" placeholder="default" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>`;
    } else if (mode === 'aks') {
        el.innerHTML = `
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:0.5rem;padding:0.75rem;margin-bottom:0.75rem">
                <p style="font-size:0.8rem;color:#1d4ed8;font-weight:600">Azure AKS (Kubernetes)</p>
                <p style="font-size:0.75rem;color:#1e3a5f">Deploy as pods in an existing AKS cluster.</p>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>AKS Cluster</label><input id="d-cluster" placeholder="my-aks-cluster" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label>Resource Group</label><input id="d-rg" placeholder="clm-rg" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>Namespace</label><input id="d-namespace" value="clm-gateway" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label>Replicas</label><input id="d-replicas" type="number" value="2" min="1" max="10" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem">
                <div class="form-group"><label>CPU</label><select id="d-cpu" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"><option value="250m">250m</option><option value="500m" selected>500m</option><option value="1000m">1000m</option></select></div>
                <div class="form-group"><label>Memory</label><select id="d-memory" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"><option value="512Mi" selected>512Mi</option><option value="1Gi">1Gi</option><option value="2Gi">2Gi</option></select></div>
                <div class="form-group"><label>Max Pods (HPA)</label><input id="d-max" type="number" value="5" min="1" max="50" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>`;
    }
}
function onCloudAccountSelect() {
    const id = document.getElementById('d-cloud-account').value;
    const accounts = getCloudAccounts();
    const account = accounts.find(a => a.id === id);
    if (account) {
        document.getElementById('d-region').value = account.region || '';
        // Update deploy mode options based on cloud provider
        const modeSelect = document.getElementById('d-mode');
        if (account.cloud === 'aws') {
            modeSelect.innerHTML = `
                <option value="lightsail">Lightsail (VM — simplest)</option>
                <option value="ec2">EC2 + ALB (production VM)</option>
                <option value="eks">EKS (Kubernetes)</option>`;
        } else if (account.cloud === 'gcp') {
            modeSelect.innerHTML = `
                <option value="gce">Compute Engine (VM)</option>
                <option value="gke">GKE (Kubernetes)</option>`;
        } else if (account.cloud === 'azure') {
            modeSelect.innerHTML = `
                <option value="azure_vm">Azure VM</option>
                <option value="aks">AKS (Kubernetes)</option>`;
        }
        onDeployModeChange(); // Refresh config fields
    }
}

function startDeploy() {
    const accountId = document.getElementById('d-cloud-account').value;
    const accounts = getCloudAccounts();
    const account = accounts.find(a => a.id === accountId);

    if (!account) {
        document.getElementById('deploy-status').innerHTML = '<p style="color:var(--danger)">Please select a cloud account.</p>';
        return;
    }

    const name = document.getElementById('d-name').value.trim();
    if (!name) {
        document.getElementById('deploy-status').innerHTML = '<p style="color:var(--danger)">Gateway name is required.</p>';
        return;
    }

    const mode = document.getElementById('d-mode').value;
    const region = document.getElementById('d-region').value || account.region;

    // Build infra config based on mode
    const infra = {};
    if (mode === 'lightsail') {
        infra.lightsail_bundle = document.getElementById('d-size').value;
        const az = document.getElementById('d-az').value;
        if (az) infra.lightsail_az = region + az;
    } else if (mode === 'ec2') {
        infra.instance_type = document.getElementById('d-size').value;
        const vpc = document.getElementById('d-vpc').value.trim();
        const subnet = document.getElementById('d-subnet').value.trim();
        const tg = document.getElementById('d-tg').value.trim();
        if (vpc) infra.vpc_id = vpc;
        if (subnet) infra.subnet_id = subnet;
        if (tg) infra.target_group_arn = tg;
        infra.min_instances = parseInt(document.getElementById('d-min').value) || 1;
        infra.max_instances = parseInt(document.getElementById('d-max').value) || 3;
    } else if (mode === 'eks') {
        const cluster = document.getElementById('d-cluster').value.trim();
        if (!cluster) {
            document.getElementById('deploy-status').innerHTML = '<p style="color:var(--danger)">EKS cluster name is required.</p>';
            return;
        }
        infra.cluster_name = cluster;
        infra.namespace = document.getElementById('d-namespace').value.trim() || 'clm-gateway';
        infra.cpu_request = document.getElementById('d-cpu').value;
        infra.memory_request = document.getElementById('d-memory').value;
        infra.replicas = parseInt(document.getElementById('d-replicas').value) || 2;
        infra.min_instances = parseInt(document.getElementById('d-min').value) || 2;
        infra.max_instances = parseInt(document.getElementById('d-max').value) || 5;
        infra.ingress_class = document.getElementById('d-ingress').value.trim() || 'alb';
    }

    const body = {
        name: name,
        tenant_id: activeTenantId,
        cloud_account_id: account.id,
        cloud: account.cloud,
        mode: mode,
        region: region,
        infra: infra
    };

    document.getElementById('deploy-status').innerHTML = '<p style="color:var(--muted)">Validating credentials and deploying gateway...</p>';

    apiPost(scopedPath('/api/v1/satellites/deploy', activeTenantId), body).then(data => {
        if (data.error) {
            document.getElementById('deploy-status').innerHTML = `<p style="color:var(--danger)">Error: ${data.error}</p>`;
            return;
        }
        document.getElementById('deploy-status').innerHTML = `
            <div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:0.5rem;padding:1rem;margin-top:0.5rem">
                <p style="color:#065f46;font-weight:600;margin-bottom:0.5rem">Deployment Initiated</p>
                <p style="color:#065f46;font-size:0.85rem">Job ID: <code>${data.job_id}</code></p>
                <p style="color:#065f46;font-size:0.85rem">State: ${data.state} | Mode: ${mode}</p>
                <button class="btn btn-primary" style="margin-top:0.75rem" onclick="viewDeployJob('${data.job_id}')">View Progress</button>
            </div>`;
    }).catch(err => {
        document.getElementById('deploy-status').innerHTML = `<p style="color:var(--danger)">Error: ${err.message||'deployment failed'}</p>`;
    });
}

// --- Deploy Jobs Page ---
function loadDeployJobs() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p>Loading deployment jobs...</p></div>';
    document.getElementById('page-title').textContent = 'Deploy Jobs';

    resolveTenantScope().then(tenantId => apiGet(scopedPath('/api/v1/satellites/deploy', tenantId))).then(data => {
        const jobs = data.jobs || [];
        if (jobs.length === 0) {
            el.innerHTML = `<div class="card">
                <h3>Deployment Jobs</h3>
                <p style="color:var(--muted);margin-top:0.5rem">No deployment jobs found. Go to <a href="#" onclick="navigate('gateways');return false" style="color:var(--primary)">Gateways</a> and click "+ Deploy New Gateway" to start one.</p>
            </div>`;
            return;
        }
        let rows = jobs.map(j => {
            const state = j.state || j.status || 'unknown';
            const name = j.name || j.type || j.id || 'Deployment job';
            const stateColor = state === 'online' || state === 'completed' ? 'var(--success)' : state === 'failed' ? 'var(--danger)' : state === 'deploying' || state === 'running' ? '#f59e0b' : 'var(--muted)';
            const stateIcon = state === 'online' || state === 'completed' ? '&#10003;' : state === 'failed' ? '&#10007;' : state === 'deploying' || state === 'running' ? '&#9881;' : '&#8226;';
            const createdAt = j.created_at || j.started_at;
            const progress = Array.isArray(j.steps) && j.steps.length
                ? `${j.current_step || 0}/${j.steps.length}`
                : '-';
            return `<tr style="cursor:pointer" onclick="viewDeployJob('${j.id}')">
                <td><strong>${esc(name)}</strong></td>
                <td>${esc(j.cloud || 'aws')}</td>
                <td>${esc(j.mode || '-')}</td>
                <td>${esc(j.region || '-')}</td>
                <td><span style="color:${stateColor};font-weight:600">${stateIcon} ${esc(state)}</span></td>
                <td>${esc(j.public_ip || '-')}</td>
                <td>${progress}</td>
                <td>${createdAt ? new Date(createdAt).toLocaleString() : '-'}</td>
            </tr>`;
        }).join('');
        el.innerHTML = `<div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h3>Deployment Jobs</h3>
                <button class="btn btn-primary" onclick="navigate('gateways')">+ New Deploy</button>
            </div>
            <table><thead><tr><th>Name</th><th>Cloud</th><th>Mode</th><th>Region</th><th>State</th><th>IP</th><th>Progress</th><th>Created</th></tr></thead>
            <tbody>${rows}</tbody></table>
        </div>`;
    }).catch(err => {
        if (renderTenantSelection(el, err)) return;
        el.innerHTML = `<div class="card"><p style="color:var(--danger)">Failed to load jobs: ${err.message}</p></div>`;
    });
}

// --- Deploy Job Detail View ---
let jobPollTimer = null;

function viewDeployJob(jobId) {
    if (jobPollTimer) { clearInterval(jobPollTimer); jobPollTimer = null; }
    const el = document.getElementById('content-area');
    document.getElementById('page-title').textContent = 'Deploy Job';
    el.innerHTML = '<div class="card"><p>Loading job details...</p></div>';

    function renderJob() {
        apiGet(scopedPath('/api/v1/satellites/deploy/' + jobId, activeTenantId)).then(job => {
            const j = job;
            const stateColor = j.state === 'online' ? 'var(--success)' : j.state === 'failed' ? 'var(--danger)' : j.state === 'deploying' ? '#f59e0b' : 'var(--muted)';

            let stepsHtml = '';
            if (j.steps && j.steps.length > 0) {
                stepsHtml = j.steps.map((step, idx) => {
                    let icon = '&#9675;';  // empty circle
                    let color = 'var(--muted)';
                    if (step.status === 'done') { icon = '&#10003;'; color = 'var(--success)'; }
                    else if (step.status === 'running') { icon = '&#9881;'; color = '#f59e0b'; }
                    else if (step.status === 'failed') { icon = '&#10007;'; color = 'var(--danger)'; }
                    const duration = step.started_at && step.done_at ? ((new Date(step.done_at) - new Date(step.started_at))/1000).toFixed(1) + 's' : '';
                    return `<div style="display:flex;align-items:center;padding:0.5rem 0;border-bottom:1px solid var(--border)">
                        <span style="color:${color};font-size:1.1rem;width:24px;text-align:center">${icon}</span>
                        <span style="flex:1;margin-left:0.5rem;font-size:0.85rem">${step.name}</span>
                        <span style="font-size:0.75rem;color:var(--muted)">${duration}</span>
                        ${step.error ? '<span style="font-size:0.75rem;color:var(--danger);margin-left:0.5rem" title="'+step.error+'">error</span>' : ''}
                    </div>`;
                }).join('');
            }

            el.innerHTML = `
                <div style="margin-bottom:1rem"><button class="btn" onclick="loadDeployJobs()" style="border:1px solid var(--border)">&larr; Back to Jobs</button></div>
                <div class="card">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start">
                        <div>
                            <h3 style="margin-bottom:0.25rem">${j.name||'Deploy Job'}</h3>
                            <p style="color:var(--muted);font-size:0.8rem">Job ID: ${j.id}</p>
                        </div>
                        <span class="badge" style="background:${stateColor}20;color:${stateColor};font-size:0.85rem;padding:0.3rem 0.8rem;font-weight:600">${j.state}</span>
                    </div>
                </div>
                <div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
                    <div class="card stat"><div class="label">Cloud</div><div class="value" style="font-size:1.1rem">${j.cloud||'aws'}</div></div>
                    <div class="card stat"><div class="label">Mode</div><div class="value" style="font-size:1.1rem">${j.mode||'lightsail'}</div></div>
                    <div class="card stat"><div class="label">Region</div><div class="value" style="font-size:1.1rem">${j.region||'-'}</div></div>
                    <div class="card stat"><div class="label">Public IP</div><div class="value" style="font-size:1.1rem">${j.public_ip||'Pending...'}</div></div>
                    <div class="card stat"><div class="label">Resource</div><div class="value" style="font-size:0.9rem">${j.resource_id||'Pending...'}</div></div>
                </div>
                <div class="card">
                    <h3 style="margin-bottom:0.75rem">Deployment Steps</h3>
                    ${stepsHtml || '<p style="color:var(--muted);font-size:0.85rem">No step data available yet.</p>'}
                </div>
                ${j.state === 'deploying' || j.state === 'pending' || j.state === 'validating' ? '<div class="card" style="border-left:3px solid #f59e0b"><p style="font-size:0.85rem;color:#92400e">Deployment in progress. This page auto-refreshes every 5 seconds.</p></div>' : ''}
                ${j.state === 'online' && j.public_ip ? '<div class="card" style="border-left:3px solid var(--success)"><p style="font-size:0.85rem;color:#065f46">Gateway is online at <strong>'+j.public_ip+'</strong>. Access: <a href="http://'+j.public_ip+':8080" target="_blank" style="color:var(--primary)">http://'+j.public_ip+':8080</a></p></div>' : ''}
                ${j.state === 'failed' ? '<div class="card" style="border-left:3px solid var(--danger)"><p style="font-size:0.85rem;color:#991b1b">Deployment failed. Check the step errors above for details.</p></div>' : ''}
            `;

            // Auto-refresh if still deploying
            if (j.state === 'deploying' || j.state === 'pending' || j.state === 'validating') {
                if (!jobPollTimer) {
                    jobPollTimer = setInterval(renderJob, 5000);
                }
            } else {
                if (jobPollTimer) { clearInterval(jobPollTimer); jobPollTimer = null; }
            }
        }).catch(err => {
            el.innerHTML = `<div class="card"><p style="color:var(--danger)">Failed to load job: ${err.message}</p></div>`;
            if (jobPollTimer) { clearInterval(jobPollTimer); jobPollTimer = null; }
        });
    }

    renderJob();
}


// ============================================================
// Identity Management — native Keycloak administration
// Talks to /api/v1/identity/* which proxies the Keycloak Admin
// REST API, so the Keycloak Admin Console is never exposed.
// ============================================================

let identityTab = 'users';
const IDENTITY_TABS = [
    ['users', 'Users'],
    ['groups', 'Groups'],
    ['roles', 'Roles'],
    ['providers', 'Identity Providers'],
    ['sessions', 'Active Sessions'],
    ['clients', 'Clients']
];

function loadIdentity(initialTab) {
    if (initialTab && IDENTITY_TABS.some(t => t[0] === initialTab)) {
        identityTab = initialTab;
    }
    document.getElementById('page-title').textContent = 'Identity Management';
    const el = document.getElementById('content-area');

    const tabs = IDENTITY_TABS.map(t =>
        '<button class="btn" id="idtab-' + t[0] + '" onclick="switchIdentityTab(\'' + t[0] + '\')" ' +
        'style="border-radius:0;background:none;color:var(--muted);border-bottom:2px solid transparent;padding:0.7rem 1.1rem">' +
        t[1] + '</button>'
    ).join('');

    el.innerHTML = `
        <div class="stats" id="id-stats">
            <div class="card stat"><div class="label">Realm Users</div><div class="value" id="id-s-users">-</div></div>
            <div class="card stat"><div class="label">Enabled</div><div class="value" id="id-s-enabled">-</div></div>
            <div class="card stat"><div class="label">Roles</div><div class="value" id="id-s-roles">-</div></div>
            <div class="card stat"><div class="label">Active Sessions</div><div class="value" id="id-s-sessions">-</div></div>
        </div>
        <div id="id-banner"></div>
        <div class="card" style="padding:0;margin-bottom:1rem">
            <div style="display:flex;flex-wrap:wrap;border-bottom:1px solid var(--border)">${tabs}</div>
        </div>
        <div id="id-body"><div class="card"><p style="color:var(--muted)">Loading...</p></div></div>
    `;

    loadIdentityStats();
    switchIdentityTab(identityTab);
}

function loadIdentityStats() {
    apiGet('/api/v1/identity/status').then(s => {
        const banner = document.getElementById('id-banner');
        if (!s || s.reachable === false) {
            if (banner) banner.innerHTML = '<div class="card" style="border-left:3px solid var(--danger)">' +
                '<p style="font-size:0.85rem;color:#991b1b">Keycloak Admin API is not reachable. ' +
                'Check that the keycloak container is running and KEYCLOAK_ADMIN_PASS is set on clm-server.</p></div>';
            return;
        }
        if (banner) banner.innerHTML = '';
        setText('id-s-users', s.users);
        setText('id-s-enabled', s.enabled_users);
        setText('id-s-roles', s.roles);
        setText('id-s-sessions', s.active_sessions);
    }).catch(err => {
        const banner = document.getElementById('id-banner');
        if (banner) banner.innerHTML = '<div class="card" style="border-left:3px solid var(--danger)">' +
            '<p style="font-size:0.85rem;color:#991b1b">Identity API error: ' + esc(err.message) + '</p></div>';
    });
}

function setText(id, val) {
    const n = document.getElementById(id);
    if (n) n.textContent = (val === undefined || val === null) ? '-' : val;
}

// esc guards against HTML/attribute injection when rendering values that come
// back from Keycloak. Ampersand must be replaced first.
function esc(s) {
    if (s === undefined || s === null) return '';
    return String(s)
        .split('&').join('&amp;')
        .split('<').join('&lt;')
        .split('>').join('&gt;')
        .split('"').join('&quot;')
        .split("'").join('&#39;');
}

// jsq escapes a value that is embedded inside a single-quoted JS string within
// an HTML attribute, e.g. onclick="fn('VALUE')". The browser HTML-decodes the
// attribute before parsing the JS, so the JS escaping must be applied first.
function jsq(s) {
    if (s === undefined || s === null) return '';
    return esc(String(s).split('\\').join('\\\\').split("'").join("\\'"));
}

function switchIdentityTab(tab) {
    identityTab = tab;
    IDENTITY_TABS.forEach(t => {
        const b = document.getElementById('idtab-' + t[0]);
        if (!b) return;
        const on = t[0] === tab;
        b.style.color = on ? 'var(--primary)' : 'var(--muted)';
        b.style.borderBottom = on ? '2px solid var(--primary)' : '2px solid transparent';
    });
    IDENTITY_TABS.forEach(t => {
        const b = document.getElementById('idtab-' + t[0]);
        if (b) {
            const on = t[0] === tab;
            b.style.background = on ? '#eff6ff' : 'none';
            b.style.fontWeight = on ? '700' : '600';
        }
    });

    if (tab === 'users') renderIdentityUsers();
    else if (tab === 'groups') renderIdentityGroups();
    else if (tab === 'roles') renderIdentityRoles();
    else if (tab === 'providers') renderIdentityProviders();
    else if (tab === 'sessions') renderIdentitySessions();
    else if (tab === 'clients') renderIdentityClients();
}

// --- Users tab ---
let identityRoleCache = [];

function renderIdentityUsers(search) {
    const body = document.getElementById('id-body');
    if (!body) return;
    body.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading users...</p></div>';

    const q = search ? '?search=' + encodeURIComponent(search) : '';
    Promise.all([
        apiGet('/api/v1/identity/users' + q),
        apiGet('/api/v1/identity/roles')
    ]).then(([ud, rd]) => {
        identityRoleCache = (rd.roles || []).map(r => r.name).sort();
        const users = ud.users || [];

        const rows = users.length === 0
            ? '<tr><td colspan="6" style="color:var(--muted)">No users found</td></tr>'
            : users.map(u => identityUserRow(u)).join('');

        body.innerHTML = `
            <div class="card" style="margin-bottom:1rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
                <input id="id-search" placeholder="Search username, email or name"
                       value="${esc(search || '')}"
                       style="flex:1;min-width:220px;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.82rem">
                <button class="btn btn-primary" onclick="identitySearch()">Search</button>
                <button class="btn" style="background:#e2e8f0" onclick="renderIdentityUsers()">Reset</button>
                <button class="btn btn-primary" onclick="showCreateIdentityUser()">+ New User</button>
            </div>
            <div class="card">
                <table>
                    <thead><tr><th>Username</th><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th style="width:1%">Actions</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div id="id-user-panel"></div>
        `;
        const input = document.getElementById('id-search');
        if (input) input.onkeydown = e => { if (e.key === 'Enter') identitySearch(); };
    }).catch(err => {
        body.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load users: ' + esc(err.message) + '</p></div>';
    });
}

function identitySearch() {
    const input = document.getElementById('id-search');
    renderIdentityUsers(input ? input.value.trim() : '');
}

function identityUserRow(u) {
    const role = (u.roles && u.roles.length) ? u.roles.join(', ') : '<span style="color:var(--muted)">none</span>';
    let status = u.enabled
        ? '<span class="badge badge-active">Enabled</span>'
        : '<span class="badge badge-disabled">Disabled</span>';

    // Keycloak refuses a Direct Grant login — the flow both portals use — in two
    // cases that leave the account looking perfectly healthy while every login
    // fails with "Account is not fully set up":
    //   1. a stored required action (UPDATE_PASSWORD, VERIFY_EMAIL, ...)
    //   2. a missing required profile attribute; the realm requires firstName and
    //      lastName, and that action is derived at login, never stored.
    // Flag both so the cause is visible.
    const pending = u.requiredActions || [];
    const noName = !u.firstName || !u.lastName;
    const blocked = pending.length > 0 || noName;
    if (blocked) {
        const why = pending.length > 0
            ? 'Pending actions: ' + pending.join(', ')
            : 'Profile incomplete: first and last name are required by the realm';
        status += ' <span class="badge badge-disabled" style="background:#fef3c7;color:#92400e" ' +
                  'title="' + esc(why) + '. Login is refused with &quot;Account is not fully ' +
                  'set up&quot; until this is resolved.">Login blocked</span>';
    }

    const name = ((u.firstName || '') + ' ' + (u.lastName || '')).trim();
    const id = jsq(u.id);
    const uname = jsq(u.username);
    const fixBtn = blocked
        ? '<button class="btn btn-primary" onclick="unlockIdentityUser(\'' + id + '\',\'' + uname +
          '\',\'' + jsq(u.firstName || '') + '\',\'' + jsq(u.lastName || '') + '\')">Fix Login</button> '
        : '';
    return '<tr>' +
        '<td><strong>' + esc(u.username) + '</strong></td>' +
        '<td>' + esc(u.email) + '</td>' +
        '<td>' + esc(name) + '</td>' +
        '<td>' + role + '</td>' +
        '<td>' + status + '</td>' +
        '<td style="white-space:nowrap">' +
            fixBtn +
            '<button class="btn" style="background:#e2e8f0" onclick="showIdentityUser(\'' + id + '\')">Manage</button> ' +
            '<button class="btn" style="background:#e2e8f0" onclick="promptResetPassword(\'' + id + '\',\'' + uname + '\')">Password</button> ' +
            '<button class="btn" style="background:#e2e8f0" onclick="toggleIdentityUser(\'' + id + '\',' + (!u.enabled) + ')">' +
                (u.enabled ? 'Disable' : 'Enable') + '</button> ' +
            '<button class="btn btn-danger" onclick="deleteIdentityUser(\'' + id + '\',\'' + uname + '\')">Delete</button>' +
        '</td>' +
    '</tr>';
}

// unlockIdentityUser repairs an account that Keycloak refuses to authenticate:
// it clears pending required actions and completes the mandatory profile name.
// When the name is what's missing, the admin is asked for it so the account is
// not left with a value guessed from the email address.
function unlockIdentityUser(id, username, firstName, lastName) {
    const body = {};
    if (!firstName || !lastName) {
        const entered = prompt(
            'First and last name are required by the identity realm, and ' +
            username + ' is missing one.\n\n' +
            'Enter "First Last" to complete the profile (leave blank to derive ' +
            'it from the email address):',
            ((firstName || '') + ' ' + (lastName || '')).trim());
        if (entered === null) return;
        const parts = entered.trim().split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
            body.first_name = parts[0];
            body.last_name = parts.slice(1).join(' ');
        } else if (parts.length === 1) {
            body.first_name = parts[0];
        }
    } else if (!confirm('Clear all pending required actions for ' + username + '?\n\n' +
                        'This lets the account log in again. Any outstanding forced ' +
                        'password change or email verification will be dropped.')) {
        return;
    }
    apiPost('/api/v1/identity/users/' + id + '/unlock', body).then(d => {
        if (d.error) { alert(d.error); return; }
        alert('Login restored for ' + username + ':\n\n- ' +
              (d.changes || ['done']).join('\n- '));
        renderIdentityUsers();
    }).catch(e => alert(e.message));
}

function showCreateIdentityUser() {
    const panel = document.getElementById('id-user-panel');
    if (!panel) return;
    const roleOpts = identityRoleCache.map(r => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('');
    panel.innerHTML = `
        <div class="card" style="margin-top:1rem;border-left:3px solid var(--primary)">
            <h3 style="margin-bottom:0.75rem;font-size:0.95rem">Create Realm User</h3>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.75rem">
                <div class="form-group"><label class="label">Email *</label>
                    <input id="nu-email" type="email" placeholder="user@aiforgers.tech" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label class="label">Username</label>
                    <input id="nu-username" placeholder="defaults to email" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label class="label">First Name *</label>
                    <input id="nu-first" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label class="label">Last Name *</label>
                    <input id="nu-last" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label class="label">Password * (min 8)</label>
                    <input id="nu-pass" type="password" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label class="label">Role</label>
                    <select id="nu-role" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"><option value="">(none)</option>${roleOpts}</select></div>
            </div>
            <div style="font-size:0.78rem;color:var(--text-muted);background:#f8fafc;border-left:3px solid var(--warning,#d97706);padding:0.5rem 0.65rem;margin:0.6rem 0;border-radius:0.25rem">
                The password is set as permanent. "Require password change at first login"
                is deliberately not offered: both portals sign in with the OAuth Direct Grant
                flow, which cannot carry out a forced password change, so such an account
                would be rejected with <em>"Account is not fully set up"</em> and could never
                log in. The user is created in this tenant and can change their own password
                after signing in.
            </div>
            <div id="nu-error" style="color:var(--danger);font-size:0.8rem;margin-bottom:0.5rem"></div>
            <button class="btn btn-primary" onclick="createIdentityUser()">Create User</button>
            <button class="btn" style="background:#e2e8f0" onclick="document.getElementById('id-user-panel').innerHTML=''">Cancel</button>
        </div>
    `;
}

function createIdentityUser() {
    const err = document.getElementById('nu-error');
    const val = id => { const n = document.getElementById(id); return n ? n.value.trim() : ''; };
    const payload = {
        email: val('nu-email'),
        username: val('nu-username'),
        first_name: val('nu-first'),
        last_name: val('nu-last'),
        password: document.getElementById('nu-pass').value,
        role: val('nu-role'),
        email_verified: true
    };
    if (!payload.email) { err.textContent = 'Email is required'; return; }
    // The realm requires firstName and lastName. Without them Keycloak refuses
    // every login with "Account is not fully set up", so block it here rather
    // than create an account that cannot sign in.
    if (!payload.first_name || !payload.last_name) {
        err.textContent = 'First and last name are required — the identity realm ' +
            'treats them as mandatory profile fields and a user missing either one ' +
            'cannot log in to the portals or the gateway.';
        return;
    }
    if (!payload.password || payload.password.length < 8) { err.textContent = 'Password must be at least 8 characters'; return; }

    err.textContent = 'Creating...';
    apiPost('/api/v1/identity/users', payload).then(d => {
        if (d.error) { err.textContent = d.error; return; }
        if (d.warning) { alert('User created with a warning: ' + d.warning); }
        document.getElementById('id-user-panel').innerHTML = '';
        loadIdentityStats();
        renderIdentityUsers();
    }).catch(e => { err.textContent = e.message; });
}

function toggleIdentityUser(id, enabled) {
    apiPost('/api/v1/identity/users/' + id + '/enabled', { enabled: enabled }).then(d => {
        if (d.error) { alert(d.error); return; }
        loadIdentityStats();
        renderIdentityUsers();
    }).catch(e => alert(e.message));
}

function deleteIdentityUser(id, username) {
    if (!confirm('Delete Keycloak user "' + username + '"?\n\nThis cannot be undone and the user will lose access immediately.')) return;
    apiDelete('/api/v1/identity/users/' + id).then(d => {
        if (d.error) { alert(d.error); return; }
        loadIdentityStats();
        renderIdentityUsers();
    }).catch(e => alert(e.message));
}

function promptResetPassword(id, username) {
    const pw = prompt('New password for "' + username + '" (min 8 characters):');
    if (!pw) return;
    if (pw.length < 8) { alert('Password must be at least 8 characters'); return; }
    const temp = confirm('Require the user to change this password at next login?\n\nOK = temporary, Cancel = permanent');
    apiPost('/api/v1/identity/users/' + id + '/password', { password: pw, temporary: temp }).then(d => {
        alert(d.error ? ('Error: ' + d.error) : 'Password updated for ' + username);
    }).catch(e => alert(e.message));
}

function showIdentityUser(id) {
    const panel = document.getElementById('id-user-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="card" style="margin-top:1rem"><p style="color:var(--muted)">Loading user...</p></div>';

    apiGet('/api/v1/identity/users/' + id).then(d => {
        if (d.error) { panel.innerHTML = '<div class="card" style="margin-top:1rem"><p style="color:var(--danger)">' + esc(d.error) + '</p></div>'; return; }
        const u = d.user || {};
        const sessions = d.sessions || [];
        const current = (u.roles && u.roles.length) ? u.roles[0] : '';
        const roleOpts = identityRoleCache.map(r =>
            '<option value="' + esc(r) + '"' + (r === current ? ' selected' : '') + '>' + esc(r) + '</option>').join('');
        const created = u.createdTimestamp ? new Date(u.createdTimestamp).toLocaleString() : 'unknown';

        const sessRows = sessions.length === 0
            ? '<p style="font-size:0.8rem;color:var(--muted)">No active sessions.</p>'
            : '<table><thead><tr><th>IP</th><th>Started</th><th>Last Access</th></tr></thead><tbody>' +
              sessions.map(s => '<tr><td>' + esc(s.ipAddress) + '</td><td>' +
                  new Date(s.start).toLocaleString() + '</td><td>' +
                  new Date(s.lastAccess).toLocaleString() + '</td></tr>').join('') +
              '</tbody></table>';

        panel.innerHTML = `
            <div class="card" style="margin-top:1rem;border-left:3px solid var(--primary)">
                <h3 style="margin-bottom:0.25rem;font-size:0.95rem">${esc(u.username)}</h3>
                <p style="font-size:0.75rem;color:var(--muted);margin-bottom:0.75rem">Keycloak ID ${esc(u.id)} &middot; created ${esc(created)}</p>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.75rem">
                    <div class="form-group"><label class="label">Email</label>
                        <input id="eu-email" value="${esc(u.email)}" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                    <div class="form-group"><label class="label">First Name</label>
                        <input id="eu-first" value="${esc(u.firstName)}" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                    <div class="form-group"><label class="label">Last Name</label>
                        <input id="eu-last" value="${esc(u.lastName)}" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                    <div class="form-group"><label class="label">Realm Role</label>
                        <select id="eu-role" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"><option value="">(none)</option>${roleOpts}</select></div>
                </div>
                <div id="eu-error" style="color:var(--danger);font-size:0.8rem;margin:0.5rem 0"></div>
                <button class="btn btn-primary" onclick="saveIdentityUser('${jsq(u.id)}')">Save Changes</button>
                <button class="btn" style="background:#e2e8f0" onclick="logoutIdentityUser('${jsq(u.id)}')">Revoke Sessions</button>
                <button class="btn" style="background:#e2e8f0" onclick="document.getElementById('id-user-panel').innerHTML=''">Close</button>
                <h4 style="margin:1rem 0 0.5rem;font-size:0.85rem">Active Sessions (${sessions.length})</h4>
                ${sessRows}
            </div>
        `;
    }).catch(e => {
        panel.innerHTML = '<div class="card" style="margin-top:1rem"><p style="color:var(--danger)">' + esc(e.message) + '</p></div>';
    });
}

function saveIdentityUser(id) {
    const err = document.getElementById('eu-error');
    const val = i => { const n = document.getElementById(i); return n ? n.value.trim() : ''; };
    const role = val('eu-role');
    err.textContent = 'Saving...';

    apiPut('/api/v1/identity/users/' + id, {
        email: val('eu-email'),
        first_name: val('eu-first'),
        last_name: val('eu-last')
    }).then(d => {
        if (d.error) { err.textContent = d.error; return null; }
        if (!role) return null;
        return apiPost('/api/v1/identity/users/' + id + '/role', { role: role });
    }).then(d => {
        if (d && d.error) { err.textContent = d.error; return; }
        err.textContent = '';
        document.getElementById('id-user-panel').innerHTML = '';
        renderIdentityUsers();
    }).catch(e => { err.textContent = e.message; });
}

function logoutIdentityUser(id) {
    if (!confirm('Revoke all sessions for this user? They will have to sign in again.')) return;
    apiPost('/api/v1/identity/users/' + id + '/logout', {}).then(d => {
        alert(d.error ? ('Error: ' + d.error) : 'All sessions revoked');
        loadIdentityStats();
        showIdentityUser(id);
    }).catch(e => alert(e.message));
}

// --- Roles tab ---
function renderIdentityRoles() {
    const body = document.getElementById('id-body');
    if (!body) return;
    body.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading roles...</p></div>';

    apiGet('/api/v1/identity/roles').then(d => {
        const roles = d.roles || [];
        const rows = roles.length === 0
            ? '<tr><td colspan="3" style="color:var(--muted)">No roles defined</td></tr>'
            : roles.map(r => '<tr><td><strong>' + esc(r.name) + '</strong></td><td>' +
                esc(r.description) + '</td><td style="white-space:nowrap">' +
                '<button class="btn btn-danger" onclick="deleteIdentityRole(\'' + jsq(r.name) + '\')">Delete</button></td></tr>').join('');

        body.innerHTML = `
            <div class="card" style="margin-bottom:1rem;display:flex;gap:0.5rem;align-items:flex-end;flex-wrap:wrap">
                <div class="form-group" style="flex:1;min-width:160px"><label class="label">Role name</label>
                    <input id="nr-name" placeholder="e.g. cert_manager" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group" style="flex:2;min-width:200px"><label class="label">Description</label>
                    <input id="nr-desc" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <button class="btn btn-primary" onclick="createIdentityRole()">Add Role</button>
            </div>
            <div class="card">
                <table><thead><tr><th>Role</th><th>Description</th><th style="width:1%">Actions</th></tr></thead><tbody>${rows}</tbody></table>
            </div>
        `;
    }).catch(e => {
        body.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load roles: ' + esc(e.message) + '</p></div>';
    });
}

function createIdentityRole() {
    const name = document.getElementById('nr-name').value.trim();
    const desc = document.getElementById('nr-desc').value.trim();
    if (!name) { alert('Role name is required'); return; }
    apiPost('/api/v1/identity/roles', { name: name, description: desc }).then(d => {
        if (d.error) { alert(d.error); return; }
        loadIdentityStats();
        renderIdentityRoles();
    }).catch(e => alert(e.message));
}

function deleteIdentityRole(name) {
    if (!confirm('Delete role "' + name + '"?\n\nUsers holding this role will lose the permissions it grants.')) return;
    apiDelete('/api/v1/identity/roles/' + encodeURIComponent(name)).then(d => {
        if (d.error) { alert(d.error); return; }
        loadIdentityStats();
        renderIdentityRoles();
    }).catch(e => alert(e.message));
}

// --- Identity Providers tab ---
function renderIdentityProviders() {
    const body = document.getElementById('id-body');
    if (!body) return;
    body.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading identity providers...</p></div>';

    apiGet('/api/v1/identity/providers').then(d => {
        const idps = d.providers || [];
        const available = d.available || {};
        const socialOpts = Object.keys(available).map(k =>
            '<option value="' + esc(k) + '">' + esc(available[k]) + '</option>').join('');

        const rows = idps.length === 0
            ? '<tr><td colspan="5" style="color:var(--muted)">No external identity providers configured</td></tr>'
            : idps.map(p => {
                const redirect = window.location.origin + '/auth/realms/clm/broker/' + p.alias + '/endpoint';
                return '<tr><td><strong>' + esc(p.displayName || p.alias) + '</strong></td>' +
                    '<td>' + esc(p.providerId) + '</td>' +
                    '<td>' + (p.enabled ? '<span class="badge badge-active">Enabled</span>' : '<span class="badge badge-disabled">Disabled</span>') + '</td>' +
                    '<td style="font-size:0.7rem;color:var(--muted);word-break:break-all">' + esc(redirect) + '</td>' +
                    '<td style="white-space:nowrap">' +
                        '<button class="btn" style="background:#e2e8f0" onclick="toggleIdentityProvider(\'' + jsq(p.alias) + '\',' + (!p.enabled) + ')">' +
                            (p.enabled ? 'Disable' : 'Enable') + '</button> ' +
                        '<button class="btn btn-danger" onclick="deleteIdentityProvider(\'' + jsq(p.alias) + '\')">Delete</button>' +
                    '</td></tr>';
            }).join('');

        body.innerHTML = renderProviderTabHTML(socialOpts, rows);
    }).catch(e => {
        body.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load providers: ' + esc(e.message) + '</p></div>';
    });
}

function renderProviderTabHTML(socialOpts, rows) {
    return `
        <div class="card" style="margin-bottom:1rem">
            <h3 style="margin-bottom:0.5rem;font-size:0.95rem">Add External Identity Provider</h3>
            <p style="font-size:0.78rem;color:var(--muted);margin-bottom:0.75rem">
                Register the redirect URI shown in the table below with the provider before enabling it.
            </p>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.75rem">
                <div class="form-group"><label class="label">Provider</label>
                    <select id="np-type" onchange="toggleOIDCFields()" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem">
                        ${socialOpts}<option value="oidc">Generic OIDC</option></select></div>
                <div class="form-group"><label class="label">Client ID *</label>
                    <input id="np-cid" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label class="label">Client Secret *</label>
                    <input id="np-secret" type="password" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div id="np-oidc" class="hidden" style="display:none;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.75rem;margin-top:0.75rem">
                <div class="form-group"><label class="label">Alias *</label>
                    <input id="np-alias" placeholder="corp-sso" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label class="label">Display Name</label>
                    <input id="np-name" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label class="label">Authorization URL *</label>
                    <input id="np-auth" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label class="label">Token URL *</label>
                    <input id="np-token" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label class="label">UserInfo URL</label>
                    <input id="np-userinfo" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                <div class="form-group"><label class="label">Issuer</label>
                    <input id="np-issuer" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            </div>
            <div id="np-error" style="color:var(--danger);font-size:0.8rem;margin:0.5rem 0"></div>
            <button class="btn btn-primary" onclick="createIdentityProvider()">Add Provider</button>
        </div>
        <div class="card">
            <table><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Redirect URI</th><th style="width:1%">Actions</th></tr></thead>
            <tbody>${rows}</tbody></table>
        </div>
    `;
}

function toggleOIDCFields() {
    const type = document.getElementById('np-type').value;
    const box = document.getElementById('np-oidc');
    if (!box) return;
    box.style.display = (type === 'oidc') ? 'grid' : 'none';
}

function createIdentityProvider() {
    const err = document.getElementById('np-error');
    const val = i => { const n = document.getElementById(i); return n ? n.value.trim() : ''; };
    const type = val('np-type');

    const payload = {
        type: type,
        client_id: val('np-cid'),
        client_secret: val('np-secret')
    };
    if (!payload.client_id || !payload.client_secret) {
        err.textContent = 'Client ID and Client Secret are required';
        return;
    }
    if (type === 'oidc') {
        payload.alias = val('np-alias');
        payload.display_name = val('np-name');
        payload.authorization_url = val('np-auth');
        payload.token_url = val('np-token');
        payload.user_info_url = val('np-userinfo');
        payload.issuer = val('np-issuer');
        if (!payload.alias || !payload.authorization_url || !payload.token_url) {
            err.textContent = 'Alias, Authorization URL and Token URL are required for generic OIDC';
            return;
        }
    }

    err.textContent = 'Creating...';
    apiPost('/api/v1/identity/providers', payload).then(d => {
        if (d.error) { err.textContent = d.error; return; }
        alert('Provider added.\n\nRegister this redirect URI with the provider:\n' +
              window.location.origin + d.redirect_uri);
        loadIdentityStats();
        renderIdentityProviders();
    }).catch(e => { err.textContent = e.message; });
}

function toggleIdentityProvider(alias, enabled) {
    apiPut('/api/v1/identity/providers/' + encodeURIComponent(alias), { enabled: enabled }).then(d => {
        if (d.error) { alert(d.error); return; }
        renderIdentityProviders();
    }).catch(e => alert(e.message));
}

function deleteIdentityProvider(alias) {
    if (!confirm('Delete identity provider "' + alias + '"?\n\nUsers who sign in through it will lose access.')) return;
    apiDelete('/api/v1/identity/providers/' + encodeURIComponent(alias)).then(d => {
        if (d.error) { alert(d.error); return; }
        loadIdentityStats();
        renderIdentityProviders();
    }).catch(e => alert(e.message));
}

// --- Sessions tab ---
function renderIdentitySessions() {
    const body = document.getElementById('id-body');
    if (!body) return;
    body.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading sessions...</p></div>';

    apiGet('/api/v1/identity/sessions').then(d => {
        const sessions = d.sessions || [];
        const rows = sessions.length === 0
            ? '<tr><td colspan="5" style="color:var(--muted)">No active sessions</td></tr>'
            : sessions.map(s => {
                const clients = s.clients ? Object.keys(s.clients).map(k => s.clients[k]).join(', ') : '';
                return '<tr><td><strong>' + esc(s.username) + '</strong></td>' +
                    '<td>' + esc(s.ipAddress) + '</td>' +
                    '<td>' + esc(clients) + '</td>' +
                    '<td>' + new Date(s.lastAccess).toLocaleString() + '</td>' +
                    '<td><button class="btn btn-danger" onclick="revokeIdentitySession(\'' + jsq(s.id) + '\')">Revoke</button></td></tr>';
            }).join('');

        body.innerHTML = `
            <div class="card" style="margin-bottom:1rem;display:flex;justify-content:space-between;align-items:center">
                <span style="font-size:0.85rem;color:var(--muted)">${sessions.length} active session(s) across all clients</span>
                <button class="btn" style="background:#e2e8f0" onclick="renderIdentitySessions()">Refresh</button>
            </div>
            <div class="card">
                <table><thead><tr><th>User</th><th>IP Address</th><th>Clients</th><th>Last Access</th><th style="width:1%">Actions</th></tr></thead>
                <tbody>${rows}</tbody></table>
            </div>
        `;
    }).catch(e => {
        body.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load sessions: ' + esc(e.message) + '</p></div>';
    });
}

function revokeIdentitySession(sid) {
    if (!confirm('Revoke this session?')) return;
    apiDelete('/api/v1/identity/sessions/' + encodeURIComponent(sid)).then(d => {
        if (d.error) { alert(d.error); return; }
        loadIdentityStats();
        renderIdentitySessions();
    }).catch(e => alert(e.message));
}

// --- Clients tab (read-only) ---
function renderIdentityClients() {
    const body = document.getElementById('id-body');
    if (!body) return;
    body.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading clients...</p></div>';

    apiGet('/api/v1/identity/clients').then(d => {
        const clients = (d.clients || []).filter(c => c.clientId && c.clientId.indexOf('realm-management') !== 0);
        const rows = clients.map(c =>
            '<tr><td><strong>' + esc(c.clientId) + '</strong></td>' +
            '<td>' + esc(c.name) + '</td>' +
            '<td>' + (c.publicClient ? 'Public' : 'Confidential') + '</td>' +
            '<td>' + (c.enabled ? '<span class="badge badge-active">Enabled</span>' : '<span class="badge badge-disabled">Disabled</span>') + '</td></tr>'
        ).join('');
        body.innerHTML = `
            <div class="card">
                <p style="font-size:0.78rem;color:var(--muted);margin-bottom:0.75rem">OIDC clients registered in the <strong>clm</strong> realm. Read-only.</p>
                <table><thead><tr><th>Client ID</th><th>Name</th><th>Type</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
            </div>
        `;
    }).catch(e => {
        body.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load clients: ' + esc(e.message) + '</p></div>';
    });
}


// ============================================================
// Organization & Tenants — merged hub
// Consolidates what were separate Organization and Tenants pages, and adds
// Subscription and Billing. Tenants/Subscription/Billing are restricted to
// platform admins; Organization is visible to everyone.
// ============================================================

let orgTab = 'organization';

const ORG_TABS = [
    ['organization', 'Organization', false],
    ['tenants', 'Tenants', true],
    ['subscription', 'Subscription', true],
    ['billing', 'Billing', true]
];

function loadOrgTenants(initialTab) {
    document.getElementById('page-title').textContent = 'Organization & Tenants';
    const el = document.getElementById('content-area');

    const visible = ORG_TABS.filter(t => !t[2] || isPlatformAdmin());
    if (initialTab && visible.some(t => t[0] === initialTab)) {
        orgTab = initialTab;
    } else if (!visible.some(t => t[0] === orgTab)) {
        orgTab = visible[0][0];
    }

    const tabs = visible.map(t =>
        '<button class="btn" id="orgtab-' + t[0] + '" onclick="switchOrgTab(\'' + t[0] + '\')" ' +
        'style="border-radius:0;background:none;color:var(--muted);border-bottom:2px solid transparent;padding:0.7rem 1.1rem">' +
        t[1] + '</button>'
    ).join('');

    el.innerHTML = `
        <div class="card" style="padding:0;margin-bottom:1rem">
            <div style="display:flex;flex-wrap:wrap;border-bottom:1px solid var(--border)">${tabs}</div>
        </div>
        <div id="org-body"><div class="card"><p style="color:var(--muted)">Loading...</p></div></div>
    `;
    switchOrgTab(orgTab);
}

function switchOrgTab(tab) {
    orgTab = tab;
    ORG_TABS.forEach(t => {
        const b = document.getElementById('orgtab-' + t[0]);
        if (!b) return;
        const on = t[0] === tab;
        b.style.color = on ? 'var(--primary)' : 'var(--muted)';
        b.style.background = on ? '#eff6ff' : 'none';
        b.style.fontWeight = on ? '700' : '600';
        b.style.borderBottom = on ? '2px solid var(--primary)' : '2px solid transparent';
    });

    if (tab === 'organization') renderOrgProfile();
    else if (tab === 'tenants') renderTenantsTab();
    else if (tab === 'subscription') renderSubscriptionTab();
    else if (tab === 'billing') renderBillingTab();
}

// panelEl returns the sub-tab panel when a hub page is showing, otherwise the
// main content area. This lets the original page loaders be reused inside the
// merged hubs without duplicating them.
function panelEl() {
    return document.getElementById('org-body') || document.getElementById('content-area');
}

function renderOrgProfile() {
    loadOrganization();
}

function renderTenantsTab() {
    if (!isPlatformAdmin()) {
        panelEl().innerHTML = '<div class="card"><p style="color:var(--muted)">' +
            'Tenant management requires the admin or super_admin role.</p></div>';
        return;
    }
    loadTenants();
}

// PLAN_LIMITS mirrors planLimits() in internal/saas/tenant/service.go. Kept in
// sync deliberately: the server rewrites a tenant's limits from its plan on
// every update, so showing anything else here would mislead.
const PLAN_LIMITS = {
    free:       { certs: 100,    gateways: 2,   users: 5 },
    pro:        { certs: 10000,  gateways: 20,  users: 50 },
    enterprise: { certs: 100000, gateways: 100, users: 500 }
};

function renderSubscriptionTab() {
    const body = panelEl();
    if (!isPlatformAdmin()) {
        body.innerHTML = '<div class="card"><p style="color:var(--muted)">Subscription requires the admin or super_admin role.</p></div>';
        return;
    }
    body.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading subscription...</p></div>';

    Promise.all([
        apiGet('/api/v1/tenants'),
        tenantApiGet('/api/v1/satellites'),
        apiGet('/api/v1/identity/status').catch(() => null)
    ]).then(([td, sd, idst]) => {
        const tenants = td.tenants || [];
        const gateways = (sd.satellites || []).length;
        const users = (idst && idst.users) || 0;

        const rows = tenants.map(t => {
            const lim = PLAN_LIMITS[t.plan] || { certs: t.max_certs, gateways: t.max_satellites, users: t.max_users };
            return '<tr>' +
                '<td><strong>' + esc(t.name) + '</strong></td>' +
                '<td><span class="badge ' + (t.plan === 'enterprise' ? 'badge-active' : 'badge-warning') + '">' + esc(t.plan) + '</span></td>' +
                '<td>' + esc(t.status) + '</td>' +
                '<td>' + usageCell(gateways, lim.gateways) + '</td>' +
                '<td>' + usageCell(users, lim.users) + '</td>' +
                '<td>0 / ' + lim.certs.toLocaleString() + '</td>' +
                '<td>' + planSelect(t) + '</td>' +
                '</tr>';
        }).join('');

        body.innerHTML = `
            <div class="card" style="border-left:3px solid var(--primary)">
                <h3 style="margin-bottom:0.4rem;font-size:0.95rem">Plan Entitlements</h3>
                <p style="font-size:0.8rem;color:var(--muted)">
                    Changing a plan rewrites the tenant's limits from the tier definition on the server.
                    Certificate counts are held by each gateway, so they read 0 here until gateway reporting is wired up.
                </p>
            </div>
            <div class="card">
                <table>
                    <thead><tr><th>Tenant</th><th>Plan</th><th>Status</th><th>Gateways</th><th>Users</th><th>Certificates</th><th>Change plan</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="7" style="color:var(--muted)">No tenants</td></tr>'}</tbody>
                </table>
            </div>
            <div class="card">
                <h4 style="font-size:0.85rem;margin-bottom:0.5rem">Tier definitions</h4>
                <table>
                    <thead><tr><th>Plan</th><th>Max certificates</th><th>Max gateways</th><th>Max users</th></tr></thead>
                    <tbody>
                        ${Object.keys(PLAN_LIMITS).map(p => '<tr><td>' + p + '</td><td>' +
                            PLAN_LIMITS[p].certs.toLocaleString() + '</td><td>' +
                            PLAN_LIMITS[p].gateways + '</td><td>' + PLAN_LIMITS[p].users + '</td></tr>').join('')}
                    </tbody>
                </table>
            </div>
        `;
    }).catch(err => {
        body.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load subscription: ' + esc(err.message) + '</p></div>';
    });
}

// usageCell shows consumption against an entitlement, flagging when it is close.
function usageCell(used, limit) {
    if (!limit) return String(used);
    const pct = Math.round((used / limit) * 100);
    const colour = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning)' : 'inherit';
    return '<span style="color:' + colour + '">' + used + ' / ' + limit + '</span>';
}

function planSelect(t) {
    const opts = Object.keys(PLAN_LIMITS).map(p =>
        '<option value="' + p + '"' + (p === t.plan ? ' selected' : '') + '>' + p + '</option>').join('');
    return '<select onchange="changeTenantPlan(\'' + jsq(t.id) + '\', this.value)" ' +
        'style="padding:0.3rem;border:1px solid var(--border);border-radius:0.25rem;font-size:0.78rem">' +
        opts + '</select>';
}

// MARKETPLACES documents the three billing integrations. None are implemented,
// so this tab states that plainly rather than rendering a fake invoice history.
const MARKETPLACES = [
    ['aws',   'AWS Marketplace',   'ResolveCustomer + BatchMeterUsage'],
    ['gcp',   'GCP Marketplace',   'Procurement API entitlements'],
    ['azure', 'Azure Marketplace', 'SaaS Fulfillment API v2 + usageEvent']
];

function renderBillingTab() {
    const body = panelEl();
    if (!isPlatformAdmin()) {
        body.innerHTML = '<div class="card"><p style="color:var(--muted)">Billing requires the admin or super_admin role.</p></div>';
        return;
    }

    const mkRows = MARKETPLACES.map(m =>
        '<tr>' +
            '<td><strong>' + m[1] + '</strong></td>' +
            '<td style="font-size:0.75rem;color:var(--muted)">' + m[2] + '</td>' +
            '<td><span class="badge badge-warning">Not configured</span></td>' +
            '<td><button class="btn" style="background:#e2e8f0" onclick="marketplaceInfo(\'' + m[0] + '\')">Details</button></td>' +
        '</tr>'
    ).join('');

    body.innerHTML = `
        <div class="card" style="border-left:3px solid var(--warning)">
            <h3 style="margin-bottom:0.4rem;font-size:0.95rem">Billing is not yet active</h3>
            <p style="font-size:0.8rem;color:var(--muted)">
                No billing account or marketplace subscription is connected, so no charges are being
                calculated or metered. Tenants currently run on plan entitlements only, enforced by the
                server's tier definitions. This page will show invoices and metered usage once a
                billing mode is configured.
            </p>
        </div>

        <div class="card">
            <h4 style="font-size:0.85rem;margin-bottom:0.5rem">Billing mode</h4>
            <table>
                <thead><tr><th>Mode</th><th>How it works</th><th>Status</th></tr></thead>
                <tbody>
                    <tr>
                        <td><strong>Direct</strong></td>
                        <td style="font-size:0.78rem;color:var(--muted)">Plan-based flat rate, entitlements capped by the tier definition</td>
                        <td><span class="badge badge-active">Active (entitlements only, no charging)</span></td>
                    </tr>
                    <tr>
                        <td><strong>Cloud marketplace</strong></td>
                        <td style="font-size:0.78rem;color:var(--muted)">Customer pays through their existing cloud commitment; the marketplace is the source of truth for plan tier</td>
                        <td><span class="badge badge-warning">Not configured</span></td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div class="card">
            <h4 style="font-size:0.85rem;margin-bottom:0.5rem">Marketplace integrations</h4>
            <table>
                <thead><tr><th>Marketplace</th><th>Binding + metering</th><th>Status</th><th></th></tr></thead>
                <tbody>${mkRows}</tbody>
            </table>
        </div>
    `;
}

function marketplaceInfo(which) {
    const detail = {
        aws: 'AWS Marketplace\n\n' +
             '1. Customer subscribes to the CLM listing.\n' +
             '2. AWS redirects to the CLM landing page with a registration token.\n' +
             '3. ResolveCustomer exchanges it for CustomerIdentifier + ProductCode.\n' +
             '4. Those are stored against the tenant and the plan is set from the offer.\n' +
             '5. Usage is reported with BatchMeterUsage.\n\n' +
             'Requires: a published SaaS listing and an IAM role for the metering API.',
        gcp: 'GCP Marketplace\n\n' +
             '1. Customer subscribes via Google Cloud Marketplace.\n' +
             '2. An Entitlement is created in the Procurement API and must be approved.\n' +
             '3. The entitlement is bound to the tenant and the plan set from the offer.\n' +
             '4. Usage is reported through Cloud Billing / Service Control.\n\n' +
             'Requires: a Marketplace-integrated project and a Pub/Sub topic for entitlement events.',
        azure: 'Azure Marketplace\n\n' +
             '1. Customer subscribes to the SaaS offer.\n' +
             '2. Azure posts a token to the CLM landing page.\n' +
             '3. SaaS Fulfillment API v2 resolves it to a subscription id, then activates it.\n' +
             '4. Usage is reported with Metering Service usageEvent on custom dimensions.\n\n' +
             'Requires: a published SaaS offer and an Entra app registration for fulfillment.'
    };
    alert((detail[which] || 'Unknown marketplace') +
          '\n\nNote: plan changes for marketplace-billed tenants must originate in the marketplace, ' +
          'otherwise metering bills against the wrong tier.');
}


// --- Identity Management: Groups tab ---
// Local Keycloak realm groups. A group carries one realm role and its members
// inherit it, so access can be managed by team rather than per user.

function renderIdentityGroups() {
    const body = document.getElementById('id-body');
    if (!body) return;
    body.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading groups...</p></div>';

    Promise.all([
        apiGet('/api/v1/identity/groups'),
        apiGet('/api/v1/identity/roles')
    ]).then(([gd, rd]) => {
        identityRoleCache = (rd.roles || []).map(r => r.name).sort();
        const groups = gd.groups || [];

        const rows = groups.length === 0
            ? '<tr><td colspan="4" style="color:var(--muted)">No groups defined</td></tr>'
            : groups.map(g => identityGroupRow(g)).join('');

        const roleOpts = identityRoleCache.map(r =>
            '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('');

        body.innerHTML = `
            <div class="card" style="margin-bottom:1rem">
                <h3 style="margin-bottom:0.4rem;font-size:0.95rem">Create Group</h3>
                <p style="font-size:0.78rem;color:var(--muted);margin-bottom:0.75rem">
                    Members inherit the group's realm role. A user's directly-assigned role still applies
                    in addition to anything inherited here.
                </p>
                <div style="display:flex;gap:0.5rem;align-items:flex-end;flex-wrap:wrap">
                    <div class="form-group" style="flex:1;min-width:180px"><label class="label">Group name</label>
                        <input id="ng-name" placeholder="e.g. platform-engineering"
                               style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem"></div>
                    <div class="form-group" style="min-width:160px"><label class="label">Inherited role</label>
                        <select id="ng-role" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem">
                            <option value="">(none)</option>${roleOpts}</select></div>
                    <button class="btn btn-primary" onclick="createIdentityGroup()">Add Group</button>
                </div>
                <div id="ng-error" style="color:var(--danger);font-size:0.8rem;margin-top:0.5rem"></div>
            </div>
            <div class="card">
                <table>
                    <thead><tr><th>Group</th><th>Inherited role</th><th>Members</th><th style="width:1%">Actions</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div id="id-group-panel"></div>
        `;
    }).catch(err => {
        body.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load groups: ' + esc(err.message) + '</p></div>';
    });
}

function identityGroupRow(g) {
    const gid = jsq(g.id);
    const roleOpts = ['<option value="">(none)</option>'].concat(
        identityRoleCache.map(r =>
            '<option value="' + esc(r) + '"' + ((g.roles || []).indexOf(r) >= 0 ? ' selected' : '') + '>' + esc(r) + '</option>')
    ).join('');

    return '<tr>' +
        '<td><strong>' + esc(g.name) + '</strong></td>' +
        '<td><select onchange="setGroupRole(\'' + gid + '\', this.value)" ' +
            'style="padding:0.3rem;border:1px solid var(--border);border-radius:0.25rem;font-size:0.78rem">' +
            roleOpts + '</select></td>' +
        '<td>' + (g.members || 0) + '</td>' +
        '<td style="white-space:nowrap">' +
            '<button class="btn" style="background:#e2e8f0" onclick="showGroupMembers(\'' + gid + '\',\'' + jsq(g.name) + '\')">Members</button> ' +
            '<button class="btn btn-danger" onclick="deleteIdentityGroup(\'' + gid + '\',\'' + jsq(g.name) + '\')">Delete</button>' +
        '</td>' +
    '</tr>';
}

function createIdentityGroup() {
    const err = document.getElementById('ng-error');
    const name = document.getElementById('ng-name').value.trim();
    const role = document.getElementById('ng-role').value;
    if (!name) { err.textContent = 'Group name is required'; return; }

    err.textContent = 'Creating...';
    apiPost('/api/v1/identity/groups', { name: name, role: role }).then(d => {
        if (d.error) { err.textContent = d.error; return; }
        loadIdentityStats();
        renderIdentityGroups();
    }).catch(e => { err.textContent = e.message; });
}

function setGroupRole(gid, role) {
    apiPost('/api/v1/identity/groups/' + encodeURIComponent(gid) + '/role', { role: role }).then(d => {
        if (d.error) { alert(d.error); return; }
        renderIdentityGroups();
    }).catch(e => alert(e.message));
}

function deleteIdentityGroup(gid, name) {
    if (!confirm('Delete group "' + name + '"?\n\nMembers are not deleted, but they lose any role this group granted them.')) return;
    apiDelete('/api/v1/identity/groups/' + encodeURIComponent(gid)).then(d => {
        if (d.error) { alert(d.error); return; }
        loadIdentityStats();
        renderIdentityGroups();
    }).catch(e => alert(e.message));
}

// showGroupMembers lists members and offers the realm's users for assignment.
function showGroupMembers(gid, name) {
    const panel = document.getElementById('id-group-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="card" style="margin-top:1rem"><p style="color:var(--muted)">Loading members...</p></div>';

    Promise.all([
        apiGet('/api/v1/identity/groups/' + encodeURIComponent(gid) + '/members'),
        apiGet('/api/v1/identity/users')
    ]).then(([md, ud]) => {
        const members = md.members || [];
        const all = ud.users || [];
        const memberIds = members.map(m => m.id);
        const candidates = all.filter(u => memberIds.indexOf(u.id) < 0);

        const memberRows = members.length === 0
            ? '<tr><td colspan="3" style="color:var(--muted)">No members</td></tr>'
            : members.map(m =>
                '<tr><td>' + esc(m.username) + '</td><td>' + esc(m.email) + '</td>' +
                '<td><button class="btn btn-danger" onclick="removeFromGroup(\'' + jsq(m.id) + '\',\'' +
                    jsq(gid) + '\',\'' + jsq(name) + '\')">Remove</button></td></tr>').join('');

        const candidateOpts = candidates.map(u =>
            '<option value="' + esc(u.id) + '">' + esc(u.username) + '</option>').join('');

        panel.innerHTML = `
            <div class="card" style="margin-top:1rem;border-left:3px solid var(--primary)">
                <h3 style="margin-bottom:0.75rem;font-size:0.95rem">Members of ${esc(name)}</h3>
                <div style="display:flex;gap:0.5rem;align-items:flex-end;margin-bottom:1rem;flex-wrap:wrap">
                    <div class="form-group" style="flex:1;min-width:200px"><label class="label">Add a user</label>
                        <select id="gm-user" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem">
                            ${candidateOpts || '<option value="">(all users are already members)</option>'}</select></div>
                    <button class="btn btn-primary" onclick="addToGroup('${jsq(gid)}','${jsq(name)}')">Add to Group</button>
                    <button class="btn" style="background:#e2e8f0" onclick="document.getElementById('id-group-panel').innerHTML=''">Close</button>
                </div>
                <table>
                    <thead><tr><th>Username</th><th>Email</th><th style="width:1%">Action</th></tr></thead>
                    <tbody>${memberRows}</tbody>
                </table>
            </div>
        `;
    }).catch(e => {
        panel.innerHTML = '<div class="card" style="margin-top:1rem"><p style="color:var(--danger)">' + esc(e.message) + '</p></div>';
    });
}

function addToGroup(gid, name) {
    const sel = document.getElementById('gm-user');
    const uid = sel ? sel.value : '';
    if (!uid) { alert('No user selected.'); return; }
    apiPut('/api/v1/identity/users/' + encodeURIComponent(uid) + '/groups/' + encodeURIComponent(gid), {})
        .then(d => {
            if (d.error) { alert(d.error); return; }
            showGroupMembers(gid, name);
            renderIdentityGroups();
        }).catch(e => alert(e.message));
}

function removeFromGroup(uid, gid, name) {
    apiDelete('/api/v1/identity/users/' + encodeURIComponent(uid) + '/groups/' + encodeURIComponent(gid))
        .then(d => {
            if (d.error) { alert(d.error); return; }
            showGroupMembers(gid, name);
            renderIdentityGroups();
        }).catch(e => alert(e.message));
}

// ==============================================================================
// Enterprise Multi-Level Approvals & Governance (ARC-004)
// ==============================================================================
function loadApprovals() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid var(--primary)">
            <h3 style="margin-bottom:0.25rem">Multi-Level Approval Workflow & Segregation of Duties (ARC-004)</h3>
            <p style="color:var(--muted);font-size:0.85rem">
                All production wildcard orders, high-value commercial certificates, and elevated permissions require multi-tier authorization.
                Requesters are strictly prohibited from approving their own lifecycle actions.
            </p>
        </div>
        <div id="approvals-container"><p style="color:var(--muted)">Loading pending approvals...</p></div>
    `;

    apiGet('/api/v1/approvals/pending').then(data => {
        const container = document.getElementById('approvals-container');
        const list = data.approvals || [];
        if (!list.length) {
            container.innerHTML = '<div class="card"><p style="color:var(--muted)">No approval requests pending your review.</p></div>';
            return;
        }

        let rows = list.map(a => {
            let badgeClass = 'badge-active';
            if (a.level === 'L2') badgeClass = 'badge-warning';
            if (a.level === 'L3') badgeClass = 'badge-disabled';

            return `
                <tr>
                    <td><strong>${esc(a.id)}</strong></td>
                    <td><span class="badge ${badgeClass}" style="font-weight:700">${esc(a.level)}</span></td>
                    <td>${esc(a.request_type)}</td>
                    <td>${esc(a.requested_by_email || a.requested_by)}</td>
                    <td>${esc(a.justification)}</td>
                    <td>$${(a.estimated_cost || 0).toFixed(2)}</td>
                    <td style="font-size:0.75rem">${esc(a.comment || 'Awaiting review')}</td>
                    <td>
                        <button class="btn btn-primary" onclick="doApprove('${esc(a.id)}')">Approve</button>
                        <button class="btn btn-danger" onclick="doReject('${esc(a.id)}')">Reject</button>
                    </td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <div class="card">
                <table>
                    <thead>
                        <tr>
                            <th>Request ID</th>
                            <th>Tier Level</th>
                            <th>Type</th>
                            <th>Requester</th>
                            <th>Justification</th>
                            <th>Cost</th>
                            <th>Progress / Comment</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }).catch(e => {
        document.getElementById('approvals-container').innerHTML = `<div class="card"><p style="color:var(--danger)">${esc(e.message)}</p></div>`;
    });
}

function doApprove(id) {
    apiPost(`/api/v1/approvals/${encodeURIComponent(id)}/approve`, { comment: "Approved via Admin Portal" })
        .then(res => {
            if (res.error) {
                alert("Approval Error: " + res.error);
            } else {
                alert("Decision recorded: " + (res.message || "Approved"));
                loadApprovals();
            }
        }).catch(e => alert(e.message));
}

function doReject(id) {
    const reason = prompt("Enter rejection reason:");
    if (!reason) return;
    apiPost(`/api/v1/approvals/${encodeURIComponent(id)}/reject`, { comment: reason })
        .then(res => {
            alert("Request rejected.");
            loadApprovals();
        }).catch(e => alert(e.message));
}

// ==============================================================================
// Enterprise Customer / Tenant Onboarding (Hybrid Managed Cloud Architecture)
// ==============================================================================
function loadCustomerOnboarding() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid var(--primary)">
            <h3 style="margin-bottom:0.25rem">Enterprise Customer Onboarding (Hybrid Managed VPC)</h3>
            <p style="color:var(--muted);font-size:0.85rem">
                Onboard a new enterprise tenant into dedicated AWS VPC infrastructure. Preflights cross-account STS trust,
                enforces strict quotas, provisions initial tenant security leads, and generates primary gateway pairing tokens.
            </p>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem">
            <div class="card">
                <h4 style="margin-bottom:1rem;color:var(--text)">1. Customer Cloud Specification</h4>
                <div class="form-group">
                    <label>Organization Slug (lowercase)</label>
                    <input type="text" id="ob-slug" value="m2p-hyc-uat" placeholder="e.g. m2p-hyc-uat">
                </div>
                <div class="form-group">
                    <label>Organization Legal / Display Name</label>
                    <input type="text" id="ob-name" value="M2P Hybrid Cloud UAT" placeholder="e.g. M2P Financial Technologies">
                </div>
                <div class="form-group">
                    <label>Lead Security / Cloud Contact Email</label>
                    <input type="email" id="ob-email" value="cloud-sec@m2pfintech.com" placeholder="cloud@customer.io">
                </div>
                <div class="form-group">
                    <label>Customer AWS Account ID (12 digits)</label>
                    <input type="text" id="ob-account" value="279078306945" placeholder="e.g. 279078306945">
                </div>
                <div class="form-group">
                    <label>Primary Cloud Region</label>
                    <input type="text" id="ob-region" value="ap-south-1" placeholder="e.g. ap-south-1">
                </div>
                <div class="form-group">
                    <label>Customer VPC ID</label>
                    <input type="text" id="ob-vpc" value="vpc-00ec0a6fc7686398c" placeholder="e.g. vpc-00ec0a6fc7686398c">
                </div>
                <div class="form-group">
                    <label>Cross-Account AssumeRole ARN</label>
                    <input type="text" id="ob-role" value="arn:aws:iam::279078306945:role/CrewpeOrchestratorRole">
                </div>
                <div class="form-group">
                    <label>STS External ID</label>
                    <input type="text" id="ob-extid" value="db95ac738a746230ddda613271903536">
                </div>
                <div class="form-group">
                    <label>Plan Tier</label>
                    <select id="ob-plan" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                        <option value="enterprise" selected>Enterprise (10k certs, 50 gateways)</option>
                        <option value="fintech-sovereign">Fintech Sovereign (Unlimited, Dedicated HSM)</option>
                        <option value="growth">Growth (100 certs, 5 gateways)</option>
                        <option value="starter">Starter (5 certs, 1 gateway)</option>
                    </select>
                </div>
                <div style="margin-top:1.25rem;display:flex;gap:0.75rem">
                    <button class="btn" style="background:#475569;color:#fff" onclick="runPreflight()">Verify Preflight Contract</button>
                    <button class="btn btn-primary" onclick="runBootstrap()">Provision Customer</button>
                </div>
            </div>

            <div>
                <div class="card" id="preflight-results-card">
                    <h4 style="margin-bottom:0.75rem">2. Preflight Verification Status</h4>
                    <p style="color:var(--muted);font-size:0.85rem">Click "Verify Preflight Contract" to validate parameters against corporate security rules.</p>
                </div>
                <div class="card hidden" id="bootstrap-results-card" style="margin-top:1rem;border-color:var(--success)">
                    <h4 style="margin-bottom:0.75rem;color:var(--success)">3. Customer Provisioning Dossier</h4>
                    <div id="bootstrap-details"></div>
                </div>
            </div>
        </div>
    `;
}

function getOnboardingPayload() {
    return {
        slug: (document.getElementById('ob-slug').value || '').trim(),
        name: (document.getElementById('ob-name').value || '').trim(),
        contact_email: (document.getElementById('ob-email').value || '').trim(),
        aws_account_id: (document.getElementById('ob-account').value || '').trim(),
        region: (document.getElementById('ob-region').value || '').trim(),
        vpc_id: (document.getElementById('ob-vpc').value || '').trim(),
        cross_account_role_arn: (document.getElementById('ob-role').value || '').trim(),
        external_id: (document.getElementById('ob-extid').value || '').trim(),
        plan: document.getElementById('ob-plan').value
    };
}

function runPreflight() {
    const payload = getOnboardingPayload();
    const card = document.getElementById('preflight-results-card');
    card.innerHTML = '<p style="color:var(--muted)">Evaluating preflight rules...</p>';

    apiPost('/api/v1/onboarding/preflight', payload).then(res => {
        let checks = (res.checks || []).map(c => {
            const icon = c.passed ? '<span style="color:var(--success)">&#10004;</span>' : '<span style="color:var(--danger)">&#10008;</span>';
            return `<li style="padding:0.35rem 0;border-bottom:1px solid #f1f5f9;display:flex;justify-content:space-between">
                <span>${icon} <strong>${esc(c.name)}</strong></span>
                <span style="font-size:0.75rem;color:var(--muted)">${esc(c.message)}</span>
            </li>`;
        }).join('');

        const banner = res.valid 
            ? '<div style="background:#d1fae5;color:#065f46;padding:0.5rem;border-radius:0.375rem;margin-bottom:0.75rem;font-weight:600">All Enterprise Preflight Checks Passed! Ready to Bootstrap.</div>'
            : '<div style="background:#fee2e2;color:#991b1b;padding:0.5rem;border-radius:0.375rem;margin-bottom:0.75rem;font-weight:600">Preflight Validation Failed. Review errors below.</div>';

        card.innerHTML = `
            <h4 style="margin-bottom:0.75rem">2. Preflight Verification Status</h4>
            ${banner}
            <ul style="list-style:none;font-size:0.82rem">${checks}</ul>
        `;
    }).catch(e => {
        card.innerHTML = `<p style="color:var(--danger)">Preflight evaluation failed: ${esc(e.message)}</p>`;
    });
}

function runBootstrap() {
    const payload = getOnboardingPayload();
    const card = document.getElementById('bootstrap-results-card');
    const details = document.getElementById('bootstrap-details');
    card.classList.remove('hidden');
    details.innerHTML = '<p style="color:var(--muted)">Provisioning tenant, security leads, and gateway pairing tokens...</p>';

    apiPost('/api/v1/onboarding/bootstrap', payload).then(res => {
        if (res.error) {
            details.innerHTML = `<p style="color:var(--danger)">Bootstrap failed: ${esc(res.error)}</p>`;
            return;
        }

        details.innerHTML = `
            <div style="font-size:0.85rem">
                <p><strong>Tenant ID:</strong> <code>${esc(res.tenant_id)}</code></p>
                <p><strong>Slug:</strong> ${esc(res.slug)} | <strong>Plan:</strong> ${esc(res.plan)}</p>
                <p><strong>Initial Admin Email:</strong> ${esc(res.admin_email)}</p>
                <p><strong>Temporary Secret:</strong> <code style="background:#fef3c7;padding:0.2rem 0.4rem;border-radius:0.25rem">${esc(res.temporary_secret)}</code></p>
                <div style="margin-top:1rem">
                    <p style="font-weight:600">Primary Customer Gateway Bootstrap Command:</p>
                    <pre style="background:#0f172a;color:#38bdf8;padding:0.75rem;border-radius:0.5rem;font-size:0.75rem;overflow-x:auto;margin-top:0.35rem">${esc(res.primary_gateway.install_script)}</pre>
                </div>
            </div>
        `;
    }).catch(e => {
        details.innerHTML = `<p style="color:var(--danger)">Bootstrap error: ${esc(e.message)}</p>`;
    });
}


// ==============================================================================
// Enterprise Directory Group Mappings (AWS IAM Identity Center / SAML / OIDC)
// ==============================================================================
function loadDirectoryMappings() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid var(--primary)">
            <h3 style="margin-bottom:0.25rem">Enterprise Directory Group-to-Role Mappings</h3>
            <p style="color:var(--muted);font-size:0.85rem">
                Map incoming enterprise directory groups (AWS IAM Identity Center permission sets, Okta groups, Azure AD groups, Keycloak roles)
                directly to internal CLM tenant roles with priority-based conflict resolution and Just-In-Time role synchronization.
            </p>
        </div>

        <div style="display:grid;grid-template-columns:2fr 1fr;gap:1.5rem">
            <div class="card">
                <h4 style="margin-bottom:1rem">Active Directory Group Rules</h4>
                <div id="mappings-table-container"><p style="color:var(--muted)">Loading directory group rules...</p></div>
            </div>

            <div class="card">
                <h4 style="margin-bottom:1rem">Add Group Mapping Rule</h4>
                <div class="form-group">
                    <label>Enterprise Group Name / Claim</label>
                    <input type="text" id="map-group-name" placeholder="e.g. AWSReservedSSO_AdministratorAccess">
                </div>
                <div class="form-group">
                    <label>Target CLM Role</label>
                    <select id="map-target-role" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                        <option value="super_admin">super_admin (Full Platform Access)</option>
                        <option value="admin">admin (Tenant Administrator)</option>
                        <option value="operator">operator (SecOps / Certificates)</option>
                        <option value="auditor">auditor (Compliance & Audits)</option>
                        <option value="viewer">viewer (Read-Only)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Priority (1-100, Higher wins)</label>
                    <input type="number" id="map-priority" value="80" min="1" max="100">
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <input type="text" id="map-description" placeholder="SecOps or Cloud Admins">
                </div>
                <button class="btn btn-primary" style="width:100%;margin-top:0.5rem" onclick="saveDirectoryMapping()">Save Rule</button>
            </div>
        </div>
    `;

    renderDirectoryMappingsTable();
}

function renderDirectoryMappingsTable() {
    const tenantId = (currentUser && currentUser.tenant_id) || 'tenant-m2p-uat';
    apiGet(`/api/v1/tenants/${encodeURIComponent(tenantId)}/sso/mappings`).then(res => {
        const mappings = res.mappings || [];
        const container = document.getElementById('mappings-table-container');
        if (!container) return;

        if (mappings.length === 0) {
            container.innerHTML = '<p style="color:var(--muted)">No directory group rules configured yet. Add a rule using the form on the right.</p>';
            return;
        }

        let rows = mappings.map(m => `
            <tr>
                <td><code>${esc(m.group_name)}</code></td>
                <td><span class="badge badge-active">${esc(m.target_role)}</span></td>
                <td><strong>${esc(m.priority)}</strong></td>
                <td style="font-size:0.75rem;color:var(--muted)">${esc(m.description || '-')}</td>
                <td>
                    <button class="btn btn-danger" style="padding:0.25rem 0.5rem;font-size:0.75rem" onclick="deleteDirectoryMapping('${esc(m.id)}')">Delete</button>
                </td>
            </tr>
        `).join('');

        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Directory Group Name</th>
                        <th>Target Role</th>
                        <th>Priority</th>
                        <th>Description</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => {
        const container = document.getElementById('mappings-table-container');
        if (container) container.innerHTML = `<p style="color:var(--danger)">Failed to load rules: ${esc(e.message)}</p>`;
    });
}

function saveDirectoryMapping() {
    const tenantId = (currentUser && currentUser.tenant_id) || 'tenant-m2p-uat';
    const groupName = (document.getElementById('map-group-name').value || '').trim();
    const targetRole = document.getElementById('map-target-role').value;
    const priority = parseInt(document.getElementById('map-priority').value, 10) || 50;
    const description = (document.getElementById('map-description').value || '').trim();

    if (!groupName) {
        alert('Group Name is required.');
        return;
    }

    const payload = {
        group_name: groupName,
        target_role: targetRole,
        priority: priority,
        description: description
    };

    apiPost(`/api/v1/tenants/${encodeURIComponent(tenantId)}/sso/mappings`, payload).then(res => {
        alert('Directory group rule saved successfully!');
        document.getElementById('map-group-name').value = '';
        document.getElementById('map-description').value = '';
        renderDirectoryMappingsTable();
    }).catch(e => alert('Error saving rule: ' + e.message));
}

function deleteDirectoryMapping(mappingId) {
    if (!confirm('Are you sure you want to remove this directory mapping rule?')) return;
    const tenantId = (currentUser && currentUser.tenant_id) || 'tenant-m2p-uat';
    apiDelete(`/api/v1/tenants/${encodeURIComponent(tenantId)}/sso/mappings/${encodeURIComponent(mappingId)}`).then(() => {
        renderDirectoryMappingsTable();
    }).catch(e => alert('Error deleting rule: ' + e.message));
}


// ==============================================================================
// 1. Departments & Financial Cost Centers (SAP / Workday / FinOps)
// ==============================================================================
function loadDepartments() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid var(--primary)">
            <h3 style="margin-bottom:0.25rem">Corporate Departments & Financial Cost Centers</h3>
            <p style="color:var(--muted);font-size:0.85rem">
                Allocate commercial CA purchasing budgets, track month-to-date (MTD) expenditure, and enforce active certificate quotas across enterprise business units.
            </p>
        </div>

        <div style="display:grid;grid-template-columns:2fr 1fr;gap:1.5rem">
            <div class="card">
                <h4 style="margin-bottom:1rem">Active Business Units</h4>
                <div id="departments-table-container"><p style="color:var(--muted)">Loading departments...</p></div>
            </div>

            <div class="card">
                <h4 style="margin-bottom:1rem">Add Department / Cost Center</h4>
                <div class="form-group"><label>Department Name</label><input type="text" id="dept-name" placeholder="e.g. Core Banking & Settlements"></div>
                <div class="form-group"><label>Department Code</label><input type="text" id="dept-code" placeholder="DEPT-BANK-01"></div>
                <div class="form-group"><label>Financial Cost Center</label><input type="text" id="dept-cost-center" placeholder="CC-FIN-1049"></div>
                <div class="form-group"><label>Lead Email</label><input type="email" id="dept-lead" placeholder="banking-lead@m2pfintech.com"></div>
                <div class="form-group"><label>Monthly Budget Cap (USD)</label><input type="number" id="dept-budget" value="5000"></div>
                <div class="form-group"><label>Certificate Quota</label><input type="number" id="dept-quota" value="250"></div>
                <button class="btn btn-primary" style="width:100%;margin-top:0.5rem" onclick="saveDepartment()">Create Department</button>
            </div>
        </div>
    `;

    renderDepartments();
}

function renderDepartments() {
    apiGet('/api/v1/departments').then(res => {
        const list = res.departments || [];
        const container = document.getElementById('departments-table-container');
        if (!container) return;

        if (list.length === 0) {
            container.innerHTML = '<p style="color:var(--muted)">No departments configured. Add one on the right.</p>';
            return;
        }

        let rows = list.map(d => {
            const pct = Math.min(100, Math.round(((d.spent_usd || 0) / (d.budget_usd || 1)) * 100));
            const barColor = pct > 85 ? 'var(--danger)' : pct > 60 ? 'var(--warning)' : 'var(--success)';
            return `
                <tr>
                    <td><strong>${esc(d.name)}</strong><br><small style="color:var(--muted)">${esc(d.code)} | ${esc(d.cost_center)}</small></td>
                    <td>${esc(d.lead_email)}</td>
                    <td>$${(d.spent_usd || 0).toFixed(2)} / $${(d.budget_usd || 0).toFixed(2)}
                        <div style="background:#e2e8f0;height:4px;border-radius:2px;margin-top:4px"><div style="background:${barColor};height:4px;width:${pct}%"></div></div>
                    </td>
                    <td><span class="badge badge-active">${d.cert_count || 0} / ${d.cert_quota || 250} certs</span></td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <table>
                <thead>
                    <tr><th>Department / Code</th><th>Lead</th><th>Budget Utilization (MTD)</th><th>Quota</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => {
        const container = document.getElementById('departments-table-container');
        if (container) container.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`;
    });
}

function saveDepartment() {
    const name = (document.getElementById('dept-name').value || '').trim();
    const code = (document.getElementById('dept-code').value || '').trim();
    const costCenter = (document.getElementById('dept-cost-center').value || '').trim();
    const lead = (document.getElementById('dept-lead').value || '').trim();
    const budget = parseFloat(document.getElementById('dept-budget').value) || 5000;
    const quota = parseInt(document.getElementById('dept-quota').value, 10) || 250;

    if (!name || !code) {
        alert('Department name and code are required.');
        return;
    }

    apiPost('/api/v1/departments', {
        name: name,
        code: code,
        cost_center: costCenter,
        lead_email: lead,
        budget_usd: budget,
        cert_quota: quota
    }).then(res => {
        alert('Department created successfully!');
        document.getElementById('dept-name').value = '';
        document.getElementById('dept-code').value = '';
        renderDepartments();
    }).catch(e => alert('Error: ' + e.message));
}

// ==============================================================================
// 2. ITSM Incidents & Service Requests (ServiceNow / ITIL)
// ==============================================================================
function loadITSMWarRoom() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid var(--danger)">
            <h3 style="margin-bottom:0.25rem">ITSM Incidents & Service Request War Room</h3>
            <p style="color:var(--muted);font-size:0.85rem">
                Real-time incident response and ITIL service requests for TLS certificate expirations, chain failures, and emergency rotation workflows.
            </p>
        </div>

        <div style="display:flex;gap:1rem;margin-bottom:1rem">
            <button class="btn btn-primary" onclick="showITSMTab('incidents')">Active Incidents</button>
            <button class="btn" style="background:#475569;color:#fff" onclick="showITSMTab('requests')">Service Catalog Requests</button>
        </div>

        <div id="itsm-content-container"></div>
    `;

    showITSMTab('incidents');
}

function showITSMTab(tab) {
    const container = document.getElementById('itsm-content-container');
    if (!container) return;

    if (tab === 'incidents') {
        container.innerHTML = `
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                    <h4>Security & Availability Incidents (SEV-1 to SEV-4)</h4>
                    <button class="btn btn-danger" onclick="promptRaiseIncident()">+ Declare Emergency Incident</button>
                </div>
                <div id="itsm-incidents-table"><p style="color:var(--muted)">Loading incidents...</p></div>
            </div>
        `;
        renderIncidents();
    } else {
        container.innerHTML = `
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                    <h4>Self-Service Certificate Catalog Requests</h4>
                    <button class="btn btn-primary" onclick="promptServiceRequest()">+ New Certificate Order Request</button>
                </div>
                <div id="itsm-requests-table"><p style="color:var(--muted)">Loading service requests...</p></div>
            </div>
        `;
        renderServiceRequests();
    }
}

function renderIncidents() {
    apiGet('/api/v1/itsm/incidents').then(res => {
        const list = res.incidents || [];
        const table = document.getElementById('itsm-incidents-table');
        if (!table) return;

        if (list.length === 0) {
            table.innerHTML = '<p style="color:var(--success)">No active incidents. Estate TLS health is normal.</p>';
            return;
        }

        let rows = list.map(inc => {
            const sevBadge = inc.severity === 'SEV1' ? 'badge-danger' : inc.severity === 'SEV2' ? 'badge-warning' : 'badge-active';
            const statusBadge = inc.status === 'resolved' ? 'badge-active' : 'badge-danger';
            return `
                <tr>
                    <td><code>${esc(inc.itsm_external_ref || inc.id)}</code></td>
                    <td><span class="badge ${sevBadge}">${esc(inc.severity)}</span></td>
                    <td><strong>${esc(inc.title)}</strong><br><small style="color:var(--muted)">Domain: ${esc(inc.affected_domain)}</small></td>
                    <td><span class="badge badge-warning">Blast Radius: ${inc.blast_radius_score}/100</span></td>
                    <td><span class="badge ${statusBadge}">${esc(inc.status)}</span></td>
                    <td>
                        ${inc.status !== 'resolved' ? `<button class="btn btn-primary" style="padding:0.25rem 0.5rem;font-size:0.75rem" onclick="resolveIncident('${esc(inc.id)}')">Resolve</button>` : '<small style="color:var(--muted)">Resolved</small>'}
                    </td>
                </tr>
            `;
        }).join('');

        table.innerHTML = `
            <table>
                <thead><tr><th>Ticket ID</th><th>Severity</th><th>Incident Summary</th><th>Blast Radius</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => {
        const table = document.getElementById('itsm-incidents-table');
        if (table) table.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`;
    });
}

function promptRaiseIncident() {
    const title = prompt('Enter Incident Summary:');
    if (!title) return;
    const domain = prompt('Enter Affected Domain Name:');
    if (!domain) return;
    const sev = prompt('Severity (SEV1, SEV2, SEV3, SEV4):', 'SEV1');

    apiPost('/api/v1/itsm/incidents', {
        title: title,
        affected_domain: domain,
        severity: sev.toUpperCase()
    }).then(() => {
        alert('Emergency incident created!');
        renderIncidents();
    }).catch(e => alert('Error: ' + e.message));
}

function resolveIncident(id) {
    const rootCause = prompt('Enter Root Cause Summary:', 'Expired token renewed');
    if (!rootCause) return;
    const remediation = prompt('Enter Remediation Actions Taken:', 'Atomic certificate rollout verified');

    apiPost(`/api/v1/itsm/incidents/${encodeURIComponent(id)}/resolve`, {
        root_cause: rootCause,
        remediation_steps: remediation
    }).then(() => {
        alert('Incident successfully resolved and closed.');
        renderIncidents();
    }).catch(e => alert('Error: ' + e.message));
}

function renderServiceRequests() {
    apiGet('/api/v1/itsm/requests').then(res => {
        const list = res.requests || [];
        const table = document.getElementById('itsm-requests-table');
        if (!table) return;

        if (list.length === 0) {
            table.innerHTML = '<p style="color:var(--muted)">No service catalog requests found.</p>';
            return;
        }

        let rows = list.map(r => `
            <tr>
                <td><code>${esc(r.itsm_ticket_ref || r.id)}</code></td>
                <td><strong>${esc(r.domain_name)}</strong></td>
                <td>${esc(r.department || 'General')}</td>
                <td><span class="badge badge-active">${esc(r.environment || 'prod')}</span></td>
                <td>${r.validity_months || 12} mos (${esc(r.cert_type || 'ov')})</td>
                <td><span class="badge badge-warning">${esc(r.status)}</span></td>
            </tr>
        `).join('');

        table.innerHTML = `
            <table>
                <thead><tr><th>Request Ref</th><th>Domain</th><th>Department</th><th>Env</th><th>Type</th><th>Status</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => {
        const table = document.getElementById('itsm-requests-table');
        if (table) table.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`;
    });
}

function promptServiceRequest() {
    const domain = prompt('Enter Requested Domain Name (e.g. pay.m2pfintech.com):');
    if (!domain) return;
    const dept = prompt('Department Name:', 'Payments & Gateway');

    apiPost('/api/v1/itsm/requests', {
        domain_name: domain,
        department: dept,
        environment: 'prod',
        cert_type: 'ov',
        validity_months: 12,
        requester_email: (currentUser && currentUser.email) || 'admin@m2pfintech.com'
    }).then(() => {
        alert('Service catalog order request submitted for approval!');
        renderServiceRequests();
    }).catch(e => alert('Error: ' + e.message));
}

// ==============================================================================
// 3. Cryptographic Risk Register (Deloitte / JPMorgan Chase / PQC)
// ==============================================================================
function loadRiskRegister() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid var(--warning)">
            <h3 style="margin-bottom:0.25rem">Enterprise Cryptographic Risk Register</h3>
            <p style="color:var(--muted);font-size:0.85rem">
                Continuous quantitative assessment of cryptographic vulnerability, Post-Quantum Cryptography (PQC) readiness, single-point-of-failure (SPOF) CA risks, and wildcard blast radiuses.
            </p>
        </div>

        <div class="stats">
            <div class="card stat"><div class="value" id="risk-score" style="color:var(--warning)">-</div><div class="label">Overall Risk Index (0-100)</div></div>
            <div class="card stat"><div class="value" id="risk-rating">-</div><div class="label">Exposure Level</div></div>
            <div class="card stat"><div class="value" id="risk-pqc">-</div><div class="label">PQC Transition State</div></div>
            <div class="card stat"><div class="value" id="risk-total" style="color:var(--danger)">-</div><div class="label">Identified Vulnerabilities</div></div>
        </div>

        <div class="card">
            <h4 style="margin-bottom:1rem">Prioritized Cryptographic Risk Findings</h4>
            <div id="risk-items-table"><p style="color:var(--muted)">Evaluating cryptographic estate...</p></div>
        </div>
    `;

    apiGet('/api/v1/risk/posture').then(res => {
        document.getElementById('risk-score').textContent = res.overall_risk_score !== undefined ? res.overall_risk_score : 28;
        document.getElementById('risk-rating').textContent = res.risk_rating || 'MODERATE';
        document.getElementById('risk-pqc').innerHTML = res.pqc_transition_ready
            ? '<span style="color:var(--success)">&#10004; Quantum-Safe</span>'
            : '<span style="color:var(--warning)">Vulnerable to Shor\'s Alg</span>';
        document.getElementById('risk-total').textContent = res.total_identified_risks || 2;

        const container = document.getElementById('risk-items-table');
        const items = res.items || [];
        if (items.length === 0) {
            container.innerHTML = '<p style="color:var(--success)">No critical cryptographic risks detected.</p>';
            return;
        }

        let rows = items.map(it => {
            const sevBadge = it.severity === 'CRITICAL' ? 'badge-danger' : 'badge-warning';
            return `
                <tr>
                    <td><code>${esc(it.id)}</code></td>
                    <td><span class="badge ${sevBadge}">${esc(it.severity)}</span></td>
                    <td><strong>${esc(it.affected)}</strong><br><small style="color:var(--muted)">${esc(it.description)}</small></td>
                    <td><span class="badge badge-warning">Score: ${it.score}</span></td>
                    <td style="font-size:0.75rem;color:var(--primary)">${esc(it.remediation)}</td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <table>
                <thead><tr><th>Risk ID</th><th>Severity</th><th>Vulnerability & Impact</th><th>Risk Score</th><th>Required Mitigation</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => {
        document.getElementById('risk-items-table').innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`;
    });
}

// ==============================================================================
// 4. Enterprise Integrations & Outbound Webhooks (Stripe / Slack / ServiceNow)
// ==============================================================================
function loadIntegrations() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid var(--primary)">
            <h3 style="margin-bottom:0.25rem">Enterprise Integrations & Webhook Subscriptions</h3>
            <p style="color:var(--muted);font-size:0.85rem">
                Connect CLM event streams to corporate webhooks, ServiceNow, Slack, Microsoft Teams, and SIEM forwarders with HMAC-SHA256 non-repudiation seals.
            </p>
        </div>

        <div style="display:grid;grid-template-columns:2fr 1fr;gap:1.5rem">
            <div class="card">
                <h4 style="margin-bottom:1rem">Configured Integrations & Event Hooks</h4>
                <div id="integrations-table-container"><p style="color:var(--muted)">Loading integrations...</p></div>
            </div>

            <div class="card">
                <h4 style="margin-bottom:1rem">Register Webhook / Connector</h4>
                <div class="form-group"><label>Integration Name</label><input type="text" id="integ-name" placeholder="e.g. Corporate Slack Ops Channel"></div>
                <div class="form-group">
                    <label>Integration Type</label>
                    <select id="integ-type" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                        <option value="slack">Slack Incoming Webhook</option>
                        <option value="teams">Microsoft Teams Webhook</option>
                        <option value="servicenow">ServiceNow ITSM Connector</option>
                        <option value="webhook">Generic HTTPS Webhook</option>
                        <option value="siem">SIEM / Splunk Event Stream</option>
                    </select>
                </div>
                <div class="form-group"><label>Endpoint URL</label><input type="url" id="integ-url" placeholder="https://hooks.slack.com/services/..."></div>
                <div class="form-group"><label>Subscribed Events</label>
                    <input type="text" id="integ-events" value="incident.raised, certificate.expired, approval.pending" placeholder="comma-separated events">
                </div>
                <button class="btn btn-primary" style="width:100%;margin-top:0.5rem" onclick="saveIntegration()">Register Integration</button>
            </div>
        </div>
    `;

    renderIntegrations();
}

function renderIntegrations() {
    apiGet('/api/v1/integrations').then(res => {
        const list = res.integrations || [];
        const container = document.getElementById('integrations-table-container');
        if (!container) return;

        if (list.length === 0) {
            container.innerHTML = '<p style="color:var(--muted)">No integrations configured. Add one on the right.</p>';
            return;
        }

        let rows = list.map(sub => `
            <tr>
                <td><strong>${esc(sub.name)}</strong></td>
                <td><span class="badge badge-active">${esc(sub.type)}</span></td>
                <td><code style="font-size:0.75rem">${esc(sub.endpoint_url)}</code></td>
                <td style="font-size:0.75rem">${(sub.events || []).join(', ')}</td>
                <td>
                    <button class="btn btn-danger" style="padding:0.25rem 0.5rem;font-size:0.75rem" onclick="deleteIntegration('${esc(sub.id)}')">Delete</button>
                </td>
            </tr>
        `).join('');

        container.innerHTML = `
            <table>
                <thead><tr><th>Name</th><th>Type</th><th>Endpoint</th><th>Events</th><th>Action</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => {
        const container = document.getElementById('integrations-table-container');
        if (container) container.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`;
    });
}

function saveIntegration() {
    const name = (document.getElementById('integ-name').value || '').trim();
    const type = document.getElementById('integ-type').value;
    const url = (document.getElementById('integ-url').value || '').trim();
    const eventsStr = (document.getElementById('integ-events').value || '').trim();

    if (!name || !url) {
        alert('Name and endpoint URL are required.');
        return;
    }

    const events = eventsStr.split(',').map(s => s.trim()).filter(Boolean);

    apiPost('/api/v1/integrations', {
        name: name,
        type: type,
        endpoint_url: url,
        events: events
    }).then(() => {
        alert('Integration registered successfully!');
        document.getElementById('integ-name').value = '';
        document.getElementById('integ-url').value = '';
        renderIntegrations();
    }).catch(e => alert('Error: ' + e.message));
}

function deleteIntegration(id) {
    if (!confirm('Remove this integration?')) return;
    apiDelete('/api/v1/integrations/' + encodeURIComponent(id)).then(() => {
        renderIntegrations();
    }).catch(e => alert('Error: ' + e.message));
}


// ==============================================================================
// ENTERPRISE CONTRACT LIFECYCLE MANAGEMENT (CLM) FRONTEND SUITE
// Covers End-to-End Contract Repository, Intake & Requests, Authoring & Templates,
// Negotiation & Redlines, E-Sign & Digital PKI, Post-Execution Obligations,
// Procurement & Suppliers, Legal Ops, Financial Terms, AI Copilot, and Analytics.
// ==============================================================================

let cachedContracts = [];
let currentViewingContract = null;
let aiChatHistory = [];

// Helper modal utilities
function showModal(html) {
    let existing = document.getElementById('clm-modal-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'clm-modal-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = '<div class="modal-box">' + html + '</div>';
    overlay.onclick = (e) => {
        if (e.target === overlay) closeModal();
    };
    document.body.appendChild(overlay);
}

function closeModal() {
    let existing = document.getElementById('clm-modal-overlay');
    if (existing) existing.remove();
}

// ------------------------------------------------------------------------------
// 1. CONTRACTS REPOSITORY & LIFECYCLE MANAGEMENT
// ------------------------------------------------------------------------------
function loadContracts() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="stats" id="contracts-metrics-bar">
            <div class="card stat"><div class="value" id="cnt-m-total">...</div><div class="label">Total Contracts</div></div>
            <div class="card stat"><div class="value" style="color:var(--success)" id="cnt-m-active">...</div><div class="label">Active In-Force</div></div>
            <div class="card stat"><div class="value" style="color:#d97706" id="cnt-m-neg">...</div><div class="label">In Negotiation</div></div>
            <div class="card stat"><div class="value" style="color:var(--primary)" id="cnt-m-sig">...</div><div class="label">Ready For Signature</div></div>
            <div class="card stat"><div class="value" id="cnt-m-val">...</div><div class="label">Active Portfolio Value</div></div>
        </div>

        <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;flex-wrap:wrap;gap:0.75rem">
                <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
                    <input type="text" id="cnt-search" placeholder="Search by number, title, party..." style="padding:0.45rem 0.75rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem;min-width:240px" oninput="filterContractsTable()">
                    <select id="cnt-filter-type" style="padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" onchange="filterContractsTable()">
                        <option value="">All Contract Types</option>
                        <option value="MSA">MSA (Master Services)</option>
                        <option value="NDA">NDA (Non-Disclosure)</option>
                        <option value="SOW">SOW (Statement of Work)</option>
                        <option value="SLA">SLA (Service Level)</option>
                        <option value="Vendor">Vendor Agreement</option>
                        <option value="Customer">Customer Contract</option>
                        <option value="License">Software License</option>
                    </select>
                    <select id="cnt-filter-stage" style="padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" onchange="filterContractsTable()">
                        <option value="">All Lifecycle Stages</option>
                        <option value="intake">1. Intake</option>
                        <option value="authoring">2. Authoring</option>
                        <option value="negotiation">3. Negotiation</option>
                        <option value="approval">4. Approval</option>
                        <option value="signature">5. Signature</option>
                        <option value="post_execution">6. Post-Execution</option>
                        <option value="renewal">7. Renewal</option>
                    </select>
                    <select id="cnt-filter-dept" style="padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" onchange="filterContractsTable()">
                        <option value="">All Departments (14)</option>
                        <option value="HR">HR</option>
                        <option value="Finance">Finance</option>
                        <option value="Procurement">Procurement</option>
                        <option value="Sales">Sales</option>
                        <option value="Legal">Legal</option>
                        <option value="IT">IT</option>
                        <option value="Security">Security</option>
                        <option value="Operations">Operations</option>
                        <option value="Manufacturing">Manufacturing</option>
                        <option value="Facilities">Facilities</option>
                        <option value="Marketing">Marketing</option>
                        <option value="Compliance">Compliance</option>
                        <option value="Administration">Administration</option>
                        <option value="Executive Management">Executive Management</option>
                    </select>
                </div>
                <div style="display:flex;gap:0.5rem">
                    <button class="btn" style="background:#475569;color:#fff" onclick="exportContractsJSON()">Export JSON</button>
                    <button class="btn btn-primary" onclick="openNewContractModal()">+ New Contract</button>
                </div>
            </div>

            <div id="contracts-table-container">
                <p style="color:var(--muted);font-size:0.85rem">Loading enterprise contracts repository...</p>
            </div>
        </div>
    `;

    apiGet('/api/v1/contracts/metrics').then(m => {
        document.getElementById('cnt-m-total').textContent = m.total_contracts || 0;
        document.getElementById('cnt-m-active').textContent = m.active_contracts || 0;
        document.getElementById('cnt-m-neg').textContent = m.in_negotiation_count || 0;
        document.getElementById('cnt-m-sig').textContent = m.pending_signature_count || 0;
        document.getElementById('cnt-m-val').textContent = '$' + (m.total_active_value || 0).toLocaleString();
    }).catch(console.error);

    apiGet('/api/v1/contracts').then(res => {
        cachedContracts = res.contracts || [];
        renderContractsTable(cachedContracts);
    }).catch(e => {
        document.getElementById('contracts-table-container').innerHTML = `<p style="color:var(--danger)">Failed to load contracts: ${esc(e.message)}</p>`;
    });
}

function renderContractsTable(list) {
    const container = document.getElementById('contracts-table-container');
    if (!list || list.length === 0) {
        container.innerHTML = '<p style="color:var(--muted);padding:1rem 0">No matching contracts found.</p>';
        return;
    }

    let rows = list.map(c => {
        const stageBadge = `<span class="badge ${getStageBadgeClass(c.stage)}">${esc(c.stage || 'authoring')}</span>`;
        const statusBadge = `<span class="badge ${getStatusBadgeClass(c.status)}">${esc(c.status || 'draft')}</span>`;
        const valFormatted = c.total_value ? '$' + Number(c.total_value).toLocaleString() + ' ' + (c.currency || 'USD') : 'N/A';
        const exp = c.expiration_date ? new Date(c.expiration_date).toLocaleDateString() : 'Evergreen';
        const riskColor = c.risk_score >= 60 ? 'var(--danger)' : c.risk_score >= 35 ? '#d97706' : 'var(--success)';

        return `
            <tr>
                <td style="font-weight:600;color:var(--primary);cursor:pointer" onclick="viewContractDetails('${c.id}')">${esc(c.contract_number)}</td>
                <td>
                    <div style="font-weight:600">${esc(c.title)}</div>
                    <div style="font-size:0.75rem;color:var(--muted)">${esc(c.counterparty_name)}</div>
                </td>
                <td><span class="badge" style="background:#e2e8f0;color:#334155">${esc(c.type)}</span></td>
                <td>${stageBadge}</td>
                <td>${statusBadge}</td>
                <td style="font-weight:600">${valFormatted}</td>
                <td style="font-size:0.8rem">${exp}</td>
                <td><span style="font-weight:700;color:${riskColor}">${c.risk_score || 20}/100</span></td>
                <td>
                    <div style="display:flex;gap:0.35rem">
                        <button class="btn btn-primary" style="padding:0.25rem 0.5rem;font-size:0.75rem" onclick="viewContractDetails('${c.id}')">Manage</button>
                        <button class="btn" style="background:#6366f1;color:#fff;padding:0.25rem 0.5rem;font-size:0.75rem" onclick="quickAIAudit('${c.id}')">AI Audit</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Contract #</th>
                    <th>Title & Counterparty</th>
                    <th>Type</th>
                    <th>Stage</th>
                    <th>Status</th>
                    <th>Value</th>
                    <th>Expiration</th>
                    <th>Risk Score</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function filterContractsTable() {
    const q = (document.getElementById('cnt-search').value || '').toLowerCase();
    const typeFilter = document.getElementById('cnt-filter-type').value;
    const stageFilter = document.getElementById('cnt-filter-stage').value;
    const deptEl = document.getElementById('cnt-filter-dept');
    const deptFilter = deptEl ? deptEl.value : '';

    const filtered = cachedContracts.filter(c => {
        if (typeFilter && c.type !== typeFilter) return false;
        if (stageFilter && c.stage !== stageFilter) return false;
        if (deptFilter && c.department !== deptFilter) return false;
        if (q) {
            const match = (c.contract_number || '').toLowerCase().includes(q) ||
                          (c.title || '').toLowerCase().includes(q) ||
                          (c.counterparty_name || '').toLowerCase().includes(q);
            if (!match) return false;
        }
        return true;
    });

    renderContractsTable(filtered);
}

function getStageBadgeClass(stage) {
    switch (stage) {
        case 'intake': return 'badge-info';
        case 'authoring': return 'badge-purple';
        case 'negotiation': return 'badge-warning';
        case 'approval': return 'badge-warning';
        case 'signature': return 'badge-info';
        case 'post_execution': return 'badge-active';
        default: return 'badge-active';
    }
}

function getStatusBadgeClass(status) {
    switch (status) {
        case 'active': case 'executed': return 'badge-active';
        case 'in_negotiation': case 'review': case 'approval': return 'badge-warning';
        case 'expired': case 'terminated': return 'badge-disabled';
        default: return 'badge-info';
    }
}

function viewContractDetails(id) {
    const c = cachedContracts.find(x => x.id === id);
    if (!c) return;
    currentViewingContract = c;

    const valFormatted = c.total_value ? '$' + Number(c.total_value).toLocaleString() + ' ' + (c.currency || 'USD') : 'N/A';
    const effective = c.effective_date ? new Date(c.effective_date).toLocaleDateString() : 'Pending Execution';
    const expiration = c.expiration_date ? new Date(c.expiration_date).toLocaleDateString() : 'Evergreen';

    showModal(`
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:0.75rem">
            <div>
                <span class="badge badge-primary">${esc(c.type)}</span>
                <span class="badge ${getStageBadgeClass(c.stage)}" style="margin-left:0.5rem">${esc(c.stage)}</span>
                <span class="badge ${getStatusBadgeClass(c.status)}" style="margin-left:0.5rem">${esc(c.status)}</span>
                <h3 style="margin-top:0.4rem">${esc(c.title)}</h3>
                <p style="color:var(--muted);font-size:0.8rem">Contract Number: <strong>${esc(c.contract_number)}</strong> | Counterparty: <strong>${esc(c.counterparty_name)}</strong></p>
            </div>
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Close</button>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;font-size:0.85rem">
            <div class="card" style="margin:0;padding:0.75rem;background:#f8fafc">
                <div><strong>Effective Date:</strong> ${effective}</div>
                <div><strong>Expiration Date:</strong> ${expiration}</div>
                <div><strong>Renewal Type:</strong> ${esc(c.renewal_type || 'manual')}</div>
                <div><strong>Notice Period:</strong> ${c.notice_period_days || 30} days</div>
            </div>
            <div class="card" style="margin:0;padding:0.75rem;background:#f8fafc">
                <div><strong>Total Value:</strong> ${valFormatted}</div>
                <div><strong>Payment Terms:</strong> ${esc(c.payment_terms || 'Net 30')}</div>
                <div><strong>Governing Law:</strong> State of Delaware, USA</div>
                <div><strong>Risk Rating:</strong> ${c.risk_score || 20}/100 (${esc(c.compliance_status || 'compliant')})</div>
            </div>
        </div>

        <div style="margin-bottom:1rem">
            <h4 style="font-size:0.9rem;margin-bottom:0.4rem">Contract Agreement Text & Clauses (v${c.current_version || 1})</h4>
            <div style="background:#f1f5f9;border:1px solid var(--border);border-radius:0.375rem;padding:0.75rem;font-family:monospace;font-size:0.8rem;white-space:pre-wrap;max-height:160px;overflow-y:auto">
${esc(c.content_body || 'No document body content loaded.')}
            </div>
        </div>

        <div class="card" style="padding:0.75rem;background:#eff6ff;border-color:#bfdbfe;margin-bottom:1rem">
            <h4 style="font-size:0.85rem;color:#1e40af;margin-bottom:0.4rem">Lifecycle State Machine Actions</h4>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
                <button class="btn btn-primary" onclick="transitionCurrentContract('authoring', 'draft')">Advance to Authoring</button>
                <button class="btn" style="background:#8b5cf6;color:#fff" onclick="transitionCurrentContract('negotiation', 'in_negotiation')">Move to Negotiation</button>
                <button class="btn" style="background:#f59e0b;color:#fff" onclick="transitionCurrentContract('approval', 'approval')">Submit for L1-L3 Approval</button>
                <button class="btn" style="background:#0284c7;color:#fff" onclick="transitionCurrentContract('signature', 'ready_for_signature')">Ready for E-Signature</button>
                <button class="btn" style="background:var(--success);color:#fff" onclick="transitionCurrentContract('post_execution', 'active')">Execute & Activate</button>
                <button class="btn btn-danger" onclick="transitionCurrentContract('archival', 'terminated')">Terminate Contract</button>
            </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="display:flex;gap:0.5rem">
                <button class="btn" style="background:#475569;color:#fff" onclick="closeModal();navigate('contract-negotiations')">Go to Redlines</button>
                <button class="btn" style="background:#475569;color:#fff" onclick="closeModal();navigate('contract-signatures')">E-Signature Room</button>
                <button class="btn" style="background:#475569;color:#fff" onclick="closeModal();navigate('contract-obligations')">View Obligations</button>
            </div>
            <button class="btn btn-primary" onclick="closeModal();quickAIAudit('${c.id}')">Run AI Legal Intelligence</button>
        </div>
    `);
}

function transitionCurrentContract(targetStage, targetStatus) {
    if (!currentViewingContract) return;
    apiPost('/api/v1/contracts/' + currentViewingContract.id + '/transition', {
        target_stage: targetStage,
        target_status: targetStatus
    }).then(() => {
        alert('Contract transitioned to stage: ' + targetStage + ' (' + targetStatus + ')');
        closeModal();
        loadContracts();
    }).catch(e => alert('Transition failed: ' + e.message));
}

function openNewContractModal() {
    showModal(`
        <h3>Draft New Enterprise Contract</h3>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Initialize a legal agreement record within the multi-tenant repository.</p>
        
        <div class="form-group"><label>Contract Title</label><input type="text" id="new-cnt-title" placeholder="e.g. Master Cloud Hosting & SLA Agreement"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group"><label>Contract Type</label>
                <select id="new-cnt-type" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="MSA">MSA (Master Services)</option>
                    <option value="NDA">NDA (Non-Disclosure)</option>
                    <option value="SOW">SOW (Statement of Work)</option>
                    <option value="SLA">SLA (Service Level)</option>
                    <option value="Vendor">Vendor Contract</option>
                    <option value="Customer">Customer Contract</option>
                    <option value="License">Software License</option>
                </select>
            </div>
            <div class="form-group"><label>Counterparty Legal Name</label><input type="text" id="new-cnt-party" placeholder="e.g. Acme Global Services Ltd"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group"><label>Total Contract Value (USD)</label><input type="number" id="new-cnt-val" placeholder="50000"></div>
            <div class="form-group"><label>Renewal Type</label>
                <select id="new-cnt-renewal" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="auto_renewal">Auto-Renewal (Annual)</option>
                    <option value="manual">Manual Renewal Required</option>
                    <option value="evergreen">Evergreen Agreement</option>
                </select>
            </div>
        </div>
        <div class="form-group"><label>Agreement Content / Initial Terms</label>
            <textarea id="new-cnt-content" rows="4" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-family:monospace;font-size:0.8rem">This Enterprise Agreement is entered into by and between the parties for professional cloud services and continuous SLA maintenance.</textarea>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitNewContract()">Create Agreement</button>
        </div>
    `);
}

function submitNewContract() {
    const title = (document.getElementById('new-cnt-title').value || '').trim();
    const type = document.getElementById('new-cnt-type').value;
    const party = (document.getElementById('new-cnt-party').value || '').trim();
    const val = Number(document.getElementById('new-cnt-val').value) || 0;
    const renewal = document.getElementById('new-cnt-renewal').value;
    const content = document.getElementById('new-cnt-content').value || '';

    if (!title || !party) {
        alert('Contract Title and Counterparty Name are mandatory.');
        return;
    }

    apiPost('/api/v1/contracts', {
        title: title,
        type: type,
        counterparty_name: party,
        total_value: val,
        renewal_type: renewal,
        content_body: content,
        stage: 'authoring',
        status: 'draft'
    }).then(res => {
        alert('Contract ' + res.contract.contract_number + ' created successfully!');
        closeModal();
        loadContracts();
    }).catch(e => alert('Failed to create contract: ' + e.message));
}

function exportContractsJSON() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(cachedContracts, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", "clm_contracts_repository_export.json");
    dlAnchorElem.click();
}

function downloadCLMAuditPDF() {
    const a = document.createElement('a');
    a.href = API + '/api/v1/clm-reports/export?format=pdf';
    a.download = 'clm_audit_report.pdf';
    a.click();
}

// ------------------------------------------------------------------------------
// 2. INTAKE & REQUEST MANAGEMENT
// ------------------------------------------------------------------------------
function loadContractRequests() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">Contract Intake & Self-Service Request Portal</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Submit, triage, validate, and convert business contract requests into legal drafting workflows.</p>
                </div>
                <button class="btn btn-primary" onclick="openNewRequestModal()">+ Submit Contract Request</button>
            </div>
        </div>

        <div class="card">
            <div id="requests-table-container">
                <p style="color:var(--muted);font-size:0.85rem">Loading request queue...</p>
            </div>
        </div>
    `;

    apiGet('/api/v1/contract-requests').then(res => {
        const list = res.requests || [];
        const container = document.getElementById('requests-table-container');
        if (list.length === 0) {
            container.innerHTML = '<p style="color:var(--muted);padding:1rem 0">No pending contract intake requests.</p>';
            return;
        }

        let rows = list.map(r => {
            const urgencyBadge = r.urgency === 'high' || r.urgency === 'critical' ? 'badge-danger' : 'badge-warning';
            return `
                <tr>
                    <td style="font-weight:600;color:var(--primary)">${esc(r.request_number)}</td>
                    <td>
                        <div style="font-weight:600">${esc(r.title)}</div>
                        <div style="font-size:0.75rem;color:var(--muted)">${esc(r.counterparty_name)} | Est: $${Number(r.estimated_value || 0).toLocaleString()}</div>
                    </td>
                    <td><span class="badge" style="background:#e2e8f0;color:#334155">${esc(r.contract_type)}</span></td>
                    <td><span class="badge ${urgencyBadge}">${esc(r.urgency || 'medium')}</span></td>
                    <td>${esc(r.department || 'Operations')}</td>
                    <td><span class="badge badge-info">${esc(r.status || 'submitted')}</span></td>
                    <td>
                        <div style="display:flex;gap:0.35rem">
                            <button class="btn btn-primary" style="padding:0.25rem 0.5rem;font-size:0.75rem" onclick="convertRequestToContract('${r.id}')">Convert to Contract</button>
                            <button class="btn" style="background:#cbd5e1;padding:0.25rem 0.5rem;font-size:0.75rem" onclick="alert('Business Justification: ' + '${esc(r.business_justification || 'Standard contract request.')}')">View Details</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Request #</th>
                        <th>Title & Counterparty</th>
                        <th>Type</th>
                        <th>Urgency</th>
                        <th>Department</th>
                        <th>Status</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => {
        document.getElementById('requests-table-container').innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`;
    });
}

function openNewRequestModal() {
    showModal(`
        <h3>Submit Business Contract Request</h3>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Initiate intake with SLA tracking and automated legal triage.</p>
        
        <div class="form-group"><label>Contract Project Title</label><input type="text" id="req-title" placeholder="e.g. Global Payments Rail Partner Agreement"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group"><label>Contract Type</label>
                <select id="req-type" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="MSA">MSA</option>
                    <option value="NDA">NDA</option>
                    <option value="SOW">SOW</option>
                    <option value="SLA">SLA</option>
                    <option value="Vendor">Vendor</option>
                </select>
            </div>
            <div class="form-group"><label>Counterparty Name</label><input type="text" id="req-party" placeholder="Counterparty Corp"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group"><label>Estimated Contract Value (USD)</label><input type="number" id="req-val" placeholder="75000"></div>
            <div class="form-group"><label>Urgency Level</label>
                <select id="req-urgency" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="medium">Medium (Standard SLA)</option>
                    <option value="high">High (48hr Turnaround)</option>
                    <option value="critical">Critical (24hr Urgent)</option>
                </select>
            </div>
        </div>
        <div class="form-group"><label>Business Justification & Scope</label>
            <textarea id="req-justification" rows="3" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" placeholder="Provide business goals, key deliverables, and commercial rationale..."></textarea>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitContractRequest()">Submit Request</button>
        </div>
    `);
}

function submitContractRequest() {
    const title = (document.getElementById('req-title').value || '').trim();
    const type = document.getElementById('req-type').value;
    const party = (document.getElementById('req-party').value || '').trim();
    const val = Number(document.getElementById('req-val').value) || 0;
    const urgency = document.getElementById('req-urgency').value;
    const just = (document.getElementById('req-justification').value || '').trim();

    if (!title || !party) {
        alert('Title and Counterparty are required.');
        return;
    }

    apiPost('/api/v1/contract-requests', {
        title: title,
        contract_type: type,
        counterparty_name: party,
        estimated_value: val,
        urgency: urgency,
        business_justification: just
    }).then(res => {
        alert('Request ' + res.request.request_number + ' submitted for legal triage!');
        closeModal();
        loadContractRequests();
    }).catch(e => alert('Failed to submit: ' + e.message));
}

function convertRequestToContract(reqId) {
    if (!confirm('Convert this intake request into an authoring contract record?')) return;
    apiPost('/api/v1/contract-requests/' + reqId + '/convert', {}).then(res => {
        alert('Successfully converted to Contract ' + res.contract.contract_number + '!');
        loadContracts();
    }).catch(e => alert('Conversion failed: ' + e.message));
}

// ------------------------------------------------------------------------------
// 3. TEMPLATES & DYNAMIC CLAUSE LIBRARY
// ------------------------------------------------------------------------------
let activeTemplateTab = 'templates';

function loadContractTemplates() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">Contract Templates & Pre-Approved Clause Library</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Standardized legal language, fallback alternatives, and automated document assembly.</p>
                </div>
                <div style="display:flex;gap:0.5rem">
                    <button class="tab-btn active" id="btn-tpl-tab" onclick="switchTemplateTab('templates')">Templates Catalog</button>
                    <button class="tab-btn" id="btn-cls-tab" onclick="switchTemplateTab('clauses')">Clause Library & Fallbacks</button>
                    <button class="tab-btn" id="btn-asm-tab" onclick="switchTemplateTab('assembly')">Document Assembly Studio</button>
                </div>
            </div>
        </div>

        <div id="template-content-container"></div>
    `;

    switchTemplateTab(activeTemplateTab);
}

function switchTemplateTab(tab) {
    activeTemplateTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    if (tab === 'templates') document.getElementById('btn-tpl-tab').classList.add('active');
    if (tab === 'clauses') document.getElementById('btn-cls-tab').classList.add('active');
    if (tab === 'assembly') document.getElementById('btn-asm-tab').classList.add('active');

    const container = document.getElementById('template-content-container');
    if (tab === 'templates') {
        apiGet('/api/v1/templates').then(res => {
            const list = res.templates || [];
            let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(360px, 1fr));gap:1rem">';
            list.forEach(t => {
                const vars = (t.variables || []).map(v => `<span class="badge" style="background:#e0f2fe;color:#0369a1">${esc(v)}</span>`).join(' ');
                html += `
                    <div class="card" style="margin:0;display:flex;flex-direction:column;justify-content:space-between">
                        <div>
                            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5rem">
                                <span class="badge badge-purple">${esc(t.category)}</span>
                                <span style="font-size:0.75rem;color:var(--muted)">Version ${t.version || 1}</span>
                            </div>
                            <h4 style="margin-bottom:0.4rem">${esc(t.name)}</h4>
                            <p style="color:var(--muted);font-size:0.8rem;margin-bottom:0.75rem">${esc(t.description || 'Pre-approved enterprise contract template.')}</p>
                            <div style="margin-bottom:0.75rem"><span style="font-size:0.75rem;color:var(--muted)">Variables: </span>${vars}</div>
                        </div>
                        <div style="border-top:1px solid var(--border);padding-top:0.75rem;display:flex;justify-content:flex-end;gap:0.5rem">
                            <button class="btn btn-primary" onclick="openAssembleStudio('${t.id}')">Assemble Contract</button>
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            container.innerHTML = html;
        }).catch(e => container.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`);
    } else if (tab === 'clauses') {
        apiGet('/api/v1/clauses').then(res => {
            const list = res.clauses || [];
            let rows = list.map(cl => {
                const riskBadge = cl.risk_level === 'high' ? 'badge-danger' : cl.risk_level === 'elevated' ? 'badge-warning' : 'badge-active';
                return `
                    <tr>
                        <td style="font-weight:600">${esc(cl.title)}</td>
                        <td><span class="badge" style="background:#f1f5f9;color:#334155">${esc(cl.category)}</span></td>
                        <td style="font-size:0.8rem;font-family:monospace;max-width:320px">${esc(cl.standard_text)}</td>
                        <td style="font-size:0.8rem;font-family:monospace;max-width:300px;color:#475569">${esc(cl.fallback_text || 'None defined')}</td>
                        <td><span class="badge ${riskBadge}">${esc(cl.risk_level || 'standard')}</span></td>
                        <td>${cl.is_mandatory ? '<span class="badge badge-danger">Mandatory</span>' : '<span class="badge badge-info">Optional</span>'}</td>
                    </tr>
                `;
            }).join('');

            container.innerHTML = `
                <div class="card">
                    <table>
                        <thead>
                            <tr>
                                <th>Clause Title</th>
                                <th>Category</th>
                                <th>Standard Language</th>
                                <th>Pre-Approved Fallback</th>
                                <th>Risk Profile</th>
                                <th>Enforcement</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
        }).catch(e => container.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`);
    } else if (tab === 'assembly') {
        openAssembleStudio('tpl-01');
    }
}

function openAssembleStudio(tplId) {
    const container = document.getElementById('template-content-container');
    container.innerHTML = `
        <div class="card">
            <h4 style="margin-bottom:0.5rem">Dynamic Document Assembly Engine</h4>
            <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Inject runtime party metadata and dynamic clauses to generate an authoring-ready agreement.</p>
            
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
                <div>
                    <div class="form-group"><label>Party A (Internal Entity)</label><input type="text" id="asm-partya" value="Enterprise Global Solutions Inc."></div>
                    <div class="form-group"><label>Party B (Counterparty)</label><input type="text" id="asm-partyb" value="Apex Global FinTech Ltd"></div>
                    <div class="form-group"><label>Effective Date</label><input type="date" id="asm-date" value="${new Date().toISOString().split('T')[0]}"></div>
                    <div class="form-group"><label>Total Consideration / Value</label><input type="text" id="asm-val" value="$350,000.00 USD"></div>
                    <button class="btn btn-primary" style="width:100%;margin-top:0.5rem;padding:0.6rem" onclick="generateAssembledDoc('${tplId}')">Generate Legal Document</button>
                </div>
                <div>
                    <label style="font-size:0.75rem;font-weight:600;color:var(--muted);display:block;margin-bottom:0.25rem">Assembled Contract Preview</label>
                    <textarea id="asm-output" rows="12" style="width:100%;padding:0.75rem;font-family:monospace;font-size:0.8rem;border:1px solid var(--border);border-radius:0.375rem;background:#f8fafc" placeholder="Click 'Generate Legal Document' to assemble..."></textarea>
                </div>
            </div>
        </div>
    `;
}

function generateAssembledDoc(tplId) {
    const partyA = document.getElementById('asm-partya').value;
    const partyB = document.getElementById('asm-partyb').value;
    const date = document.getElementById('asm-date').value;
    const val = document.getElementById('asm-val').value;

    apiPost('/api/v1/templates/' + tplId + '/instantiate', {
        variables: {
            PartyA: partyA,
            PartyB: partyB,
            EffectiveDate: date,
            TotalValue: val
        }
    }).then(res => {
        document.getElementById('asm-output').value = res.content_body;
    }).catch(e => alert('Assembly error: ' + e.message));
}

// ------------------------------------------------------------------------------
// 4. NEGOTIATION WORKSPACE & REDLINES
// ------------------------------------------------------------------------------
function loadContractNegotiations() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">Contract Negotiation & Redline Collaboration Workspace</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Multi-party redline management, comment tracking, round governance, and audit trails.</p>
                </div>
                <div style="display:flex;gap:0.5rem;align-items:center">
                    <span style="font-size:0.85rem;color:var(--muted)">Active Contract:</span>
                    <select id="neg-contract-select" style="padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" onchange="renderNegotiationDetails(this.value)">
                        <option value="cnt-002">CNT-2026-00914 (HyperScale Cloud - In Negotiation)</option>
                        <option value="cnt-001">CNT-2026-00892 (Apex Global FinTech - MSA)</option>
                    </select>
                </div>
            </div>
        </div>

        <div id="neg-details-container"></div>
    `;

    renderNegotiationDetails('cnt-002');
}

function renderNegotiationDetails(contractId) {
    const container = document.getElementById('neg-details-container');
    apiGet('/api/v1/negotiations/' + contractId).then(sessionRes => {
        apiGet('/api/v1/negotiations/' + contractId + '/redlines').then(redlinesRes => {
            const list = redlinesRes.redlines || [];
            let redlineRows = list.map(r => {
                const authorBadge = r.author_type === 'counterparty' ? 'badge-warning' : 'badge-info';
                const statusBadge = r.status === 'accepted' ? 'badge-active' : r.status === 'rejected' ? 'badge-danger' : 'badge-warning';

                return `
                    <tr>
                        <td style="font-weight:600">${esc(r.clause_title)}</td>
                        <td><span class="badge ${authorBadge}">${esc(r.author_name)}</span></td>
                        <td style="font-size:0.8rem;font-family:monospace;max-width:280px"><span class="diff-removed">${esc(r.original_text)}</span></td>
                        <td style="font-size:0.8rem;font-family:monospace;max-width:280px"><span class="diff-added">${esc(r.proposed_text)}</span></td>
                        <td><span class="badge ${statusBadge}">${esc(r.status)}</span></td>
                        <td>
                            <div style="display:flex;gap:0.35rem">
                                <button class="btn btn-primary" style="padding:0.25rem 0.5rem;font-size:0.75rem" onclick="resolveRedline('${contractId}', '${r.id}', 'accepted')">Accept</button>
                                <button class="btn btn-danger" style="padding:0.25rem 0.5rem;font-size:0.75rem" onclick="resolveRedline('${contractId}', '${r.id}', 'rejected')">Reject</button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');

            container.innerHTML = `
                <div class="card" style="margin-bottom:1rem;background:#f8fafc">
                    <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.85rem">
                        <div><strong>Counterparty Portal Token:</strong> <code style="background:#e2e8f0;padding:2px 6px;border-radius:4px">${esc(sessionRes.session.guest_access_token)}</code></div>
                        <div><strong>Turnaround SLA Deadline:</strong> ${new Date(sessionRes.session.deadline).toLocaleString()}</div>
                        <button class="btn btn-primary" onclick="openProposeRedlineModal('${contractId}')">+ Propose Redline</button>
                    </div>
                </div>

                <div class="card">
                    <h4 style="margin-bottom:0.75rem">Proposed Redlines & Term Modifications</h4>
                    ${list.length > 0 ? `
                        <table>
                            <thead>
                                <tr>
                                    <th>Clause</th>
                                    <th>Author</th>
                                    <th>Current Language</th>
                                    <th>Proposed Change</th>
                                    <th>Status</th>
                                    <th>Decision</th>
                                </tr>
                            </thead>
                            <tbody>${redlineRows}</tbody>
                        </table>
                    ` : '<p style="color:var(--muted)">No redlines recorded for this negotiation round.</p>'}
                </div>
            `;
        });
    }).catch(e => container.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`);
}

function resolveRedline(contractId, redlineId, decision) {
    apiPut('/api/v1/negotiations/' + contractId + '/redlines/' + redlineId + '/resolve', { decision: decision })
        .then(() => {
            alert('Redline marked as ' + decision);
            renderNegotiationDetails(contractId);
        }).catch(e => alert('Error: ' + e.message));
}

function openProposeRedlineModal(contractId) {
    showModal(`
        <h3>Propose Contract Redline</h3>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Submit structured clause redline for counterparty review.</p>
        
        <div class="form-group"><label>Clause Section Name</label><input type="text" id="red-clause" placeholder="e.g. Limitation of Liability"></div>
        <div class="form-group"><label>Original Contract Language</label><textarea id="red-orig" rows="2" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" placeholder="Existing text..."></textarea></div>
        <div class="form-group"><label>Proposed Replacement Language</label><textarea id="red-prop" rows="2" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" placeholder="New proposed text..."></textarea></div>

        <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitNewRedline('${contractId}')">Submit Redline</button>
        </div>
    `);
}

function submitNewRedline(contractId) {
    const clause = (document.getElementById('red-clause').value || '').trim();
    const orig = (document.getElementById('red-orig').value || '').trim();
    const prop = (document.getElementById('red-prop').value || '').trim();

    if (!clause || !prop) {
        alert('Clause name and proposed replacement language are required.');
        return;
    }

    apiPost('/api/v1/negotiations/' + contractId + '/redlines', {
        clause_title: clause,
        original_text: orig,
        proposed_text: prop,
        author_name: "Internal Legal Counsel",
        author_type: "internal"
    }).then(() => {
        alert('Redline proposed successfully!');
        closeModal();
        renderNegotiationDetails(contractId);
    }).catch(e => alert('Failed: ' + e.message));
}

// ------------------------------------------------------------------------------
// 5. E-SIGNATURES & DIGITAL PKI SIGNATURES
// ------------------------------------------------------------------------------
function loadContractSignatures() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">Electronic Signature & Digital PKI Execution Studio</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Compliant multi-party e-signatures, X.509 cryptographic timestamps, and tamper-evident audit sealing.</p>
                </div>
                <div style="display:flex;gap:0.5rem;align-items:center">
                    <span style="font-size:0.85rem;color:var(--muted)">Target Contract:</span>
                    <select id="sig-contract-select" style="padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" onchange="renderSignersList(this.value)">
                        <option value="cnt-003">CNT-2026-00955 (Quantex AI - MNDA)</option>
                    </select>
                </div>
            </div>
        </div>

        <div id="signers-container"></div>
    `;

    renderSignersList('cnt-003');
}

function renderSignersList(contractId) {
    const container = document.getElementById('signers-container');
    apiGet('/api/v1/signatures/' + contractId).then(res => {
        const signers = res.signers || [];
        let rows = signers.map(s => {
            const isSigned = s.status === 'signed';
            const statusBadge = isSigned ? '<span class="badge badge-active">Signed</span>' : '<span class="badge badge-warning">Awaiting Signature</span>';
            const sigDetails = isSigned ? `<div style="font-size:0.75rem;color:var(--muted);font-family:monospace">Hash: ${esc((s.digital_signature_hash || '').slice(0, 24))}...<br>IP: ${esc(s.ip_address)} | ${new Date(s.signed_at).toLocaleString()}</div>` : 'Pending';

            return `
                <tr>
                    <td style="font-weight:600">#${s.signing_order}</td>
                    <td>
                        <div style="font-weight:600">${esc(s.signer_name)}</div>
                        <div style="font-size:0.75rem;color:var(--muted)">${esc(s.signer_email)}</div>
                    </td>
                    <td>${esc(s.signer_role)}</td>
                    <td><span class="badge" style="background:#e0f2fe;color:#0369a1">${esc(s.auth_method)}</span></td>
                    <td>${statusBadge}</td>
                    <td>${sigDetails}</td>
                    <td>
                        ${!isSigned ? `<button class="btn btn-primary" style="padding:0.25rem 0.6rem;font-size:0.75rem" onclick="executeSignDialog('${contractId}', '${s.id}', '${s.signer_name}')">Sign Now</button>` : '<span style="color:var(--success);font-weight:600;font-size:0.8rem">Verified OK</span>'}
                    </td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
                    <h4>Required Signatories (Sequential Execution Order)</h4>
                    <button class="btn" style="background:#475569;color:#fff;font-size:0.8rem" onclick="viewAuditEvidence('${contractId}')">View Cryptographic Evidence Bundle</button>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Order</th>
                            <th>Signer</th>
                            <th>Title / Role</th>
                            <th>Auth Method</th>
                            <th>Status</th>
                            <th>Signature Evidence</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }).catch(e => container.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`);
}

function executeSignDialog(contractId, sigId, signerName) {
    showModal(`
        <h3>Electronic & Digital Signature Execution</h3>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Signing as <strong>${esc(signerName)}</strong> under ESIGN & eIDAS non-repudiation standards.</p>
        
        <div class="card" style="background:#f8fafc;padding:0.75rem;margin-bottom:1rem">
            <p style="font-size:0.8rem;color:#334155">"I hereby declare that I am the authorized representative with legal signatory authority to execute this enterprise contract on behalf of my organization."</p>
        </div>

        <div class="form-group"><label>Authentication & Identity Verification</label>
            <select id="sig-auth-select" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                <option value="email_otp">Verified Corporate Email OTP (10.125.4.68)</option>
                <option value="pki_certificate">X.509 Client Certificate / Smart Card</option>
                <option value="hardware_token">FIDO2 / Hardware Cryptographic Security Key</option>
            </select>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="confirmSignature('${contractId}', '${sigId}')">Execute Cryptographic Signature</button>
        </div>
    `);
}

function confirmSignature(contractId, sigId) {
    apiPost('/api/v1/signatures/' + contractId + '/sign', {
        signature_id: sigId,
        ip_address: "10.125.4.68"
    }).then(res => {
        alert('Contract successfully signed and cryptographically sealed!');
        closeModal();
        renderSignersList(contractId);
    }).catch(e => alert('Signing error: ' + e.message));
}

function viewAuditEvidence(contractId) {
    apiGet('/api/v1/signatures/' + contractId + '/evidence').then(res => {
        showModal(`
            <h3>Cryptographic Signature Evidence Certificate</h3>
            <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Legal certificate of tamper-evident non-repudiation and execution authenticity.</p>
            
            <div class="card" style="background:#f8fafc;font-size:0.85rem">
                <div><strong>Contract ID:</strong> ${esc(res.contract_id)}</div>
                <div><strong>Sealed Timestamp:</strong> ${res.sealed_at}</div>
                <div><strong>Master Document SHA-256 Digest:</strong> <code style="font-size:0.75rem">${esc(res.master_content_hash)}</code></div>
                <div><strong>Audit Seal Proof Digest:</strong> <code style="font-size:0.75rem">${esc(res.audit_seal_digest)}</code></div>
                <div style="margin-top:0.5rem"><strong>Legal Frameworks Complied:</strong>
                    <ul style="margin-left:1.25rem;margin-top:0.25rem;font-size:0.8rem">
                        ${res.compliance.map(c => '<li>' + esc(c) + '</li>').join('')}
                    </ul>
                </div>
            </div>

            <div style="display:flex;justify-content:flex-end;margin-top:1rem">
                <button class="btn btn-primary" onclick="closeModal()">Close Certificate</button>
            </div>
        `);
    }).catch(e => alert('Failed to load evidence: ' + e.message));
}

// ------------------------------------------------------------------------------
// 6. OBLIGATION CALENDAR & SLA MILESTONES
// ------------------------------------------------------------------------------
function loadContractObligations() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="stats" id="obligations-metrics-bar">
            <div class="card stat"><div class="value" id="obl-m-total">...</div><div class="label">Total Obligations</div></div>
            <div class="card stat"><div class="value" style="color:var(--success)" id="obl-m-ful">...</div><div class="label">Fulfilled Deliverables</div></div>
            <div class="card stat"><div class="value" style="color:var(--primary)" id="obl-m-prog">...</div><div class="label">In Progress</div></div>
            <div class="card stat"><div class="value" style="color:var(--danger)" id="obl-m-over">...</div><div class="label">Overdue Milestones</div></div>
            <div class="card stat"><div class="value" id="obl-m-rate">...</div><div class="label">Compliance SLA Rate</div></div>
        </div>

        <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h3 style="font-size:1rem">Post-Execution Obligation & Deliverable Calendar</h3>
                <button class="btn btn-primary" onclick="openNewObligationModal()">+ Log New Obligation</button>
            </div>
            <div id="obligations-table-container">
                <p style="color:var(--muted);font-size:0.85rem">Loading deliverables...</p>
            </div>
        </div>
    `;

    apiGet('/api/v1/obligations/summary').then(s => {
        document.getElementById('obl-m-total').textContent = s.total_obligations || 0;
        document.getElementById('obl-m-ful').textContent = s.fulfilled_count || 0;
        document.getElementById('obl-m-prog').textContent = s.in_progress_count || 0;
        document.getElementById('obl-m-over').textContent = s.overdue_count || 0;
        document.getElementById('obl-m-rate').textContent = (s.compliance_rate || 100).toFixed(1) + '%';
    }).catch(console.error);

    apiGet('/api/v1/obligations').then(res => {
        const list = res.obligations || [];
        const container = document.getElementById('obligations-table-container');
        if (list.length === 0) {
            container.innerHTML = '<p style="color:var(--muted)">No post-execution obligations found.</p>';
            return;
        }

        let rows = list.map(o => {
            const statusBadge = o.status === 'fulfilled' ? 'badge-active' : o.status === 'overdue' ? 'badge-danger' : 'badge-warning';
            return `
                <tr>
                    <td>
                        <div style="font-weight:600">${esc(o.title)}</div>
                        <div style="font-size:0.75rem;color:var(--muted)">Contract: ${esc(o.contract_id)} | Penalty: ${esc(o.penalty_details || 'None')}</div>
                    </td>
                    <td><span class="badge" style="background:#e0f2fe;color:#0369a1">${esc(o.category)}</span></td>
                    <td>${esc(o.party_responsible)}</td>
                    <td style="font-weight:600">${new Date(o.due_date).toLocaleDateString()}</td>
                    <td>${esc(o.recurrence)}</td>
                    <td><span class="badge ${statusBadge}">${esc(o.status)}</span></td>
                    <td>
                        ${o.status !== 'fulfilled' ? `<button class="btn btn-primary" style="padding:0.25rem 0.5rem;font-size:0.75rem" onclick="fulfillObligation('${o.id}')">Fulfill</button>` : '<span style="color:var(--success);font-size:0.8rem">Complete</span>'}
                    </td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Deliverable & Obligation Title</th>
                        <th>Category</th>
                        <th>Responsible Party</th>
                        <th>Due Date</th>
                        <th>Recurrence</th>
                        <th>Status</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => container.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`);
}

function fulfillObligation(oblId) {
    if (!confirm('Mark deliverable as fulfilled and verified with evidence?')) return;
    apiPost('/api/v1/obligations', { id: oblId, status: 'fulfilled' }).then(() => {
        alert('Obligation fulfilled!');
        loadContractObligations();
    }).catch(e => alert('Error: ' + e.message));
}

function openNewObligationModal() {
    showModal(`
        <h3>Record Contractual Obligation</h3>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Calendar post-execution deliverable with penalty escalation rules.</p>
        
        <div class="form-group"><label>Deliverable / Milestone Title</label><input type="text" id="new-obl-title" placeholder="e.g. Annual SOC 2 Type II Compliance Report"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group"><label>Category</label>
                <select id="new-obl-cat" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="Regulatory">Regulatory Compliance</option>
                    <option value="Operational">Operational Milestone</option>
                    <option value="Warranty">Warranty & Uptime SLA</option>
                    <option value="Financial">Financial Payment Milestone</option>
                </select>
            </div>
            <div class="form-group"><label>Party Responsible</label>
                <select id="new-obl-party" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="counterparty">Counterparty / Vendor</option>
                    <option value="internal">Internal Organization</option>
                    <option value="both">Both Parties Jointly</option>
                </select>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group"><label>Due Date</label><input type="date" id="new-obl-date" value="${new Date(Date.now() + 30*86400000).toISOString().split('T')[0]}"></div>
            <div class="form-group"><label>Recurrence</label>
                <select id="new-obl-rec" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="one_time">One-Time Deliverable</option>
                    <option value="monthly">Monthly Recurring</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="annual">Annual</option>
                </select>
            </div>
        </div>
        <div class="form-group"><label>Penalty & SLA Breach Terms</label><input type="text" id="new-obl-penalty" placeholder="e.g. 5% monthly fee credit per 15-day delay"></div>

        <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitNewObligation()">Save Obligation</button>
        </div>
    `);
}

function submitNewObligation() {
    const title = (document.getElementById('new-obl-title').value || '').trim();
    const cat = document.getElementById('new-obl-cat').value;
    const party = document.getElementById('new-obl-party').value;
    const date = document.getElementById('new-obl-date').value;
    const rec = document.getElementById('new-obl-rec').value;
    const penalty = document.getElementById('new-obl-penalty').value;

    if (!title) {
        alert('Title is required.');
        return;
    }

    apiPost('/api/v1/obligations', {
        contract_id: "cnt-001",
        title: title,
        category: cat,
        party_responsible: party,
        due_date: new Date(date).toISOString(),
        recurrence: rec,
        penalty_details: penalty
    }).then(() => {
        alert('Obligation created!');
        closeModal();
        loadContractObligations();
    }).catch(e => alert('Failed: ' + e.message));
}

// ------------------------------------------------------------------------------
// 7. CORPORATE PROCUREMENT & SUPPLIER MANAGEMENT
// ------------------------------------------------------------------------------
function loadProcurementSuppliers() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">Corporate Procurement & Supplier Agreement Governance</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Vendor prequalification, scorecards, performance evaluation, and spend monitoring.</p>
                </div>
                <button class="btn btn-primary" onclick="openNewSupplierModal()">+ Onboard Supplier</button>
            </div>
        </div>

        <div class="card">
            <div id="suppliers-table-container">
                <p style="color:var(--muted);font-size:0.85rem">Loading suppliers...</p>
            </div>
        </div>
    `;

    apiGet('/api/v1/suppliers').then(res => {
        const list = res.suppliers || [];
        const container = document.getElementById('suppliers-table-container');
        if (list.length === 0) {
            container.innerHTML = '<p style="color:var(--muted)">No suppliers registered.</p>';
            return;
        }

        let rows = list.map(s => {
            const statusBadge = s.onboarding_status === 'active' ? 'badge-active' : 'badge-warning';
            const certBadge = s.insurance_valid ? '<span style="color:var(--success);font-weight:600">✓ Valid</span>' : '<span style="color:var(--danger);font-weight:600">⚠ Expired</span>';
            return `
                <tr>
                    <td>
                        <div style="font-weight:600">${esc(s.supplier_name)}</div>
                        <div style="font-size:0.75rem;color:var(--muted)">Code: ${esc(s.supplier_code)} | Contact: ${esc(s.contact_name)}</div>
                    </td>
                    <td>${esc(s.category)}</td>
                    <td><span class="badge" style="background:#e0f2fe;color:#0369a1">${esc(s.risk_tier)}</span></td>
                    <td style="font-weight:700;color:var(--primary)">${s.performance_score}/100</td>
                    <td><span class="badge" style="background:#f3e8ff;color:#6b21a8">${esc(s.diversity_status)}</span></td>
                    <td style="font-weight:600">$${Number(s.annual_spend || 0).toLocaleString()}</td>
                    <td>${certBadge}</td>
                    <td><span class="badge ${statusBadge}">${esc(s.onboarding_status)}</span></td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Supplier Name</th>
                        <th>Category</th>
                        <th>Risk Tier</th>
                        <th>Scorecard</th>
                        <th>Diversity</th>
                        <th>Annual Spend</th>
                        <th>Insurance Cert</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => container.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`);
}

function openNewSupplierModal() {
    showModal(`
        <h3>Prequalify & Onboard Supplier</h3>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Enter vendor credentials and due-diligence parameters.</p>
        
        <div class="form-group"><label>Supplier Legal Entity Name</label><input type="text" id="sup-name" placeholder="e.g. Nexus Security Networks Ltd"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group"><label>Category</label><input type="text" id="sup-cat" placeholder="Cybersecurity Infrastructure"></div>
            <div class="form-group"><label>Risk Tier</label>
                <select id="sup-tier" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                    <option value="Tier-1">Tier-1 (Critical)</option>
                    <option value="Tier-2">Tier-2 (Operational)</option>
                    <option value="Tier-3">Tier-3 (Commodity)</option>
                </select>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group"><label>Contact Person</label><input type="text" id="sup-contact" placeholder="John Doe"></div>
            <div class="form-group"><label>Contact Email</label><input type="email" id="sup-email" placeholder="vendor@nexus.com"></div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitNewSupplier()">Register Supplier</button>
        </div>
    `);
}

function submitNewSupplier() {
    const name = (document.getElementById('sup-name').value || '').trim();
    const cat = document.getElementById('sup-cat').value;
    const tier = document.getElementById('sup-tier').value;
    const contact = document.getElementById('sup-contact').value;
    const email = document.getElementById('sup-email').value;

    if (!name) {
        alert('Name is required.');
        return;
    }

    apiPost('/api/v1/suppliers', {
        supplier_name: name,
        category: cat,
        risk_tier: tier,
        contact_name: contact,
        contact_email: email,
        insurance_valid: true
    }).then(() => {
        alert('Supplier registered!');
        closeModal();
        loadProcurementSuppliers();
    }).catch(e => alert('Failed: ' + e.message));
}

// ------------------------------------------------------------------------------
// 8. LEGAL OPERATIONS & MATTER MANAGEMENT
// ------------------------------------------------------------------------------
function loadLegalMatters() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">Legal Operations & Case Matter Governance</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Litigation holds, outside counsel spend, legal research, and regulatory advisory.</p>
                </div>
                <button class="btn btn-primary" onclick="openNewMatterModal()">+ New Legal Matter</button>
            </div>
        </div>

        <div class="card">
            <div id="matters-table-container">
                <p style="color:var(--muted);font-size:0.85rem">Loading legal matters...</p>
            </div>
        </div>
    `;

    apiGet('/api/v1/legal-matters').then(res => {
        const list = res.matters || [];
        const container = document.getElementById('matters-table-container');
        if (list.length === 0) {
            container.innerHTML = '<p style="color:var(--muted)">No legal matters logged.</p>';
            return;
        }

        let rows = list.map(m => {
            const holdBadge = m.litigation_hold_active ? '<span class="badge badge-danger">HOLD ACTIVE</span>' : '<span class="badge" style="background:#e2e8f0;color:#64748b">Inactive</span>';
            const spendPct = m.legal_budget > 0 ? Math.round((m.legal_spend / m.legal_budget) * 100) : 0;
            return `
                <tr>
                    <td style="font-weight:600;color:var(--primary)">${esc(m.matter_number)}</td>
                    <td>
                        <div style="font-weight:600">${esc(m.title)}</div>
                        <div style="font-size:0.75rem;color:var(--muted)">Outside Counsel: ${esc(m.outside_counsel_firm || 'In-House')}</div>
                    </td>
                    <td>${esc(m.case_type)}</td>
                    <td><span class="badge badge-warning">${esc(m.priority)}</span></td>
                    <td>${esc(m.lead_counsel)}</td>
                    <td>
                        <div style="font-size:0.8rem">$${Number(m.legal_spend).toLocaleString()} / $${Number(m.legal_budget).toLocaleString()} (${spendPct}%)</div>
                    </td>
                    <td>${holdBadge}</td>
                    <td>
                        <button class="btn btn-primary" style="padding:0.25rem 0.5rem;font-size:0.75rem" onclick="toggleLitigationHold('${m.id}')">Toggle Hold</button>
                    </td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Matter #</th>
                        <th>Case Title</th>
                        <th>Type</th>
                        <th>Priority</th>
                        <th>Lead Counsel</th>
                        <th>Budget & Spend</th>
                        <th>Litigation Hold</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => container.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`);
}

function toggleLitigationHold(matId) {
    apiPost('/api/v1/legal-matters/' + matId + '/toggle-hold', {}).then(() => {
        loadLegalMatters();
    }).catch(e => alert('Error: ' + e.message));
}

function openNewMatterModal() {
    showModal(`
        <h3>Log New Legal Case / Matter</h3>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Track disputes, IP filings, regulatory inquiries, or contract audits.</p>
        
        <div class="form-group"><label>Matter Title</label><input type="text" id="mat-title" placeholder="e.g. Cross-Border Tax & Settlement Injunction"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group"><label>Case Type</label><input type="text" id="mat-type" placeholder="Commercial Advisory"></div>
            <div class="form-group"><label>Lead Counsel</label><input type="text" id="mat-lead" placeholder="General Counsel"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group"><label>Legal Budget (USD)</label><input type="number" id="mat-budget" value="50000"></div>
            <div class="form-group"><label>Outside Counsel Firm</label><input type="text" id="mat-firm" placeholder="e.g. Skadden Arps LLP"></div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitNewMatter()">Log Matter</button>
        </div>
    `);
}

function submitNewMatter() {
    const title = (document.getElementById('mat-title').value || '').trim();
    const type = document.getElementById('mat-type').value;
    const lead = document.getElementById('mat-lead').value;
    const budget = Number(document.getElementById('mat-budget').value) || 50000;
    const firm = document.getElementById('mat-firm').value;

    if (!title) {
        alert('Title is required.');
        return;
    }

    apiPost('/api/v1/legal-matters', {
        title: title,
        case_type: type,
        lead_counsel: lead,
        legal_budget: budget,
        outside_counsel_firm: firm
    }).then(() => {
        alert('Matter logged successfully!');
        closeModal();
        loadLegalMatters();
    }).catch(e => alert('Failed: ' + e.message));
}

// ------------------------------------------------------------------------------
// 9. FINANCIAL & COMMERCIAL SPEND TERMS
// ------------------------------------------------------------------------------
function loadContractFinancials() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">Contract Financial Terms & Three-Way Invoice Matching</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Real-time spend verification, milestone releases, and revenue leakage detection.</p>
                </div>
                <button class="btn btn-primary" onclick="runThreeWayMatch()">Run 3-Way Match Audit</button>
            </div>
        </div>

        <div class="card">
            <div id="financials-table-container">
                <p style="color:var(--muted);font-size:0.85rem">Loading financial schedules...</p>
            </div>
        </div>
    `;

    apiGet('/api/v1/financials').then(res => {
        const list = res.financials || [];
        const container = document.getElementById('financials-table-container');
        if (list.length === 0) {
            container.innerHTML = '<p style="color:var(--muted)">No financial schedules recorded.</p>';
            return;
        }

        let rows = list.map(f => {
            const matchBadge = f.three_way_match === 'verified' ? '<span class="badge badge-active">3-Way Verified</span>' : '<span class="badge badge-warning">Unmatched</span>';
            const leakageBadge = f.leakage_risk === 'low' ? '<span style="color:var(--success);font-weight:600">Low Leakage</span>' : '<span style="color:var(--danger);font-weight:600">Review Leakage</span>';

            return `
                <tr>
                    <td style="font-weight:600">${esc(f.contract_id)}</td>
                    <td>${esc(f.pricing_model)}</td>
                    <td style="font-weight:600">$${Number(f.total_committed).toLocaleString()}</td>
                    <td style="color:var(--primary);font-weight:600">$${Number(f.billed_to_date).toLocaleString()}</td>
                    <td style="font-weight:600">$${Number(f.remaining_balance).toLocaleString()}</td>
                    <td>${matchBadge}</td>
                    <td>${leakageBadge}</td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Contract Ref</th>
                        <th>Pricing Model</th>
                        <th>Total Committed</th>
                        <th>Billed To Date</th>
                        <th>Remaining Commitment</th>
                        <th>PO / Invoice Match</th>
                        <th>Value Leakage Risk</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => container.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`);
}

function runThreeWayMatch() {
    apiPost('/api/v1/financials/three-way-match', {}).then(res => {
        showModal(`
            <h3>Three-Way Match Verification Result</h3>
            <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Automated reconciliation between Purchase Order, Contract Rates, and Inbound Invoice.</p>
            
            <div class="card" style="background:#f8fafc;font-size:0.85rem">
                <div><strong>Purchase Order ID:</strong> ${esc(res.purchase_order_id)}</div>
                <div><strong>Contract Reference:</strong> ${esc(res.contract_reference)}</div>
                <div><strong>Contract Schedule Rate:</strong> $${Number(res.contract_rate).toLocaleString()}</div>
                <div><strong>Inbound Invoice Total:</strong> $${Number(res.invoice_amount).toLocaleString()}</div>
                <div><strong>Reconciliation Variance:</strong> ${res.tolerance_percent}% (Within 0.0% Tolerance)</div>
                <div style="margin-top:0.5rem"><span class="badge badge-active" style="font-size:0.8rem">✓ THREE-WAY MATCH PASSED - APPROVED FOR TREASURY WIRE</span></div>
            </div>

            <div style="display:flex;justify-content:flex-end;margin-top:1rem">
                <button class="btn btn-primary" onclick="closeModal()">Dismiss</button>
            </div>
        `);
    }).catch(e => alert('Error running matching: ' + e.message));
}

// ------------------------------------------------------------------------------
// 10. AI CONTRACT INTELLIGENCE & LEGAL COPILOT
// ------------------------------------------------------------------------------
function loadAIContracts() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">AI Contract Intelligence & Legal Copilot</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Clause identification, risk prediction, deviation detection, and interactive contract Q&A.</p>
                </div>
                <div style="display:flex;gap:0.5rem;align-items:center">
                    <span style="font-size:0.85rem;color:var(--muted)">Target Agreement:</span>
                    <select id="ai-contract-select" style="padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem;max-width:320px" onchange="loadAIAnalysisForContract(this.value)">
                        ${(cachedContracts.length > 0 ? cachedContracts : [{id:'cnt-001', contract_number:'CNT-2026-00892', title:'Apex Global FinTech MSA'}]).map(c => `<option value="${c.id}">${esc(c.contract_number)} - ${esc(c.title.slice(0, 32))}...</option>`).join('')}
                    </select>
                    <button class="btn btn-primary" onclick="triggerAIAnalysis()">Run Full AI Audit</button>
                </div>
            </div>
        </div>

        <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:1rem">
            <div>
                <div class="card" id="ai-audit-results">
                    <p style="color:var(--muted)">Loading AI audit data...</p>
                </div>
            </div>

            <div>
                <div class="card" style="display:flex;flex-direction:column;height:540px">
                    <div style="border-bottom:1px solid var(--border);padding-bottom:0.5rem;margin-bottom:0.5rem">
                        <h4 style="font-size:0.9rem">Interactive Legal Assistant Copilot</h4>
                        <p style="color:var(--muted);font-size:0.75rem">Ask natural language questions about clauses, liabilities, and warranties.</p>
                    </div>

                    <div id="ai-chat-stream" style="flex:1;overflow-y:auto;padding-right:0.5rem">
                        <div class="chat-bubble-ai">
                            Hello! I am your Enterprise Legal AI Assistant. Ask me anything about this contract, such as:
                            <div style="margin-top:0.4rem;display:flex;flex-direction:column;gap:0.25rem">
                                <a href="javascript:void(0)" onclick="quickAsk('What is the limitation of liability cap?')">"What is the limitation of liability cap?"</a>
                                <a href="javascript:void(0)" onclick="quickAsk('Can either party terminate for convenience?')">"Can either party terminate for convenience?"</a>
                                <a href="javascript:void(0)" onclick="quickAsk('What are the payment and invoice terms?')">"What are the payment and invoice terms?"</a>
                            </div>
                        </div>
                    </div>

                    <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
                        <input type="text" id="ai-chat-input" placeholder="Ask a question..." style="flex:1;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" onkeypress="if(event.key==='Enter')sendAIChat()">
                        <button class="btn btn-primary" onclick="sendAIChat()">Send</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    loadAIAnalysisForContract('cnt-001');
}

function loadAIAnalysisForContract(contractId) {
    const container = document.getElementById('ai-audit-results');
    apiGet('/api/v1/ai-contracts/' + contractId + '/analysis').then(res => {
        const a = res.analysis || {};
        let clausesHtml = (a.extracted_clauses || []).map(cl => {
            const riskColor = cl.risk === 'high' ? 'var(--danger)' : cl.risk === 'medium' ? '#d97706' : 'var(--success)';
            return `
                <div style="border-left:3px solid ${riskColor};padding-left:0.5rem;margin-bottom:0.5rem">
                    <div style="font-weight:600;font-size:0.85rem">${esc(cl.clause_name)} <span style="font-size:0.7rem;color:${riskColor}">(${esc(cl.risk).toUpperCase()} RISK)</span></div>
                    <div style="font-size:0.8rem;color:var(--muted)">${esc(cl.excerpt)}</div>
                </div>
            `;
        }).join('');

        let risksHtml = (a.detected_risks || []).map(r => `
            <div style="background:#fef2f2;border:1px solid #fee2e2;border-radius:0.375rem;padding:0.5rem;margin-bottom:0.4rem;font-size:0.8rem">
                <div style="font-weight:700;color:#991b1b">[${esc(r.severity)}] ${esc(r.title)}</div>
                <div style="color:#7f1d1d">${esc(r.description)}</div>
                ${r.suggestion ? `<div style="color:#0369a1;margin-top:0.25rem"><strong>Suggestion:</strong> ${esc(r.suggestion)}</div>` : ''}
            </div>
        `).join('');

        container.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
                <span class="badge" style="background:#e0f2fe;color:#0369a1">${esc(a.model_name || 'Enterprise Legal-LLM')}</span>
                <span style="font-weight:600;font-size:0.8rem;color:var(--success)">Confidence: ${Math.round((a.confidence_score || 0.95) * 100)}%</span>
            </div>
            
            <h4 style="font-size:0.95rem;margin-bottom:0.4rem">Executive Legal Summary</h4>
            <p style="font-size:0.85rem;color:#334155;line-height:1.4;margin-bottom:1rem;background:#f8fafc;padding:0.6rem;border-radius:0.375rem">
                ${esc(a.executive_summary || 'Analysis complete.')}
            </p>

            <h4 style="font-size:0.9rem;margin-bottom:0.4rem">Extracted Core Clauses & Risk Flags</h4>
            <div style="margin-bottom:1rem">${clausesHtml || '<p style="color:var(--muted)">No clauses flagged.</p>'}</div>

            <h4 style="font-size:0.9rem;margin-bottom:0.4rem">Detected Legal & Commercial Risks</h4>
            <div>${risksHtml || '<p style="color:var(--success);font-size:0.85rem">✓ No high-risk policy deviations detected.</p>'}</div>
        `;
    }).catch(e => container.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`);
}

function triggerAIAnalysis() {
    const contractId = document.getElementById('ai-contract-select').value;
    apiPost('/api/v1/ai-contracts/' + contractId + '/analyze', {}).then(() => {
        alert('AI full contract audit recomputed!');
        loadAIAnalysisForContract(contractId);
    }).catch(e => alert('Error: ' + e.message));
}

function quickAIAudit(contractId) {
    navigate('ai-contracts');
    setTimeout(() => {
        const select = document.getElementById('ai-contract-select');
        if (select) {
            select.value = contractId;
            loadAIAnalysisForContract(contractId);
        }
    }, 100);
}

function quickAsk(q) {
    document.getElementById('ai-chat-input').value = q;
    sendAIChat();
}

function sendAIChat() {
    const input = document.getElementById('ai-chat-input');
    const q = (input.value || '').trim();
    if (!q) return;

    const stream = document.getElementById('ai-chat-stream');
    stream.innerHTML += `<div class="chat-bubble-user">${esc(q)}</div>`;
    input.value = '';
    stream.scrollTop = stream.scrollHeight;

    const contractId = document.getElementById('ai-contract-select').value;
    apiPost('/api/v1/ai-contracts/' + contractId + '/ask', { question: q }).then(res => {
        const citations = (res.cited_clauses || []).map(c => `<span class="badge" style="background:#e2e8f0;color:#334155;margin-right:4px">${esc(c)}</span>`).join('');
        stream.innerHTML += `
            <div class="chat-bubble-ai">
                <div>${esc(res.answer)}</div>
                <div style="margin-top:0.4rem;font-size:0.75rem;color:var(--muted)"><strong>Citations:</strong> ${citations} (Confidence: ${Math.round((res.confidence || 0.94) * 100)}%)</div>
            </div>
        `;
        stream.scrollTop = stream.scrollHeight;
    }).catch(e => {
        stream.innerHTML += `<div class="chat-bubble-ai" style="color:var(--danger)">Error: ${esc(e.message)}</div>`;
    });
}

// ------------------------------------------------------------------------------
// 11. CLM ANALYTICS, HEATMAPS & EXECUTIVE REPORTING
// ------------------------------------------------------------------------------
function loadCLMAnalytics() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <h3 style="margin-bottom:0.25rem">Enterprise Contract Lifecycle Analytics & Governance</h3>
            <p style="color:var(--muted);font-size:0.85rem">Cycle time velocity, approval bottlenecks, value leakage detection, and renewal forecasting.</p>
        </div>

        <div id="analytics-content-container">
            <p style="color:var(--muted)">Loading governance metrics...</p>
        </div>
    `;

    apiGet('/api/v1/clm-reports/summary').then(r => {
        const ct = r.cycle_time || {};
        const ph = r.portfolio_health || {};
        const fe = r.financial_exposure || {};
        const ex = r.expirations || {};

        document.getElementById('analytics-content-container').innerHTML = `
            <div class="stats" style="margin-bottom:1rem">
                <div class="card stat"><div class="value" style="color:var(--primary)">${ct.average_days} days</div><div class="label">Avg Contract Cycle Time</div></div>
                <div class="card stat"><div class="value" style="color:var(--success)">${ph.overall_score}/100</div><div class="label">Portfolio Health Score</div></div>
                <div class="card stat"><div class="value" style="color:var(--danger)">$${Number(fe.potential_leakage_detected).toLocaleString()}</div><div class="label">Value Leakage Prevented</div></div>
                <div class="card stat"><div class="value">${ex.within_90_days}</div><div class="label">Renewals in 90 Days</div></div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem">
                <div class="card">
                    <h4 style="margin-bottom:0.75rem">Cycle Time Bottleneck Breakdown (Stage Velocity)</h4>
                    <div style="font-size:0.85rem;display:flex;flex-direction:column;gap:0.5rem">
                        <div>
                            <div style="display:flex;justify-content:space-between"><span>Intake to Authoring Draft</span><strong>${ct.request_to_draft} days</strong></div>
                            <div style="background:#e2e8f0;height:6px;border-radius:3px;margin-top:2px"><div style="background:var(--primary);width:${Math.min(100, Math.round(ct.request_to_draft / ct.average_days * 100))}%;height:100%"></div></div>
                        </div>
                        <div>
                            <div style="display:flex;justify-content:space-between"><span>Negotiation & Redlines</span><strong>${ct.draft_to_negotiation} days</strong></div>
                            <div style="background:#e2e8f0;height:6px;border-radius:3px;margin-top:2px"><div style="background:#f59e0b;width:${Math.min(100, Math.round(ct.draft_to_negotiation / ct.average_days * 100))}%;height:100%"></div></div>
                        </div>
                        <div>
                            <div style="display:flex;justify-content:space-between"><span>L1-L3 Approval Routing</span><strong>${ct.negotiation_to_approval} days</strong></div>
                            <div style="background:#e2e8f0;height:6px;border-radius:3px;margin-top:2px"><div style="background:#8b5cf6;width:${Math.min(100, Math.round(ct.negotiation_to_approval / ct.average_days * 100))}%;height:100%"></div></div>
                        </div>
                        <div>
                            <div style="display:flex;justify-content:space-between"><span>Signatures & Digital Sealing</span><strong>${ct.approval_to_execution} days</strong></div>
                            <div style="background:#e2e8f0;height:6px;border-radius:3px;margin-top:2px"><div style="background:var(--success);width:${Math.min(100, Math.round(ct.approval_to_execution / ct.average_days * 100))}%;height:100%"></div></div>
                        </div>
                    </div>
                </div>

                <div class="card">
                    <h4 style="margin-bottom:0.75rem">Portfolio Risk & Compliance Heatmap</h4>
                    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">
                        <div style="font-size:2rem;font-weight:700;color:var(--success)">${ph.compliance_rate}%</div>
                        <div style="font-size:0.85rem;color:var(--muted)">Overall Regulatory Compliance Posture across all multi-entity subsidiaries.</div>
                    </div>
                    <div style="display:flex;gap:0.5rem;font-size:0.8rem">
                        <div style="flex:1;background:#d1fae5;color:#065f46;padding:0.5rem;border-radius:0.375rem;text-align:center"><strong>Low Risk</strong><br>${ph.risk_profile.low}%</div>
                        <div style="flex:1;background:#fef3c7;color:#92400e;padding:0.5rem;border-radius:0.375rem;text-align:center"><strong>Medium</strong><br>${ph.risk_profile.medium}%</div>
                        <div style="flex:1;background:#fee2e2;color:#991b1b;padding:0.5rem;border-radius:0.375rem;text-align:center"><strong>High Risk</strong><br>${ph.risk_profile.high}%</div>
                    </div>
                </div>
            </div>

            <div class="card" style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h4 style="margin-bottom:0.25rem">Auditor-Ready Compliance & Contract Reports</h4>
                    <p style="color:var(--muted);font-size:0.85rem">Download structured portfolio exports conforming to SOX, SOC 2, and GDPR requirements.</p>
                </div>
                <div style="display:flex;gap:0.5rem">
                    <button class="btn" style="background:#475569;color:#fff" onclick="exportContractsJSON()">Export Full Portfolio (JSON)</button>
                    <button class="btn btn-primary" onclick="downloadCLMAuditPDF()">Download Audit Report (PDF)</button>
                </div>
            </div>
        `;
    }).catch(e => document.getElementById('analytics-content-container').innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`);
}


// ------------------------------------------------------------------------------
// CORPORATE DEPARTMENTS (14 ENTERPRISE FUNCTIONS) MANAGEMENT HUB
// ------------------------------------------------------------------------------
function loadCorporateDepartments() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem;background:linear-gradient(135deg, #1e293b, #0f172a);color:#fff;border:none">
            <h3 style="margin-bottom:0.25rem;color:#f8fafc">Enterprise Corporate Department CLM Matrix</h3>
            <p style="color:#94a3b8;font-size:0.85rem">
                Centralized contract governance, financial visibility, workflow automation, and compliance across all 14 corporate departments.
            </p>
        </div>

        <div id="corporate-depts-container">
            <p style="color:var(--muted)">Loading corporate departments matrix...</p>
        </div>
    `;

    apiGet('/api/v1/corporate-departments').then(res => {
        const list = res.departments || [];
        const container = document.getElementById('corporate-depts-container');
        let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(360px, 1fr));gap:1rem">';

        list.forEach(d => {
            const caps = d.capabilities.map(c => `<li style="margin-bottom:2px">${esc(c)}</li>`).join('');
            html += `
                <div class="card" style="margin:0;display:flex;flex-direction:column;justify-content:space-between">
                    <div>
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5rem">
                            <span class="badge" style="background:#e0f2fe;color:#0369a1;font-weight:700">${esc(d.code)}</span>
                            <span style="font-size:0.75rem;color:var(--muted)">${esc(d.lead)}</span>
                        </div>
                        <h4 style="margin-bottom:0.35rem">${esc(d.name)}</h4>
                        <div style="display:flex;gap:1rem;font-size:0.85rem;margin-bottom:0.75rem;background:#f8fafc;padding:0.5rem;border-radius:0.375rem">
                            <div><strong>Contracts:</strong> <span style="color:var(--primary);font-weight:700">${d.contracts_count}</span></div>
                            <div><strong>Value Exposure:</strong> <span style="font-weight:700">$${Number(d.total_value).toLocaleString()}</span></div>
                        </div>
                        <div style="font-size:0.8rem;color:#475569;margin-bottom:0.75rem">
                            <strong>Key Capabilities:</strong>
                            <ul style="margin-left:1.25rem;margin-top:0.25rem">${caps}</ul>
                        </div>
                    </div>
                    <div style="border-top:1px solid var(--border);padding-top:0.75rem;display:flex;justify-content:space-between;align-items:center">
                        <button class="btn btn-primary" style="font-size:0.8rem" onclick="viewDepartmentContracts('${d.code}')">View ${esc(d.code)} Contracts</button>
                        <button class="btn" style="background:#f1f5f9;color:#334155;font-size:0.75rem" onclick="viewDepartmentContracts('${d.code}')">${esc(d.action_label)}</button>
                    </div>
                </div>
            `;
        });

        html += '</div>';
        container.innerHTML = html;
    }).catch(e => {
        document.getElementById('corporate-depts-container').innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`;
    });
}

function viewDepartmentContracts(deptCode) {
    navigate('contracts');
    setTimeout(() => {
        const select = document.getElementById('cnt-filter-dept');
        if (select) {
            select.value = deptCode;
            filterContractsTable();
        }
    }, 150);
}


// ------------------------------------------------------------------------------
// 400 ENTERPRISE CLM FEATURES EXPLORER & MODULE RUNNER
// ------------------------------------------------------------------------------
let cached400Features = [];
let cached400Domains = [];
let selectedFeatureForExec = null;

function load400FeaturesExplorer() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">Enterprise CLM — 400 Feature Requirements Catalog</h3>
                    <p style="color:var(--muted);font-size:0.85rem">The catalog contains 400 registrations across 20 domains. Registry smoke checks do not prove implementation, business functionality, persisted evidence, or production readiness.</p>
                </div>
                <div style="display:flex;gap:0.5rem">
                    <span id="feature400-status" class="badge" style="padding:0.4rem 0.8rem;font-size:0.8rem">Loading catalog status...</span>
                </div>
            </div>
            <div style="display:flex;gap:1rem;margin-top:1rem">
                <input type="text" id="feat400-search" placeholder="Search by ID, feature name, or domain..." style="flex:1;padding:0.5rem 0.75rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" oninput="filter400FeaturesTable()">
                <select id="feat400-domain-filter" style="padding:0.5rem 0.75rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem;background:#fff" onchange="filter400FeaturesTable()">
                    <option value="">All 20 Operational Domains</option>
                </select>
            </div>
        </div>

        <div class="card">
            <div id="feat400-table-container">
                <p style="color:var(--muted);font-size:0.85rem">Loading 400 feature catalog...</p>
            </div>
        </div>
    `;

    Promise.all([
        apiGet('/api/v1/domains'),
        apiGet('/api/v1/features')
    ]).then(([domRes, featRes]) => {
        cached400Domains = domRes.domains || [];
        cached400Features = featRes.features || [];
        const status = document.getElementById('feature400-status');
        if (status) {
            const registered = cached400Features.filter(feature => feature.status === 'registered').length;
            const unassessed = cached400Features.filter(feature => feature.implementationStatus === 'NOT_ASSESSED').length;
            status.textContent = `${registered} registered · ${unassessed} not assessed for implementation`;
        }

        const sel = document.getElementById('feat400-domain-filter');
        if (sel) {
            cached400Domains.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.id;
                opt.textContent = `${d.name} (#${d.range})`;
                sel.appendChild(opt);
            });
        }

        render400FeaturesTable(cached400Features);
    }).catch(e => {
        document.getElementById('feat400-table-container').innerHTML = `<p style="color:var(--danger)">Failed to load features: ${esc(e.message)}</p>`;
    });
}

function render400FeaturesTable(list) {
    const container = document.getElementById('feat400-table-container');
    if (!list || list.length === 0) {
        container.innerHTML = '<p style="color:var(--muted);padding:1rem 0">No matching features found.</p>';
        return;
    }

    let rows = list.map(f => {
        return `
            <tr>
                <td style="font-weight:700;color:var(--primary);width:60px">#${f.id}</td>
                <td style="font-weight:600;width:130px"><span class="badge" style="background:#e0f2fe;color:#0369a1">${esc(f.code)}</span></td>
                <td>
                    <div style="font-weight:600">${esc(f.name)}</div>
                    <div style="font-size:0.75rem;color:var(--muted)">Module: ${esc(f.folder || f.code)}</div>
                </td>
                <td><span style="font-size:0.8rem;color:#334155;font-weight:500">${esc(f.domain)}</span></td>
                <td><span class="badge">${esc(f.implementationStatus || 'NOT_ASSESSED')}</span></td>
                <td style="font-size:0.75rem;color:var(--muted)">No feature-level evidence</td>
                <td>
                    <button class="btn btn-primary" style="padding:0.25rem 0.6rem;font-size:0.75rem" onclick="openExecute400Modal(${f.id})">Run smoke check</button>
                </td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <div style="font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem">Showing ${list.length} of 400 features</div>
        <table>
            <thead>
                <tr>
                    <th>ID</th>
                    <th>Req Code</th>
                    <th>Feature Name & Module</th>
                    <th>Operational Domain</th>
                    <th>Implementation status</th>
                    <th>Evidence</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function filter400FeaturesTable() {
    const q = (document.getElementById('feat400-search').value || '').toLowerCase().trim();
    const domainId = document.getElementById('feat400-domain-filter').value;

    const filtered = cached400Features.filter(f => {
        if (domainId && f.domainId !== domainId) return false;
        if (q) {
            const match = String(f.id).includes(q) ||
                          (f.code || '').toLowerCase().includes(q) ||
                          (f.name || '').toLowerCase().includes(q) ||
                          (f.domain || '').toLowerCase().includes(q);
            if (!match) return false;
        }
        return true;
    });

    render400FeaturesTable(filtered);
}

function openExecute400Modal(featureId) {
    selectedFeatureForExec = cached400Features.find(f => f.id === featureId);
    if (!selectedFeatureForExec) return;

    showModal(`
        <h3>Registry smoke check #${selectedFeatureForExec.id}: ${esc(selectedFeatureForExec.name)}</h3>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">This checks the registry wrapper only; it does not verify the feature's business capability or production readiness.</p>
        
        <div class="form-group">
            <label for="exec-tenant-id">Test tenant ID</label>
            <input type="text" id="exec-tenant-id" value="tenant-enterprise-uat" required style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
            <small style="color:var(--muted)">Included as test context only; this mock registry check does not verify tenant isolation.</small>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submit400FeatureExecution()">Run Registry Check</button>
        </div>
        <div id="exec-result-area" style="display:none;margin-top:1rem">
            <h4 style="font-size:0.85rem;margin-bottom:0.25rem">Registry smoke-check output (not business verification):</h4>
            <pre id="exec-result-json" style="background:#0f172a;color:#f8fafc;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto"></pre>
        </div>
    `);
}

function submit400FeatureExecution() {
    if (!selectedFeatureForExec) return;
    const tenantId = document.getElementById('exec-tenant-id').value.trim();
    if (!tenantId) {
        alert('Enter a test tenant ID.');
        return;
    }

    apiPost(`/api/v1/features/${selectedFeatureForExec.id}/execute`, {
        tenant_id: tenantId,
        data: { ping: true }
    }).then(res => {
        document.getElementById('exec-result-area').style.display = 'block';
        document.getElementById('exec-result-json').textContent = JSON.stringify(res, null, 2);
    }).catch(err => {
        alert("Execution error: " + err.message);
    });
}

// ------------------------------------------------------------------------------
// SDLC WORKFLOWS CONTROL CENTER
// ------------------------------------------------------------------------------
function loadSDLCWorkflows() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <h3 style="margin-bottom:0.25rem">SDLC Workflows Control Center</h3>
            <p style="color:var(--muted);font-size:0.85rem">Structured Feature Development, Structured Bug-Fix with reproduction test gate, and Fast Spec generator.</p>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:1rem;margin-bottom:1.5rem">
            <div class="card">
                <h4 style="color:var(--primary);margin-bottom:0.5rem">1. Structured Feature Development</h4>
                <p style="font-size:0.8rem;color:var(--muted);margin-bottom:1rem">Pipeline: Design → Review Loop (3x) → Plan → Implement → Validation Gate.</p>
                <input type="text" id="wf-feat-name" placeholder="Feature Name" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.8rem;margin-bottom:0.5rem" value="Automated Multi-Jurisdiction Stamp">
                <button class="btn btn-primary" style="width:100%" onclick="executeWorkflowAPI('feature')">Execute Feature Dev</button>
            </div>

            <div class="card">
                <h4 style="color:#d97706;margin-bottom:0.5rem">2. Structured Bug-Fix Workflow</h4>
                <p style="font-size:0.8rem;color:var(--muted);margin-bottom:1rem">Pipeline: Investigate (Repro Test) → Diagnose Root Cause → Fix (PBT & Rollback) → Validation Gate.</p>
                <input type="text" id="wf-bug-report" placeholder="Bug Report" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.8rem;margin-bottom:0.5rem" value="Cross-tenant isolation check on contract export">
                <button class="btn" style="width:100%;background:#d97706;color:#fff" onclick="executeWorkflowAPI('bugfix')">Execute Bug-Fix</button>
            </div>

            <div class="card">
                <h4 style="color:#7c3aed;margin-bottom:0.5rem">3. Fast Spec Workflow (SpecFast)</h4>
                <p style="font-size:0.8rem;color:var(--muted);margin-bottom:1rem">Pipeline: Clarify Ambiguities → Auto-generate Requirements (FR/NFR) → Technical Design → Tasks.</p>
                <input type="text" id="wf-spec-idea" placeholder="Idea Prompt" style="width:100%;padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.8rem;margin-bottom:0.5rem" value="Proactive AI renewal price escalation predictor">
                <button class="btn" style="width:100%;background:#7c3aed;color:#fff" onclick="executeWorkflowAPI('spec')">Execute SpecFast</button>
            </div>
        </div>

        <div class="card" id="wf-live-output" style="display:none;margin-bottom:1.5rem">
            <h4>Live Workflow Execution Artifacts:</h4>
            <pre id="wf-live-json" style="background:#0f172a;color:#f8fafc;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto"></pre>
        </div>

        <div class="card">
            <h4>WORM Immutable Audit Trail (.agents/tasks/workflow-audit-log.json)</h4>
            <p style="color:var(--muted);font-size:0.8rem;margin-bottom:0.75rem">Cryptographically signed SHA-256 records of all executed pipeline runs.</p>
            <div id="wf-audit-table"><p style="color:var(--muted)">Loading audit trail...</p></div>
        </div>
    `;

    loadWorkflowAuditLogs();
}

function executeWorkflowAPI(type) {
    let payload = {};
    if (type === 'feature') payload.name = document.getElementById('wf-feat-name').value;
    if (type === 'bugfix') payload.report = document.getElementById('wf-bug-report').value;
    if (type === 'spec') payload.idea = document.getElementById('wf-spec-idea').value;

    apiPost(`/api/v1/workflows/${type}`, payload).then(res => {
        document.getElementById('wf-live-output').style.display = 'block';
        document.getElementById('wf-live-json').textContent = JSON.stringify(res, null, 2);
        loadWorkflowAuditLogs();
    }).catch(e => alert("Workflow failed: " + e.message));
}

function loadWorkflowAuditLogs() {
    apiGet('/api/v1/workflows/audit-log').then(res => {
        const logs = res.logs || [];
        const container = document.getElementById('wf-audit-table');
        if (logs.length === 0) {
            container.innerHTML = '<p style="color:var(--muted);font-size:0.85rem">No audit records yet.</p>';
            return;
        }

        let rows = logs.slice().reverse().map(l => `
            <tr>
                <td style="font-size:0.75rem">${l.run_start}</td>
                <td><span class="badge" style="background:#e0f2fe;color:#0369a1">${esc(l.workflow)}</span></td>
                <td style="font-family:monospace;font-size:0.75rem">${esc((l.run_id || '').substring(0,8))}...</td>
                <td style="font-size:0.75rem">${esc(l.feature_request || l.bug_report || l.idea || 'N/A')}</td>
                <td style="font-family:monospace;font-size:0.75rem;color:#059669">${esc(l.hash)}</td>
            </tr>
        `).join('');

        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Timestamp</th>
                        <th>Workflow</th>
                        <th>Run ID</th>
                        <th>Input Detail</th>
                        <th>SHA-256 Integrity Hash</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(console.error);
}


// ==============================================================================
// 1. LEGAL CLAUSE PLAYBOOK & FALLBACK HIERARCHY
// ==============================================================================
let cachedPlaybook = [];

function loadClausePlaybook() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">📘 Enterprise Legal Clause Playbook & Fallback Hierarchy</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Patterned after Icertis & Sirion. Defines preferred clauses, multi-tier fallback concessions, and negotiation guidance.</p>
                </div>
                <div>
                    <button class="btn btn-primary" onclick="openTestFallbackModal()">Test Fallback Substitution</button>
                </div>
            </div>
        </div>

        <div class="card">
            <div id="playbook-container"><p style="color:var(--muted)">Loading legal playbook clauses...</p></div>
        </div>
    `;

    apiGet('/api/v1/playbook/clauses').then(res => {
        cachedPlaybook = res.playbook || [];
        renderPlaybookCards(cachedPlaybook);
    }).catch(e => {
        document.getElementById('playbook-container').innerHTML = `<p style="color:var(--danger)">Failed to load playbook: ${esc(e.message)}</p>`;
    });
}

function renderPlaybookCards(list) {
    const container = document.getElementById('playbook-container');
    if (!list || list.length === 0) {
        container.innerHTML = '<p style="color:var(--muted)">No playbook clauses found.</p>';
        return;
    }

    container.innerHTML = list.map(c => `
        <div style="border:1px solid var(--border);border-radius:0.5rem;padding:1rem;margin-bottom:1rem;background:#f8fafc">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
                <div>
                    <h4 style="font-size:1rem;margin-bottom:0.25rem">${esc(c.title)}</h4>
                    <span class="badge" style="background:#e0f2fe;color:#0369a1">${esc(c.category)}</span>
                </div>
                <div style="font-size:0.75rem;color:var(--muted);text-align:right">
                    <strong>Walk-Away:</strong> ${esc(c.walk_away_position)}
                </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem;margin-top:1rem">
                <!-- Standard -->
                <div style="background:#fff;border-left:4px solid var(--success);padding:0.75rem;border-radius:0.375rem;font-size:0.8rem">
                    <div style="font-weight:700;color:var(--success);margin-bottom:0.25rem">🟢 Preferred (Standard)</div>
                    <div style="color:var(--muted);margin-bottom:0.5rem">Risk: ${c.tiers.standard.riskScore} · Approval: ${c.tiers.standard.approvalRequired}</div>
                    <p style="font-style:italic">${esc(c.tiers.standard.text)}</p>
                </div>

                <!-- Fallback 1 -->
                <div style="background:#fff;border-left:4px solid var(--warning);padding:0.75rem;border-radius:0.375rem;font-size:0.8rem">
                    <div style="font-weight:700;color:var(--warning);margin-bottom:0.25rem">🟡 Fallback 1 (Concession)</div>
                    <div style="color:var(--muted);margin-bottom:0.5rem">Risk: ${c.tiers.fallback_1.riskScore} · Approval: ${c.tiers.fallback_1.approvalRequired}</div>
                    <p style="font-style:italic">${esc(c.tiers.fallback_1.text)}</p>
                    <div style="font-size:0.75rem;color:#b45309;margin-top:0.5rem"><strong>Guidance:</strong> ${esc(c.tiers.fallback_1.guidance)}</div>
                </div>

                <!-- Fallback 2 -->
                <div style="background:#fff;border-left:4px solid var(--danger);padding:0.75rem;border-radius:0.375rem;font-size:0.8rem">
                    <div style="font-weight:700;color:var(--danger);margin-bottom:0.25rem">🔴 Fallback 2 (High Concession)</div>
                    <div style="color:var(--muted);margin-bottom:0.5rem">Risk: ${c.tiers.fallback_2.riskScore} · Approval: ${c.tiers.fallback_2.approvalRequired}</div>
                    <p style="font-style:italic">${esc(c.tiers.fallback_2.text)}</p>
                    <div style="font-size:0.75rem;color:#b91c1c;margin-top:0.5rem"><strong>Guidance:</strong> ${esc(c.tiers.fallback_2.guidance)}</div>
                </div>
            </div>
        </div>
    `).join('');
}

function openTestFallbackModal() {
    showModal(`
        <h3>Test Fallback Substitution & Risk Delta</h3>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Select a clause and fallback tier to calculate the risk score delta and generate an updated contract digest.</p>
        <div class="form-group">
            <label>Select Clause</label>
            <select id="modal-fb-clause" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                ${cachedPlaybook.map(c => `<option value="${c.key}">${esc(c.title)}</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>Select Concession Tier</label>
            <select id="modal-fb-tier" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">
                <option value="fallback_1">Fallback 1 (L2 Legal Approval)</option>
                <option value="fallback_2">Fallback 2 (L3 CFO / General Counsel Approval)</option>
            </select>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitApplyFallback()">Apply Fallback</button>
        </div>
        <div id="fb-result-area" style="display:none;margin-top:1rem;background:#0f172a;color:#f8fafc;padding:0.75rem;border-radius:0.375rem;font-size:0.8rem">
            <pre id="fb-result-json" style="margin:0"></pre>
        </div>
    `);
}

function submitApplyFallback() {
    const clauseKey = document.getElementById('modal-fb-clause').value;
    const tier = document.getElementById('modal-fb-tier').value;
    apiPost('/api/v1/playbook/apply-fallback', {
        contract_text: "Standard Enterprise Master Services Agreement 2026.",
        clause_key: clauseKey,
        tier: tier
    }).then(res => {
        document.getElementById('fb-result-area').style.display = 'block';
        document.getElementById('fb-result-json').textContent = JSON.stringify(res, null, 2);
    }).catch(e => alert(e.message));
}

// ==============================================================================
// 2. SIDE-BY-SIDE CONTRACT COMPARISON & SEMANTIC DIFF
// ==============================================================================
function loadContractCompare() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <h3 style="margin-bottom:0.25rem">⚖️ Side-by-Side Contract Comparison & Semantic Diff</h3>
            <p style="color:var(--muted);font-size:0.85rem">Patterned after Ironclad and Sirion. Compares Baseline vs Revised counterparty drafts, calculates similarity percentages, and flags risk deltas.</p>
        </div>

        <div class="card" style="margin-bottom:1rem">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
                <div>
                    <label style="font-weight:600;font-size:0.85rem">Contract A (Baseline Version 1.0)</label>
                    <textarea id="cmp-doc-a" style="width:100%;height:160px;margin-top:0.25rem;padding:0.5rem;font-size:0.8rem;border:1px solid var(--border);border-radius:0.375rem">CONFIDENTIAL MASTER SERVICES AGREEMENT.
Section 1. Confidentiality: Each party shall protect confidential information for 3 years using reasonable care.
Section 2. Limitation of Liability: Aggregate liability shall not exceed fees paid in the preceding 12 months.
Section 3. Termination: Either party may terminate for convenience upon sixty (60) days notice.
Section 4. Payment Terms: Invoices are payable within Net 30 days via wire transfer.</textarea>
                </div>
                <div>
                    <label style="font-weight:600;font-size:0.85rem">Contract B (Counterparty Redline Version 2.0)</label>
                    <textarea id="cmp-doc-b" style="width:100%;height:160px;margin-top:0.25rem;padding:0.5rem;font-size:0.8rem;border:1px solid var(--border);border-radius:0.375rem">MASTER SERVICES AGREEMENT (VENDOR REVISED).
Section 1. Confidentiality: Recipient shall hold information for 1 year. Trade secrets expire upon contract termination.
Section 2. Limitation of Liability: Customer liability is capped at $50,000; Provider liability is unlimited for all direct and indirect damages.
Section 3. Termination: Provider may terminate on 10 days notice; Customer cannot terminate before 24 months.
Section 4. Payment Terms: Invoices are payable within Net 60 days.</textarea>
                </div>
            </div>
            <div style="text-align:right;margin-top:1rem">
                <button class="btn btn-primary" onclick="runContractComparison()">Run Semantic Comparison</button>
            </div>
        </div>

        <div id="cmp-result-card" class="card" style="display:none">
            <div id="cmp-result-container"></div>
        </div>
    `;
}

function runContractComparison() {
    const textA = document.getElementById('cmp-doc-a').value;
    const textB = document.getElementById('cmp-doc-b').value;

    apiPost('/api/v1/contract-comparison/compare', {
        contract_a: textA,
        contract_b: textB,
        title_a: "Baseline Draft v1.0",
        title_b: "Vendor Redline v2.0"
    }).then(res => {
        const card = document.getElementById('cmp-result-card');
        card.style.display = 'block';
        const container = document.getElementById('cmp-result-container');

        const simBadgeColor = res.similarity.score >= 0.85 ? 'var(--success)' : res.similarity.score >= 0.6 ? '#f59e0b' : 'var(--danger)';
        const riskColor = res.risk_variance.risk_delta > 0 ? 'var(--danger)' : 'var(--success)';

        container.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:0.75rem">
                <div>
                    <h4 style="margin:0">Comparison Report: ${esc(res.comparison_id)}</h4>
                    <span style="font-size:0.8rem;color:var(--muted)">Calculated at: ${esc(res.metadata.compared_at)}</span>
                </div>
                <div style="display:flex;gap:1rem">
                    <div style="text-align:center">
                        <div style="font-size:1.25rem;font-weight:700;color:${simBadgeColor}">${esc(res.similarity.percentage)}</div>
                        <div style="font-size:0.7rem;color:var(--muted)">Similarity Score</div>
                    </div>
                    <div style="text-align:center">
                        <div style="font-size:1.25rem;font-weight:700;color:${riskColor}">${res.risk_variance.risk_delta > 0 ? '+' : ''}${res.risk_variance.risk_delta}</div>
                        <div style="font-size:0.7rem;color:var(--muted)">Risk Delta (${esc(res.risk_variance.risk_trajectory)})</div>
                    </div>
                </div>
            </div>

            <h5 style="margin-bottom:0.5rem">Clause Deviation & Risk Assessment:</h5>
            <table>
                <thead>
                    <tr>
                        <th>Clause Type</th>
                        <th>Baseline (A)</th>
                        <th>Revised (B)</th>
                        <th>Deviation Status</th>
                        <th>Attention Level</th>
                    </tr>
                </thead>
                <tbody>
                    ${res.clause_deviations.map(cd => `
                        <tr>
                            <td style="font-weight:600">${esc(cd.clause)}</td>
                            <td>${cd.in_baseline ? '✓ Present' : '— Missing'}</td>
                            <td>${cd.in_revised ? '✓ Present' : '— Removed'}</td>
                            <td><span class="badge" style="background:#f1f5f9">${esc(cd.status)}</span></td>
                            <td><span class="badge" style="background:${cd.variance_degree.includes('CRITICAL') || cd.variance_degree.includes('HIGH') ? '#fee2e2;color:#991b1b' : '#dcfce7;color:#166534'}">${esc(cd.variance_degree)}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }).catch(e => alert('Comparison failed: ' + e.message));
}

// ==============================================================================
// 3. OBLIGATION RADAR & SLA PENALTY CALCULATOR
// ==============================================================================
function loadExpirationRadar() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <h3 style="margin-bottom:0.25rem">⏰ Post-Execution Renewal Radar & SLA Penalty Calculator</h3>
            <p style="color:var(--muted);font-size:0.85rem">Patterned after Sirion. Monitors contract milestones, auto-renewal opt-out cutoffs, and calculates SLA availability penalties.</p>
        </div>

        <div class="stats" id="radar-metric-bar">
            <div class="card stat"><div class="value" id="r-urgent" style="color:var(--danger)">...</div><div class="label">Urgent (< 30 Days)</div></div>
            <div class="card stat"><div class="value" id="r-60d" style="color:#f59e0b">...</div><div class="label">Renewal Window (31-60d)</div></div>
            <div class="card stat"><div class="value" id="r-90d" style="color:var(--primary)">...</div><div class="label">Early Warning (61-90d)</div></div>
            <div class="card stat"><div class="value" id="r-cutoffs" style="color:#7c3aed">...</div><div class="label">Auto-Renewal Cutoffs</div></div>
        </div>

        <div id="radar-cutoff-alert" style="display:none;margin-bottom:1rem;background:#fef2f2;border-left:4px solid var(--danger);padding:0.75rem 1rem;border-radius:0.375rem;font-size:0.85rem"></div>

        <div class="card" style="margin-bottom:1rem">
            <h4 style="margin-bottom:0.5rem">Contractual SLA Downtime Penalty Calculator</h4>
            <p style="color:var(--muted);font-size:0.8rem;margin-bottom:1rem">Calculates contractual fee credit rebates when vendor availability drops below contracted SLA thresholds.</p>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem">
                <div>
                    <label style="font-size:0.8rem;font-weight:600">Annual Contract Value ($)</label>
                    <input type="number" id="sla-val" value="120000" style="width:100%;padding:0.4rem;border:1px solid var(--border);border-radius:0.375rem">
                </div>
                <div>
                    <label style="font-size:0.8rem;font-weight:600">Target Uptime (%)</label>
                    <input type="number" step="0.1" id="sla-target" value="99.9" style="width:100%;padding:0.4rem;border:1px solid var(--border);border-radius:0.375rem">
                </div>
                <div>
                    <label style="font-size:0.8rem;font-weight:600">Actual Recorded Uptime (%)</label>
                    <input type="number" step="0.1" id="sla-actual" value="98.4" style="width:100%;padding:0.4rem;border:1px solid var(--border);border-radius:0.375rem">
                </div>
            </div>
            <div style="text-align:right;margin-top:1rem">
                <button class="btn btn-primary" onclick="calculateSLAPenaltyUI()">Calculate Penalty Rebate</button>
            </div>
            <div id="sla-calc-result" style="display:none;margin-top:1rem;background:#f8fafc;border:1px solid var(--border);border-radius:0.375rem;padding:0.75rem;font-size:0.85rem"></div>
        </div>
    `;

    apiGet('/api/v1/obligations/radar').then(res => {
        document.getElementById('r-urgent').textContent = res.counts.urgent_30_days;
        document.getElementById('r-60d').textContent = res.counts.renewal_window_60_days;
        document.getElementById('r-90d').textContent = res.counts.early_warning_90_days;
        document.getElementById('r-cutoffs').textContent = res.counts.auto_renewal_cutoffs;

        if (res.counts.auto_renewal_cutoffs > 0) {
            const alertBox = document.getElementById('radar-cutoff-alert');
            alertBox.style.display = 'block';
            alertBox.innerHTML = `<strong>⚠️ AUTO-RENEWAL CUTOFF ALERT:</strong> ${res.counts.auto_renewal_cutoffs} agreement(s) have impending auto-renewal opt-out notice deadlines. Review notice periods to prevent unintended commitment extensions.`;
        }
    }).catch(e => console.error(e));
}

function calculateSLAPenaltyUI() {
    const val = parseFloat(document.getElementById('sla-val').value);
    const target = parseFloat(document.getElementById('sla-target').value);
    const actual = parseFloat(document.getElementById('sla-actual').value);

    apiPost('/api/v1/obligations/calculate-penalty', {
        contract_value: val,
        target_uptime: target,
        actual_uptime: actual
    }).then(res => {
        const box = document.getElementById('sla-calc-result');
        box.style.display = 'block';
        box.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <strong>Breach Severity:</strong> <span class="badge" style="background:#fee2e2;color:#991b1b">${esc(res.breach_severity)}</span>
                    <span style="margin-left:0.5rem">Deficit: ${res.uptime_deficit}%</span>
                </div>
                <div>
                    <strong style="color:var(--danger);font-size:1.1rem">Calculated Fee Credit Rebate: $${res.calculated_penalty_rebate.toLocaleString()}</strong> (${res.credit_rebate_percentage} of monthly base)
                </div>
            </div>
            <div style="font-size:0.8rem;color:var(--muted);margin-top:0.5rem">
                ERP Adjustment Code: <code>${esc(res.erp_adjustment_code)}</code> · Right to terminate for cause: ${res.right_to_terminate_for_cause ? '<span style="color:var(--danger);font-weight:700">YES (Material Breach)</span>' : 'No'}
            </div>
        `;
    }).catch(e => alert(e.message));
}

// ==============================================================================
// 4. SELF-SERVICE CLICKWRAP & CERTIFICATE ISSUANCE
// ==============================================================================
function loadClickwrapPortal() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">✍️ Self-Service Clickwrap & Public Agreement Portal</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Patterned after Ironclad Clickwrap & DocuSign. Generates self-service campaigns with audit-logged acceptance and Certificates of Completion.</p>
                </div>
                <div>
                    <button class="btn btn-primary" onclick="openSimulateClickwrapModal()">Simulate Counterparty Acceptance</button>
                </div>
            </div>
        </div>

        <div class="card" style="margin-bottom:1rem">
            <h4 style="margin-bottom:0.5rem">Active Standard Clickwrap Agreements</h4>
            <table>
                <thead>
                    <tr>
                        <th>Campaign Token</th>
                        <th>Agreement Title</th>
                        <th>Type</th>
                        <th>Enforceability Standard</th>
                        <th>Status</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><code>CLICK-NDA-STANDARD-2026</code></td>
                        <td><strong>Standard Enterprise Mutual NDA</strong></td>
                        <td><span class="badge" style="background:#e0f2fe;color:#0369a1">NDA</span></td>
                        <td>ESIGN Act & UETA Compliant</td>
                        <td><span class="badge" style="background:#dcfce7;color:#15803d">ACTIVE</span></td>
                        <td><button class="btn btn-primary" style="padding:0.2rem 0.5rem;font-size:0.75rem" onclick="openSimulateClickwrapModal('CLICK-NDA-STANDARD-2026')">Sign</button></td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div id="clickwrap-cert-card" class="card" style="display:none">
            <h4 style="margin-bottom:0.5rem">Official Certificate of Completion:</h4>
            <div id="clickwrap-cert-view" style="background:#f8fafc;border:2px solid var(--primary);border-radius:0.5rem;padding:1rem;font-size:0.85rem"></div>
        </div>
    `;
}

function openSimulateClickwrapModal(token = "CLICK-NDA-STANDARD-2026") {
    showModal(`
        <h3>Self-Service Agreement Acceptance</h3>
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Review and execute agreement via clickwrap with digital audit evidence capture.</p>
        <div class="form-group">
            <label>Campaign Token</label>
            <input type="text" id="cw-token" value="${esc(token)}" readonly style="width:100%;padding:0.4rem;border:1px solid var(--border);border-radius:0.375rem;background:#f1f5f9">
        </div>
        <div class="form-group">
            <label>Signatory Full Name</label>
            <input type="text" id="cw-name" value="Jane Doe, VP Procurement" style="width:100%;padding:0.4rem;border:1px solid var(--border);border-radius:0.375rem">
        </div>
        <div class="form-group">
            <label>Corporate Email</label>
            <input type="email" id="cw-email" value="jane.doe@counterparty.com" style="width:100%;padding:0.4rem;border:1px solid var(--border);border-radius:0.375rem">
        </div>
        <div class="form-group">
            <label>Organization / Legal Entity</label>
            <input type="text" id="cw-company" value="Global Innovations LLC" style="width:100%;padding:0.4rem;border:1px solid var(--border);border-radius:0.375rem">
        </div>
        <div style="margin:1rem 0">
            <label style="font-size:0.8rem;display:flex;align-items:center;gap:0.5rem">
                <input type="checkbox" id="cw-agree" checked> I agree to be legally bound by this agreement under ESIGN Act & UETA.
            </label>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitClickwrapAcceptance()">Execute Clickwrap</button>
        </div>
    `);
}

function submitClickwrapAcceptance() {
    if (!document.getElementById('cw-agree').checked) {
        alert("You must check the agreement box to execute.");
        return;
    }

    const token = document.getElementById('cw-token').value;
    const name = document.getElementById('cw-name').value;
    const email = document.getElementById('cw-email').value;
    const company = document.getElementById('cw-company').value;

    apiPost('/api/v1/clickwrap/accept', {
        token: token,
        counterparty: {
            signer_name: name,
            signer_email: email,
            company_name: company,
            ip_address: "198.51.100." + Math.floor(Math.random() * 200 + 10),
            user_agent: navigator.userAgent
        }
    }).then(res => {
        closeModal();
        const certCard = document.getElementById('clickwrap-cert-card');
        certCard.style.display = 'block';
        const certView = document.getElementById('clickwrap-cert-view');
        const c = res.certificate;

        certView.innerHTML = `
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:0.5rem;margin-bottom:0.5rem">
                <div>
                    <h4 style="margin:0;color:var(--primary)">CERTIFICATE OF COMPLETION</h4>
                    <span style="font-size:0.75rem;color:var(--muted)">Certificate ID: <strong>${esc(c.certificate_id)}</strong></span>
                </div>
                <div>
                    <span class="badge" style="background:#dcfce7;color:#15803d">LEGALLY BINDING</span>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                <div><strong>Agreement:</strong> ${esc(c.agreement_title)}</div>
                <div><strong>Executed At:</strong> ${esc(c.accepted_at)}</div>
                <div><strong>Signatory:</strong> ${esc(c.signer.name)} (${esc(c.signer.email)})</div>
                <div><strong>Organization:</strong> ${esc(c.signer.company)}</div>
                <div><strong>Signer IP:</strong> <code>${esc(c.signer.ip_address)}</code></div>
                <div><strong>Enforceability:</strong> ${esc(c.legal_enforceability)}</div>
            </div>
            <div style="margin-top:0.75rem;background:#0f172a;color:#f8fafc;padding:0.5rem;border-radius:0.25rem;font-size:0.75rem">
                <strong>SHA-256 Tamper-Evident Certificate Hash:</strong> <code>${esc(c.certificate_hash)}</code>
            </div>
        `;
    }).catch(e => alert(e.message));
}


// ==============================================================================
// 1. VISUAL CONTRACT RISK HEATMAP & GOVERNANCE COCKPIT (Evisort / Icertis)
// ==============================================================================

function loadRiskHeatmap() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">📊 Visual Contract Risk Heatmap & Governance Cockpit</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Portfolio risk matrix across 5 core vectors: Liability, IP/Indemnity, Privacy/GDPR, Financial Spend, and Operational Termination.</p>
                </div>
                <button class="btn btn-primary" onclick="openEvaluateRiskModal()">➕ Evaluate Contract Risk</button>
            </div>
        </div>

        <div id="risk-heatmap-stats" class="stats" style="grid-template-columns:repeat(4,1fr);margin-bottom:1rem">
            <div class="card stat"><div class="label">Compliance Index</div><div class="value" id="rh-compliance">--</div></div>
            <div class="card stat"><div class="label">Portfolio Value</div><div class="value" id="rh-val">--</div></div>
            <div class="card stat"><div class="label">High / Critical Risk</div><div class="value" id="rh-high-risk" style="color:var(--danger)">--</div></div>
            <div class="card stat"><div class="label">Low / Moderate Risk</div><div class="value" id="rh-low-risk" style="color:var(--success)">--</div></div>
        </div>

        <div class="card" style="margin-bottom:1rem">
            <h4 style="margin-bottom:0.75rem">Departmental Risk Matrix & Vector Distribution</h4>
            <div class="table-container">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Department</th>
                            <th>Active Contracts</th>
                            <th>Total Exposure</th>
                            <th>Average Risk</th>
                            <th>Risk Tier</th>
                            <th>Liability (25%)</th>
                            <th>IP & Indemnity (25%)</th>
                            <th>Privacy / Reg (20%)</th>
                            <th>Financial (15%)</th>
                            <th>Operational (15%)</th>
                        </tr>
                    </thead>
                    <tbody id="risk-dept-tbody">
                        <tr><td colspan="10" style="text-align:center;color:var(--muted)">Loading risk matrix...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div class="card">
            <h4 style="margin-bottom:0.75rem">Top High-Exposure Contract Outliers</h4>
            <div id="risk-outliers-container">
                <p style="color:var(--muted)">Scanning portfolio outliers...</p>
            </div>
        </div>
    `;

    apiGet('/api/v1/risk-heatmap/matrix').then(res => {
        const p = res.portfolio_summary;
        document.getElementById('rh-compliance').textContent = p.governance_compliance_index + "%";
        document.getElementById('rh-val').textContent = "$" + (p.total_portfolio_value / 1000).toFixed(0) + "k";
        document.getElementById('rh-high-risk').textContent = (p.distribution.critical + p.distribution.high);
        document.getElementById('rh-low-risk').textContent = (p.distribution.medium + p.distribution.low);

        const tbody = document.getElementById('risk-dept-tbody');
        tbody.innerHTML = res.department_matrix.map(d => {
            let badgeBg = '#dcfce7', badgeColor = '#15803d';
            if (d.risk_tier === 'CRITICAL' || d.risk_tier === 'HIGH') {
                badgeBg = '#fee2e2'; badgeColor = '#b91c1c';
            } else if (d.risk_tier === 'MEDIUM') {
                badgeBg = '#fef3c7'; badgeColor = '#b45309';
            }
            return `
                <tr>
                    <td><strong>${esc(d.department)}</strong></td>
                    <td>${d.contract_count}</td>
                    <td>$${d.total_value.toLocaleString()}</td>
                    <td><strong>${d.average_risk_score} / 100</strong></td>
                    <td><span class="badge" style="background:${badgeBg};color:${badgeColor}">${esc(d.risk_tier)}</span></td>
                    <td>${d.vector_averages.liability_exposure}</td>
                    <td>${d.vector_averages.ip_indemnification}</td>
                    <td>${d.vector_averages.data_privacy_compliance}</td>
                    <td>${d.vector_averages.financial_commitments}</td>
                    <td>${d.vector_averages.operational_termination}</td>
                </tr>
            `;
        }).join('');

        const outContainer = document.getElementById('risk-outliers-container');
        if (!res.top_risk_outliers || res.top_risk_outliers.length === 0) {
            outContainer.innerHTML = '<p style="color:var(--success)">No high-exposure outliers detected. Portfolio conforms to enterprise risk standards.</p>';
        } else {
            outContainer.innerHTML = res.top_risk_outliers.map(o => `
                <div style="border-left:4px solid var(--danger);background:#fef2f2;padding:0.75rem;border-radius:0.375rem;margin-bottom:0.75rem">
                    <div style="display:flex;justify-content:space-between;align-items:center">
                        <div>
                            <strong>${esc(o.title)}</strong> (${esc(o.contract_number)}) - <em>${esc(o.department)}</em>
                        </div>
                        <span class="badge" style="background:#fee2e2;color:#b91c1c;font-weight:700">Risk Score: ${o.composite_risk_score} (${o.risk_tier})</span>
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:0.5rem;font-size:0.75rem;margin-top:0.5rem;color:#7f1d1d">
                        <div>Liability: ${o.vectors.liability_exposure}</div>
                        <div>IP/Indemnity: ${o.vectors.ip_indemnification}</div>
                        <div>Privacy: ${o.vectors.data_privacy_compliance}</div>
                        <div>Financial: ${o.vectors.financial_commitments}</div>
                        <div>Operational: ${o.vectors.operational_termination}</div>
                    </div>
                </div>
            `).join('');
        }
    }).catch(e => {
        document.getElementById('risk-dept-tbody').innerHTML = `<tr><td colspan="10" style="color:var(--danger)">Error: ${esc(e.message)}</td></tr>`;
    });
}

function openEvaluateRiskModal() {
    showModal(`
        <h3>Evaluate Contract Risk Profile</h3>
        <div class="form-group">
            <label>Contract Title</label>
            <input type="text" id="er-title" class="form-control" value="Global Infrastructure Expansion SOW">
        </div>
        <div class="form-group">
            <label>Department</label>
            <select id="er-dept" class="form-control">
                <option value="Engineering">Engineering</option>
                <option value="Procurement">Procurement</option>
                <option value="Sales">Sales</option>
                <option value="Legal">Legal</option>
                <option value="HR">HR</option>
            </select>
        </div>
        <div class="form-group">
            <label>Contract Value ($ USD)</label>
            <input type="number" id="er-value" class="form-control" value="750000">
        </div>
        <div class="form-group">
            <label>Contract Draft Excerpt</label>
            <textarea id="er-content" class="form-control" rows="4">Vendor demands unlimited liability for data outages. Liquidated damages shall apply. Non-refundable prepayments.</textarea>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitContractRiskEval()">Calculate Multidimensional Risk</button>
        </div>
    `);
}

function submitContractRiskEval() {
    const title = document.getElementById('er-title').value;
    const department = document.getElementById('er-dept').value;
    const contract_value = parseFloat(document.getElementById('er-value').value) || 0;
    const content = document.getElementById('er-content').value;

    apiPost('/api/v1/risk-heatmap/evaluate', {
        title, department, contract_value, content
    }).then(res => {
        closeModal();
        alert(`Evaluation Complete:
Composite Risk Score: ${res.composite_risk_score}/100 (${res.risk_tier})
Liability Exposure: ${res.vectors.liability_exposure}
IP / Indemnity: ${res.vectors.ip_indemnification}
Privacy / Compliance: ${res.vectors.data_privacy_compliance}
Financial Spend: ${res.vectors.financial_commitments}
Operational Exit: ${res.vectors.operational_termination}`);
        loadRiskHeatmap();
    }).catch(e => alert(e.message));
}

// ==============================================================================
// 2. EXTERNAL COUNTERPARTY NEGOTIATION WORKSPACE (Ironclad / Agiloft)
// ==============================================================================

let generatedPortalTokens = [];

function loadCounterpartyPortal() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">🌐 External Counterparty Negotiation Workspace</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Zero-trust, tokenized negotiation links for external vendors and customers. Cryptographically signed access without enterprise seat licenses.</p>
                </div>
                <button class="btn btn-primary" onclick="openCreatePortalTokenModal()">➕ Generate Guest Negotiation Token</button>
            </div>
        </div>

        <div class="card" style="margin-bottom:1rem">
            <h4 style="margin-bottom:0.75rem">Active External Negotiation Links</h4>
            <div class="table-container">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Token ID</th>
                            <th>Contract ID</th>
                            <th>Counterparty Email</th>
                            <th>Organization</th>
                            <th>Expires</th>
                            <th>Permissions</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="portal-tokens-tbody">
                        <tr><td colspan="8" style="text-align:center;color:var(--muted)">No external tokens active. Click Generate to invite a counterparty.</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div id="portal-simulator-card" class="card" style="display:none;background:#f8fafc;border:2px dashed var(--primary)">
            <h4 style="margin-bottom:0.5rem;color:var(--primary)">External Guest Portal Simulation (Vendor Perspective)</h4>
            <div id="portal-simulator-content"></div>
        </div>
    `;

    renderPortalTokensTable();
}

function renderPortalTokensTable() {
    const tbody = document.getElementById('portal-tokens-tbody');
    if (!tbody) return;
    if (generatedPortalTokens.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No external tokens active. Click Generate to invite a counterparty.</td></tr>';
        return;
    }

    tbody.innerHTML = generatedPortalTokens.map(t => `
        <tr>
            <td><code>${esc(t.token_id)}</code></td>
            <td><strong>${esc(t.contract_id)}</strong></td>
            <td>${esc(t.counterparty_email)}</td>
            <td>${esc(t.counterparty_org)}</td>
            <td>${esc(t.expires_at.split('T')[0])}</td>
            <td><span class="badge" style="background:#e0f2fe;color:#0369a1">${t.permissions.join(', ')}</span></td>
            <td><span class="badge" style="background:#dcfce7;color:#15803d">${esc(t.status)}</span></td>
            <td>
                <button class="btn btn-sm btn-outline" onclick="simulateGuestPortal('${esc(t.token)}')">Simulate Guest Review</button>
            </td>
        </tr>
    `).join('');
}

function openCreatePortalTokenModal() {
    showModal(`
        <h3>Issue External Counterparty Negotiation Token</h3>
        <div class="form-group">
            <label>Contract ID / Ref</label>
            <input type="text" id="pt-contract" class="form-control" value="CNT-2026-MSA-08">
        </div>
        <div class="form-group">
            <label>Counterparty Legal Contact Email</label>
            <input type="email" id="pt-email" class="form-control" value="legal@partner-tech.com">
        </div>
        <div class="form-group">
            <label>Counterparty Organization</label>
            <input type="text" id="pt-org" class="form-control" value="Partner Tech Global Corp">
        </div>
        <div class="form-group">
            <label>Link Expiration</label>
            <select id="pt-expiry" class="form-control">
                <option value="7">7 Days</option>
                <option value="14" selected>14 Days (Standard)</option>
                <option value="30">30 Days</option>
            </select>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitCreatePortalToken()">Issue Secure Token</button>
        </div>
    `);
}

function submitCreatePortalToken() {
    const contract_id = document.getElementById('pt-contract').value;
    const counterparty_email = document.getElementById('pt-email').value;
    const counterparty_org = document.getElementById('pt-org').value;
    const expiry_days = parseInt(document.getElementById('pt-expiry').value) || 14;

    apiPost('/api/v1/counterparty-portal/create-token', {
        contract_id, counterparty_email, counterparty_org, expiry_days,
        initial_draft: "1. Fees: Customer shall pay within 30 days. 2. Liability: Capped at 12 months fees. 3. Governing Law: State of New York."
    }).then(res => {
        closeModal();
        generatedPortalTokens.push(res);
        renderPortalTokensTable();
        alert(`Secure Counterparty Negotiation Link Generated:
URL: ${res.portal_url}
Token Digest Signed with HMAC-SHA256.`);
    }).catch(e => alert(e.message));
}

function simulateGuestPortal(token) {
    apiGet('/api/v1/counterparty-portal/session?token=' + encodeURIComponent(token)).then(res => {
        const card = document.getElementById('portal-simulator-card');
        const content = document.getElementById('portal-simulator-content');
        card.style.display = 'block';

        const s = res.session;
        content.innerHTML = `
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:0.5rem;margin-bottom:0.5rem">
                <div>
                    <strong>Guest Identity:</strong> ${esc(s.counterparty_email)} (${esc(s.counterparty_org)})<br>
                    <span style="font-size:0.75rem;color:var(--muted)">Negotiation Round: <strong>Round ${s.current_round}</strong> · Access expires: ${s.expires_at}</span>
                </div>
                <div>
                    <span class="badge" style="background:#dcfce7;color:#15803d">HMAC-SHA256 AUTHENTICATED</span>
                </div>
            </div>
            <div class="form-group">
                <label>Active Contract Draft</label>
                <textarea id="sim-redline-text" class="form-control" rows="4">${esc(s.current_draft)}</textarea>
            </div>
            <div class="form-group">
                <label>Counterparty Commentary / Redline Rationale</label>
                <input type="text" id="sim-comment" class="form-control" value="Proposed revising payment terms to Net 45 and adding mutual consequential damages waiver.">
            </div>
            <button class="btn btn-primary" onclick="submitGuestRedline('${esc(token)}')">Submit Counterparty Redline</button>
        `;
    }).catch(e => alert(e.message));
}

function submitGuestRedline(token) {
    const redline_text = document.getElementById('sim-redline-text').value;
    const comments = document.getElementById('sim-comment').value;

    apiPost('/api/v1/counterparty-portal/submit-redline', {
        token, redline_text, comments
    }).then(res => {
        alert(`Redline Submitted Successfully!
Round: ${res.round}
Draft Digest Hash: ${res.draft_digest}`);
        simulateGuestPortal(token);
    }).catch(e => alert(e.message));
}

// ==============================================================================
// 3. SOURCING-TO-CONTRACT (S2C) CONVERTER (SAP Ariba / Coupa)
// ==============================================================================

function loadSourcingConverter() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">🛒 Sourcing-to-Contract (S2C) / RFP-to-Agreement Converter</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Seamlessly converts winning procurement bids, RFP rate-cards, and milestones into binding MSAs and SOWs with line-item pricing tables.</p>
                </div>
                <button class="btn btn-primary" onclick="openConvertRfpModal()">⚡ Convert RFP Bid to Agreement</button>
            </div>
        </div>

        <div id="s2c-result-card" class="card" style="display:none">
            <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding-bottom:0.5rem;margin-bottom:1rem">
                <div>
                    <h4 id="s2c-title" style="margin:0;color:var(--primary)">Statement of Work</h4>
                    <span id="s2c-meta" style="font-size:0.8rem;color:var(--muted)"></span>
                </div>
                <span class="badge" style="background:#e0f2fe;color:#0369a1" id="s2c-status">DRAFT</span>
            </div>
            <div id="s2c-content-view" style="background:#0f172a;color:#f8fafc;padding:1rem;border-radius:0.375rem;font-family:monospace;white-space:pre-wrap;max-height:350px;overflow-y:auto"></div>
            <div style="margin-top:1rem;padding:0.75rem;background:#f1f5f9;border-radius:0.375rem;font-size:0.8rem">
                <strong>Cryptographic Sourcing Provenance Chain:</strong>
                <div id="s2c-provenance" style="font-family:monospace;color:#334155;margin-top:0.25rem"></div>
            </div>
        </div>
    `;
}

function openConvertRfpModal() {
    showModal(`
        <h3>Convert Awarded Sourcing RFP into Binding Contract</h3>
        <div class="form-group">
            <label>RFP Reference ID</label>
            <input type="text" id="s2c-rfp-id" class="form-control" value="RFP-2026-CLOUD-INFRA">
        </div>
        <div class="form-group">
            <label>Awarded Supplier Name</label>
            <input type="text" id="s2c-supplier" class="form-control" value="Apex Cloud Solutions LLC">
        </div>
        <div class="form-group">
            <label>Agreement Type</label>
            <select id="s2c-type" class="form-control">
                <option value="STATEMENT_OF_WORK" selected>Statement of Work (SOW)</option>
                <option value="MASTER_SERVICES_AGREEMENT">Master Services Agreement (MSA)</option>
            </select>
        </div>
        <div class="form-group">
            <label>Payment Terms</label>
            <input type="text" id="s2c-terms" class="form-control" value="Net 30 Days (3-Way Matching Enforced)">
        </div>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitConvertRfp()">Generate Binding Agreement</button>
        </div>
    `);
}

function submitConvertRfp() {
    const rfp_id = document.getElementById('s2c-rfp-id').value;
    const supplier_name = document.getElementById('s2c-supplier').value;
    const agreement_type = document.getElementById('s2c-type').value;
    const payment_terms = document.getElementById('s2c-terms').value;

    apiPost('/api/v1/sourcing/convert-rfp', {
        rfp_id, supplier_name, agreement_type, payment_terms,
        line_items: [
            { item_id: "ITEM-01", description: "Multi-Cloud Kubernetes Architecture Build", quantity: 1, unit_price: 180000, unit: "fixed_scope" },
            { item_id: "ITEM-02", description: "Zero-Trust Mesh & IAM Integration", quantity: 160, unit_price: 275, unit: "hour" },
            { item_id: "ITEM-03", description: "24/7 Managed SRE Support Services (Annual)", quantity: 12, unit_price: 6500, unit: "month" }
        ],
        milestones: [
            { milestone_id: "M-01", title: "Architecture Design Review & Signoff", target_date: "2026-12-01", percentage: 25, amount: 75500 },
            { milestone_id: "M-02", title: "Cluster Deployment & Workload Migration", target_date: "2027-02-15", percentage: 50, amount: 151000 },
            { milestone_id: "M-03", title: "Production Go-Live & Handover", target_date: "2027-04-30", percentage: 25, amount: 75500 }
        ]
    }).then(res => {
        closeModal();
        const card = document.getElementById('s2c-result-card');
        card.style.display = 'block';
        document.getElementById('s2c-title').textContent = res.title;
        document.getElementById('s2c-meta').textContent = `Contract: ${res.contract_number} · Supplier: ${res.supplier.name} · Value: $${res.financials.total_value.toLocaleString()} USD`;
        document.getElementById('s2c-content-view').textContent = res.generated_content;
        document.getElementById('s2c-provenance').innerHTML = `
            RFP Source Digest: <code>${res.rfp_source_digest}</code><br>
            Contract Content Digest: <code>${res.contract_digest}</code><br>
            Engine: ${res.provenance_chain.transition_engine} (${res.provenance_chain.timestamp})
        `;
    }).catch(e => alert(e.message));
}

// ==============================================================================
// 4. CONTRACT TERMINATION & SURVIVAL RUNBOOK (Icertis / Sirion)
// ==============================================================================

function loadTerminationRunbook() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">🛑 Contract Termination, Clause Survival & Archival Runbook</h3>
                    <p style="color:var(--muted);font-size:0.85rem">Legal workflow governing Termination for Convenience vs Cause, surviving clause obligations, data destruction certificates, and archival seals.</p>
                </div>
                <button class="btn btn-danger" onclick="openExecuteTerminationModal()">⚠️ Execute Contract Termination</button>
            </div>
        </div>

        <div id="term-result-card" class="card" style="display:none">
            <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding-bottom:0.5rem;margin-bottom:1rem">
                <div>
                    <h4 id="term-contract-num" style="margin:0;color:var(--danger)">CNT-2026-TERM</h4>
                    <span id="term-reason" style="font-size:0.8rem;color:var(--muted)"></span>
                </div>
                <span class="badge" style="background:#fee2e2;color:#b91c1c" id="term-status">TERMINATED</span>
            </div>

            <div style="margin-bottom:1rem">
                <h5 style="margin-bottom:0.5rem">Post-Termination Surviving Clauses (Legally Enforceable)</h5>
                <div id="term-survivals-container"></div>
            </div>

            <div style="border-top:1px solid var(--border);padding-top:1rem;margin-bottom:1rem">
                <h5 style="margin-bottom:0.5rem">NIST SP 800-88 Certificate of Data Destruction</h5>
                <div id="term-cert-view" style="background:#f8fafc;padding:0.75rem;border-radius:0.375rem;font-size:0.8rem"></div>
            </div>

            <div style="background:#0f172a;color:#f8fafc;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem">
                <strong>Immutable Archival SHA-256 Seal:</strong> <code id="term-archival-seal"></code>
            </div>
        </div>
    `;
}

function openExecuteTerminationModal() {
    showModal(`
        <h3>Execute Contract Termination Runbook</h3>
        <div class="form-group">
            <label>Contract Number</label>
            <input type="text" id="tr-number" class="form-control" value="CNT-2024-VENDOR-088">
        </div>
        <div class="form-group">
            <label>Termination Type</label>
            <select id="tr-type" class="form-control">
                <option value="TERMINATION_FOR_CONVENIENCE" selected>Termination for Convenience</option>
                <option value="TERMINATION_FOR_CAUSE">Termination for Cause (Material Breach)</option>
                <option value="MUTUAL_TERMINATION">Mutual Agreement Termination</option>
            </select>
        </div>
        <div class="form-group">
            <label>Notice Period Served (Days)</label>
            <input type="number" id="tr-notice" class="form-control" value="35">
        </div>
        <div class="form-group">
            <label>Contractual Required Notice (Days)</label>
            <input type="number" id="tr-req-notice" class="form-control" value="30">
        </div>
        <div class="form-group">
            <label>Termination Reason</label>
            <input type="text" id="tr-reason" class="form-control" value="Strategic vendor consolidation and internal technology transition.">
        </div>
        <div class="form-group">
            <label>Contract Clauses Excerpt for Survival Audit</label>
            <textarea id="tr-text" class="form-control" rows="3">1. Confidentiality obligations survive for 5 years. 2. Pre-existing Intellectual Property remains solely with enterprise. 3. Indemnification shall survive post-termination. 4. Books and records audit rights retained.</textarea>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
            <button class="btn" style="background:#cbd5e1" onclick="closeModal()">Cancel</button>
            <button class="btn btn-danger" onclick="submitExecuteTermination()">Execute Termination Protocol</button>
        </div>
    `);
}

function submitExecuteTermination() {
    const contract_number = document.getElementById('tr-number').value;
    const termination_type = document.getElementById('tr-type').value;
    const notice_served_days = parseInt(document.getElementById('tr-notice').value) || 30;
    const required_notice_days = parseInt(document.getElementById('tr-req-notice').value) || 30;
    const reason = document.getElementById('tr-reason').value;
    const contract_text = document.getElementById('tr-text').value;

    apiPost('/api/v1/contracts/terminate-runbook', {
        contract_number, termination_type, notice_served_days, required_notice_days, reason, contract_text
    }).then(res => {
        closeModal();
        const card = document.getElementById('term-result-card');
        card.style.display = 'block';
        document.getElementById('term-contract-num').textContent = `${res.contract_number} (${res.termination_type})`;
        document.getElementById('term-reason').textContent = `Reason: ${res.termination_reason} · Effective: ${res.effective_termination_date} · Notice Compliant: ${res.notice_governance.compliant ? 'YES' : 'NO'}`;
        document.getElementById('term-status').textContent = res.termination_status;

        const survContainer = document.getElementById('term-survivals-container');
        survContainer.innerHTML = res.surviving_obligations.map(s => `
            <div style="background:#fff;border-left:4px solid #0284c7;padding:0.5rem 0.75rem;margin-bottom:0.5rem;font-size:0.8rem;border:1px solid var(--border)">
                <strong>${esc(s.name)}</strong>: <span style="color:#0369a1">${esc(s.survival_duration)}</span>
                <div style="color:var(--muted);font-size:0.75rem">${esc(s.enforcement_governance)}</div>
            </div>
        `).join('');

        const cert = res.data_destruction_certificate;
        document.getElementById('term-cert-view').innerHTML = `
            <strong>Certificate ID:</strong> ${esc(cert.certificate_id)} · <strong>Status:</strong> ${esc(cert.data_destruction_status)}<br>
            <strong>Standard:</strong> ${esc(cert.destruction_protocol)}<br>
            <strong>PII Purged:</strong> ${cert.pii_data_purged ? 'YES' : 'NO'} · <strong>Certified By:</strong> ${esc(cert.certified_by_dpo)} (${esc(cert.certified_at)})
        `;

        document.getElementById('term-archival-seal').textContent = res.archival_seal_hash;
    }).catch(e => alert(e.message));
}
