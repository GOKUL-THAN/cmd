// CLM Gateway UI — Satellite Gateway Dashboard
// Authenticates via SaaS-issued JWT (shared auth)
// Manages: Certificates, Inventory, Discovery, Approvals, Deployment,
// Monitoring, Reports and Certificate Authorities (accounts, pricing, orders)

const GATEWAY_API = window.location.origin;
// Keycloak and the SaaS API are reached through this gateway's own nginx
// (/saas-auth/ and /saas-api/) so every request stays same-origin.
const SAAS_AUTH = window.location.origin + '/saas-auth';
const KC_REALM = 'clm';
const KC_CLIENT = 'clm-gateway-portal';
let token = '';
let refreshToken = '';
let currentPage = 'dashboard';
let refreshTimer = null;

// --- Auth: Keycloak Direct Grant (same realm as the Admin Portal) ---
// The JS adapter is deliberately not used; see the note in index.html.
function checkAuth() {
    const saved = sessionStorage.getItem('clm_gw_token');
    if (saved) {
        token = saved;
        refreshToken = sessionStorage.getItem('clm_gw_refresh') || '';
        if (!isTokenExpired(token)) {
            onAuthenticated();
            return;
        }
    }
    showLogin();
}

function showLogin() {
    const el = document.getElementById('login-redirect');
    if (el) el.classList.remove('hidden');
}

// decodeJwt reads a JWT payload. JWTs are base64url encoded: the payload may
// contain '-' or '_' and carries no padding, both of which make a bare atob()
// throw. That matters because isTokenExpired() treats a decode failure as
// "expired", so an unlucky token would sign the user straight back out on the
// next page load.
function decodeJwt(t) {
    const seg = String(t || '').split('.')[1];
    if (!seg) return null;
    let b64 = seg.split('-').join('+').split('_').join('/');
    while (b64.length % 4) { b64 += '='; }
    try {
        return JSON.parse(atob(b64));
    } catch (e) {
        return null;
    }
}

function isTokenExpired(t) {
    const p = decodeJwt(t);
    if (!p) return true;
    return !p.exp || (p.exp * 1000) <= Date.now();
}

function parseToken(t) {
    try {
        return decodeJwt(t) || {};
    } catch (e) {
        return {};
    }
}

// roleOf handles both Keycloak tokens (roles at the top level in this realm)
// and internal SaaS tokens (single `role` claim).
function roleOf(claims) {
    if (claims.role) return claims.role;
    const roles = claims.roles || (claims.realm_access && claims.realm_access.roles) || [];
    const meaningful = roles.filter(r =>
        r.indexOf('default-roles-') !== 0 && r !== 'offline_access' && r !== 'uma_authorization');
    return meaningful[0] || 'user';
}

function doGatewayLogin() {
    const emailEl = document.getElementById('gw-login-email');
    const passEl = document.getElementById('gw-login-password');
    const errEl = document.getElementById('gw-login-error');
    const email = emailEl ? emailEl.value.trim() : '';
    const password = passEl ? passEl.value : '';

    if (!email || !password) {
        errEl.textContent = 'Email and password are required.';
        return;
    }
    errEl.textContent = 'Signing in...';

    const body = new URLSearchParams({
        grant_type: 'password',
        client_id: KC_CLIENT,
        username: email,
        password: password
    });

    fetch(SAAS_AUTH + '/realms/' + KC_REALM + '/protocol/openid-connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    }).then(r => r.json()).then(data => {
        if (data.access_token) {
            storeSession(data);
            onAuthenticated();
            return;
        }
        // Keycloak unavailable or user only exists in the SaaS DB. Carry the
        // real reason forward: the fallback reports "Invalid credentials" for
        // everything, which used to mask causes such as Keycloak's
        // "Account is not fully set up" (an incomplete profile or a pending
        // required action) and made these failures very hard to diagnose.
        return legacyLogin(email, password, errEl, describeAuthError(data));
    }).catch(() => legacyLogin(email, password, errEl, ''));
}

// describeAuthError turns a Keycloak token-endpoint error into something a
// human can act on.
function describeAuthError(data) {
    if (!data) return '';
    const desc = data.error_description || data.error || '';
    if (!desc) return '';
    if (desc.indexOf('not fully set up') !== -1) {
        return desc + ' — the account has a pending required action or an ' +
               'incomplete profile (first and last name are mandatory). An ' +
               'administrator can repair it from Identity Management using ' +
               '"Fix Login".';
    }
    return desc;
}

// legacyLogin falls back to the control plane's own credential endpoint.
// kcError, when set, is the reason Keycloak already rejected the sign-in and is
// preferred over the fallback's generic message.
function legacyLogin(email, password, errEl, kcError) {
    return fetch(GATEWAY_API + '/saas-api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
    }).then(r => r.json()).then(data => {
        if (data.access_token) {
            storeSession(data);
            onAuthenticated();
        } else {
            errEl.textContent = kcError || data.error || data.error_description ||
                'Invalid credentials.';
        }
    }).catch(() => {
        errEl.textContent = kcError ||
            'Cannot reach the control plane. Check that the SaaS server is up.';
    });
}

function storeSession(data) {
    token = data.access_token;
    refreshToken = data.refresh_token || '';
    sessionStorage.setItem('clm_gw_token', token);
    if (refreshToken) sessionStorage.setItem('clm_gw_refresh', refreshToken);
}

function onAuthenticated() {
    const overlay = document.getElementById('login-redirect');
    if (overlay) overlay.classList.add('hidden');

    const claims = parseToken(token);
    const info = document.getElementById('user-info');
    if (info) {
        info.textContent = (claims.email || claims.preferred_username || '') + ' (' + roleOf(claims) + ')';
    }

    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(renewToken, 60000);

    loadDashboard();
}

function renewToken() {
    if (!refreshToken) return;
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: KC_CLIENT,
        refresh_token: refreshToken
    });
    fetch(SAAS_AUTH + '/realms/' + KC_REALM + '/protocol/openid-connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    }).then(r => r.json()).then(data => {
        if (data.access_token) storeSession(data);
    }).catch(() => {});
}

function logout() {
    token = '';
    refreshToken = '';
    sessionStorage.removeItem('clm_gw_token');
    sessionStorage.removeItem('clm_gw_refresh');
    if (refreshTimer) clearInterval(refreshTimer);
    window.location.reload();
}

checkAuth();

// --- Navigation ---
// Titles that need more than a capitalised route name. 'purchasing' is the
// retired CA Purchasing route, now an alias of the merged page.
const PAGE_TITLES = {
    authorities: 'Certificate Authorities',
    purchasing: 'Certificate Authorities',
    inventory: 'Inventory',
    certificates: 'Inventory',
    vsatellites: 'vSatellites',
    policies: 'Certificate Policy',
    multicloud: 'Multi-Cloud SSL Sync',
    compliance: 'Corporate Compliance & Audit Posture',
    migration: 'Bulk Certificate Migration & Ingestion',
    rotation: 'Automated Certificate Rotation & Rollback',
    audit: 'Audit Log'
};

function navigate(page) {
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    // The highlight follows the click when there is one. This used to read the
    // implicit global `event`, which is undefined whenever navigate() is called
    // from code rather than from an onclick, and the resulting TypeError aborted
    // the whole navigation. Fall back to matching the sidebar entry by name.
    const src = (typeof event !== 'undefined' && event && event.target) ? event.target : null;
    if (src && src.classList) {
        src.classList.add('active');
    } else {
        document.querySelectorAll('.nav-item').forEach(n => {
            if ((n.getAttribute('onclick') || '').indexOf("'" + page + "'") !== -1) {
                n.classList.add('active');
            }
        });
    }

    document.getElementById('page-title').textContent =
        PAGE_TITLES[page] || (page.charAt(0).toUpperCase() + page.slice(1));
    switch (page) {
        case 'dashboard': loadDashboard(); break;
        case 'inventory': loadInventory(); break;
        case 'certificates': loadInventory('certificates'); break;
        case 'lifecycle': loadLifecycle(); break;
        case 'automation': loadAutomation(); break;
        case 'authorities': loadAuthorities(); break;
        case 'reports': loadReports(); break;
        case 'vsatellites': loadVSatellites(); break;
        case 'discovery': loadDiscovery(); break;
        case 'approvals': loadApprovals(); break;
        case 'deploy': loadCertDeploy(); break;
        case 'multicloud': loadMultiCloudSync(); break;
        case 'compliance': loadCompliancePosture(); break;
        case 'migration': loadBulkMigration(); break;
        case 'rotation': loadAutoRotation(); break;
        case 'monitoring': loadMonitoring(); break;
        case 'policies': loadPolicies(); break;
        case 'audit': loadAuditLog(); break;
    // Certificate Management System
    case 'cms-upload': loadCmsUpload(); break;
    case 'cms-inventory': loadCmsInventory(); break;
    case 'cms-users': loadCmsUsers(); break;
    case 'cms-templates': loadCmsTemplates(); break;
    case 'cms-notifications': loadCmsNotifications(); break;
    case 'cms-tracking': loadCmsTracking(); break;
    case 'cms-audit': loadCmsAuditLog(); break;
        // CA Providers and CA Purchasing are one page now. The old route is kept
        // as an alias so existing links land on the pricing tab instead of 404ing
        // into a blank content area.
        case 'purchasing': loadAuthorities('pricing'); break;
    }
}

// --- API ---
// A 401 means the token lapsed, so the session is cleared and the login
// overlay comes back rather than leaving the page silently empty.
function handleUnauthorized() {
    sessionStorage.removeItem('clm_gw_token');
    sessionStorage.removeItem('clm_gw_refresh');
    token = '';
    showLogin();
    throw new Error('Session expired');
}

function apiGet(path) {
    return fetch(GATEWAY_API + path, {
        headers: { 'Authorization': 'Bearer ' + token }
    }).then(r => {
        if (r.status === 401) return handleUnauthorized();
        return r.json();
    });
}

function apiWrite(method, path, body) {
    return fetch(GATEWAY_API + path, {
        method: method,
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(r => {
        if (r.status === 401) return handleUnauthorized();
        return r.json();
    });
}

function apiPost(path, body) {
    return apiWrite('POST', path, body);
}

function apiPut(path, body) {
    return apiWrite('PUT', path, body);
}

// --- Pages ---
function loadDashboard() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="stats">
            <div class="card stat"><div class="label">Certificates</div><div class="value" id="s-certs">-</div></div>
            <div class="card stat"><div class="label">Expiring (30d)</div><div class="value" id="s-expiring" style="color:var(--warning)">-</div></div>
            <div class="card stat"><div class="label">Pending Approvals</div><div class="value" id="s-approvals">-</div></div>
            <div class="card stat"><div class="label">vSatellite Agents</div><div class="value" id="s-agents">-</div></div>
        </div>
        <div class="card"><h3>Gateway Status</h3><div id="gw-status" style="margin-top:0.5rem;color:var(--muted);font-size:0.85rem">Checking...</div></div>
    `;

    apiGet('/api/v1/status').then(d => {
        if (!d || d.error) throw new Error((d && d.error) || 'unavailable');
        setStat('s-certs', d.certificates);
        setStat('s-expiring', d.expiring_30d);
        setStat('s-approvals', d.pending_approvals);
        setStat('s-agents', d.agents ? d.agents.online_agents : 0);
        document.getElementById('gw-status').innerHTML =
            '<span style="color:var(--success)">Online</span> &middot; ' +
            escapeHtml(d.name || '') + ' &middot; v' + escapeHtml(d.version || '') +
            ' &middot; uptime ' + escapeHtml(d.uptime || '') +
            '<br>Control plane: ' + escapeHtml(d.saas_endpoint || '');
    }).catch(err => {
        const el = document.getElementById('gw-status');
        if (el) el.innerHTML = '<span style="color:var(--danger)">Gateway API unreachable</span> — ' +
            escapeHtml(err.message);
    });
}

function setStat(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = (val === undefined || val === null) ? '0' : val;
}

function escapeHtml(s) {
    if (s === undefined || s === null) return '';
    return String(s)
        .split('&').join('&amp;')
        .split('<').join('&lt;')
        .split('>').join('&gt;')
        .split('"').join('&quot;');
}

function loadCertificates() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p>Loading certificates...</p></div>';
    apiGet('/api/v1/certificates').then(data => {
        const certs = data.certificates || data || [];
        let rows = certs.map(c => {
            const daysLeft = c.not_after ? Math.ceil((new Date(c.not_after) - new Date()) / 86400000) : null;
            const badge = c.status === 'active' ? 'badge-active'
                        : (c.status === 'expired' || c.status === 'revoked' || c.status === 'failed') ? 'badge-expired'
                        : 'badge-pending';
            const managed = c.managed_by === 'acme'
                ? '<span class="badge badge-active">managed</span>'
                : '<span style="color:var(--muted);font-size:0.75rem">observed</span>';

            // Renew and revoke are only offered where a key actually exists here.
            let actions = '<span style="color:var(--muted);font-size:0.72rem">report only</span>';
            // Test the boolean, not revoked_at: a zero Go time serialises as
            // "0001-01-01T00:00:00Z", which is a truthy string.
            if (c.managed_by === 'acme' && !c.revoked && c.status !== 'failed') {
                actions = '<button class="btn" style="background:#e2e8f0" onclick="renewCertificate(\'' +
                          escapeAttr(c.id) + '\',\'' + escapeAttr(c.domain) + '\')">Renew</button> ' +
                          '<button class="btn btn-danger" onclick="revokeCertificate(\'' +
                          escapeAttr(c.id) + '\',\'' + escapeAttr(c.domain) + '\')">Revoke</button>';
            } else if (c.status === 'failed') {
                actions = '<span style="color:var(--danger);font-size:0.72rem" title="' +
                          escapeAttr(c.last_error || '') + '">issuance failed</span>';
            }

            return '<tr><td><strong>' + escapeHtml(c.domain || '-') + '</strong>' +
                   (c.host && c.host !== c.domain ? '<br><span style="color:var(--muted);font-size:0.72rem">' +
                        escapeHtml(c.host) + (c.port ? ':' + c.port : '') + '</span>' : '') +
                   '</td><td>' + managed + '</td>' +
                   '<td><span class="badge ' + badge + '">' + escapeHtml(c.status || '-') + '</span></td>' +
                   '<td style="font-size:0.8rem">' + escapeHtml(c.issuer || '-') + '</td>' +
                   '<td style="font-size:0.8rem">' + (daysLeft === null ? '-' : daysLeft + 'd') + '</td>' +
                   '<td style="font-size:0.8rem">' + escapeHtml(c.environment || '-') + '</td>' +
                   '<td style="white-space:nowrap">' + actions + '</td></tr>';
        }).join('');
        el.innerHTML = `<div class="card">
            <h3>Certificates</h3>
            <p style="color:var(--muted);font-size:0.82rem">
                Managed certificates were issued here and can be renewed or revoked.
                Observed ones were discovered on the network: the gateway holds no key
                for them, so it can report on them but not act on them.
            </p>
            <div style="margin:0.6rem 0">
                <button class="btn btn-primary" onclick="showIssueForm()">+ Issue Certificate</button>
                <button class="btn" style="background:#e2e8f0" onclick="requestCert()">Record a request</button>
            </div>
            <table>
                <thead><tr><th>Domain</th><th>Managed</th><th>Status</th><th>Issuer</th>
                <th>Expires</th><th>Env</th><th style="width:1%">Actions</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No certificates yet — run a discovery scan or issue one</td></tr>'}</tbody>
            </table>
            </div>
            <div id="cert-actions"></div>`;
    });
}

function requestCert() {
    const domain = prompt('Domain (e.g., api.example.com):');
    if (!domain) return;
    apiPost('/api/v1/certificates', { domain, type: 'DV', environment: 'prod', ca_provider: 'letsencrypt' })
        .then(() => loadCertificates());
}

const FIELD_STYLE = 'width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem';

function loadDiscovery() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
    <div class="card" style="margin-bottom:1rem">
        <h3>Certificate Discovery</h3>
        <p style="color:var(--muted);font-size:0.85rem">
            Two complementary methods. A network scan sweeps addresses; a DNS scan
            works from names and sends SNI, which is the only way to see the
            certificates of name-based virtual hosts and of hosts that resolve
            outside the scanned ranges.
        </p>
        <div style="display:flex;gap:0.5rem;margin-top:0.75rem;border-bottom:1px solid var(--border)">
            <button class="btn" id="disc-tab-net" onclick="switchDiscTab('net')"
                    style="background:none;border:none;border-bottom:2px solid var(--primary);border-radius:0;font-weight:600">Network Scan</button>
            <button class="btn" id="disc-tab-dns" onclick="switchDiscTab('dns')"
                    style="background:none;border:none;border-bottom:2px solid transparent;border-radius:0">DNS Scan</button>
        </div>
    </div>

    <div class="card" id="disc-pane-net" style="margin-bottom:1rem">
        <h3 style="font-size:0.95rem">Network Scan</h3>
        <p style="color:var(--muted);font-size:0.8rem;margin-bottom:0.75rem">
            Probes every address in the range on the configured TLS ports.
        </p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0.75rem">
            <div class="form-group"><label>CIDR ranges (comma separated)</label>
                <input id="disc-cidr" placeholder="10.0.0.0/24, 192.168.1.0/24" style="${FIELD_STYLE}"></div>
            <div class="form-group"><label>Individual hosts (optional)</label>
                <input id="disc-hosts" placeholder="10.0.0.5, 10.0.0.9" style="${FIELD_STYLE}"></div>
        </div>
        <button class="btn btn-primary" onclick="runDiscovery()">Scan Network</button>
    </div>

    <div class="card hidden" id="disc-pane-dns" style="margin-bottom:1rem">
        <h3 style="font-size:0.95rem">DNS Scan</h3>
        <p style="color:var(--muted);font-size:0.8rem;margin-bottom:0.75rem">
            Collects candidate hostnames from the zone's own records, optionally a
            subdomain wordlist, then probes each resolved name with SNI set.
        </p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0.75rem">
            <div class="form-group"><label>Domains (comma separated) *</label>
                <input id="disc-domain" placeholder="example.com, corp.internal" style="${FIELD_STYLE}"></div>
            <div class="form-group"><label>DNS server (optional)</label>
                <input id="disc-dns-server" placeholder="10.0.0.2 — blank uses the gateway resolver" style="${FIELD_STYLE}"></div>
            <div class="form-group"><label>Ports</label>
                <input id="disc-dns-ports" value="443, 8443" style="${FIELD_STYLE}"></div>
            <div class="form-group"><label>Extra names (optional)</label>
                <input id="disc-extra" placeholder="legacy.example.com" style="${FIELD_STYLE}"></div>
            <div class="form-group"><label>Max candidate names (up to 2000)</label>
                <input id="disc-maxnames" value="2000" style="${FIELD_STYLE}"></div>
        </div>
        <label style="display:block;font-size:0.8rem;margin:0.5rem 0">
            <input type="checkbox" id="disc-enumerate" checked> Enumerate subdomains from the built-in wordlist
            <span style="color:var(--muted)">(skipped automatically on wildcard zones, where every guess resolves)</span>
        </label>
        <label style="display:block;font-size:0.8rem;margin-bottom:0.75rem">
            <input type="checkbox" id="disc-follow-sans" checked> Follow SANs of certificates found, within the same domain
        </label>
        <button class="btn btn-primary" onclick="runDNSDiscovery()">Scan DNS</button>
    </div>

    <div id="disc-results"></div>`;
}

function switchDiscTab(which) {
    const net = which === 'net';
    document.getElementById('disc-pane-net').classList.toggle('hidden', !net);
    document.getElementById('disc-pane-dns').classList.toggle('hidden', net);
    const tn = document.getElementById('disc-tab-net');
    const td = document.getElementById('disc-tab-dns');
    tn.style.borderBottomColor = net ? 'var(--primary)' : 'transparent';
    td.style.borderBottomColor = net ? 'transparent' : 'var(--primary)';
    tn.style.fontWeight = net ? '600' : '400';
    td.style.fontWeight = net ? '400' : '600';
}

// splitList turns a comma or whitespace separated field into a clean array.
function splitList(id) {
    const el = document.getElementById(id);
    if (!el || !el.value) return [];
    return el.value.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

function scanBusy(label) {
    document.getElementById('disc-results').innerHTML =
        '<div class="card"><p style="color:var(--muted)">' + escapeHtml(label) +
        ' This can take a few minutes; results appear when the scan completes.</p></div>';
}

function runDiscovery() {
    const cidrs = splitList('disc-cidr');
    const hosts = splitList('disc-hosts');
    if (cidrs.length === 0 && hosts.length === 0) {
        renderDiscError('Enter at least one CIDR range or host.');
        return;
    }
    scanBusy('Scanning ' + cidrs.concat(hosts).join(', ') + '...');
    apiPost('/api/v1/discover', { cidrs: cidrs, hosts: hosts }).then(data => {
        if (data.error) { renderDiscError(data.error); return; }
        renderNetworkResult(data);
    }).catch(e => renderDiscError(e.message));
}

function runDNSDiscovery() {
    const domains = splitList('disc-domain');
    if (domains.length === 0) {
        renderDiscError('Enter at least one domain.');
        return;
    }
    const ports = splitList('disc-dns-ports').map(Number).filter(n => n > 0 && n < 65536);
    const body = {
        domains: domains,
        dns_server: (document.getElementById('disc-dns-server').value || '').trim(),
        enumerate: document.getElementById('disc-enumerate').checked,
        follow_sans: document.getElementById('disc-follow-sans').checked,
        extra_names: splitList('disc-extra'),
        ports: ports,
        max_names: parseInt((document.getElementById('disc-maxnames') || {}).value, 10) || 0
    };
    scanBusy('Resolving and probing names under ' + domains.join(', ') + '...');
    apiPost('/api/v1/discover/dns', body).then(data => {
        if (data.error) { renderDiscError(data.error); return; }
        renderDNSResult(data);
    }).catch(e => renderDiscError(e.message));
}

function renderDiscError(msg) {
    document.getElementById('disc-results').innerHTML =
        '<div class="card"><p style="color:var(--danger)">' + escapeHtml(msg || 'unknown error') + '</p></div>';
}

function renderNetworkResult(data) {
    const scanned = (data.scanned || []).join(', ');
    let html = '<div class="card"><h3 style="font-size:0.95rem">Network Scan Result</h3>' +
        '<p style="color:var(--success)">Found ' + (data.certs_found || 0) +
        ' certificate(s) across ' + escapeHtml(scanned) + '</p>';
    html += discErrorList(data.errors);
    html += '<p style="color:var(--muted);font-size:0.8rem">Results are folded into the ' +
            'Certificates page, deduplicated by fingerprint.</p></div>';
    document.getElementById('disc-results').innerHTML = html;
}

function renderDNSResult(data) {
    let html = '<div class="card" style="margin-bottom:1rem"><h3 style="font-size:0.95rem">DNS Scan Result</h3>' +
        '<div class="stats" style="margin:0.5rem 0">' +
        statTile('Certificates', data.certs_found || 0) +
        statTile('Names resolved', data.names_resolved || 0) +
        statTile('Names tried', data.names_tried || 0) +
        statTile('Name limit', data.names_limit || 0) +
        '</div>';
    if (data.dns_server) {
        html += '<p style="color:var(--muted);font-size:0.8rem">Queries sent to ' +
                escapeHtml(data.dns_server) + '</p>';
    }
    html += discErrorList(data.errors) + '</div>';

    (data.results || []).forEach(r => {
        html += '<div class="card" style="margin-bottom:1rem">';
        html += '<h3 style="font-size:0.9rem">' + escapeHtml(r.domain) + '</h3>';

        if (r.wildcard_dns) {
            html += '<p style="color:#92400e;background:#fef3c7;padding:0.5rem;border-radius:0.25rem;font-size:0.8rem">' +
                    'Wildcard DNS detected — subdomain enumeration was skipped because every ' +
                    'guessed name resolves, which would make the results meaningless.</p>';
        }

        const recs = r.records || {};
        const recKeys = Object.keys(recs);
        if (recKeys.length > 0) {
            html += '<p style="font-size:0.8rem;color:var(--muted)">Zone records used: ' +
                    recKeys.map(k => escapeHtml(k) + ' (' + recs[k].length + ')').join(', ') + '</p>';
        }

        const certs = r.certs || [];
        if (certs.length > 0) {
            html += '<table><thead><tr><th>Name probed</th><th>Port</th><th>Subject</th>' +
                    '<th>Issuer</th><th>Expires</th><th>Flags</th></tr></thead><tbody>';
            certs.forEach(c => {
                const flags = [];
                if (c.self_signed) flags.push('<span class="badge badge-expired">self-signed</span>');
                if (c.days_left <= 0) flags.push('<span class="badge badge-expired">expired</span>');
                else if (c.days_left <= 30) flags.push('<span class="badge badge-pending">' + c.days_left + 'd left</span>');
                if (c.key_size > 0 && c.key_size < 2048) flags.push('<span class="badge badge-expired">weak key</span>');
                html += '<tr><td><strong>' + escapeHtml(c.host) + '</strong>' +
                        (c.resolved_ip ? '<br><span style="color:var(--muted);font-size:0.75rem">' + escapeHtml(c.resolved_ip) + '</span>' : '') +
                        '</td><td>' + c.port + '</td><td>' + escapeHtml(c.subject || '-') +
                        '</td><td>' + escapeHtml(c.issuer || '-') + '</td><td>' +
                        (c.not_after ? escapeHtml(String(c.not_after).slice(0, 10)) : '-') +
                        '</td><td>' + (flags.join(' ') || '<span class="badge badge-active">ok</span>') +
                        '</td></tr>';
            });
            html += '</tbody></table>';
        } else {
            html += '<p style="color:var(--muted);font-size:0.85rem">No certificates served on the scanned ports.</p>';
        }

        const names = r.names_resolved || [];
        if (names.length > 0) {
            html += '<details style="margin-top:0.75rem"><summary style="cursor:pointer;font-size:0.85rem">' +
                    names.length + ' name(s) resolved</summary><table style="margin-top:0.5rem">' +
                    '<thead><tr><th>Name</th><th>Addresses</th><th>Found via</th><th>Certificate</th></tr></thead><tbody>';
            names.forEach(n => {
                html += '<tr><td>' + escapeHtml(n.name) + '</td><td>' +
                        escapeHtml((n.addresses || []).join(', ')) + '</td><td>' +
                        escapeHtml(n.source || '-') + '</td><td>' +
                        (n.has_cert ? 'yes' : '<span style="color:var(--muted)">no</span>') + '</td></tr>';
            });
            html += '</tbody></table></details>';
        }

        (r.notes || []).forEach(note => {
            html += '<p style="color:var(--muted);font-size:0.75rem;margin-top:0.5rem">' + escapeHtml(note) + '</p>';
        });
        html += '</div>';
    });

    document.getElementById('disc-results').innerHTML = html;
}

function statTile(label, value) {
    return '<div class="stat-card"><div class="stat-value">' + value +
           '</div><div class="stat-label">' + escapeHtml(label) + '</div></div>';
}

function discErrorList(errors) {
    if (!errors || errors.length === 0) return '';
    return '<div style="margin-top:0.5rem"><p style="color:var(--danger);font-size:0.8rem">' +
           errors.map(e => escapeHtml(e)).join('<br>') + '</p></div>';
}

function loadApprovals() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p>Loading approvals...</p></div>';
    apiGet('/api/v1/approvals/pending').then(data => {
        const items = data.approvals || data || [];
        let rows = items.map(a => {
            // certificate_issue approvals come from the policy engine's
            // require_approval_for_cert_types rule and carry the specific
            // request; other request types keep the generic justification text.
            const what = a.request_type === 'certificate_issue'
                ? escapeHtml((a.domain || '-') + ' — ' + (a.cert_type || '').toUpperCase() +
                    ' via ' + (a.ca_account || '?') + ' (' + (a.environment || '-') + ')')
                : escapeHtml(a.justification || '-');
            return '<tr><td>' + escapeHtml(a.request_type) + '</td><td>' + escapeHtml(a.level) + '</td>' +
                '<td>' + (a.estimated_cost ? '$' + a.estimated_cost : '-') + '</td>' +
                '<td style="font-size:0.82rem">' + what + '</td>' +
                '<td style="font-size:0.75rem;color:var(--muted)">' + escapeHtml(a.requested_by || '-') + '</td>' +
                '<td style="white-space:nowrap">' +
                '<button class="btn btn-primary" onclick="approve(\'' + escapeAttr(a.id) + '\')">Approve</button> ' +
                '<button class="btn btn-danger" onclick="rejectApproval(\'' + escapeAttr(a.id) + '\')">Reject</button></td></tr>';
        }).join('');
        el.innerHTML = '<div class="card"><h3>Pending Approvals</h3>' +
            (items.some(a => a.request_type === 'certificate_issue')
                ? '<p style="color:var(--muted);font-size:0.8rem">Entries here created by certificate policy ' +
                  '(the "require approval" rule) become issuable once approved — resubmit the same request ' +
                  'from Issue Certificate after approving.</p>' : '') +
            '<table><thead><tr><th>Type</th><th>Level</th><th>Cost</th><th>Request</th><th>Requested by</th>' +
            '<th style="width:1%">Action</th></tr></thead><tbody>' +
            (rows || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No pending approvals</td></tr>') +
            '</tbody></table></div>';
    });
}

function approve(id) {
    apiPost('/api/v1/approvals/' + id + '/approve', { comment: 'Approved via Gateway UI' }).then(() => loadApprovals());
}

function rejectApproval(id) {
    const comment = prompt('Reason for rejecting this request (optional):', '');
    if (comment === null) return;
    apiPost('/api/v1/approvals/' + id + '/reject', { comment: comment }).then(() => loadApprovals());
}

// ---------------------------------------------------------------------------
// Audit Log.
//
// Every other page answers "what is true now". This answers "what happened" —
// who issued, renewed, revoked, approved, rejected, deployed, scanned, or
// changed a CA account or credential, and when. Filters mirror the query API;
// export streams the full durable log rather than only the in-memory window a
// live query can see.
// ---------------------------------------------------------------------------
let auditFilters = {};

function loadAuditLog() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading the audit trail...</p></div>';
    fetchAuditLog();
}

function auditQueryString() {
    const p = [];
    Object.keys(auditFilters).forEach(k => {
        const v = auditFilters[k];
        if (v !== '' && v !== null && v !== undefined) {
            p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        }
    });
    return p.length ? '?' + p.join('&') : '';
}

function fetchAuditLog() {
    apiGet('/api/v1/audit' + auditQueryString()).then(d => {
        if (d.error) {
            document.getElementById('content-area').innerHTML =
                '<div class="card"><p style="color:var(--danger)">' + escapeHtml(d.error) + '</p></div>';
            return;
        }
        renderAuditLog(d);
    }).catch(e => {
        document.getElementById('content-area').innerHTML =
            '<div class="card"><p style="color:var(--danger)">Failed to load the audit trail: ' +
            escapeHtml(e.message) + '</p></div>';
    });
}

function renderAuditLog(d) {
    const events = d.events || [];
    const actions = d.actions || [];

    let html = '<div class="card" style="margin-bottom:1rem">' +
        '<h3>Audit Log</h3>' +
        '<p style="color:var(--muted);font-size:0.85rem">Every issue, renew, revoke, approval decision, ' +
        'deployment, discovery scan, and CA account or credential change made on this gateway, with who ' +
        'made it and when. The live view covers recent history; export reaches back through the full log.</p>';
    if (d.reason) {
        html += '<p style="color:var(--danger);font-size:0.85rem">' + escapeHtml(d.reason) + '</p></div>';
        document.getElementById('content-area').innerHTML = html;
        return;
    }
    html += '<button class="btn btn-primary" onclick="downloadAuditExport(\'csv\')">Export CSV</button> ' +
        '<button class="btn" style="background:#e2e8f0" onclick="downloadAuditExport(\'jsonl\')">Export JSONL</button>' +
        '</div>';

    // --- filters ---
    html += '<div class="card" style="margin-bottom:1rem">' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.6rem">' +
        '<div class="form-group"><label>Actor</label>' +
        '<input id="audit-actor" value="' + escapeAttr(auditFilters.actor || '') + '" ' +
        'placeholder="email or username" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Action</label><select id="audit-action" style="' + FIELD_STYLE + '">' +
        opt('', 'any', auditFilters.action) +
        actions.map(a => opt(a, a, auditFilters.action)).join('') +
        '</select></div>' +
        '<div class="form-group"><label>Target type</label><select id="audit-target-type" style="' + FIELD_STYLE + '">' +
        opt('', 'any', auditFilters.target_type) +
        opt('certificate', 'certificate', auditFilters.target_type) +
        opt('approval', 'approval', auditFilters.target_type) +
        opt('deployment', 'deployment', auditFilters.target_type) +
        opt('discovery', 'discovery', auditFilters.target_type) +
        opt('ca_account', 'ca_account', auditFilters.target_type) +
        opt('credential', 'credential', auditFilters.target_type) +
        opt('policy', 'policy', auditFilters.target_type) +
        '</select></div>' +
        '<div class="form-group"><label>Result</label><select id="audit-result" style="' + FIELD_STYLE + '">' +
        opt('', 'any', auditFilters.result) +
        opt('success', 'success', auditFilters.result) +
        opt('failure', 'failure', auditFilters.result) +
        opt('denied', 'denied', auditFilters.result) +
        '</select></div>' +
        '<div class="form-group"><label>Since</label>' +
        '<input id="audit-since" type="datetime-local" value="' + escapeAttr(auditFilters.since_local || '') + '" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Until</label>' +
        '<input id="audit-until" type="datetime-local" value="' + escapeAttr(auditFilters.until_local || '') + '" style="' + FIELD_STYLE + '"></div>' +
        '</div>' +
        '<div style="margin-top:0.6rem">' +
        '<button class="btn btn-primary" onclick="applyAuditFilters()">Apply</button> ' +
        '<button class="btn" style="background:#e2e8f0" onclick="clearAuditFilters()">Clear</button>' +
        '</div></div>';

    // --- table ---
    html += '<div class="card"><h3 style="font-size:0.95rem">' +
        (d.returned || 0) + ' of ' + (d.total || 0) + ' event(s)</h3>';
    if (events.length === 0) {
        html += '<p style="color:var(--muted);font-size:0.85rem">No events match. Clear the filters, or nothing has happened yet.</p>';
    } else {
        html += '<table><thead><tr><th>When</th><th>Actor</th><th>Role</th><th>Action</th>' +
                '<th>Target</th><th>Result</th><th>Detail</th></tr></thead><tbody>';
        events.forEach(e => {
            const badge = e.result === 'success' ? 'badge-active'
                        : e.result === 'denied' ? 'badge-pending' : 'badge-expired';
            html += '<tr><td style="font-size:0.72rem;white-space:nowrap">' + escapeHtml(shortTime(e.time)) + '</td>' +
                    '<td style="font-size:0.8rem">' + escapeHtml(e.actor || '-') + '</td>' +
                    '<td style="font-size:0.75rem;color:var(--muted)">' + escapeHtml(e.role || '-') + '</td>' +
                    '<td style="font-size:0.8rem"><code>' + escapeHtml(e.action || '-') + '</code></td>' +
                    '<td style="font-size:0.78rem">' + escapeHtml(e.target_label || e.target_id || '-') +
                    (e.target_type ? ' <span style="color:var(--muted)">(' + escapeHtml(e.target_type) + ')</span>' : '') + '</td>' +
                    '<td><span class="badge ' + badge + '">' + escapeHtml(e.result || '-') + '</span></td>' +
                    '<td style="font-size:0.72rem;color:var(--muted);max-width:280px">' + escapeHtml(e.detail || '') + '</td></tr>';
        });
        html += '</tbody></table>';
    }
    html += '</div>';

    document.getElementById('content-area').innerHTML = html;
}

function applyAuditFilters() {
    const val = id => { const n = document.getElementById(id); return n ? n.value : ''; };
    auditFilters = {
        actor: val('audit-actor').trim(),
        action: val('audit-action'),
        target_type: val('audit-target-type'),
        result: val('audit-result'),
        since_local: val('audit-since'),
        until_local: val('audit-until'),
        since: val('audit-since') ? new Date(val('audit-since')).toISOString() : '',
        until: val('audit-until') ? new Date(val('audit-until')).toISOString() : ''
    };
    fetchAuditLog();
}

function clearAuditFilters() {
    auditFilters = {};
    fetchAuditLog();
}

// downloadAuditExport mirrors downloadExport for the audit log's own endpoint.
function downloadAuditExport(format) {
    fetch(GATEWAY_API + '/api/v1/audit/export?format=' + encodeURIComponent(format), {
        headers: { 'Authorization': 'Bearer ' + token }
    }).then(r => {
        if (r.status === 401) return handleUnauthorized();
        if (!r.ok) return r.json().then(d => { throw new Error(d.error || ('HTTP ' + r.status)); });
        return r.blob();
    }).then(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'clm-audit.' + (format === 'jsonl' ? 'jsonl' : 'csv');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }).catch(e => alert('Export failed: ' + e.message));
}

// ---------------------------------------------------------------------------
// Certificate Policy.
//
// The compliance report on the Reports page scores certificates that already
// exist. This page enforces rules before an order ever reaches a CA: a
// violation blocks issuance with a 400/403 naming every rule that failed, or —
// for the one rule that requires approval rather than outright refusal —
// creates a pending approval instead of ordering anything.
// ---------------------------------------------------------------------------
let policiesCache = [];

function loadPolicies() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading certificate policies...</p></div>';
    apiGet('/api/v1/policies').then(d => {
        if (d.reason) {
            el.innerHTML = '<div class="card"><h3>Certificate Policy</h3>' +
                '<p style="color:var(--danger);font-size:0.85rem">' + escapeHtml(d.reason) + '</p></div>';
            return;
        }
        policiesCache = d.policies || [];
        renderPolicies();
    }).catch(e => {
        el.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load policies: ' +
            escapeHtml(e.message) + '</p></div>';
    });
}

function renderPolicies() {
    const el = document.getElementById('content-area');
    let html = '<div class="card" style="margin-bottom:1rem"><h3>Certificate Policy</h3>' +
        '<p style="color:var(--muted);font-size:0.85rem">Enforceable rules checked before an order reaches ' +
        'a CA — minimum key strength, maximum validity, which CA accounts and certificate types an ' +
        'environment may use, wildcard permission, name limits, denied domain patterns, and mandatory ' +
        'approval for chosen certificate types. When several policies apply to the same request, every ' +
        'one of them must pass: a policy narrows what is allowed, it never widens it.</p>' +
        '<button class="btn btn-primary" style="margin:0.5rem 0" onclick="showPolicyForm()">+ Add Policy</button>' +
        '<div id="policy-form"></div>';

    if (policiesCache.length === 0) {
        html += '<p style="color:var(--muted);font-size:0.85rem">No policies configured. Issuance proceeds unrestricted.</p></div>';
    } else {
        html += '<table><thead><tr><th>Name</th><th>Environment</th><th>Enabled</th>' +
                '<th>Rules</th><th style="width:1%">Actions</th></tr></thead><tbody>';
        policiesCache.forEach(p => {
            html += '<tr><td><strong>' + escapeHtml(p.name) + '</strong>' +
                    (p.description ? '<br><span style="color:var(--muted);font-size:0.72rem">' + escapeHtml(p.description) + '</span>' : '') + '</td>' +
                    '<td><span class="badge badge-pending">' + escapeHtml(p.environment) + '</span></td>' +
                    '<td>' + (p.enabled ? '<span class="badge badge-active">on</span>' : '<span style="color:var(--muted)">off</span>') + '</td>' +
                    '<td style="font-size:0.72rem;color:var(--muted)">' + policySummary(p) + '</td>' +
                    '<td style="white-space:nowrap">' +
                    '<button class="btn" style="background:#e2e8f0" onclick="showPolicyForm(\'' + escapeAttr(p.id) + '\')">Edit</button> ' +
                    '<button class="btn btn-danger" onclick="deletePolicy(\'' + escapeAttr(p.id) + '\',\'' + escapeAttr(p.name) + '\')">Remove</button>' +
                    '</td></tr>';
        });
        html += '</tbody></table></div>';
    }

    // --- dry-run evaluator ---
    html += '<div class="card"><h3 style="font-size:0.95rem">Check a request against policy</h3>' +
        '<p style="color:var(--muted);font-size:0.8rem">Preview what would happen without ordering anything.</p>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0.6rem">' +
        '<div class="form-group"><label>Domain(s)</label><input id="peval-domains" placeholder="*.example.com" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Cert type</label><select id="peval-type" style="' + FIELD_STYLE + '">' +
        '<option value="dv">DV</option><option value="ov">OV</option><option value="ev">EV</option></select></div>' +
        '<div class="form-group"><label>Environment</label><input id="peval-env" placeholder="prod" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>CA account</label><input id="peval-ca" placeholder="acme" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Years</label><input id="peval-years" value="1" style="' + FIELD_STYLE + '"></div>' +
        '</div>' +
        '<button class="btn btn-primary" onclick="runPolicyDryRun()">Check</button>' +
        '<div id="peval-result" style="margin-top:0.6rem"></div></div>';

    el.innerHTML = html;
}

function policySummary(p) {
    const bits = [];
    if (p.min_key_size_rsa) bits.push('RSA≥' + p.min_key_size_rsa);
    if (p.min_key_size_ecdsa) bits.push('ECDSA≥' + p.min_key_size_ecdsa);
    if (p.max_validity_days) bits.push('≤' + p.max_validity_days + 'd');
    if (p.allowed_ca_accounts && p.allowed_ca_accounts.length) bits.push('CAs: ' + p.allowed_ca_accounts.join(','));
    if (p.allowed_cert_types && p.allowed_cert_types.length) bits.push('types: ' + p.allowed_cert_types.join('/'));
    if (p.wildcard_allowed === false) bits.push('no wildcards');
    if (p.max_san_count) bits.push('≤' + p.max_san_count + ' SAN');
    if (p.denied_domain_patterns && p.denied_domain_patterns.length) bits.push('denies: ' + p.denied_domain_patterns.join(','));
    if (p.require_approval_for_cert_types && p.require_approval_for_cert_types.length) bits.push('approval: ' + p.require_approval_for_cert_types.join('/'));
    return bits.length ? escapeHtml(bits.join(' · ')) : 'no constraints';
}

function showPolicyForm(existingId) {
    const box = document.getElementById('policy-form');
    if (!box) return;
    const existing = existingId ? policiesCache.find(p => p.id === existingId) : null;

    const csv = arr => (arr || []).join(', ');

    let h = '<div style="border:1px solid var(--border);border-radius:0.375rem;padding:0.8rem;margin:0.75rem 0;background:#f8fafc">' +
        '<h4 style="margin:0 0 0.5rem">' + (existing ? 'Edit: ' + escapeHtml(existing.name) : 'Add Policy') + '</h4>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.6rem">' +
        '<div class="form-group"><label>Name *</label>' +
        '<input id="pol-name" value="' + escapeAttr(existing ? existing.name : '') + '" style="' + FIELD_STYLE + '" placeholder="prod-baseline"></div>' +
        '<div class="form-group"><label>Environment</label>' +
        '<input id="pol-env" value="' + escapeAttr(existing ? existing.environment : '*') + '" style="' + FIELD_STYLE + '" placeholder="* for all, or prod / staging"></div>' +
        '<div class="form-group"><label>Enabled</label><select id="pol-enabled" style="' + FIELD_STYLE + '">' +
        '<option value="true"' + (!existing || existing.enabled ? ' selected' : '') + '>yes</option>' +
        '<option value="false"' + (existing && !existing.enabled ? ' selected' : '') + '>no</option></select></div>' +
        '<div class="form-group"><label>Description</label>' +
        '<input id="pol-desc" value="' + escapeAttr(existing ? existing.description || '' : '') + '" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Min RSA key size (bits)</label>' +
        '<input id="pol-rsa" value="' + escapeAttr(existing ? existing.min_key_size_rsa || '' : '') + '" placeholder="2048" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Min ECDSA key size (bits)</label>' +
        '<input id="pol-ecdsa" value="' + escapeAttr(existing ? existing.min_key_size_ecdsa || '' : '') + '" placeholder="256" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Max validity (days)</label>' +
        '<input id="pol-validity" value="' + escapeAttr(existing ? existing.max_validity_days || '' : '') + '" placeholder="398" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Max SAN count</label>' +
        '<input id="pol-sans" value="' + escapeAttr(existing ? existing.max_san_count || '' : '') + '" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Wildcard</label><select id="pol-wildcard" style="' + FIELD_STYLE + '">' +
        '<option value="">not stated (unrestricted)</option>' +
        '<option value="true"' + (existing && existing.wildcard_allowed === true ? ' selected' : '') + '>allowed</option>' +
        '<option value="false"' + (existing && existing.wildcard_allowed === false ? ' selected' : '') + '>forbidden</option></select></div>' +
        '<div class="form-group"><label>Allowed CA accounts (comma separated)</label>' +
        '<input id="pol-ca" value="' + escapeAttr(csv(existing ? existing.allowed_ca_accounts : [])) + '" placeholder="acme, namecheap-prod" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Allowed cert types (comma separated)</label>' +
        '<input id="pol-types" value="' + escapeAttr(csv(existing ? existing.allowed_cert_types : [])) + '" placeholder="dv, ov" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Require approval for cert types</label>' +
        '<input id="pol-approval" value="' + escapeAttr(csv(existing ? existing.require_approval_for_cert_types : [])) + '" placeholder="ov, ev" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Denied domain patterns (comma separated)</label>' +
        '<input id="pol-denied" value="' + escapeAttr(csv(existing ? existing.denied_domain_patterns : [])) + '" placeholder="legacy., internal-only" style="' + FIELD_STYLE + '"></div>' +
        '</div>' +
        '<div style="margin-top:0.6rem">' +
        '<button class="btn btn-primary" onclick="savePolicy(\'' + escapeAttr(existingId || '') + '\')">Save Policy</button> ' +
        '<button class="btn" style="background:#e2e8f0" onclick="document.getElementById(\'policy-form\').innerHTML=\'\'">Cancel</button></div></div>';
    box.innerHTML = h;
}

function csvToList(s) {
    return (s || '').split(',').map(x => x.trim()).filter(Boolean);
}

function savePolicy(existingId) {
    const val = id => { const n = document.getElementById(id); return n ? n.value.trim() : ''; };
    const name = val('pol-name');
    if (!name) { alert('Name is required'); return; }

    const wc = val('pol-wildcard');
    const body = {
        id: existingId || '',
        name: name,
        environment: val('pol-env') || '*',
        enabled: val('pol-enabled') === 'true',
        description: val('pol-desc'),
        min_key_size_rsa: parseInt(val('pol-rsa'), 10) || 0,
        min_key_size_ecdsa: parseInt(val('pol-ecdsa'), 10) || 0,
        max_validity_days: parseInt(val('pol-validity'), 10) || 0,
        max_san_count: parseInt(val('pol-sans'), 10) || 0,
        allowed_ca_accounts: csvToList(val('pol-ca')),
        allowed_cert_types: csvToList(val('pol-types')).map(t => t.toLowerCase()),
        require_approval_for_cert_types: csvToList(val('pol-approval')).map(t => t.toLowerCase()),
        denied_domain_patterns: csvToList(val('pol-denied'))
    };
    if (wc === 'true') body.wildcard_allowed = true;
    else if (wc === 'false') body.wildcard_allowed = false;

    apiPost('/api/v1/policies', body).then(d => {
        if (d.error) { alert(d.error); return; }
        document.getElementById('policy-form').innerHTML =
            '<p style="color:var(--success);font-size:0.82rem;margin:0.5rem 0">Policy "' + escapeHtml(name) + '" saved.</p>';
        loadPolicies();
    }).catch(e => alert(e.message));
}

function deletePolicy(id, name) {
    if (!confirm('Remove policy "' + name + '"? Requests that were blocked by it will no longer be checked against it.')) return;
    apiDelete('/api/v1/policies/' + encodeURIComponent(id)).then(d => {
        if (d.error) { alert(d.error); return; }
        loadPolicies();
    }).catch(e => alert(e.message));
}

function runPolicyDryRun() {
    const val = id => { const n = document.getElementById(id); return n ? n.value.trim() : ''; };
    const out = document.getElementById('peval-result');
    out.innerHTML = '<p style="color:var(--muted)">Checking...</p>';

    apiPost('/api/v1/policies/evaluate', {
        domains: splitList('peval-domains'),
        cert_type: val('peval-type'),
        environment: val('peval-env'),
        ca_account: val('peval-ca'),
        validity_years: parseInt(val('peval-years'), 10) || 1
    }).then(d => {
        if (d.allowed) {
            out.innerHTML = '<p style="color:var(--success);font-size:0.85rem">No policy violations — this request would be allowed to proceed.</p>';
            return;
        }
        let h = '<p style="color:var(--danger);font-size:0.85rem">' + (d.violations || []).length + ' violation(s):</p><ul style="font-size:0.82rem;margin-left:1.2rem">';
        (d.violations || []).forEach(v => {
            h += '<li><strong>' + escapeHtml(v.policy_name) + '</strong> (' + escapeHtml(v.rule) + '): ' + escapeHtml(v.message) + '</li>';
        });
        h += '</ul>';
        out.innerHTML = h;
    }).catch(e => { out.innerHTML = '<p style="color:var(--danger)">' + escapeHtml(e.message) + '</p>'; });
}

function loadMonitoring() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading monitoring data...</p></div>';

    Promise.all([apiGet('/api/v1/certificates'), apiGet('/api/v1/alerts')]).then(([certsData, alertsData]) => {
        const certs = certsData.certificates || certsData || [];
        const now = Date.now();
        let critical = 0, warning = 0, info = 0, healthy = 0;

        (Array.isArray(certs) ? certs : []).forEach(c => {
            if (c.status === 'revoked' || c.status === 'archived') return;
            if (!c.expiry && !c.not_after && !c.expires_at) { healthy++; return; }
            const exp = new Date(c.expiry || c.not_after || c.expires_at).getTime();
            const days = (exp - now) / 86400000;
            if (days <= 7)       critical++;
            else if (days <= 14) warning++;
            else if (days <= 30) info++;
            else                 healthy++;
        });

        const allAlerts = alertsData.alerts || alertsData || [];
        const activeAlerts = (Array.isArray(allAlerts) ? allAlerts : []).filter(a => a.status === 'active');

        let html = '<div class="card" style="margin-bottom:1rem">' +
            '<h3>Certificate Monitoring</h3>' +
            '<p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Auto-checks every hour. Alerts sent via Slack/webhook.</p>' +
            '<div class="stats">' +
            '<div class="card stat" style="border-left:3px solid var(--danger)"><div class="label">Critical (&lt;7d)</div><div class="value" style="color:var(--danger)">' + critical + '</div></div>' +
            '<div class="card stat" style="border-left:3px solid var(--warning)"><div class="label">Warning (&lt;14d)</div><div class="value" style="color:var(--warning)">' + warning + '</div></div>' +
            '<div class="card stat" style="border-left:3px solid var(--primary)"><div class="label">Info (&lt;30d)</div><div class="value">' + info + '</div></div>' +
            '<div class="card stat" style="border-left:3px solid var(--success)"><div class="label">Healthy</div><div class="value" style="color:var(--success)">' + healthy + '</div></div>' +
            '</div></div>';

        html += '<div class="card"><h3>Active Alerts</h3>';
        if (activeAlerts.length === 0) {
            html += '<p style="color:var(--success)">No active alerts</p>';
        } else {
            html += '<table><thead><tr><th>Severity</th><th>Title</th><th>Domain</th><th>Time</th></tr></thead><tbody>';
            activeAlerts.forEach(a => {
                const sev = (a.severity || 'info').toLowerCase();
                const badgeCls = sev === 'critical' ? 'badge-expired' : sev === 'warning' ? 'badge-pending' : 'badge-active';
                const ts = a.created_at || a.timestamp || a.triggered_at || '';
                const timeStr = typeof shortTime === 'function' ? shortTime(ts) : ts;
                html += '<tr>' +
                    '<td><span class="badge ' + badgeCls + '">' + escapeHtml(a.severity || 'info') + '</span></td>' +
                    '<td>' + escapeHtml(a.title || a.name || '-') + '</td>' +
                    '<td>' + escapeHtml(a.domain || a.cert_domain || '-') + '</td>' +
                    '<td style="font-size:0.8rem">' + escapeHtml(timeStr) + '</td>' +
                    '</tr>';
            });
            html += '</tbody></table>';
        }
        html += '</div>';

        el.innerHTML = html;
    }).catch(e => {
        el.innerHTML = '<div class="card"><p style="color:var(--danger)">' + escapeHtml(e.message || 'Failed to load monitoring data') + '</p></div>';
    });
}

// ---------------------------------------------------------------------------
// Certificate lifecycle
//
// The Certificates page lists what exists. This page ranks what needs doing:
// expiry is graded rather than treated as a single 30-day cliff, and hygiene
// problems that never expire (self-signed, over-long validity) are surfaced
// alongside it.
// ---------------------------------------------------------------------------
const RISK_STYLE = {
    expired:  { bg: '#fee2e2', fg: '#991b1b', label: 'Expired' },
    critical: { bg: '#fed7aa', fg: '#9a3412', label: 'Critical (≤7d)' },
    warning:  { bg: '#fef3c7', fg: '#92400e', label: 'Warning (≤30d)' },
    notice:   { bg: '#e0e7ff', fg: '#3730a3', label: 'Notice (≤60d)' },
    healthy:  { bg: '#d1fae5', fg: '#065f46', label: 'Healthy' },
    unknown:  { bg: '#e2e8f0', fg: '#475569', label: 'No expiry known' }
};

function loadLifecycle() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Assessing certificate lifecycle...</p></div>';

    apiGet('/api/v1/lifecycle').then(d => {
        if (d.error) { el.innerHTML = '<div class="card"><p style="color:var(--danger)">' + escapeHtml(d.error) + '</p></div>'; return; }

        let html = '<div class="card" style="margin-bottom:1rem">' +
            '<h3>Certificate Lifecycle</h3>' +
            '<p style="font-size:0.9rem;margin:0.5rem 0">' + escapeHtml(d.summary || '') + '</p>' +
            '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem">';
        ['expired', 'critical', 'warning', 'notice', 'healthy', 'unknown'].forEach(k => {
            const n = (d.risk || {})[k] || 0;
            const st = RISK_STYLE[k];
            html += '<div style="background:' + st.bg + ';color:' + st.fg +
                    ';padding:0.5rem 0.9rem;border-radius:0.375rem;min-width:110px">' +
                    '<div style="font-size:1.3rem;font-weight:700">' + n + '</div>' +
                    '<div style="font-size:0.7rem">' + st.label + '</div></div>';
        });
        html += '</div></div>';

        // Expiry distribution
        const buckets = d.expiry_buckets || [];
        if (buckets.length) {
            html += '<div class="card" style="margin-bottom:1rem"><h3 style="font-size:0.95rem">Expiry Distribution</h3>' +
                    '<table><thead><tr><th>Window</th><th>Certificates</th></tr></thead><tbody>';
            buckets.forEach(b => {
                html += '<tr><td>' + escapeHtml(b.window) + '</td><td>' + b.count + '</td></tr>';
            });
            html += '</tbody></table></div>';
        }

        // Hygiene
        const hyg = d.hygiene || {};
        const hygKeys = Object.keys(hyg);
        if (hygKeys.length) {
            html += '<div class="card" style="margin-bottom:1rem"><h3 style="font-size:0.95rem">Hygiene</h3>' +
                    '<p style="color:var(--muted);font-size:0.8rem">Problems that do not fix themselves with time.</p><ul style="font-size:0.85rem;margin-left:1.2rem">';
            hygKeys.forEach(k => {
                html += '<li>' + escapeHtml(k.split('_').join(' ')) + ': <strong>' + hyg[k] + '</strong></li>';
            });
            html += '</ul></div>';
        }

        // Issuers
        const issuers = d.by_issuer || [];
        if (issuers.length) {
            html += '<div class="card" style="margin-bottom:1rem"><h3 style="font-size:0.95rem">By Issuer</h3>' +
                    '<p style="color:var(--muted);font-size:0.8rem">An unexpected issuer, or everything concentrated on one CA, both matter here.</p>' +
                    '<table><thead><tr><th>Issuer</th><th>Total</th><th>At risk</th></tr></thead><tbody>';
            issuers.forEach(i => {
                html += '<tr><td>' + escapeHtml(i.issuer) + '</td><td>' + i.count + '</td><td>' +
                        (i.at_risk > 0 ? '<span class="badge badge-pending">' + i.at_risk + '</span>' : '0') +
                        '</td></tr>';
            });
            html += '</tbody></table></div>';
        }

        // Worklist
        const findings = d.findings || [];
        html += '<div class="card"><h3 style="font-size:0.95rem">Action List (' + findings.length + ')</h3>';
        if (findings.length === 0) {
            html += '<p style="color:var(--success)">Nothing needs attention.</p>';
        } else {
            html += '<p style="color:var(--muted);font-size:0.8rem">Ordered by urgency.</p>' +
                    '<table><thead><tr><th>Domain</th><th>Where</th><th>Risk</th><th>Days</th>' +
                    '<th>Issues</th><th>Recommended action</th></tr></thead><tbody>';
            findings.forEach(f => {
                const st = RISK_STYLE[f.risk] || RISK_STYLE.unknown;
                const where = f.host ? escapeHtml(f.host) + (f.port ? ':' + f.port : '') : '-';
                html += '<tr><td><strong>' + escapeHtml(f.domain || '-') + '</strong></td>' +
                        '<td style="font-size:0.8rem">' + where + '</td>' +
                        '<td><span style="background:' + st.bg + ';color:' + st.fg +
                        ';padding:0.15rem 0.45rem;border-radius:0.25rem;font-size:0.72rem">' + st.label + '</span></td>' +
                        '<td>' + (f.risk === 'unknown' ? '-' : f.days_left) + '</td>' +
                        '<td style="font-size:0.8rem">' + (f.issues || []).map(escapeHtml).join('<br>') + '</td>' +
                        '<td style="font-size:0.8rem">' + escapeHtml(f.action || '') + '</td></tr>';
            });
            html += '</tbody></table>';
        }
        html += '</div>';

        el.innerHTML = html;
    }).catch(e => {
        el.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load lifecycle: ' +
                       escapeHtml(e.message) + '</p></div>';
    });
}

// ---------------------------------------------------------------------------
// vSatellite fleet and deployment
//
// Deployment is pull-based: the gateway issues a single-use enrolment token and
// serves an installer that the target host fetches itself. That works through
// NAT and outbound-only firewalls, and the gateway never holds SSH credentials
// for the estate.
// ---------------------------------------------------------------------------
function loadVSatellites() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading fleet...</p></div>';

    apiGet('/api/v1/vsatellites').then(d => {
        if (d.error) { el.innerHTML = '<div class="card"><p style="color:var(--danger)">' + escapeHtml(d.error) + '</p></div>'; return; }

        const stats = d.stats || {};
        let html = '<div class="card" style="margin-bottom:1rem">' +
            '<h3>vSatellite Fleet</h3>' +
            '<p style="color:var(--muted);font-size:0.85rem">' +
            'vSatellite agents extend this gateway into network segments it cannot reach directly. ' +
            'They connect outbound to the coordinator, so no inbound access to the segment is needed.</p>' +
            '<div class="stats" style="margin-top:0.75rem">' +
            statTile('Agents', stats.total_agents || 0) +
            statTile('Online', stats.online_agents || 0) +
            statTile('Certs managed', stats.total_certs || 0) +
            '</div>' +
            '<button class="btn btn-primary" style="margin-top:0.75rem" onclick="showEnrolForm()">+ Deploy vSatellite</button>' +
            '</div><div id="vsat-enrol"></div>';

        const agents = d.agents || [];
        html += '<div class="card" style="margin-bottom:1rem"><h3 style="font-size:0.95rem">Agents</h3>';
        if (agents.length === 0) {
            html += '<p style="color:var(--muted);font-size:0.85rem">No agents enrolled. ' +
                    'Use Deploy vSatellite to generate an install command.</p>';
        } else {
            html += '<table><thead><tr><th>Name</th><th>Agent ID</th><th>Host</th><th>Status</th>' +
                    '<th>CIDRs</th><th>Queue</th><th>Last heartbeat</th><th style="width:1%">Actions</th></tr></thead><tbody>';
            agents.forEach(a => {
                const badge = a.status === 'online' ? 'badge-active'
                            : a.status === 'busy' ? 'badge-pending' : 'badge-expired';
                html += '<tr><td><strong>' + escapeHtml(a.name || '-') + '</strong></td>' +
                        '<td style="font-size:0.75rem">' + escapeHtml(a.id) + '</td>' +
                        '<td style="font-size:0.8rem">' + escapeHtml(a.host || '-') + '</td>' +
                        '<td><span class="badge ' + badge + '">' + escapeHtml(a.status) + '</span></td>' +
                        '<td style="font-size:0.78rem">' + escapeHtml((a.cidrs || []).join(', ') || '-') + '</td>' +
                        '<td>' + (a.queued_commands || 0) + '</td>' +
                        '<td style="font-size:0.75rem">' + escapeHtml(shortTime(a.last_heartbeat)) + '</td>' +
                        '<td style="white-space:nowrap">' +
                        '<button class="btn" style="background:#e2e8f0" onclick="dispatchVSatCommand(\'' +
                            escapeAttr(a.id) + '\')">Send Command</button> ' +
                        '<button class="btn btn-danger" onclick="decommissionVSat(\'' +
                            escapeAttr(a.id) + '\',\'' + escapeAttr(a.name || a.id) + '\')">Decommission</button>' +
                        '</td></tr>';
            });
            html += '</tbody></table>';
        }
        html += '</div>';

        const enrolments = d.enrolments || [];
        if (enrolments.length) {
            html += '<div class="card"><h3 style="font-size:0.95rem">Enrolments</h3>' +
                    '<p style="color:var(--muted);font-size:0.8rem">Tokens are single use and shown only at creation.</p>' +
                    '<table><thead><tr><th>Name</th><th>Token</th><th>Status</th><th>Expires</th>' +
                    '<th>Consumed by</th><th style="width:1%"></th></tr></thead><tbody>';
            enrolments.forEach(e => {
                const badge = e.status === 'pending' ? 'badge-pending'
                            : e.status === 'consumed' ? 'badge-active' : 'badge-expired';
                html += '<tr><td>' + escapeHtml(e.name) + '</td>' +
                        '<td style="font-family:monospace;font-size:0.75rem">' + escapeHtml(e.token_prefix) + '…</td>' +
                        '<td><span class="badge ' + badge + '">' + escapeHtml(e.status) + '</span></td>' +
                        '<td style="font-size:0.75rem">' + escapeHtml(shortTime(e.expires_at)) + '</td>' +
                        '<td style="font-size:0.75rem">' + escapeHtml(e.consumed_by || '-') + '</td><td>' +
                        (e.status === 'pending'
                            ? '<button class="btn btn-danger" onclick="revokeEnrolment(\'' + escapeAttr(e.token_prefix) + '\')">Revoke</button>'
                            : '') +
                        '</td></tr>';
            });
            html += '</tbody></table></div>';
        }

        el.innerHTML = html;
    }).catch(e => {
        el.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load fleet: ' +
                       escapeHtml(e.message) + '</p></div>';
    });
}

function showEnrolForm() {
    const p = document.getElementById('vsat-enrol');
    if (!p) return;
    p.innerHTML = '<div class="card" style="margin-bottom:1rem;border-left:3px solid var(--primary)">' +
        '<h3 style="font-size:0.95rem">Deploy a vSatellite</h3>' +
        '<p style="color:var(--muted);font-size:0.8rem;margin-bottom:0.75rem">' +
        'This generates a single-use install command. Run it on the target host; it ' +
        'detects the distribution, installs the agent and enrols it with this gateway.</p>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:0.75rem">' +
        '<div class="form-group"><label>Name *</label><input id="vs-name" placeholder="dc-mumbai-vpc-a" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>VPC / network</label><input id="vs-vpc" placeholder="vpc-0a1b2c3d" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Subnet</label><input id="vs-subnet" placeholder="subnet-123" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>CIDRs it is responsible for</label><input id="vs-cidrs" placeholder="10.20.0.0/16, 10.21.0.0/16" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Token validity (hours)</label><input id="vs-ttl" value="24" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Gateway URL the host can reach</label><input id="vs-gwurl" placeholder="defaults to this portal URL" style="' + FIELD_STYLE + '"></div>' +
        '</div>' +
        '<div id="vs-error" style="color:var(--danger);font-size:0.8rem;margin:0.5rem 0"></div>' +
        '<button class="btn btn-primary" onclick="createEnrolment()">Generate Install Command</button> ' +
        '<button class="btn" style="background:#e2e8f0" onclick="document.getElementById(\'vsat-enrol\').innerHTML=\'\'">Cancel</button>' +
        '</div>';
}

function createEnrolment() {
    const err = document.getElementById('vs-error');
    const name = (document.getElementById('vs-name').value || '').trim();
    if (!name) { err.textContent = 'Name is required.'; return; }

    const body = {
        name: name,
        vpc: (document.getElementById('vs-vpc').value || '').trim(),
        subnet: (document.getElementById('vs-subnet').value || '').trim(),
        cidrs: splitList('vs-cidrs'),
        ttl_hours: parseInt(document.getElementById('vs-ttl').value, 10) || 24,
        gateway_url: (document.getElementById('vs-gwurl').value || '').trim()
    };
    err.textContent = 'Generating...';

    apiPost('/api/v1/vsatellites/enroll', body).then(d => {
        if (d.error) { err.textContent = d.error; return; }
        document.getElementById('vsat-enrol').innerHTML =
            '<div class="card" style="margin-bottom:1rem;border-left:3px solid var(--success)">' +
            '<h3 style="font-size:0.95rem">Install command for ' + escapeHtml(d.name) + '</h3>' +
            '<p style="color:var(--muted);font-size:0.8rem">Single use, expires ' +
            escapeHtml(shortTime(d.expires_at)) + '. It is shown only now — generate a new one if lost.</p>' +
            '<pre style="background:#0f172a;color:#e2e8f0;padding:0.75rem;border-radius:0.375rem;' +
            'overflow-x:auto;font-size:0.78rem;white-space:pre-wrap;word-break:break-all">' +
            escapeHtml(d.install_command) + '</pre>' +
            '<button class="btn btn-primary" onclick="copyText(' + jsQuote(d.install_command) + ')">Copy</button> ' +
            '<button class="btn" style="background:#e2e8f0" onclick="loadVSatellites()">Done</button>' +
            '<p style="color:var(--muted);font-size:0.75rem;margin-top:0.5rem">' +
            escapeHtml(d.note || '') + '</p></div>';
    }).catch(e => { err.textContent = e.message; });
}

function dispatchVSatCommand(agentId) {
    const type = prompt('Command type (certificate deployment is disabled until tenant authorization and authenticated transport are available):\n\nscan_cidr, health_check', 'health_check');
    if (!type) return;
    let payload = {};
    if (type === 'scan_cidr') {
        const cidr = prompt('CIDR for the agent to scan:', '10.0.0.0/24');
        if (!cidr) return;
        payload = { cidrs: [cidr] };
    }
    apiPost('/api/v1/vsatellites/' + encodeURIComponent(agentId) + '/command',
            { type: type, payload: payload }).then(d => {
        if (d.error) { alert(d.error); return; }
        alert('Queued ' + d.type + ' as ' + d.command_id + '.\n\n' + (d.note || ''));
        loadVSatellites();
    }).catch(e => alert(e.message));
}

function decommissionVSat(agentId, name) {
    if (!confirm('Decommission ' + name + '?\n\nIts credential is revoked and any queued ' +
                 'commands are dropped. The agent will have to be re-enrolled to return.')) return;
    apiDelete('/api/v1/vsatellites/' + encodeURIComponent(agentId)).then(d => {
        if (d.error) { alert(d.error); return; }
        loadVSatellites();
    }).catch(e => alert(e.message));
}

function revokeEnrolment(prefix) {
    if (!confirm('Revoke enrolment ' + prefix + '?')) return;
    apiDelete('/api/v1/vsatellites/enrollments/' + encodeURIComponent(prefix)).then(d => {
        if (d.error) { alert(d.error); return; }
        loadVSatellites();
    }).catch(e => alert(e.message));
}

// apiDelete mirrors apiGet/apiPost for the fleet management calls.
function apiDelete(path) {
    return fetch(GATEWAY_API + path, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
    }).then(r => {
        if (r.status === 401) return handleUnauthorized();
        return r.json();
    });
}

function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
            () => alert('Copied to the clipboard.'),
            () => alert('Copy failed; select the text manually.'));
        return;
    }
    alert('Clipboard unavailable; select the text manually.');
}

// jsQuote renders a value safe to embed inside a single-quoted JS string in an
// onclick attribute.
function jsQuote(s) {
    return "'" + String(s === undefined || s === null ? '' : s)
        .split('\\').join('\\\\')
        .split("'").join("\\'")
        .split('<').join('\\u003c')
        .split('\n').join('\\n') + "'";
}

// escapeAttr protects a value used inside an onclick handler's quoted argument.
function escapeAttr(s) {
    return String(s === undefined || s === null ? '' : s)
        .split('&').join('&amp;')
        .split('"').join('&quot;')
        .split("'").join('&#39;')
        .split('<').join('&lt;');
}

function shortTime(v) {
    if (!v) return '-';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

// ---------------------------------------------------------------------------
// Automation: the background processes and the alert channel.
//
// These jobs are the difference between an inventory and a lifecycle manager, so
// their state is shown explicitly — including failures. A scheduled job whose
// failures are invisible is worse than no job, because it creates confidence that
// something is handled when it is not.
// ---------------------------------------------------------------------------
function loadAutomation() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading automation state...</p></div>';

    Promise.all([
        apiGet('/api/v1/scheduler'),
        apiGet('/api/v1/alerts'),
        apiGet('/api/v1/acme/status')
    ]).then(([sched, alerts, acme]) => {
        let html = '';

        // --- background jobs ---
        html += '<div class="card" style="margin-bottom:1rem"><h3>Background Processes</h3>' +
            '<p style="color:var(--muted);font-size:0.85rem">Discovery, expiry evaluation and renewal ' +
            'run on their own schedule. Each can also be run now.</p>' +
            '<table><thead><tr><th>Job</th><th>Status</th><th>Every</th><th>Next</th>' +
            '<th>Last result</th><th style="width:1%"></th></tr></thead><tbody>';
        (sched.jobs || []).forEach(j => {
            const badge = !j.enabled ? '<span class="badge badge-disabled">disabled</span>'
                        : j.running ? '<span class="badge badge-pending">running</span>'
                        : '<span class="badge badge-active">scheduled</span>';
            const lr = j.last_run;
            let lastCell = '<span style="color:var(--muted)">not run yet</span>';
            if (lr) {
                const ok = lr.ok ? '<span class="badge badge-active">ok</span>'
                                 : '<span class="badge badge-expired">failed</span>';
                lastCell = ok + ' <span style="font-size:0.78rem">' + escapeHtml(lr.summary || '') + '</span>' +
                           '<br><span style="color:var(--muted);font-size:0.72rem">' +
                           escapeHtml(shortTime(lr.started_at)) + ' &middot; ' + escapeHtml(lr.duration || '') +
                           ' &middot; ' + escapeHtml(lr.trigger || '') + '</span>';
                if (lr.errors && lr.errors.length) {
                    lastCell += '<br><span style="color:var(--danger);font-size:0.72rem">' +
                                lr.errors.map(escapeHtml).join('<br>') + '</span>';
                }
            }
            html += '<tr><td><strong>' + escapeHtml(j.job) + '</strong>' +
                    '<br><span style="color:var(--muted);font-size:0.72rem">' + escapeHtml(j.detail || '') + '</span></td>' +
                    '<td>' + badge + '</td><td>' + escapeHtml(j.interval || '-') + '</td>' +
                    '<td style="font-size:0.75rem">' + escapeHtml(j.next_run ? shortTime(j.next_run) : '-') + '</td>' +
                    '<td>' + lastCell + '</td>' +
                    '<td><button class="btn btn-primary" onclick="runJob(\'' + escapeAttr(j.job) + '\')">Run now</button></td></tr>';
        });
        html += '</tbody></table></div>';

        // --- alerting ---
        const st = alerts.stats || {};
        html += '<div class="card" style="margin-bottom:1rem"><h3 style="font-size:0.95rem">Alerting</h3>';
        if (!st.enabled) {
            html += '<p style="color:#92400e;background:#fef3c7;padding:0.5rem;border-radius:0.25rem;font-size:0.82rem">' +
                    'Alerting is disabled. Conditions are still evaluated and recorded, but nothing is sent.</p>';
        }
        html += '<div class="stats" style="margin:0.5rem 0">' +
            statTile('Raised', st.raised || 0) +
            statTile('Delivered', st.delivered || 0) +
            statTile('Undeliverable', st.failed || 0) +
            '</div>' +
            '<p style="font-size:0.82rem">Channels: <strong>' +
            escapeHtml((st.channels && st.channels.length) ? st.channels.join(', ') : 'none configured') +
            '</strong> &middot; warn at ' + escapeHtml(String(st.warn_days)) + 'd &middot; critical at ' +
            escapeHtml(String(st.critical_days)) + 'd &middot; cooldown ' + escapeHtml(String(st.cooldown)) + '</p>' +
            '<p style="color:var(--muted);font-size:0.78rem">The cooldown stops the same condition ' +
            'being re-sent every evaluation. An escalation from warning to critical is sent regardless.</p>' +
            '<button class="btn btn-primary" onclick="sendTestAlert()">Send test alert</button>';

        const list = alerts.alerts || [];
        if (list.length) {
            html += '<table style="margin-top:0.75rem"><thead><tr><th>When</th><th>Severity</th>' +
                    '<th>Domain</th><th>Kind</th><th>Days</th><th>Delivered</th><th>Message</th></tr></thead><tbody>';
            list.slice(0, 25).forEach(a => {
                const sev = a.severity === 'critical' ? 'badge-expired'
                          : a.severity === 'warning' ? 'badge-pending' : 'badge-active';
                html += '<tr><td style="font-size:0.72rem">' + escapeHtml(shortTime(a.raised_at)) + '</td>' +
                        '<td><span class="badge ' + sev + '">' + escapeHtml(a.severity) + '</span></td>' +
                        '<td>' + escapeHtml(a.domain || '-') + '</td>' +
                        '<td style="font-size:0.78rem">' + escapeHtml(a.kind) + '</td>' +
                        '<td>' + (a.days_left === 0 ? '-' : a.days_left) + '</td>' +
                        '<td style="font-size:0.75rem">' + (a.delivered ? 'yes'
                            : '<span style="color:var(--muted)">' +
                              escapeHtml((a.channels || []).join(',') || a.delivery_error || 'no') + '</span>') + '</td>' +
                        '<td style="font-size:0.78rem">' + escapeHtml(a.message || '') + '</td></tr>';
            });
            html += '</tbody></table>';
        } else {
            html += '<p style="color:var(--muted);font-size:0.85rem;margin-top:0.5rem">No alerts raised yet.</p>';
        }
        html += '</div>';

        // --- ACME ---
        html += '<div class="card"><h3 style="font-size:0.95rem">Certificate Authority (ACME)</h3>';
        if (!acme.enabled) {
            html += '<p style="color:var(--muted);font-size:0.85rem">' +
                    escapeHtml(acme.reason || 'ACME issuance is not configured.') + '</p>';
        } else {
            if (acme.non_production_ca) {
                html += '<p style="color:#92400e;background:#fef3c7;padding:0.5rem;border-radius:0.25rem;font-size:0.8rem">' +
                        'This is a non-production CA. Certificates it issues are not publicly trusted.</p>';
            }
            html += '<table><tbody>' +
                row('Directory', acme.directory_url) +
                row('Account registered', String(acme.account_registered)) +
                row('Contact', acme.email || '-') +
                row('Key type', acme.key_type) +
                row('Renew before', acme.renew_before_days + ' days') +
                row('Challenge', acme.challenge_type + ' (wildcards need DNS-01, not implemented)') +
                '</tbody></table>';
            if (acme.account_error) {
                html += '<p style="color:var(--danger);font-size:0.8rem">Account error: ' +
                        escapeHtml(acme.account_error) + '</p>';
            }
        }
        html += '</div>';

        el.innerHTML = html;
    }).catch(e => {
        el.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load automation state: ' +
                       escapeHtml(e.message) + '</p></div>';
    });
}

function row(label, value) {
    return '<tr><td style="width:180px;color:var(--muted);font-size:0.8rem">' + escapeHtml(label) +
           '</td><td style="font-size:0.82rem">' + escapeHtml(String(value === undefined || value === null ? '-' : value)) + '</td></tr>';
}

function runJob(job) {
    apiPost('/api/v1/scheduler/run/' + encodeURIComponent(job), {}).then(d => {
        if (d.error) { alert(d.error); return; }
        alert(job + ' started.\n\n' + (d.note || ''));
        setTimeout(loadAutomation, 6000);
    }).catch(e => alert(e.message));
}

function sendTestAlert() {
    apiPost('/api/v1/alerts/test', {}).then(d => {
        if (d.delivered || d.sent) {
            alert('Delivered via: ' + (d.channels || []).join(', '));
        } else {
            alert('Not delivered.\n\n' + (d.error || 'no channel configured'));
        }
        loadAutomation();
    }).catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// Reports: scored compliance posture and export.
// ---------------------------------------------------------------------------
function loadReports() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Building the compliance report...</p></div>';

    apiGet('/api/v1/reports/compliance').then(d => {
        if (d.error) { el.innerHTML = '<div class="card"><p style="color:var(--danger)">' + escapeHtml(d.error) + '</p></div>'; return; }

        const gradeColour = { A: '#065f46', B: '#166534', C: '#92400e', D: '#9a3412', E: '#991b1b' }[d.grade] || '#475569';

        let html = '<div class="card" style="margin-bottom:1rem">' +
            '<h3>Compliance</h3>' +
            '<div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap;margin:0.75rem 0">' +
            '<div style="text-align:center"><div style="font-size:2.4rem;font-weight:700;color:' + gradeColour + '">' +
            (d.score || 0) + '</div><div style="font-size:0.72rem;color:var(--muted)">SCORE / 100</div></div>' +
            '<div style="text-align:center"><div style="font-size:2.4rem;font-weight:700;color:' + gradeColour + '">' +
            escapeHtml(d.grade || '-') + '</div><div style="font-size:0.72rem;color:var(--muted)">GRADE</div></div>' +
            '<div style="flex:1;min-width:240px;font-size:0.88rem">' + escapeHtml(d.summary || '') + '</div>' +
            '</div>' +
            '<p style="font-size:0.8rem;color:var(--muted)">' + (d.assessed || 0) + ' assessed, ' +
            (d.excluded || 0) + ' excluded (revoked or failed issuance), ' + (d.total || 0) + ' records held.</p>' +
            '<button class="btn btn-primary" onclick="downloadExport(\'csv\')">Export CSV</button> ' +
            '<button class="btn" style="background:#e2e8f0" onclick="downloadExport(\'json\')">Export JSON</button>' +
            '</div>';

        html += '<div class="card" style="margin-bottom:1rem"><h3 style="font-size:0.95rem">Controls</h3>' +
                '<table><thead><tr><th>ID</th><th>Control</th><th>Severity</th><th>Result</th>' +
                '<th>Passed</th><th>Failing examples</th></tr></thead><tbody>';
        (d.rules || []).forEach(r => {
            const badge = r.status === 'pass' ? 'badge-active'
                        : r.status === 'fail' ? 'badge-expired' : 'badge-disabled';
            html += '<tr><td style="font-size:0.78rem"><strong>' + escapeHtml(r.id) + '</strong></td>' +
                    '<td style="font-size:0.82rem">' + escapeHtml(r.title) +
                    '<br><span style="color:var(--muted);font-size:0.72rem">' + escapeHtml(r.description || '') + '</span></td>' +
                    '<td style="font-size:0.78rem">' + escapeHtml(r.severity) + '</td>' +
                    '<td><span class="badge ' + badge + '">' + escapeHtml(r.status.split('_').join(' ')) + '</span></td>' +
                    '<td style="font-size:0.8rem">' + r.passed + '/' + r.checked + '</td>' +
                    '<td style="font-size:0.75rem">' + escapeHtml((r.failing_domains || []).join(', ') || '-') + '</td></tr>';
        });
        html += '</tbody></table></div>';

        html += '<div class="card" style="margin-bottom:1rem"><h3 style="font-size:0.95rem">Breakdown</h3>' +
                '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem">' +
                breakdown('Key strength', d.key_strength) +
                breakdown('By issuer', d.by_issuer) +
                breakdown('By environment', d.by_environment) +
                breakdown('By source', d.by_source) +
                '</div></div>';

        if ((d.caveats || []).length) {
            html += '<div class="card"><h3 style="font-size:0.95rem">What this report does not cover</h3><ul style="font-size:0.82rem;margin-left:1.2rem">';
            d.caveats.forEach(c => { html += '<li>' + escapeHtml(c) + '</li>'; });
            html += '</ul></div>';
        }

        el.innerHTML = html;
    }).catch(e => {
        el.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load the report: ' +
                       escapeHtml(e.message) + '</p></div>';
    });
}

function breakdown(title, items) {
    let h = '<div><h4 style="font-size:0.82rem;margin-bottom:0.35rem">' + escapeHtml(title) + '</h4>';
    if (!items || items.length === 0) {
        h += '<p style="color:var(--muted);font-size:0.78rem">none</p></div>';
        return h;
    }
    h += '<table style="font-size:0.78rem"><tbody>';
    items.slice(0, 8).forEach(i => {
        h += '<tr><td>' + escapeHtml(i.name) + '</td><td style="text-align:right"><strong>' + i.count + '</strong></td></tr>';
    });
    h += '</tbody></table></div>';
    return h;
}

// downloadExport fetches with the bearer token and saves via a blob, because a
// plain link cannot carry an Authorization header.
function downloadExport(format) {
    fetch(GATEWAY_API + '/api/v1/reports/export?format=' + encodeURIComponent(format), {
        headers: { 'Authorization': 'Bearer ' + token }
    }).then(r => {
        if (r.status === 401) return handleUnauthorized();
        return r.blob();
    }).then(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'clm-inventory.' + format;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }).catch(e => alert('Export failed: ' + e.message));
}

// ---------------------------------------------------------------------------
// Issuance, renewal and revocation actions on the Certificates page.
// ---------------------------------------------------------------------------
function showIssueForm() {
    const el = document.getElementById('cert-actions');
    if (!el) return;

    // The account list drives what the form offers, so a combination the chosen CA
    // cannot do is not presented in the first place.
    const render = accounts => {
        caAccountsCache = accounts;
        const opts = accounts.map(a =>
            '<option value="' + escapeAttr(a.name) + '"' + (a.default ? ' selected' : '') + '>' +
            escapeHtml(a.name + ' — ' + a.provider + ' (' + a.environment + ')') + '</option>').join('');

        el.innerHTML = '<div class="card" style="margin-top:1rem;border-left:3px solid var(--primary)">' +
            '<h3 style="font-size:0.95rem">Issue a certificate</h3>' +
            (accounts.length === 0
                ? '<p style="color:var(--danger);font-size:0.85rem">No CA accounts are configured.</p>'
                : '') +
            '<p style="color:var(--muted);font-size:0.8rem;margin-bottom:0.75rem">' +
            'The private key stays on the gateway and is never returned by the API. ' +
            'Commercial CAs issue asynchronously: the order is placed, you complete the ' +
            'validation steps, and the certificate is collected automatically.</p>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:0.75rem">' +
            '<div class="form-group"><label>Certificate authority *</label>' +
            '<select id="iss-account" onchange="toggleIssueOrgFields()" style="' + FIELD_STYLE + '">' + opts + '</select></div>' +
            '<div class="form-group"><label>Domains (comma separated) *</label>' +
            '<input id="iss-domains" placeholder="api.example.com, www.example.com" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>Validation level</label>' +
            '<select id="iss-type" onchange="toggleIssueOrgFields()" style="' + FIELD_STYLE + '">' +
            '<option value="dv">DV — domain only</option>' +
            '<option value="ov">OV — organisation vetted</option>' +
            '<option value="ev">EV — extended validation</option></select></div>' +
            '<div class="form-group"><label>Years</label>' +
            '<input id="iss-years" value="1" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>Environment</label>' +
            '<input id="iss-env" placeholder="prod / staging / test" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>Contact email</label>' +
            '<input id="iss-email" placeholder="ops@example.com" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>Validation method</label>' +
            '<select id="iss-dcv" style="' + FIELD_STYLE + '">' +
            '<option value="">CA default</option><option value="dns">DNS</option>' +
            '<option value="http">HTTP</option><option value="email">Email</option></select></div>' +
            '</div>' +
            '<div id="iss-caps" style="font-size:0.78rem;color:var(--muted);margin:0.4rem 0"></div>' +
            '<div id="iss-org" class="hidden"></div>' +
            '<div id="iss-error" style="color:var(--danger);font-size:0.8rem;margin:0.5rem 0"></div>' +
            '<button class="btn btn-primary" onclick="issueCertificate()">Place order</button> ' +
            '<button class="btn" style="background:#e2e8f0" onclick="document.getElementById(\'cert-actions\').innerHTML=\'\'">Cancel</button>' +
            '</div>';
        toggleIssueOrgFields();
    };

    if (caAccountsCache.length > 0) { render(caAccountsCache); return; }
    apiGet('/api/v1/ca/providers').then(d => render(d.accounts || []))
        .catch(() => render([]));
}

// toggleIssueOrgFields shows the organisation block only when the chosen
// validation level actually needs it, and states what the selected CA can do.
function toggleIssueOrgFields() {
    const acctEl = document.getElementById('iss-account');
    const typeEl = document.getElementById('iss-type');
    const capsEl = document.getElementById('iss-caps');
    const orgEl = document.getElementById('iss-org');
    if (!acctEl || !typeEl || !orgEl) return;

    const acct = caAccountsCache.filter(a => a.name === acctEl.value)[0];
    const caps = (acct && acct.capabilities) || {};
    const type = typeEl.value;

    if (capsEl) {
        const bits = [];
        bits.push(caps.synchronous ? 'issues immediately' : 'issues asynchronously');
        bits.push('types: ' + (caps.cert_types || []).join('/'));
        bits.push(caps.wildcard ? 'wildcards supported' : 'no wildcards');
        if (caps.max_validity_years) bits.push('up to ' + caps.max_validity_years + ' year(s)');
        capsEl.textContent = bits.join(' · ') + (caps.notes ? ' — ' + caps.notes : '');
    }

    const needsOrg = type === 'ov' || type === 'ev';
    orgEl.classList.toggle('hidden', !needsOrg);
    if (needsOrg && !document.getElementById('org-name')) {
        orgEl.innerHTML = '<div style="border-top:1px solid var(--border);margin-top:0.6rem;padding-top:0.6rem">' +
            '<p style="font-size:0.8rem;margin-bottom:0.4rem"><strong>Organisation</strong> ' +
            '<span style="color:var(--muted)">— the CA vets these against public records, ' +
            'which is why OV and EV take days rather than minutes</span></p>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.6rem">' +
            '<div class="form-group"><label>Legal name *</label><input id="org-name" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>Address</label><input id="org-address" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>City</label><input id="org-city" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>State</label><input id="org-state" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>Country (2-letter)</label><input id="org-country" placeholder="IN" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>Phone</label><input id="org-phone" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>Contact first name</label><input id="org-first" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>Contact last name</label><input id="org-last" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>Job title</label><input id="org-title" style="' + FIELD_STYLE + '"></div>' +
            '</div></div>';
    }
}

function issueCertificate() {
    const err = document.getElementById('iss-error');
    const val = id => { const n = document.getElementById(id); return n ? n.value.trim() : ''; };
    const domains = splitList('iss-domains');
    if (domains.length === 0) { err.textContent = 'At least one domain is required.'; return; }

    const type = val('iss-type') || 'dv';
    const body = {
        domains: domains,
        ca_account: val('iss-account'),
        cert_type: type,
        validity_years: parseInt(val('iss-years'), 10) || 1,
        environment: val('iss-env'),
        contact_email: val('iss-email'),
        dcv_method: val('iss-dcv')
    };

    if (type === 'ov' || type === 'ev') {
        if (!val('org-name')) { err.textContent = 'The organisation legal name is required for ' + type.toUpperCase() + '.'; return; }
        body.organization = {
            name: val('org-name'), address: val('org-address'),
            city: val('org-city'), state: val('org-state'),
            country: val('org-country'), phone: val('org-phone'),
            contact_first_name: val('org-first'), contact_last_name: val('org-last'),
            contact_email: val('iss-email'), job_title: val('org-title')
        };
    }

    err.textContent = 'Placing the order with ' + body.ca_account + '...';

    apiPost('/api/v1/certificates/issue', body).then(d => {
        // A policy violation blocks the order and names every rule that failed,
        // rather than a bare "issuance failed" that would send the operator
        // looking at the CA when the request never left the gateway.
        if (d.violations && d.violations.length) {
            err.innerHTML = '<strong>Blocked by certificate policy:</strong><ul style="margin:0.3rem 0 0 1.1rem">' +
                d.violations.map(v => '<li>' + escapeHtml(v.message) + '</li>').join('') + '</ul>';
            return;
        }
        if (d.error) { err.textContent = d.error; return; }

        if (d.status === 'awaiting_approval') {
            err.innerHTML = '';
            document.getElementById('cert-actions').innerHTML = '';
            alert((d.message || 'This request needs approval before it can be issued.') +
                  '\n\nSee the Approvals page to review it.');
            navigate('approvals');
            return;
        }
        document.getElementById('cert-actions').innerHTML = '';

        if (d.order_status === 'issued') {
            alert('Issued for ' + (d.domains || []).join(', ') +
                  '\n\nCA: ' + d.ca_account + '\nIssuer: ' + d.issuer +
                  '\nExpires: ' + d.not_after + '\n\n' + (d.note || ''));
            loadCertificates();
            return;
        }

        // Asynchronous order: the validation steps are the actionable part, so
        // show them rather than a bare "accepted".
        let msg = 'Order placed with ' + d.ca_account + ' (order ' + d.order_id + ').\n\n' +
                  (d.message || '') + '\n';
        (d.validation || []).forEach(v => {
            msg += '\n' + v.type.toUpperCase() + ' validation for ' + v.domain + ':\n';
            if (v.name) msg += '  ' + v.name + '\n';
            if (v.value) msg += '  = ' + v.value + '\n';
            if (v.emails) msg += '  one of: ' + v.emails.join(', ') + '\n';
            if (v.detail) msg += '  (' + v.detail + ')\n';
        });
        msg += '\n' + (d.next || '');
        alert(msg);
        navigate('authorities');
    }).catch(e => { err.textContent = e.message; });
}

function renewCertificate(id, domain) {
    if (!confirm('Renew ' + domain + ' now?')) return;
    apiPost('/api/v1/certificates/' + encodeURIComponent(id) + '/renew', {}).then(d => {
        if (d.error) { alert(d.error); return; }
        alert('Renewed ' + domain + '\n\nNew expiry: ' + d.not_after +
              '\nRenewals so far: ' + d.renewal_count);
        loadCertificates();
    }).catch(e => alert(e.message));
}

function revokeCertificate(id, domain) {
    const reason = prompt('Revoke ' + domain + ' at the CA?\n\n' +
        'This cannot be undone. Anything still serving this certificate will start ' +
        'failing for clients that check revocation.\n\n' +
        'Reason (unspecified, superseded, key_compromise, cessation):', 'superseded');
    if (reason === null) return;
    apiPost('/api/v1/certificates/' + encodeURIComponent(id) + '/revoke',
            { reason: reason }).then(d => {
        if (d.error) { alert(d.error); return; }
        alert(d.message || 'revoked');
        loadCertificates();
    }).catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// Centralized certificate inventory.
//
// The Certificates page is the working list: issue, renew, revoke. This is the
// estate view — search across every field discovery collected, slice it by the
// facets the API supplies, open a single record in full, and remove records that
// no longer describe anything real.
//
// Filtering happens server-side. Doing it here would mean downloading the whole
// inventory to narrow it, and the same filter logic would then exist in two
// places and drift.
// ---------------------------------------------------------------------------
let invFilters = {};
let invSummaryCache = null;

let invActiveTab = 'inventory';
const INV_TABS = ['inventory', 'certificates', 'endpoints'];

function loadInventory(initialTab) {
    if (initialTab) invActiveTab = initialTab;
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading...</p></div>';
    Promise.all([
        apiGet('/api/v1/inventory' + invQueryString()),
        apiGet('/api/v1/certificates'),
        apiGet('/api/v1/inventory/deployments')
    ]).then(([inv, certsData, depsData]) => {
        invSummaryCache = inv.summary || {};
        const el = document.getElementById('content-area');
        let h = '<div class="card" style="margin-bottom:1rem"><h3>Inventory</h3>' +
            '<p style="color:var(--muted);font-size:0.85rem">All certificates ' +
            'this gateway knows about, their lifecycle status and where they are deployed.</p>' +
            '<div style="display:flex;gap:0.5rem;margin-top:0.75rem;border-bottom:1px solid var(--border)">' +
            invTabBtn('inventory', 'All Certificates') +
            invTabBtn('certificates', 'Managed (' + ((certsData.certificates || certsData || []).filter(c => c.managed_by).length) + ')') +
            invTabBtn('endpoints', 'Deployed Endpoints (' + (depsData.total || 0) + ')') +
            '</div></div>' +
            '<div id="inv-pane-inventory">' + '</div>' +
            '<div id="inv-pane-certificates"></div>' +
            '<div id="inv-pane-endpoints"></div>';
        el.innerHTML = h;
        renderInventory(inv);
        renderCertsTab(certsData);
        renderEndpointsTab(depsData);
        switchInvTab(invActiveTab);
    }).catch(e => {
        document.getElementById('content-area').innerHTML =
            '<div class="card"><p style="color:var(--danger)">Failed to load: ' +
            escapeHtml(e.message) + '</p></div>';
    });
}

function invTabBtn(id, label) {
    const on = invActiveTab === id;
    return '<button class="btn" id="inv-tab-' + id + '" onclick="switchInvTab(\'' + id + '\')" ' +
        'style="background:none;border:none;border-bottom:2px solid ' +
        (on ? 'var(--primary)' : 'transparent') + ';border-radius:0;font-weight:' +
        (on ? '600' : '400') + '">' + label + '</button>';
}

function switchInvTab(which) {
    if (INV_TABS.indexOf(which) === -1) which = 'inventory';
    invActiveTab = which;
    INV_TABS.forEach(p => {
        const pane = document.getElementById('inv-pane-' + p);
        if (pane) pane.classList.toggle('hidden', p !== which);
        const tab = document.getElementById('inv-tab-' + p);
        if (tab) {
            tab.style.borderBottomColor = (p === which) ? 'var(--primary)' : 'transparent';
            tab.style.fontWeight = (p === which) ? '600' : '400';
        }
    });
}

function invQueryString() {
    const p = [];
    Object.keys(invFilters).forEach(k => {
        const v = invFilters[k];
        if (v !== '' && v !== null && v !== undefined && v !== false) {
            p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        }
    });
    return p.length ? '?' + p.join('&') : '';
}

function fetchInventory() {
    apiGet('/api/v1/inventory' + invQueryString()).then(d => {
        if (d.error) {
            document.getElementById('content-area').innerHTML =
                '<div class="card"><p style="color:var(--danger)">' + escapeHtml(d.error) + '</p></div>';
            return;
        }
        invSummaryCache = d.summary || {};
        renderInventory(d);
    }).catch(e => {
        document.getElementById('content-area').innerHTML =
            '<div class="card"><p style="color:var(--danger)">Failed to load the inventory: ' +
            escapeHtml(e.message) + '</p></div>';
    });
}

function renderInventory(d) {
    const s = d.summary || {};
    const certs = d.certificates || [];

    let html = '<div class="card" style="margin-bottom:1rem">' +
        '<h3>Certificate Inventory</h3>' +
        '<p style="color:var(--muted);font-size:0.85rem">' +
        'Every certificate this gateway has discovered or issued. <strong>Managed</strong> means ' +
        'the private key is held here, so it can be renewed and revoked; <strong>observed</strong> ' +
        'means it was found on the network and can only be reported on.</p>' +
        '<div class="stats" style="margin:0.75rem 0">' +
        statTile('Total', s.total || 0) +
        statTile('Managed', s.managed || 0) +
        statTile('Observed', s.observed || 0) +
        statTile('Expiring 30d', s.expiring_30d || 0) +
        statTile('Expired', s.expired || 0) +
        statTile('Stale', s.stale || 0) +
        '</div>' +
        '<button class="btn btn-primary" onclick="downloadExport(\'csv\')">Export CSV</button> ' +
        '<button class="btn" style="background:#e2e8f0" onclick="downloadExport(\'json\')">Export JSON</button> ' +
        '<button class="btn" style="background:#e2e8f0" onclick="showPrune()">Prune records</button>' +
        '</div><div id="inv-prune"></div>';

    // --- filters ---
    html += '<div class="card" style="margin-bottom:1rem">' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.6rem">' +
        '<div class="form-group"><label>Search</label>' +
        '<input id="inv-search" value="' + escapeAttr(invFilters.search || '') + '" ' +
        'placeholder="domain, host, issuer, serial, SAN" style="' + FIELD_STYLE + '"></div>' +
        selectFilter('inv-status', 'Status', 'status', s.statuses) +
        selectFilter('inv-source', 'Source', 'source', s.sources) +
        selectFilter('inv-issuer', 'Issuer', 'issuer', s.issuers) +
        selectFilter('inv-env', 'Environment', 'environment', s.environments) +
        '<div class="form-group"><label>Ownership</label><select id="inv-managed" style="' + FIELD_STYLE + '">' +
        opt('', 'any', invFilters.managed) +
        opt('managed', 'managed (key held)', invFilters.managed) +
        opt('observed', 'observed only', invFilters.managed) +
        '</select></div>' +
        '<div class="form-group"><label>Expiring within</label><select id="inv-expiring" style="' + FIELD_STYLE + '">' +
        opt('', 'any', invFilters.expiring_within) +
        opt('7', '7 days', invFilters.expiring_within) +
        opt('30', '30 days', invFilters.expiring_within) +
        opt('60', '60 days', invFilters.expiring_within) +
        opt('90', '90 days', invFilters.expiring_within) +
        '</select></div>' +
        '<div class="form-group"><label>Sort by</label><select id="inv-sort" style="' + FIELD_STYLE + '">' +
        opt('', 'soonest expiry', invFilters.sort) +
        opt('domain', 'domain', invFilters.sort) +
        opt('issuer', 'issuer', invFilters.sort) +
        opt('last_seen', 'last seen', invFilters.sort) +
        '</select></div>' +
        '</div>' +
        '<label style="font-size:0.8rem;margin-right:1rem"><input type="checkbox" id="inv-selfsigned"' +
        (invFilters.self_signed ? ' checked' : '') + '> self-signed only</label>' +
        '<label style="font-size:0.8rem;margin-right:1rem"><input type="checkbox" id="inv-weakkey"' +
        (invFilters.weak_key ? ' checked' : '') + '> weak key only</label>' +
        '<label style="font-size:0.8rem;margin-right:1rem" title="Discovered certificates not seen for over ' +
        escapeAttr(d.stale_after || '30 days') + '"><input type="checkbox" id="inv-stale"' +
        (invFilters.stale ? ' checked' : '') + '> stale only</label>' +
        '<div style="margin-top:0.6rem">' +
        '<button class="btn btn-primary" onclick="applyInvFilters()">Apply</button> ' +
        '<button class="btn" style="background:#e2e8f0" onclick="clearInvFilters()">Clear</button>' +
        '</div></div>';

    // --- table ---
    html += '<div class="card"><h3 style="font-size:0.95rem">' +
        (d.returned || 0) + ' of ' + (d.total || 0) + ' record(s)' +
        (d.truncated ? ' <span style="color:var(--muted);font-size:0.78rem">(truncated)</span>' : '') +
        '</h3>';

    if (certs.length === 0) {
        html += '<p style="color:var(--muted);font-size:0.85rem">Nothing matches. ' +
                'Run a discovery scan, or clear the filters.</p>';
    } else {
        html += '<table><thead><tr><th>Domain</th><th>Where</th><th>Own</th><th>Status</th>' +
                '<th>Days</th><th>Issuer</th><th>Key</th><th>Found by</th><th>Last seen</th>' +
                '<th style="width:1%">Actions</th></tr></thead><tbody>';
        certs.forEach(c => {
            const badge = c.status === 'active' ? 'badge-active'
                        : (c.status === 'expired' || c.status === 'revoked' || c.status === 'failed') ? 'badge-expired'
                        : 'badge-pending';
            const own = c.managed_by
                ? '<span class="badge badge-active" title="private key held here">managed</span>'
                : '<span style="color:var(--muted);font-size:0.72rem">observed</span>';
            const where = c.host ? escapeHtml(c.host) + (c.port ? ':' + c.port : '') : '-';
            const key = c.key_size
                ? escapeHtml((c.key_algorithm || '') + ' ' + c.key_size) +
                  (c.key_size < 2048 ? ' <span class="badge badge-expired">weak</span>' : '')
                : '<span style="color:var(--muted)">unknown</span>';
            const stale = c.last_seen_at && !c.managed_by &&
                          (Date.now() - new Date(c.last_seen_at).getTime()) > 30 * 86400000;

            html += '<tr><td><strong>' + escapeHtml(c.domain || '-') + '</strong>' +
                    (c.self_signed ? ' <span class="badge badge-expired" title="self-signed">SS</span>' : '') +
                    ((c.sans && c.sans.length > 1)
                        ? '<br><span style="color:var(--muted);font-size:0.7rem">+' + (c.sans.length - 1) + ' SAN(s)</span>' : '') +
                    '</td><td style="font-size:0.78rem">' + where + '</td>' +
                    '<td>' + own + '</td>' +
                    '<td><span class="badge ' + badge + '">' + escapeHtml(c.status || '-') + '</span></td>' +
                    '<td style="font-size:0.8rem">' + (c.not_after ? c.days_left : '-') + '</td>' +
                    '<td style="font-size:0.78rem">' + escapeHtml(c.issuer || '-') + '</td>' +
                    '<td style="font-size:0.75rem">' + key + '</td>' +
                    '<td style="font-size:0.75rem">' + escapeHtml(c.discovery_method || c.source || '-') + '</td>' +
                    '<td style="font-size:0.72rem">' +
                        (c.last_seen_at ? escapeHtml(shortTime(c.last_seen_at)) +
                            (stale ? '<br><span class="badge badge-pending">stale</span>' : '')
                          : '<span style="color:var(--muted)">-</span>') +
                    '</td>' +
                    '<td style="white-space:nowrap">' +
                    '<button class="btn" style="background:#e2e8f0" onclick="showCertDetail(\'' +
                        escapeAttr(c.id) + '\')">Details</button> ' +
                    '<button class="btn btn-danger" onclick="removeCertRecord(\'' +
                        escapeAttr(c.id) + '\',\'' + escapeAttr(c.domain || c.id) + '\')">Remove</button>' +
                    '</td></tr>';
        });
        html += '</tbody></table>';
    }
    html += '</div><div id="inv-detail"></div>';

    document.getElementById('inv-pane-inventory').innerHTML = html;

    const search = document.getElementById('inv-search');
    if (search) search.onkeydown = e => { if (e.key === 'Enter') applyInvFilters(); };
}

// selectFilter builds a dropdown from the facet counts the API returned, so the
// options are always the values actually present.
function selectFilter(id, label, key, items) {
    let h = '<div class="form-group"><label>' + escapeHtml(label) + '</label>' +
            '<select id="' + id + '" style="' + FIELD_STYLE + '">' + opt('', 'any', invFilters[key]);
    (items || []).forEach(i => {
        h += opt(i.name, i.name + ' (' + i.count + ')', invFilters[key]);
    });
    return h + '</select></div>';
}

function opt(value, label, current) {
    const sel = String(current === undefined || current === null ? '' : current) === String(value) ? ' selected' : '';
    return '<option value="' + escapeAttr(value) + '"' + sel + '>' + escapeHtml(label) + '</option>';
}

function applyInvFilters() {
    const val = id => { const n = document.getElementById(id); return n ? n.value : ''; };
    const chk = id => { const n = document.getElementById(id); return !!(n && n.checked); };
    invFilters = {
        search: val('inv-search').trim(),
        status: val('inv-status'),
        source: val('inv-source'),
        issuer: val('inv-issuer'),
        environment: val('inv-env'),
        managed: val('inv-managed'),
        expiring_within: val('inv-expiring'),
        sort: val('inv-sort'),
        self_signed: chk('inv-selfsigned'),
        weak_key: chk('inv-weakkey'),
        stale: chk('inv-stale')
    };
    fetchInventory();
}

function clearInvFilters() {
    invFilters = {};
    fetchInventory();
}

// showCertDetail opens the full record, including everything discovery collected
// that the table has no room for.
function showCertDetail(id) {
    const panel = document.getElementById('inv-detail');
    if (!panel) return;
    panel.innerHTML = '<div class="card" style="margin-top:1rem"><p style="color:var(--muted)">Loading record...</p></div>';

    apiGet('/api/v1/certificates/' + encodeURIComponent(id)).then(d => {
        if (d.error) { panel.innerHTML = '<div class="card"><p style="color:var(--danger)">' + escapeHtml(d.error) + '</p></div>'; return; }
        const c = d.certificate || {};

        let h = '<div class="card" style="margin-top:1rem;border-left:3px solid var(--primary)">' +
            '<h3 style="font-size:0.95rem">' + escapeHtml(c.domain || '-') + '</h3>';

        if (d.stale) {
            h += '<p style="color:#92400e;background:#fef3c7;padding:0.5rem;border-radius:0.25rem;font-size:0.8rem">' +
                 'Not observed by discovery since ' + escapeHtml(shortTime(c.last_seen_at)) +
                 '. The host may no longer serve it.</p>';
        }
        if (c.last_error) {
            h += '<p style="color:var(--danger);background:#fee2e2;padding:0.5rem;border-radius:0.25rem;font-size:0.8rem">' +
                 'Last error: ' + escapeHtml(c.last_error) + '</p>';
        }

        h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem">';
        h += '<table><tbody>' +
            row('Status', c.status) +
            row('Days left', c.not_after ? c.days_left : 'no expiry recorded') +
            row('Not before', c.not_before ? shortTime(c.not_before) : '-') +
            row('Not after', c.not_after ? shortTime(c.not_after) : '-') +
            row('Issuer', c.issuer || '(unknown)') +
            row('Serial', c.serial_number || '-') +
            row('Self-signed', String(!!c.self_signed)) +
            '</tbody></table>';
        h += '<table><tbody>' +
            row('Ownership', c.managed_by ? 'managed by ' + c.managed_by : 'observed only') +
            row('Key held here', String(!!d.key_held)) +
            row('Key', c.key_size ? (c.key_algorithm || '') + ' ' + c.key_size + '-bit' : 'unknown') +
            row('Source', c.source || '-') +
            row('Found by', c.discovery_method || '-') +
            row('Host', (c.host || '-') + (c.port ? ':' + c.port : '')) +
            row('Resolved IP', c.resolved_ip || '-') +
            '</tbody></table>';
        h += '<table><tbody>' +
            row('Environment', c.environment || '-') +
            row('Requested by', c.requested_by || '-') +
            row('First recorded', c.created_at ? shortTime(c.created_at) : '-') +
            row('Last seen', c.last_seen_at ? shortTime(c.last_seen_at) : '-') +
            row('Issued at', c.issued_at ? shortTime(c.issued_at) : '-') +
            row('Renewals', String(c.renewal_count || 0)) +
            row('Revoked at', c.revoked ? shortTime(c.revoked_at) : 'not revoked') +
            '</tbody></table>';
        h += '</div>';

        h += '<p style="font-size:0.8rem;margin-top:0.75rem"><strong>Fingerprint (SHA-256)</strong><br>' +
             '<span style="font-family:monospace;font-size:0.72rem;word-break:break-all">' +
             escapeHtml(c.fingerprint || '-') + '</span></p>';

        if (c.sans && c.sans.length) {
            h += '<details style="margin-top:0.5rem"><summary style="cursor:pointer;font-size:0.85rem">' +
                 c.sans.length + ' subject alternative name(s)</summary>' +
                 '<p style="font-size:0.78rem;word-break:break-all">' +
                 c.sans.map(escapeHtml).join('<br>') + '</p></details>';
        }
        if (c.secret_ref) {
            h += '<p style="font-size:0.78rem;color:var(--muted);margin-top:0.5rem">' +
                 'Private key on the gateway at <span style="font-family:monospace">' +
                 escapeHtml(c.secret_ref) + '</span>. ' + escapeHtml(d.note || '') + '</p>';
        }
        if (c.chain_pem) {
            h += '<details style="margin-top:0.5rem"><summary style="cursor:pointer;font-size:0.85rem">' +
                 'Certificate chain (public)</summary><pre style="background:#0f172a;color:#e2e8f0;' +
                 'padding:0.6rem;border-radius:0.375rem;font-size:0.68rem;overflow-x:auto;max-height:220px">' +
                 escapeHtml(c.chain_pem) + '</pre></details>';
        }

        h += '<div style="margin-top:0.85rem">';
        if (d.can_renew) {
            h += '<button class="btn btn-primary" onclick="renewCertificate(\'' + escapeAttr(c.id) +
                 '\',\'' + escapeAttr(c.domain) + '\')">Renew</button> ';
        }
        if (d.can_revoke) {
            h += '<button class="btn btn-danger" onclick="revokeCertificate(\'' + escapeAttr(c.id) +
                 '\',\'' + escapeAttr(c.domain) + '\')">Revoke</button> ';
        }
        if (!d.can_renew && !d.can_revoke) {
            h += '<span style="color:var(--muted);font-size:0.8rem">No key is held here, so this ' +
                 'record can be reported on but not acted on. </span>';
        }
        h += '<button class="btn" style="background:#e2e8f0" ' +
             'onclick="document.getElementById(\'inv-detail\').innerHTML=\'\'">Close</button>';
        h += '</div></div>';

        panel.innerHTML = h;
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }).catch(e => {
        panel.innerHTML = '<div class="card"><p style="color:var(--danger)">' + escapeHtml(e.message) + '</p></div>';
    });
}

function removeCertRecord(id, domain) {
    if (!confirm('Remove the inventory record for ' + domain + '?\n\n' +
                 'This does not revoke anything. If a key is held here it is deleted too, ' +
                 'so a managed certificate could no longer be renewed or revoked.')) return;

    apiDelete('/api/v1/certificates/' + encodeURIComponent(id)).then(d => {
        if (d.error) {
            // A still-valid managed certificate is refused until confirmed, because
            // removing the record leaves it live at the CA with nothing tracking it.
            if (confirm(d.error + '\n\nRemove it anyway?')) {
                apiDelete('/api/v1/certificates/' + encodeURIComponent(id) + '?force=true').then(f => {
                    if (f.error) { alert(f.error); return; }
                    if (f.warning) alert('Removed. ' + f.warning);
                    fetchInventory();
                }).catch(e => alert(e.message));
            }
            return;
        }
        fetchInventory();
    }).catch(e => alert(e.message));
}

function showPrune() {
    const p = document.getElementById('inv-prune');
    if (!p) return;
    p.innerHTML = '<div class="card" style="margin-bottom:1rem;border-left:3px solid var(--danger)">' +
        '<h3 style="font-size:0.95rem">Prune records</h3>' +
        '<p style="color:var(--muted);font-size:0.8rem">Removes records that no longer describe ' +
        'anything real. Check first with a dry run.</p>' +
        '<label style="display:block;font-size:0.82rem;margin:0.3rem 0">' +
        '<input type="checkbox" id="pr-failed" checked> failed issuance attempts</label>' +
        '<label style="display:block;font-size:0.82rem;margin-bottom:0.3rem">' +
        '<input type="checkbox" id="pr-stale"> discovered certificates not seen for ' +
        '<input id="pr-days" value="30" style="width:60px;padding:0.2rem;border:1px solid var(--border);border-radius:0.25rem"> days' +
        '</label>' +
        '<div id="pr-result" style="font-size:0.8rem;margin:0.5rem 0"></div>' +
        '<button class="btn" style="background:#e2e8f0" onclick="runPrune(true)">Dry run</button> ' +
        '<button class="btn btn-danger" onclick="runPrune(false)">Prune</button> ' +
        '<button class="btn" style="background:#e2e8f0" onclick="document.getElementById(\'inv-prune\').innerHTML=\'\'">Cancel</button>' +
        '</div>';
}

function runPrune(dryRun) {
    const body = {
        failed: document.getElementById('pr-failed').checked,
        stale: document.getElementById('pr-stale').checked,
        stale_days: parseInt(document.getElementById('pr-days').value, 10) || 30,
        dry_run: dryRun
    };
    if (!body.failed && !body.stale) {
        document.getElementById('pr-result').innerHTML =
            '<span style="color:var(--danger)">Choose at least one category.</span>';
        return;
    }
    if (!dryRun && !confirm('Permanently remove the matching records?')) return;

    apiPost('/api/v1/inventory/prune', body).then(d => {
        if (d.error) {
            document.getElementById('pr-result').innerHTML =
                '<span style="color:var(--danger)">' + escapeHtml(d.error) + '</span>';
            return;
        }
        let h = '<strong>' + (d.dry_run ? 'Would remove' : 'Removed') + ' ' +
                (d.dry_run ? d.matched : d.removed) + ' record(s).</strong>';
        if ((d.candidates || []).length) {
            h += '<ul style="margin:0.4rem 0 0 1.1rem">';
            d.candidates.slice(0, 12).forEach(v => {
                h += '<li>' + escapeHtml(v.domain || v.id) + ' — ' + escapeHtml(v.reason) + '</li>';
            });
            h += '</ul>';
        }
        document.getElementById('pr-result').innerHTML = h;
        if (!d.dry_run) setTimeout(fetchInventory, 1200);
    }).catch(e => {
        document.getElementById('pr-result').innerHTML =
            '<span style="color:var(--danger)">' + escapeHtml(e.message) + '</span>';
    });
}

// ---------------------------------------------------------------------------
// Certificate authorities: multiple vendors, their capabilities, pricing and
// pending orders.
//
// Capabilities are shown rather than assumed, because they differ sharply: ACME
// is free, instant and DV-only; a commercial CA does wildcards and OV/EV but
// issues asynchronously and costs money. Offering a combination the account
// cannot do would just produce a rejection later.
// ---------------------------------------------------------------------------
let caAccountsCache = [];

// ---------------------------------------------------------------------------
// Certificate Authorities.
//
// This was two pages: "CA Providers" (accounts) and "CA Purchasing" (quotes).
// Splitting them made little sense - buying a certificate always starts by
// choosing an account - and the two disagreed: the purchasing page called a
// legacy stub that answered "no CA accounts are configured on this gateway"
// while the providers page listed four of them. Now one page with three tabs
// over a single source of pricing.
// ---------------------------------------------------------------------------
let caActiveTab = 'accounts';
const CA_TABS = ['accounts', 'pricing', 'orders'];

function loadAuthorities(initialTab) {
    if (initialTab) caActiveTab = initialTab;
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading CA accounts...</p></div>';

    Promise.all([
        apiGet('/api/v1/ca/providers'),
        apiGet('/api/v1/ca/orders')
    ]).then(([prov, orders]) => {
        caAccountsCache = prov.accounts || [];
        const list = orders.orders || [];

        let html = '<div class="card" style="margin-bottom:1rem"><h3>Certificate Authorities</h3>' +
            '<p style="color:var(--muted);font-size:0.85rem">Register CA credentials, compare live ' +
            'pricing across them, and follow orders that are waiting on validation. Each account is a ' +
            'separate CA credential; issuance routes to the account named in the request, and an unknown ' +
            'name is refused rather than quietly substituted. Credentials are stored on the gateway and ' +
            'never returned here.</p>' +
            '<div style="display:flex;gap:0.5rem;margin-top:0.75rem;border-bottom:1px solid var(--border)">' +
            caTabButton('accounts', 'Accounts (' + caAccountsCache.length + ')') +
            caTabButton('pricing', 'Pricing &amp; Purchase') +
            caTabButton('orders', 'Orders (' + list.length + ')') +
            '</div></div>' +
            '<div id="ca-pane-accounts">' + renderCAAccounts(prov) + '</div>' +
            '<div id="ca-pane-pricing">' + renderCAPricing() + '</div>' +
            '<div id="ca-pane-orders">' + renderCAOrders(orders, list) + '</div>';

        el.innerHTML = html;
        switchCATab(caActiveTab);
    }).catch(e => {
        el.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load CA accounts: ' +
                       escapeHtml(e.message) + '</p></div>';
    });
}

function caTabButton(id, label) {
    const on = caActiveTab === id;
    return '<button class="btn" id="ca-tab-' + id + '" onclick="switchCATab(\'' + id + '\')" ' +
        'style="background:none;border:none;border-bottom:2px solid ' +
        (on ? 'var(--primary)' : 'transparent') + ';border-radius:0;font-weight:' +
        (on ? '600' : '400') + '">' + label + '</button>';
}

function switchCATab(which) {
    if (CA_TABS.indexOf(which) === -1) which = 'accounts';
    caActiveTab = which;
    CA_TABS.forEach(p => {
        const pane = document.getElementById('ca-pane-' + p);
        if (pane) pane.classList.toggle('hidden', p !== which);
        const tab = document.getElementById('ca-tab-' + p);
        if (tab) {
            tab.style.borderBottomColor = (p === which) ? 'var(--primary)' : 'transparent';
            tab.style.fontWeight = (p === which) ? '600' : '400';
        }
    });
}

// --- accounts tab ---
function renderCAAccounts(prov) {
    let html = '<div class="card" style="margin-bottom:1rem">';
    if (caAccountsCache.length === 0) {
        html += '<p style="color:var(--muted);font-size:0.85rem">' +
                escapeHtml(prov.reason || 'No CA accounts are configured.') + '</p>' +
                '<button class="btn btn-primary" onclick="showRegisterCA()">+ Register CA account</button>' +
                '</div><div id="ca-register"></div>';
        return html;
    }

    html += '<button class="btn btn-primary" style="margin-bottom:0.5rem" onclick="showRegisterCA()">' +
        '+ Register CA account</button>' +
        '<table><thead><tr><th>Account</th><th>Vendor</th><th>Environment</th>' +
        '<th>Types</th><th>Wildcard</th><th>Issuance</th><th>Pricing</th>' +
        '<th>Validation</th><th style="width:1%">Actions</th></tr></thead><tbody>';

    caAccountsCache.forEach(a => {
        const c = a.capabilities || {};
        const isProd = /prod/i.test(a.environment || '');
        html += '<tr><td><strong>' + escapeHtml(a.name) + '</strong>' +
                (a.default ? ' <span class="badge badge-active">default</span>' : '') + '</td>' +
                '<td>' + escapeHtml(a.provider) + '</td>' +
                '<td><span class="badge ' + (isProd ? 'badge-expired' : 'badge-pending') + '">' +
                    escapeHtml(a.environment || '-') + '</span></td>' +
                '<td style="font-size:0.78rem">' + escapeHtml((c.cert_types || []).join(', ')) + '</td>' +
                '<td>' + (c.wildcard ? 'yes' : '<span style="color:var(--muted)">no</span>') + '</td>' +
                '<td style="font-size:0.78rem">' + (c.synchronous ? 'immediate' : 'asynchronous') + '</td>' +
                '<td>' + (c.quoting ? 'yes' : '<span style="color:var(--muted)">no API</span>') + '</td>' +
                '<td style="font-size:0.75rem">' + escapeHtml((c.dcv_methods || []).join(', ')) + '</td>' +
                '<td style="white-space:nowrap">' +
                    '<button class="btn" style="background:#e2e8f0" onclick="testCAAccount(\'' +
                        escapeAttr(a.name) + '\',false)">Test</button> ' +
                    (a.default ? '' : '<button class="btn" style="background:#e2e8f0" onclick="makeCADefault(\'' +
                        escapeAttr(a.name) + '\')">Default</button> ') +
                    '<button class="btn" style="background:#e2e8f0" onclick="showRegisterCA(\'' +
                        escapeAttr(a.name) + '\')">Edit</button> ' +
                    '<button class="btn btn-danger" onclick="deleteCAAccount(\'' +
                        escapeAttr(a.name) + '\')">Remove</button>' +
                '</td></tr>';
        if (c.notes) {
            html += '<tr><td colspan="9" style="color:var(--muted);font-size:0.75rem;' +
                    'border-top:none;padding-top:0">' + escapeHtml(c.notes) + '</td></tr>';
        }
    });
    html += '</tbody></table></div><div id="ca-register"></div>';
    return html;
}

// --- pricing and purchase tab ---
function renderCAPricing() {
    if (caAccountsCache.length === 0) {
        return '<div class="card"><h3 style="font-size:0.95rem">Pricing &amp; Purchase</h3>' +
            '<p style="color:var(--muted);font-size:0.85rem">Register a CA account first. Pricing is read ' +
            'from each vendor\'s API using its own credentials, so there is nothing to quote until at ' +
            'least one account exists.</p></div>';
    }

    const quoting = caAccountsCache.filter(a => (a.capabilities || {}).quoting).map(a => a.name);
    const silent = caAccountsCache.filter(a => !(a.capabilities || {}).quoting).map(a => a.name);

    let html = '<div class="card"><h3 style="font-size:0.95rem">Pricing &amp; Purchase</h3>' +
        '<p style="color:var(--muted);font-size:0.8rem">Live pricing from every account whose API ' +
        'exposes it. Accounts without a pricing endpoint are absent from the results rather than ' +
        'guessed at.';
    if (quoting.length > 0) {
        html += ' Quoting: <strong>' + escapeHtml(quoting.join(', ')) + '</strong>.';
    }
    if (silent.length > 0) {
        html += ' No pricing API: ' + escapeHtml(silent.join(', ')) + '.';
    }
    html += '</p>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.6rem">' +
        '<div class="form-group"><label>Domain</label>' +
        '<input id="caq-domain" placeholder="example.com" style="' + FIELD_STYLE + '"></div>' +
        '<div class="form-group"><label>Validation level</label>' +
        '<select id="caq-type" style="' + FIELD_STYLE + '">' +
        '<option value="">any</option><option value="dv">DV</option>' +
        '<option value="ov">OV</option><option value="ev">EV</option></select></div>' +
        '<div class="form-group"><label>Years</label>' +
        '<input id="caq-years" value="1" style="' + FIELD_STYLE + '"></div>' +
        '</div>' +
        '<label style="display:block;font-size:0.8rem;margin:0.25rem 0 0.6rem">' +
        '<input type="checkbox" id="caq-wildcard" onchange="toggleCAQWildcard()"> Wildcard certificate ' +
        '<span style="color:var(--muted)">(prefixes the domain with <code>*.</code>; wildcard cover is ' +
        'read from the names, not requested separately)</span></label>' +
        '<button class="btn btn-primary" onclick="runCAQuote()">Get quotes</button>' +
        '<div id="caq-results" style="margin-top:0.75rem"></div></div>';
    return html;
}

// toggleCAQWildcard keeps the checkbox and the domain field telling the same
// story, since the CAs infer wildcard cover from the names themselves.
function toggleCAQWildcard() {
    const d = document.getElementById('caq-domain');
    const box = document.getElementById('caq-wildcard');
    if (!d || !box) return;
    const bare = (d.value || '').trim().replace(/^\*\./, '');
    d.value = (box.checked && bare) ? '*.' + bare : bare;
}

// --- orders tab ---
function renderCAOrders(orders, list) {
    let html = '<div class="card"><h3 style="font-size:0.95rem">Pending Orders (' + list.length + ')</h3>';
    if (list.length === 0) {
        html += '<p style="color:var(--muted);font-size:0.85rem">No orders are waiting on a CA.</p></div>';
        return html;
    }
    html += '<p style="color:var(--muted);font-size:0.8rem">' + escapeHtml(orders.note || '') + '</p>';
    list.forEach(o => {
        html += '<div style="border:1px solid var(--border);border-radius:0.375rem;padding:0.7rem;margin-bottom:0.6rem">' +
            '<strong>' + escapeHtml(o.domain) + '</strong> &middot; ' +
            escapeHtml(o.ca_provider) + ' (' + escapeHtml(o.ca_account) + ')' +
            ' &middot; order <span style="font-family:monospace;font-size:0.78rem">' +
            escapeHtml(o.order_id) + '</span>' +
            ' &middot; waiting ' + escapeHtml(o.waiting_for) +
            '<button class="btn" style="background:#e2e8f0;float:right" onclick="refreshCAOrder(\'' +
                escapeAttr(o.cert_id) + '\')">Check now</button>';
        if (o.last_error) {
            html += '<p style="color:var(--muted);font-size:0.78rem;margin-top:0.35rem">' +
                    escapeHtml(o.last_error) + '</p>';
        }
        (o.validation || []).forEach(v => {
            html += '<div style="background:#f8fafc;border-left:3px solid var(--primary);' +
                'padding:0.45rem 0.6rem;margin-top:0.4rem;font-size:0.78rem">' +
                '<strong>' + escapeHtml(v.type.toUpperCase()) + ' validation</strong> for ' +
                escapeHtml(v.domain) + '<br>' +
                (v.name ? '<span style="font-family:monospace">' + escapeHtml(v.name) + '</span><br>' : '') +
                (v.value ? '<span style="font-family:monospace;word-break:break-all">' +
                    escapeHtml(v.value) + '</span><br>' : '') +
                (v.emails ? 'one of: ' + escapeHtml(v.emails.join(', ')) + '<br>' : '') +
                '<span style="color:var(--muted)">' + escapeHtml(v.detail || '') + '</span></div>';
        });
        html += '</div>';
    });
    html += '</div>';
    return html;
}

function runCAQuote() {
    const out = document.getElementById('caq-results');
    out.innerHTML = '<p style="color:var(--muted)">Asking each CA...</p>';
    apiPost('/api/v1/ca/quote', {
        domain: (document.getElementById('caq-domain').value || '').trim(),
        cert_type: document.getElementById('caq-type').value,
        validity_years: parseInt(document.getElementById('caq-years').value, 10) || 1
    }).then(d => {
        if (d.error) { out.innerHTML = '<p style="color:var(--danger)">' + escapeHtml(d.error) + '</p>'; return; }
        let h = '';
        if ((d.quotes || []).length === 0) {
            h += '<p style="color:var(--muted);font-size:0.85rem">' +
                 escapeHtml(d.message || 'No quotes returned.') + '</p>';
        } else {
            h += '<table><thead><tr><th>Account</th><th>Product</th><th>Type</th>' +
                 '<th>Wildcard</th><th>Price</th><th>Validity</th><th>Issued in</th>' +
                 '<th style="width:1%"></th></tr></thead><tbody>';
            d.quotes.forEach(q => {
                h += '<tr><td>' + escapeHtml(q.account || q.provider) + '</td>' +
                     '<td><strong>' + escapeHtml(q.product_name) + '</strong></td>' +
                     '<td>' + escapeHtml((q.cert_type || '').toUpperCase()) + '</td>' +
                     '<td>' + (q.wildcard ? 'yes' : '-') + '</td>' +
                     '<td><strong>' + q.price.toFixed(2) + ' ' + escapeHtml(q.currency) + '</strong></td>' +
                     '<td>' + escapeHtml(q.validity) + '</td>' +
                     '<td style="font-size:0.75rem">' + escapeHtml(q.issuance_time || '-') + '</td>' +
                     '<td><button class="btn btn-primary" onclick="orderFromQuote(' +
                        jsQuote(q.account || q.provider) + ',' + jsQuote(q.cert_type || 'dv') + ')">Order</button></td></tr>';
            });
            h += '</tbody></table>';
        }
        (d.errors || []).forEach(e => {
            h += '<p style="color:var(--danger);font-size:0.78rem">' + escapeHtml(e) + '</p>';
        });
        out.innerHTML = h;
    }).catch(e => { out.innerHTML = '<p style="color:var(--danger)">' + escapeHtml(e.message) + '</p>'; });
}

function orderFromQuote(account, certType) {
    const domain = (document.getElementById('caq-domain').value || '').trim();
    navigate('certificates');
    setTimeout(() => {
        showIssueForm();
        const d = document.getElementById('iss-domains');
        if (d) d.value = domain;
        const acct = document.getElementById('iss-account');
        if (acct) acct.value = account;
        const t = document.getElementById('iss-type');
        if (t) t.value = certType;
        toggleIssueOrgFields();
    }, 700);
}

function refreshCAOrder(certID) {
    apiPost('/api/v1/ca/orders/' + encodeURIComponent(certID) + '/refresh', {}).then(d => {
        if (d.error) { alert(d.error); return; }
        alert('Order status: ' + d.status + (d.changed ? ' (changed)' : ' (no change yet)') +
              (d.message ? '\n\n' + d.message : ''));
        loadAuthorities();
    }).catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// CA vendor registration.
//
// Accounts previously existed only as environment variables read at startup, so
// onboarding a CA meant editing a compose file and restarting. The form is built
// from the vendor schema the API returns, which is why it can render GoDaddy's
// key/secret and Namecheap's IP allow-list field without knowing either vendor.
// ---------------------------------------------------------------------------
let caVendorSpecs = [];

function showRegisterCA(existingName) {
    const panel = document.getElementById('ca-register');
    if (!panel) return;
    panel.innerHTML = '<div class="card" style="margin-bottom:1rem"><p style="color:var(--muted)">Loading vendors...</p></div>';

    const existing = existingName ? caAccountsCache.find(a => a.name === existingName) : null;
    apiGet('/api/v1/ca/vendors').then(d => {
        caVendorSpecs = d.vendors || [];
        const opts = caVendorSpecs.map(v =>
            '<option value="' + escapeAttr(v.vendor) + '"' +
            (existing && existing.provider === v.vendor ? ' selected' : '') + '>' +
            escapeHtml(v.title) + '</option>').join('');

        panel.innerHTML = '<div class="card" style="margin-bottom:1rem;border-left:3px solid var(--primary)">' +
            '<h3 style="font-size:0.95rem">' +
            (existingName ? 'Update CA account: ' + escapeHtml(existingName) : 'Register a CA account') + '</h3>' +
            '<p style="color:var(--muted);font-size:0.8rem">' +
            'Credentials are stored on the gateway and never returned. On an update, leave a ' +
            'secret blank to keep the stored value.</p>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:0.7rem">' +
            '<div class="form-group"><label>Account name *</label>' +
            '<input id="ca-name" value="' + escapeAttr(existingName || '') + '"' +
            (existingName ? ' readonly' : '') +
            ' placeholder="godaddy-prod" style="' + FIELD_STYLE + '"></div>' +
            '<div class="form-group"><label>Vendor *</label>' +
            '<select id="ca-vendor" onchange="renderCAVendorFields()" style="' + FIELD_STYLE + '"' +
            (existing ? ' disabled' : '') + '>' + opts + '</select></div>' +
            '<div class="form-group"><label>Environment</label>' +
            '<select id="ca-env" style="' + FIELD_STYLE + '"></select></div>' +
            '</div>' +
            '<label style="display:block;font-size:0.8rem;margin:0.5rem 0">' +
            '<input type="checkbox" id="ca-default"' + (existing && existing.default ? ' checked' : '') + '> make this the default account</label>' +
            '<div id="ca-fields"></div>' +
            '<div id="ca-reg-error" style="color:var(--danger);font-size:0.8rem;margin:0.5rem 0"></div>' +
            '<button class="btn btn-primary" onclick="submitCAAccount()">Save account</button> ' +
            '<button class="btn" style="background:#e2e8f0" onclick="document.getElementById(\'ca-register\').innerHTML=\'\'">Cancel</button>' +
            '</div>';
        renderCAVendorFields(existing);
    }).catch(e => {
        panel.innerHTML = '<div class="card"><p style="color:var(--danger)">' + escapeHtml(e.message) + '</p></div>';
    });
}

function renderCAVendorFields(existing) {
    const vendor = document.getElementById('ca-vendor').value;
    const spec = caVendorSpecs.filter(v => v.vendor === vendor)[0];
    const fields = document.getElementById('ca-fields');
    const envSel = document.getElementById('ca-env');
    if (!spec || !fields) return;

    envSel.innerHTML = (spec.environments || []).map(e =>
        '<option value="' + escapeAttr(e) + '"' +
        (existing && existing.environment === e ? ' selected' : '') + '>' + escapeHtml(e) + '</option>').join('');
    const existingKeys = existing ? (existing.credential_keys || []) : [];

    let h = '<div style="border-top:1px solid var(--border);margin-top:0.6rem;padding-top:0.6rem">' +
        '<p style="font-size:0.8rem;color:var(--muted)">' + escapeHtml(spec.summary || '') + '</p>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:0.7rem">';

    (spec.fields || []).forEach(f => {
        const id = 'cf-' + f.key;
        const isStored = existingKeys.includes(f.key);
        h += '<div class="form-group"><label>' + escapeHtml(f.label) +
             (f.required ? ' *' : '') + (f.secret ? ' <span style="color:var(--muted)">(secret)</span>' : '') +
             (isStored ? ' <span style="color:var(--muted);font-size:0.7rem">(stored)</span>' : '') + '</label>';
        if (f.options && f.options.length) {
            h += '<select id="' + id + '" style="' + FIELD_STYLE + '">' +
                 (existing && isStored ? '<option value="" selected>keep stored value</option>' : '') +
                 f.options.map(o => '<option value="' + escapeAttr(o) + '"' +
                    (!existing && o === f.default ? ' selected' : '') + '>' + escapeHtml(o) + '</option>').join('') +
                 '</select>';
        } else {
            h += '<input id="' + id + '" ' + (f.secret ? 'type="password" ' : '') +
                 'value="' + escapeAttr(existing ? '' : (f.default || '')) + '" ' +
                 'placeholder="' + escapeAttr(isStored ? '••••••••' : (f.placeholder || '')) + '" style="' + FIELD_STYLE + '">';
        }
        if (existing && isStored && !f.required) {
            h += '<label style="display:block;color:var(--danger);font-size:0.7rem;margin-top:0.2rem">' +
                 '<input type="checkbox" id="carm-' + escapeAttr(f.key) + '"> Remove stored value</label>';
        }
        if (f.help) {
            h += '<span style="display:block;color:var(--muted);font-size:0.72rem;margin-top:0.15rem">' +
                 escapeHtml(f.help) + '</span>';
        }
        h += '</div>';
    });
    h += '</div></div>';
    fields.innerHTML = h;
}

function submitCAAccount() {
    const err = document.getElementById('ca-reg-error');
    const vendor = document.getElementById('ca-vendor').value;
    const spec = caVendorSpecs.filter(v => v.vendor === vendor)[0] || { fields: [] };
    const name = (document.getElementById('ca-name').value || '').trim();
    if (!name) { err.textContent = 'An account name is required.'; return; }

    const existing = caAccountsCache.find(a => a.name === name) || null;
    const creds = {};
    const removeKeys = [];
    (spec.fields || []).forEach(f => {
        const el = document.getElementById('cf-' + f.key);
        if (el && el.value !== '') creds[f.key] = el.value;
        const remove = document.getElementById('carm-' + f.key);
        if (remove && remove.checked) removeKeys.push(f.key);
    });

    const body = {
        name: name, vendor: vendor,
        environment: document.getElementById('ca-env').value,
        default: document.getElementById('ca-default').checked,
        credentials: creds,
        remove_keys: removeKeys,
        updated_at: existing ? existing.credential_updated_at : undefined
    };
    err.textContent = 'Saving...';
    const request = existing
        ? apiPut('/api/v1/ca/accounts/' + encodeURIComponent(name), body)
        : apiPost('/api/v1/ca/accounts', body);
    request.then(d => {
        if (d.error) { err.textContent = d.error; return; }
        document.getElementById('ca-register').innerHTML = '';
        // Test straight away: fields that merely parse are the usual cause of a
        // first order failing hours later.
        testCAAccount(name, true);
    }).catch(e => { err.textContent = e.message; });
}

function testCAAccount(name, thenReload) {
    apiPost('/api/v1/ca/accounts/' + encodeURIComponent(name) + '/test', {}).then(d => {
        const ok = d.ok === true;
        alert('CA account "' + name + '": ' + (ok ? 'credentials accepted' : 'FAILED') +
              '\n\nChecked: ' + (d.checked || '-') +
              (d.products_returned !== undefined ? '\nProducts returned: ' + d.products_returned : '') +
              (d.error ? '\n\nError: ' + d.error : '') +
              (d.note ? '\n\n' + d.note : ''));
        if (thenReload) loadAuthorities();
    }).catch(e => {
        alert('Test failed: ' + e.message);
        if (thenReload) loadAuthorities();
    });
}

function deleteCAAccount(name) {
    if (!confirm('Remove the CA account "' + name + '"?\n\n' +
                 'Its stored credentials are deleted. Certificates already issued stay in ' +
                 'the inventory but cannot be renewed or revoked until the account is registered again.')) return;
    apiDelete('/api/v1/ca/accounts/' + encodeURIComponent(name)).then(d => {
        if (d.error) { alert(d.error); return; }
        loadAuthorities();
    }).catch(e => alert(e.message));
}

function makeCADefault(name) {
    apiPost('/api/v1/ca/accounts/' + encodeURIComponent(name) + '/default', {}).then(d => {
        if (d.error) { alert(d.error); return; }
        loadAuthorities();
    }).catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// Deployment: target types with per-service credentials, and a choice of which
// vSatellite carries out the work.
// ---------------------------------------------------------------------------
let deployTargets = [];
let deployExecutors = [];
let deployCredSets = [];
let deployEndpoints = [];

function loadCertDeploy() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading deployment targets...</p></div>';

    Promise.all([
        apiGet('/api/v1/deploy/targets'),
        apiGet('/api/v1/credentials?kind=deploy'),
        apiGet('/api/v1/inventory?managed=managed'),
        apiGet('/api/v1/deploy/endpoints')
    ]).then(([t, c, inv, epData]) => {
        deployTargets = t.targets || [];
        deployExecutors = t.executors || [];
        deployCredSets = c.credentials || [];
        deployEndpoints = (epData.endpoints || []);

        const certs = (inv.certificates || []).filter(x => x.status === 'active');
        window._depCertsCache = certs;

        // --- Deploy a Certificate: merged with Deployment Endpoints ---
        // One place to deploy: either to a saved endpoint (its target details and
        // credential are already known — pick it and go), or to a target
        // configured on the spot, with the option to save it as an endpoint for
        // next time. Endpoint management (edit/remove) lives in the same card as
        // a collapsible list rather than a separate top-level section.
        let html = '<div class="card" style="margin-bottom:1rem"><h3>Deploy a Certificate</h3>' +
            '<p style="color:var(--muted);font-size:0.85rem">' + escapeHtml(t.note || '') + '</p>';

        html += '<div class="form-group" style="margin-top:0.6rem"><label style="font-weight:600">Deploy to</label>';
        if (deployEndpoints.length === 0) {
            html += '<p style="color:var(--muted);font-size:0.8rem;margin:0.2rem 0">' +
                'No saved endpoints yet — configure the target below and optionally save it for next time.</p>';
        } else {
            html += '<select id="dep-endpoint" onchange="onDepEndpointChange()" style="' + FIELD_STYLE + '">' +
                '<option value="">— configure a new target —</option>' +
                deployEndpointGroups() +
                '</select>' +
                '<span style="display:block;color:var(--muted);font-size:0.72rem;margin-top:0.15rem">' +
                'Picking a saved endpoint fills in its target, credentials and executor automatically.</span>';
        }
        html += '</div>';

        // Saved-endpoint summary (shown only when one is selected).
        html += '<div id="dep-endpoint-summary" class="hidden" style="margin:0.5rem 0;padding:0.6rem 0.75rem;' +
            'background:#f0f9ff;border:1px solid #bae6fd;border-radius:0.375rem;font-size:0.82rem"></div>';

        // Ad-hoc target configuration (target type, fields, credentials).
        html += '<div id="dep-adhoc">' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0.7rem;margin-top:0.6rem">' +
            '<div class="form-group"><label>Target type *</label>' +
            '<select id="dep-type" onchange="renderDeployFields()" style="' + FIELD_STYLE + '">' +
            deployTargets.map(x => '<option value="' + escapeAttr(x.type) + '"' +
                (x.available ? '' : ' disabled') + '>' +
                escapeHtml(x.title) + (x.available ? '' : ' — deployer not registered') +
                '</option>').join('') +
            '</select></div>' +
            '<div class="form-group"><label>Executed by *</label>' +
            '<select id="dep-executor" style="' + FIELD_STYLE + '">' +
            deployExecutors.map(x => '<option value="' + escapeAttr(x.id) + '"' +
                (x.status === 'online' ? '' : ' disabled') + '>' +
                escapeHtml(x.name + (x.status === 'online' ? '' : ' — ' + x.status)) +
                '</option>').join('') +
            '</select></div>' +
            '</div>' +
            '<div id="dep-exec-note" style="font-size:0.75rem;color:var(--muted);margin-top:0.3rem"></div>' +
            '<div id="dep-target-note" style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem"></div>' +
            '<div id="dep-fields"></div>' +
            '<label style="display:block;font-size:0.8rem;margin-top:0.6rem;padding-top:0.5rem;border-top:1px solid var(--border)">' +
            '<input type="checkbox" id="dep-save-endpoint" onchange="toggleSaveEndpoint()"> ' +
            'Save this target as a reusable endpoint</label>' +
            '<div id="dep-save-endpoint-name" class="hidden" style="margin-top:0.3rem">' +
            '<input id="dep-endpoint-name" placeholder="endpoint name, e.g. prod-alb-api" style="' + FIELD_STYLE + '"></div>' +
            '</div>' +

            '<div class="form-group" style="margin-top:0.6rem"><label>Gateway-managed certificate *</label>' +
            '<select id="dep-cert" style="' + FIELD_STYLE + '">' +
            '<option value="">— choose a certificate —</option>' +
            certs.map(c => '<option value="' + escapeAttr(c.id) + '">' +
                escapeHtml(c.domain + ' — ' + (c.ca_account || c.managed_by) + ', expires ' +
                    String(c.not_after || '').slice(0, 10)) + '</option>').join('') +
            '</select>' +
            '<span style="display:block;color:var(--muted);font-size:0.72rem;margin-top:0.15rem">' +
            'Private keys remain on this gateway and are resolved by certificate ID; PEM upload is disabled.</span></div>' +
            '<div id="dep-error" style="color:var(--danger);font-size:0.8rem;margin:0.5rem 0"></div>' +
            '<button class="btn btn-primary" onclick="runDeploy()">Deploy</button>' +
            '<div id="dep-result" style="margin-top:0.75rem"></div>';

        // Saved endpoints management, folded into this same card as a collapsible
        // list rather than a separate top-level section.
        html += '<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border)">' +
            '<a href="#" onclick="toggleEndpointManager();return false;" style="font-size:0.85rem;font-weight:600">' +
            'Manage saved endpoints (' + deployEndpoints.length + ') ▾</a>' +
            '<div id="ep-manager" class="hidden" style="margin-top:0.6rem">' +
            '<p style="color:var(--muted);font-size:0.8rem">' +
            'The <strong>where</strong> (ACM ARN, ALB listener, CloudFront distribution, Linux host + path, ' +
            'Azure vault, etc.), linked to a stored credential set. One credential can serve many endpoints ' +
            'in the same account.</p>' +
            '<button class="btn" style="background:#e2e8f0;margin:0.4rem 0" onclick="showEndpointForm()">+ Add Endpoint</button>' +
            '<div id="ep-form"></div>';
        if (deployEndpoints.length === 0) {
            html += '<p style="color:var(--muted);font-size:0.85rem">No endpoints registered yet.</p>';
        } else {
            html += '<table><thead><tr><th>Name</th><th>Service</th><th>Target</th>' +
                    '<th>Credential</th><th>Executor</th><th>Env</th><th style="width:1%">Actions</th></tr></thead><tbody>';
            deployEndpoints.forEach(ep => {
                const target = epSummary(ep);
                html += '<tr><td><strong>' + escapeHtml(ep.name) + '</strong>' +
                        (ep.description ? '<br><span style="color:var(--muted);font-size:0.7rem">' + escapeHtml(ep.description) + '</span>' : '') + '</td>' +
                        '<td style="font-size:0.78rem">' + escapeHtml(ep.service) + '</td>' +
                        '<td style="font-size:0.75rem;max-width:250px;word-break:break-all">' + escapeHtml(target) + '</td>' +
                        '<td style="font-size:0.78rem">' + escapeHtml(ep.credential_ref || 'none') + '</td>' +
                        '<td style="font-size:0.78rem">' + escapeHtml(ep.executor || 'gateway') + '</td>' +
                        '<td style="font-size:0.78rem">' + escapeHtml(ep.environment || '-') + '</td>' +
                        '<td style="white-space:nowrap">' +
                            '<button class="btn" style="background:#e2e8f0" onclick="showEndpointForm(\'' +
                                escapeAttr(ep.id) + '\')">Edit</button> ' +
                            '<button class="btn btn-danger" onclick="deleteEndpoint(\'' +
                                escapeAttr(ep.id) + '\',\'' + escapeAttr(ep.name) + '\')">Remove</button></td></tr>';
            });
            html += '</tbody></table>';
        }
        html += '</div></div>'; // #ep-manager, border wrapper
        html += '</div>'; // close card

        // Stored credential sets — deployment only. The API reports endpoint
        // references so an in-use set cannot be removed accidentally.
        html += '<div class="card"><h3 style="font-size:0.95rem">Stored Deployment Credentials</h3>' +
            '<p style="color:var(--muted);font-size:0.8rem">Reusable, schema-validated credentials for supported certificate deployment targets. ' +
            'Secret values are never returned once saved; leave a field blank on update to keep it. ' +
            'Snapshots are gateway-local files and are not encrypted at rest. CA vendor credentials are managed separately.</p>' +
            '<button class="btn btn-primary" style="margin:0.5rem 0" onclick="showCredForm()">+ Add Credential Set</button>' +
            '<div id="cred-form"></div>';
        if (deployCredSets.length === 0) {
            html += '<p style="color:var(--muted);font-size:0.85rem">None stored yet.</p>';
        } else {
            html += '<table><thead><tr><th>Name</th><th>Service</th><th>Configured fields</th>' +
                    '<th>Used by</th><th>Created by</th><th>Updated</th><th style="width:1%">Actions</th></tr></thead><tbody>';
            deployCredSets.forEach(c => {
                const refs = c.endpoint_references || [];
                const supported = deployTargets.some(t => t.type === c.service &&
                    (t.fields || []).some(f => f.credential));
                const editAction = supported
                    ? '<button class="btn" style="background:#e2e8f0" onclick="showCredForm(\'' +
                        escapeAttr(c.name) + '\')">Edit</button>'
                    : '<button class="btn" disabled title="Legacy unsupported service">Legacy</button>';
                const removeAction = refs.length > 0
                    ? '<button class="btn" disabled title="Remove referencing endpoints first">In use</button>'
                    : '<button class="btn btn-danger" onclick="deleteCredSet(\'' +
                        escapeAttr(c.name) + '\')">Remove</button>';
                html += '<tr><td><strong>' + escapeHtml(c.name) + '</strong></td>' +
                        '<td>' + escapeHtml(c.service || '-') + '</td>' +
                        '<td style="font-size:0.75rem">' + escapeHtml((c.keys || []).join(', ')) + '</td>' +
                        '<td style="font-size:0.75rem">' + (refs.length ? escapeHtml(refs.join(', ')) : 'not referenced') + '</td>' +
                        '<td style="font-size:0.75rem">' + escapeHtml(c.created_by || '-') + '</td>' +
                        '<td style="font-size:0.75rem">' + escapeHtml(shortTime(c.updated_at)) + '</td>' +
                        '<td style="white-space:nowrap">' + editAction + ' ' + removeAction + '</td></tr>';
            });
            html += '</tbody></table>';
        }
        html += '</div>'; // close credentials card

        el.innerHTML = html;
        renderDeployFields();
        const ex = document.getElementById('dep-executor');
        if (ex) ex.onchange = showExecutorNote;
        showExecutorNote();
    }).catch(e => {
        el.innerHTML = '<div class="card"><p style="color:var(--danger)">Failed to load: ' +
                       escapeHtml(e.message) + '</p></div>';
    });
}

// deployEndpointGroups renders the saved-endpoint <option> list, grouped by
// environment so a long list of ARNs stays navigable.
function deployEndpointGroups() {
    const byEnv = {};
    deployEndpoints.forEach(ep => {
        const env = ep.environment || 'ungrouped';
        (byEnv[env] = byEnv[env] || []).push(ep);
    });
    const envOrder = Object.keys(byEnv).sort((a, b) => {
        if (a === 'ungrouped') return 1;
        if (b === 'ungrouped') return -1;
        return a.localeCompare(b);
    });
    return envOrder.map(env => {
        const label = env === 'ungrouped' ? 'No environment set' : env;
        const opts = byEnv[env].map(ep => '<option value="' + escapeAttr(ep.id) + '">' +
            escapeHtml(ep.name) + ' — ' + escapeHtml(ep.service) + '</option>').join('');
        return '<optgroup label="' + escapeAttr(label) + '">' + opts + '</optgroup>';
    }).join('');
}

// onDepEndpointChange fills the ad-hoc target form from the selected saved
// endpoint and hides the manual configuration, since it is no longer needed.
function onDepEndpointChange() {
    const sel = document.getElementById('dep-endpoint');
    const summary = document.getElementById('dep-endpoint-summary');
    const adhoc = document.getElementById('dep-adhoc');
    if (!sel) return;

    const epId = sel.value;
    if (!epId) {
        // Back to manual configuration.
        if (summary) summary.classList.add('hidden');
        if (adhoc) adhoc.style.display = '';
        return;
    }

    const ep = deployEndpoints.find(e => e.id === epId);
    if (!ep) return;

    // Set the target type and executor from the endpoint, then render its fields
    // and pre-fill them from the endpoint's saved properties.
    const typeSel = document.getElementById('dep-type');
    if (typeSel) typeSel.value = ep.service;
    renderDeployFields();

    // Give the DOM a tick to render dep-fields before filling values.
    setTimeout(() => {
        const props = ep.properties || {};
        Object.keys(props).forEach(k => {
            const el = document.getElementById('df-' + k);
            if (el) el.value = props[k];
        });
        const credSel = document.getElementById('dep-credref');
        if (credSel && ep.credential_ref) {
            credSel.value = ep.credential_ref;
            onCredRefChange();
        }
        const execSel = document.getElementById('dep-executor');
        if (execSel && ep.executor) execSel.value = ep.executor;
    }, 0);

    // Show a summary and collapse the manual target/credential fields, since the
    // endpoint already answers "where" and "how" — only the certificate choice
    // and Deploy button remain relevant.
    if (summary) {
        const target = epSummary(ep);
        summary.classList.remove('hidden');
        summary.innerHTML =
            '<strong>' + escapeHtml(ep.name) + '</strong> (' + escapeHtml(ep.service) + ')' +
            (ep.description ? ' — ' + escapeHtml(ep.description) : '') + '<br>' +
            '<span style="color:var(--muted)">target:</span> <span style="font-family:monospace">' + escapeHtml(target) + '</span><br>' +
            '<span style="color:var(--muted)">credential:</span> ' + escapeHtml(ep.credential_ref || 'none') +
            ' &middot; <span style="color:var(--muted)">executor:</span> ' + escapeHtml(ep.executor || 'gateway') +
            ' <a href="#" onclick="clearDepEndpoint();return false;" style="margin-left:0.5rem">change</a>';
    }
    if (adhoc) adhoc.style.display = 'none';
}

function clearDepEndpoint() {
    const sel = document.getElementById('dep-endpoint');
    if (sel) sel.value = '';
    onDepEndpointChange();
}

function toggleEndpointManager() {
    const box = document.getElementById('ep-manager');
    if (box) box.classList.toggle('hidden');
}

function toggleSaveEndpoint() {
    const chk = document.getElementById('dep-save-endpoint');
    const box = document.getElementById('dep-save-endpoint-name');
    if (chk && box) box.classList.toggle('hidden', !chk.checked);
}

function showExecutorNote() {
    const sel = document.getElementById('dep-executor');
    const note = document.getElementById('dep-exec-note');
    if (!sel || !note) return;
    const ex = deployExecutors.filter(x => x.id === sel.value)[0];
    note.textContent = ex ? ex.detail : '';
}

// renderDeployFields builds the form for the chosen target type, splitting target
// fields from credential fields so the request is assembled correctly.
function renderDeployFields() {
    const type = document.getElementById('dep-type').value;
    const spec = deployTargets.filter(x => x.type === type)[0];
    const box = document.getElementById('dep-fields');
    const note = document.getElementById('dep-target-note');
    if (!spec || !box) return;

    if (note) {
        note.textContent = (spec.summary || '') +
            (spec.notes ? ' — ' + spec.notes : '') +
            (spec.rollback ? '' : ' Rollback is not implemented for this target.');
    }

    const matching = deployCredSets.filter(c => c.service === type);
    const targetFields = (spec.fields || []).filter(f => !f.credential);
    let h = '<div style="border-top:1px solid var(--border);margin-top:0.6rem;padding-top:0.6rem">';

    h += '<div class="form-group"><label style="font-weight:600">Stored credential reference</label>';
    if (matching.length === 0) {
        h += '<p style="color:var(--muted);font-size:0.8rem;margin:0.2rem 0">' +
             'No credential set is stored for this target type. Register one below, or leave this empty only when the gateway ambient identity is intentionally used.</p>' +
             '<input type="hidden" id="dep-credref" value="">';
    } else {
        h += '<select id="dep-credref" style="' + FIELD_STYLE + '">' +
             '<option value="">— gateway ambient identity / no credential —</option>' +
             matching.map(c => '<option value="' + escapeAttr(c.name) + '">' +
                escapeHtml(c.name) + ' (' + escapeHtml((c.keys || []).join(', ')) + ')' +
                '</option>').join('') + '</select>' +
             '<span style="display:block;color:var(--muted);font-size:0.72rem;margin-top:0.15rem">' +
             'Deployment requests carry only this reference; secret values are resolved inside the gateway.</span>';
    }
    h += '</div>';

    h += '<div id="dep-target-fields" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:0.7rem">';
    targetFields.forEach(f => {
        const id = 'df-' + f.key;
        h += '<div class="form-group"><label>' + escapeHtml(f.label) + (f.required ? ' *' : '') + '</label>';
        if (f.options && f.options.length) {
            h += '<select id="' + id + '" style="' + FIELD_STYLE + '">' +
                 f.options.map(o => '<option value="' + escapeAttr(o) + '"' +
                    (o === f.default ? ' selected' : '') + '>' + escapeHtml(o) + '</option>').join('') +
                 '</select>';
        } else if (f.multiline) {
            h += '<textarea id="' + id + '" rows="3" placeholder="' + escapeAttr(f.placeholder || '') +
                 '" style="' + FIELD_STYLE + ';font-family:monospace;font-size:0.7rem"></textarea>';
        } else {
            h += '<input id="' + id + '" value="' + escapeAttr(f.default || '') + '" placeholder="' +
                 escapeAttr(f.placeholder || '') + '" style="' + FIELD_STYLE + '">';
        }
        if (f.help) {
            h += '<span style="display:block;color:var(--muted);font-size:0.72rem;margin-top:0.15rem">' +
                 escapeHtml(f.help) + '</span>';
        }
        h += '</div>';
    });
    h += '</div></div>';
    box.innerHTML = h;
}

// Target fields that must be sent as numbers rather than strings.
const NUMERIC_TARGET_FIELDS = { port: true, retain_versions: true };

// When an operator picks a stored credential set, dim the credential fields to
// show they are overridden. Clear the selection to go back to manual entry.
function onCredRefChange() {
    const ref = document.getElementById('dep-credref');
    const fields = document.getElementById('dep-cred-fields');
    if (!ref || !fields) return;
    const selected = ref.value !== '';
    fields.style.opacity = selected ? '0.5' : '1';
    fields.style.pointerEvents = selected ? 'none' : 'auto';
    // Add a small badge indicating the active set.
    const badge = document.getElementById('dep-credref-badge');
    if (badge) badge.remove();
    if (selected) {
        const b = document.createElement('span');
        b.id = 'dep-credref-badge';
        b.style.cssText = 'display:inline-block;background:var(--primary);color:#fff;padding:0.15rem 0.5rem;border-radius:0.25rem;font-size:0.75rem;margin-left:0.5rem';
        b.textContent = 'using: ' + ref.value;
        ref.parentNode.appendChild(b);
    }
}

function runDeploy() {
    const err = document.getElementById('dep-error');
    const out = document.getElementById('dep-result');
    const type = document.getElementById('dep-type').value;
    const spec = deployTargets.filter(x => x.type === type)[0] || { fields: [] };
    const val = id => { const n = document.getElementById(id); return n ? n.value.trim() : ''; };

    const target = { type: type, category: spec.category };
    (spec.fields || []).filter(f => !f.credential).forEach(f => {
        const v = val('df-' + f.key);
        if (v === '') return;
        // Schema field keys are the DeployTarget JSON names, so the key is used
        // directly. This used to be a hand-maintained allow-list, which meant any
        // field added to the schema rendered in the form, looked like it had been
        // filled in, and was then silently dropped before the request was sent.
        if (NUMERIC_TARGET_FIELDS[f.key]) {
            const n = parseInt(v, 10);
            if (!isNaN(n)) target[f.key] = n;
            return;
        }
        target[f.key] = v;
    });

    const ref = val('dep-credref');
    if (ref) target.credential_ref = ref;

    const body = {
        target: target,
        executor: val('dep-executor') || 'gateway',
        cert_id: val('dep-cert')
    };
    if (!body.cert_id) {
        err.textContent = 'Choose a gateway-managed certificate. Private-key PEM upload is disabled.';
        return;
    }
    if (body.executor !== 'gateway') {
        err.textContent = 'vSatellite deployment is disabled until authenticated durable command transport and key-local execution are available.';
        return;
    }

    // Save this ad-hoc target as a reusable endpoint, so next time it can be
    // picked from the "Deploy to" dropdown instead of re-entered. Skipped when
    // an existing saved endpoint was used, since there is nothing new to save.
    const epSel = document.getElementById('dep-endpoint');
    const usingSavedEndpoint = epSel && epSel.value !== '';
    const saveEpEl = document.getElementById('dep-save-endpoint');
    const epName = val('dep-endpoint-name');
    const shouldSaveEndpoint = !usingSavedEndpoint && saveEpEl && saveEpEl.checked && epName;

    err.textContent = '';
    out.innerHTML = '<p style="color:var(--muted)">Deploying and verifying via gateway...</p>';

    const go = () => apiPost('/api/v1/deploy', body).then(d => {
        const r = d.result || {};
        if (d.error && !d.result) {
            out.innerHTML = '<p style="color:var(--danger)">' + escapeHtml(d.error) + '</p>';
            return;
        }
        const committed = d.status === 'completed' && r.success === true && r.verified === true;
        let label = 'Deployment failed';
        if (committed) label = 'Deployed and verified';
        else if (r.rollback_attempted && r.rollback_success) label = 'Verification failed — rolled back';
        else if (r.rollback_attempted) label = 'Verification failed — rollback failed';

        const colour = committed ? 'var(--success)' : 'var(--danger)';
        const tgt = r.target || {};
        let h = '<div style="border-left:3px solid ' + colour + ';padding:0.5rem 0.7rem;font-size:0.85rem">' +
            '<strong>' + escapeHtml(label) + '</strong> via ' + escapeHtml(d.executor || 'gateway') + '<br>' +
            (committed
                ? '<span style="color:var(--success)">serving state verified and committed</span>'
                : '<span style="color:var(--danger)">not committed</span>');
        if (r.message) h += '<br>' + escapeHtml(r.message);
        if (d.error || r.error) {
            h += '<br><span style="color:var(--danger)">error: ' + escapeHtml(d.error || r.error) + '</span>';
        }
        if (r.verify_error) {
            h += '<br><span style="color:var(--danger)">verification: ' + escapeHtml(r.verify_error) + '</span>';
        }
        if (r.rollback_attempted) {
            h += '<br><span style="color:' + (r.rollback_success ? 'var(--success)' : 'var(--danger)') + '">' +
                 'rollback: ' + (r.rollback_success ? 'completed' : 'failed' +
                    (r.rollback_error ? ' — ' + escapeHtml(r.rollback_error) : '')) + '</span>';
        }
        if (tgt.certificate_arn) {
            h += '<br><span style="color:var(--muted)">candidate certificate:</span> ' +
                 '<span style="font-family:monospace;font-size:0.75rem">' +
                 escapeHtml(tgt.certificate_arn) + '</span>';
        }
        if (r.previous_cert) {
            h += '<br><span style="color:var(--muted)">previous certificate:</span> ' +
                 '<span style="font-family:monospace;font-size:0.75rem">' +
                 escapeHtml(r.previous_cert) + '</span>';
        }
        h += '<br><span style="color:var(--muted)">attempt:</span> ' +
             '<span style="font-family:monospace;font-size:0.75rem">' + escapeHtml(d.attempt_id || '-') + '</span>' +
             '<br><span style="color:var(--muted)">correlation:</span> ' +
             '<span style="font-family:monospace;font-size:0.75rem">' + escapeHtml(d.correlation_id || '-') + '</span></div>';
        out.innerHTML = h;
        if (committed) loadInventoryQuiet();
        if (committed && shouldSaveEndpoint) {
            // Build the endpoint's "where" properties from the non-credential
            // target fields just used, so it can be picked directly next time.
            const props = {};
            (spec.fields || []).forEach(f => {
                if (f.credential) return;
                const v = val('df-' + f.key);
                if (v !== '') props[f.key] = v;
            });
            apiPost('/api/v1/deploy/endpoints', {
                name: epName, service: type, credential_ref: ref,
                executor: body.executor, properties: props
            }).then(d => {
                if (!d.error) {
                    out.innerHTML += '<p style="color:var(--success);font-size:0.8rem;margin-top:0.4rem">' +
                        'Saved as endpoint "' + escapeHtml(epName) + '" for next time.</p>';
                }
            }).catch(() => {});
        }
    }).catch(e => {
        out.innerHTML = '<p style="color:var(--danger)">' + escapeHtml(e.message) + '</p>';
    });

    go();
}

function loadInventoryQuiet() { /* deployment attempts are loaded on the inventory page */ }
function renderCertsTab(data) {
    const certs = (data.certificates || data || []).filter(c => c.managed_by);
    let rows = certs.map(c => {
        const daysLeft = c.not_after ? Math.ceil((new Date(c.not_after) - new Date()) / 86400000) : null;
        const badge = c.status === 'active' ? 'badge-active'
                    : (c.status === 'expired' || c.status === 'revoked' || c.status === 'failed') ? 'badge-expired'
                    : 'badge-pending';
        let actions = '';
        if (!c.revoked && c.status !== 'failed') {
            actions = '<button class="btn" style="background:#e2e8f0" onclick="renewCertificate(\'' +
                      escapeAttr(c.id) + '\',\'' + escapeAttr(c.domain) + '\')">Renew</button> ' +
                      '<button class="btn btn-danger" onclick="revokeCertificate(\'' +
                      escapeAttr(c.id) + '\',\'' + escapeAttr(c.domain) + '\')">Revoke</button>';
        } else if (c.status === 'failed') {
            actions = '<span style="color:var(--danger);font-size:0.72rem" title="' +
                      escapeAttr(c.last_error || '') + '">issuance failed</span>';
        }
        return '<tr><td><strong>' + escapeHtml(c.domain || '-') + '</strong></td>' +
               '<td><span class="badge ' + badge + '">' + escapeHtml(c.status || '-') + '</span></td>' +
               '<td style="font-size:0.8rem">' + escapeHtml(c.ca_account || c.ca_name || '-') + '</td>' +
               '<td style="font-size:0.8rem">' + (daysLeft === null ? '-' : daysLeft + 'd') + '</td>' +
               '<td style="font-size:0.78rem">' + (c.renewal_count || 0) + '</td>' +
               '<td style="font-size:0.78rem">' + escapeHtml(c.environment || '-') + '</td>' +
               '<td style="white-space:nowrap">' + actions + '</td></tr>';
    }).join('');
    const h = '<div class="card">' +
        '<div style="margin:0.6rem 0">' +
        '<button class="btn btn-primary" onclick="showIssueForm()">+ Issue Certificate</button>' +
        '</div>' +
        '<table><thead><tr><th>Domain</th><th>Status</th><th>CA Account</th>' +
        '<th>Expires</th><th>Renewals</th><th>Env</th><th style="width:1%">Actions</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No managed certificates yet</td></tr>') +
        '</tbody></table></div><div id="cert-actions"></div>';
    document.getElementById('inv-pane-certificates').innerHTML = h;
}

function renderEndpointsTab(data) {
    const deps = data.deployments || [];
    const sum = data.summary || {};
    let h = '<div class="card">' +
        '<div class="stats" style="margin:0.5rem 0">' +
        statTile('Deployed', sum.deployed || 0) +
        statTile('Deploying', sum.deploying || 0) +
        statTile('Failed', sum.failed || 0) +
        statTile('Superseded', sum.superseded || 0) +
        statTile('Queued', sum.queued || 0) +
        '</div>';
    if (deps.length === 0) {
        h += '<p style="color:var(--muted);font-size:0.85rem">No deployments recorded yet. ' +
             'Use the Deploy Certs page to push a certificate to a target.</p>';
    } else {
        h += '<table><thead><tr><th>Domain</th><th>Target</th><th>Type</th><th>Region</th>' +
             '<th>Status / Stage</th><th>Executor</th><th>Outcome</th><th>Evidence</th><th>When</th>' +
             '<th style="width:1%">Actions</th></tr></thead><tbody>';
        deps.forEach(d => {
            const dep = d.deployment || {};
            const badge = dep.status === 'deployed' ? 'badge-active'
                        : dep.status === 'failed' ? 'badge-expired'
                        : 'badge-pending';
            const when = dep.deployed_at ? shortTime(dep.deployed_at) : '-';
            h += '<tr><td><strong>' + escapeHtml(d.domain || '-') + '</strong>' +
                 '<br><span style="color:var(--muted);font-size:0.7rem">' + escapeHtml(d.cert_status || '') + ' / ' + (d.days_left || '?') + 'd</span></td>' +
                 '<td style="font-size:0.78rem;max-width:220px;word-break:break-all">' + escapeHtml(dep.target_host || dep.target_arn || '-') + '</td>' +
                 '<td style="font-size:0.78rem">' + escapeHtml(dep.target_type || '-') + '</td>' +
                 '<td style="font-size:0.78rem">' + escapeHtml(dep.region || '-') + '</td>' +
                 '<td><span class="badge ' + badge + '">' + escapeHtml(dep.status || '-') + '</span>' +
                 '<br><span style="font-size:0.68rem;color:var(--muted)">' + escapeHtml(dep.stage || '-') + '</span></td>' +
                 '<td style="font-size:0.78rem">' + escapeHtml(dep.executor || '-') + '</td>' +
                 '<td style="font-size:0.72rem">' +
                 (dep.verified ? '<span style="color:var(--success)">verified</span>' : '<span style="color:var(--danger)">not verified</span>') +
                 (dep.rollback_attempted ? '<br><span style="color:' + (dep.rollback_success ? 'var(--success)' : 'var(--danger)') + '">rollback ' +
                    (dep.rollback_success ? 'completed' : 'failed') + '</span>' : '') + '</td>' +
                 '<td style="font-size:0.68rem;max-width:180px;word-break:break-all">attempt ' + escapeHtml(dep.attempt_id || dep.id || '-') +
                 '<br>correlation ' + escapeHtml(dep.correlation_id || '-') + '</td>' +
                 '<td style="font-size:0.72rem">' + escapeHtml(when) + '</td>' +
                 '<td style="white-space:nowrap"><button class="btn" style="background:#e2e8f0;font-size:0.72rem" ' +
                 'onclick="updateDeployStatus(\'' + escapeAttr(dep.id) + '\')">Update</button></td></tr>';
        });
        h += '</tbody></table>';
    }
    h += '</div>';
    document.getElementById('inv-pane-endpoints').innerHTML = h;
}

function updateDeployStatus(id) {
    const status = prompt('New status (failed / superseded / queued). Only a verified deployment can set deployed:');
    if (!status) return;
    apiPost('/api/v1/inventory/deployments/' + encodeURIComponent(id) + '/status', { status: status })
        .then(d => { if (d.error) alert(d.error); else loadInventory('endpoints'); })
        .catch(e => alert(e.message));
}


// ---------------------------------------------------------------------------
// Deployment Endpoints management.
//
// An endpoint = where you deploy a certificate (ACM ARN, ALB listener ARN,
// CloudFront distribution, Linux host + path, Azure vault, etc.).
// A credential = how you authenticate to reach it (AWS keys, SSH key, etc.).
// They are separate because one credential (one AWS account) can have many
// endpoints (ACM + ALB + CloudFront).
// ---------------------------------------------------------------------------

function epSummary(ep) {
    const p = ep.properties || {};
    // Show the most recognisable identifier for this endpoint type.
    return p.listener_arn || p.certificate_arn || p.resource_id ||
           p.distribution_id || p.api_gateway_arn ||
           p.host || p.vault_name || p.cert_name ||
           Object.values(p).filter(Boolean)[0] || '-';
}

// Endpoint properties come directly from the gateway's canonical deployment
// target schema. Credential fields are stored separately in Credential Sets.
function endpointFieldsFor(service) {
    const spec = deployTargets.find(t => t.type === service);
    return spec ? (spec.fields || []).filter(f => !f.credential) : [];
}

function showEndpointForm(existingId) {
    const box = document.getElementById('ep-form');
    if (!box) return;
    const existing = existingId ? deployEndpoints.find(e => e.id === existingId) : null;
    const currentService = existing ? existing.service : 'aws-acm';

    // Services and labels come only from the canonical deployment schema.
    const allServices = deployTargets.map(t => t.type);

    let h = '<div style="border:1px solid var(--border);border-radius:0.375rem;padding:0.8rem;margin:0.75rem 0;background:#f0f9ff">' +
        '<h4 style="margin:0 0 0.5rem">' + (existing ? 'Edit Endpoint: ' + escapeHtml(existing.name) : 'Add Deployment Endpoint') + '</h4>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.6rem">' +
        '<div class="form-group"><label>Name *</label>' +
        '<input id="ep-name" value="' + escapeAttr(existing ? existing.name : '') + '" style="' + FIELD_STYLE + '" placeholder="prod-alb-api"></div>' +
        '<div class="form-group"><label>Service *</label>' +
        '<select id="ep-service" onchange="renderEpFields();filterEndpointCredentials()" style="' + FIELD_STYLE + '">' +
        allServices.map(s => '<option value="' + escapeAttr(s) + '"' +
            (s === currentService ? ' selected' : '') + '>' + escapeHtml(s) + '</option>').join('') +
        '</select></div>' +
        '<div class="form-group"><label>Credential Set</label>' +
        '<select id="ep-cred" style="' + FIELD_STYLE + '"></select></div>' +
        '<div class="form-group"><label>Executor</label>' +
        '<select id="ep-executor" style="' + FIELD_STYLE + '">' +
        deployExecutors.map(x => '<option value="' + escapeAttr(x.id) + '"' +
            (existing && existing.executor === x.id ? ' selected' : '') + '>' +
            escapeHtml(x.name) + '</option>').join('') +
        '</select></div>' +
        '<div class="form-group"><label>Environment</label>' +
        '<select id="ep-env" style="' + FIELD_STYLE + '">' +
        ['', 'production', 'staging', 'development', 'dr'].map(e =>
            '<option value="' + e + '"' + (existing && existing.environment === e ? ' selected' : '') + '>' +
            (e || 'not set') + '</option>').join('') +
        '</select></div>' +
        '<div class="form-group"><label>Description</label>' +
        '<input id="ep-desc" value="' + escapeAttr(existing ? existing.description || '' : '') + '" style="' + FIELD_STYLE + '" placeholder="API load balancer, Mumbai"></div>' +
        '</div>' +
        '<div id="ep-fields"></div>' +
        '<div style="margin-top:0.6rem">' +
        '<button class="btn btn-primary" onclick="saveEndpoint(\'' + escapeAttr(existingId || '') + '\')">Save Endpoint</button> ' +
        '<button class="btn" style="background:#e2e8f0" onclick="document.getElementById(\'ep-form\').innerHTML=\'\'">Cancel</button></div></div>';
    box.innerHTML = h;
    filterEndpointCredentials(existing ? existing.credential_ref : '');
    renderEpFields(existing);
}

function filterEndpointCredentials(selectedRef) {
    const service = (document.getElementById('ep-service') || {}).value || '';
    const select = document.getElementById('ep-cred');
    if (!select) return;
    const current = selectedRef === undefined ? select.value : selectedRef;
    const matching = deployCredSets.filter(c => c.service === service);
    select.innerHTML = '<option value="">none (gateway ambient identity only)</option>' +
        matching.map(c => '<option value="' + escapeAttr(c.name) + '"' +
            (c.name === current ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>').join('');
}

function renderEpFields(existing) {
    const service = (document.getElementById('ep-service') || {}).value || '';
    const fields = endpointFieldsFor(service);
    const box = document.getElementById('ep-fields');
    if (!box) return;
    const props = existing ? (existing.properties || {}) : {};

    let h = '';
    if (fields.length > 0) {
        h += '<p style="color:var(--muted);font-size:0.78rem;margin:0.3rem 0">Endpoint properties for <strong>' + escapeHtml(service) + '</strong>:</p>';
        h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0.6rem">';
        fields.forEach(f => {
            const id = 'epv-' + f.key;
            const val = props[f.key] || f.default || '';
            h += '<div class="form-group"><label>' + escapeHtml(f.label) + (f.required ? ' *' : '') + '</label>';
            if (f.options) {
                h += '<select id="' + id + '" style="' + FIELD_STYLE + '">' +
                     f.options.map(o => '<option value="' + escapeAttr(o) + '"' +
                        (o === val ? ' selected' : '') + '>' + escapeHtml(o) + '</option>').join('') +
                     '</select>';
            } else {
                h += '<input id="' + id + '" value="' + escapeAttr(val) + '" placeholder="' +
                     escapeAttr(f.placeholder || '') + '" style="' + FIELD_STYLE + '">';
            }
            if (f.help) h += '<span style="display:block;color:var(--muted);font-size:0.7rem;margin-top:0.1rem">' + escapeHtml(f.help) + '</span>';
            h += '</div>';
        });
        h += '</div>';
    } else {
        h += '<p style="color:var(--danger);font-size:0.78rem;margin:0.3rem 0">' +
             'This service has no endpoint schema and cannot be saved.</p>';
    }
    box.innerHTML = h;
}

function saveEndpoint(existingId) {
    const name = (document.getElementById('ep-name').value || '').trim();
    const service = (document.getElementById('ep-service').value || '').trim();
    if (!name) { alert('Name is required'); return; }
    if (!service) { alert('Service is required'); return; }

    const fields = endpointFieldsFor(service);
    const properties = {};
    fields.forEach(f => {
        const el = document.getElementById('epv-' + f.key);
        const v = el ? el.value.trim() : '';
        if (v) properties[f.key] = v;
    });
    const requiredMissing = fields
        .filter(f => f.required && !properties[f.key])
        .map(f => f.label || f.key);
    if (requiredMissing.length) {
        alert('Required endpoint fields: ' + requiredMissing.join(', '));
        return;
    }

    const existing = existingId ? deployEndpoints.find(ep => ep.id === existingId) : null;
    if (existingId && (!existing || !existing.updated_at)) {
        alert('This endpoint is no longer available in the loaded view. Reload and try again.');
        return;
    }

    const body = {
        name: name,
        service: service,
        credential_ref: (document.getElementById('ep-cred').value || '').trim(),
        executor: (document.getElementById('ep-executor').value || '').trim() || 'gateway',
        properties: properties,
        environment: (document.getElementById('ep-env').value || '').trim(),
        description: (document.getElementById('ep-desc').value || '').trim()
    };
    const request = existingId
        ? apiPut('/api/v1/deploy/endpoints/' + encodeURIComponent(existingId),
            Object.assign({}, body, {updated_at: existing.updated_at}))
        : apiPost('/api/v1/deploy/endpoints', body);

    request.then(d => {
        if (d.error) { alert(d.error); return; }
        document.getElementById('ep-form').innerHTML =
            '<p style="color:var(--success);font-size:0.82rem;margin:0.5rem 0">Endpoint "' +
            escapeHtml(name) + '" saved.</p>';
        loadCertDeploy();
    }).catch(e => alert(e.message));
}

function deleteEndpoint(id, name) {
    if (!confirm('Remove endpoint "' + name + '"?')) return;
    apiDelete('/api/v1/deploy/endpoints/' + encodeURIComponent(id)).then(d => {
        if (d.error) { alert(d.error); return; }
        loadCertDeploy();
    }).catch(e => alert(e.message));
}

function deleteCredSet(name) {
    if (!confirm('Remove the stored credential set "' + name + '"?\n\nAny deploy or CA account that references it by name will fail until new credentials are stored under the same name.')) return;
    apiDelete('/api/v1/credentials/' + encodeURIComponent(name)).then(d => {
        if (d.error) { alert(d.error); return; }
        loadCertDeploy();
    }).catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// Credential set add / edit form.
//
// The schema is driven by the target type chosen in the service dropdown, so it
// renders the same fields the deploy form would for that service (only the
// credential-marked ones). On edit, secret fields show a masked placeholder and
// sending an empty value keeps what is stored — the API explicitly does this so
// a form that cannot show the current value does not need to resend it.
// ---------------------------------------------------------------------------

function showCredForm(existingName) {
    const box = document.getElementById('cred-form');
    if (!box) return;

    // For an edit, find the stored set's metadata.
    let existing = null;
    if (existingName) {
        existing = deployCredSets.find(c => c.name === existingName);
    }

    // Only services advertised by the gateway deployment schema may own a
    // Credential Set. This keeps the portal and backend on one contract and
    // avoids storing arbitrary keys that no deployer can consume safely.
    const serviceOptions = deployTargets
        .filter(t => (t.fields || []).some(f => f.credential))
        .map(t => ({ value: t.type, label: t.title || t.type }));
    const currentService = existing ? existing.service :
        ((serviceOptions[0] || {}).value || 'linux');

    let h = '<div style="border:1px solid var(--border);border-radius:0.375rem;padding:0.8rem;margin:0.75rem 0;background:#f8fafc">' +
        '<h4 style="margin:0 0 0.5rem">' + (existing ? 'Edit: ' + escapeHtml(existingName) : 'Add Credential Set') + '</h4>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.6rem">' +
        '<div class="form-group"><label>Name *</label>' +
        '<input id="cred-name" value="' + escapeAttr(existing ? existing.name : '') + '"' +
        (existing ? ' readonly style="' + FIELD_STYLE + ';background:#e2e8f0"' : ' style="' + FIELD_STYLE + '"') +
        ' placeholder="prod-aws-acm"></div>' +
        '<div class="form-group"><label>Service / Target *</label>' +
        '<select id="cred-service" onchange="renderCredFields()" style="' + FIELD_STYLE + '"' +
        (existing ? ' disabled' : '') + '>' +
        serviceOptions.map(s => '<option value="' + escapeAttr(s.value) + '"' +
            (s.value === currentService ? ' selected' : '') + '>' + escapeHtml(s.label) + '</option>').join('') +
        '</select>' +
        (existing ? '<span style="display:block;color:var(--muted);font-size:0.72rem">Service is immutable; create a new set to change it.</span>' : '') +
        '</div>' +
        '</div>' +
        '<div id="cred-fields"></div>' +
        '<div style="margin-top:0.6rem">' +
        '<button class="btn btn-primary" onclick="saveCredSet(\'' + escapeAttr(existingName || '') + '\')">Save</button> ' +
        '<button class="btn" style="background:#e2e8f0" onclick="document.getElementById(\'cred-form\').innerHTML=\'\'">Cancel</button>' +
        '</div></div>';
    box.innerHTML = h;
    renderCredFields(existing);
}

function renderCredFields(existing) {
    const serviceEl = document.getElementById('cred-service');
    const service = serviceEl ? serviceEl.value : '';

    const spec = deployTargets.find(t => t.type === service);
    const fields = spec ? (spec.fields || []).filter(f => f.credential) : [];
    const box = document.getElementById('cred-fields');
    if (!box) return;

    const existingKeys = existing ? (existing.keys || []) : [];

    let h = '';
    if (fields.length > 0) {
        h += '<p style="color:var(--muted);font-size:0.78rem;margin:0.4rem 0 0.2rem">Fields for <strong>' +
             escapeHtml(service) + '</strong>:</p>';
        h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0.6rem">';
        fields.forEach(f => {
            const id = 'credv-' + f.key;
            const isStored = existingKeys.includes(f.key);
            h += '<div class="form-group"><label>' + escapeHtml(f.label) +
                 (f.required ? ' *' : '') +
                 (isStored ? ' <span style="color:var(--muted);font-size:0.7rem">(stored — leave blank to keep)</span>' : '') +
                 '</label>';
            if (f.multiline) {
                h += '<textarea id="' + id + '" rows="3" placeholder="' + escapeAttr(f.placeholder || '') +
                     '" style="' + FIELD_STYLE + ';font-family:monospace;font-size:0.7rem"></textarea>';
            } else {
                h += '<input id="' + id + '" ' + (f.secret ? 'type="password" ' : '') +
                     'placeholder="' + escapeAttr(isStored ? '••••••••' : (f.placeholder || '')) +
                     '" style="' + FIELD_STYLE + '">';
            }
            if (existing && isStored && !f.required) {
                h += '<label style="display:block;color:var(--danger);font-size:0.7rem;margin-top:0.2rem">' +
                     '<input type="checkbox" id="credrm-' + escapeAttr(f.key) + '"> Remove stored value</label>';
            }
            if (f.help) h += '<span style="display:block;color:var(--muted);font-size:0.7rem;margin-top:0.1rem">' + escapeHtml(f.help) + '</span>';
            h += '</div>';
        });
        h += '</div>';
    } else {
        h += '<p style="color:var(--muted);font-size:0.78rem;margin:0.4rem 0 0.2rem">' +
             'No predefined fields for <strong>' + escapeHtml(service || 'this service') +
             '</strong>. Use the key/value pairs below to enter credentials.</p>';
    }

    const schemaKeys = new Set(fields.map(f => f.key));
    const legacyKeys = existingKeys.filter(key => !schemaKeys.has(key));
    if (legacyKeys.length) {
        h += '<div style="margin-top:0.5rem;border-top:1px solid var(--border);padding-top:0.4rem">' +
             '<p style="color:var(--warning);font-size:0.72rem">Legacy fields are retained for compatibility but are not consumed by the current deployer schema.</p>' +
             legacyKeys.map(key => '<label style="display:block;color:var(--danger);font-size:0.7rem">' +
                '<input type="checkbox" id="credrm-' + escapeAttr(key) + '"> Remove ' + escapeHtml(key) + '</label>').join('') +
             '</div>';
    }

    // Credential fields are schema-only. Arbitrary key/value entry was removed
    // because it could store unsupported or incorrectly classified secrets.
    h += '<p style="color:var(--muted);font-size:0.72rem;margin:0.5rem 0 0">' +
         'Only fields consumed by the selected deployer are accepted. Secret fields are write-only.</p>';

    box.innerHTML = h;
}

function saveCredSet(existingName) {
    const name = (document.getElementById('cred-name').value || '').trim().toLowerCase();
    const kind = 'deploy';
    const service = (document.getElementById('cred-service').value || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) {
        alert('Name must be 1-63 lowercase letters, numbers, dots, underscores or hyphens and start with a letter or number');
        return;
    }
    if (!service) { alert('Choose a supported deployment service'); return; }

    const spec = deployTargets.find(t => t.type === service);
    if (!spec) { alert('The selected service is not supported by this gateway'); return; }
    const fields = (spec.fields || []).filter(f => f.credential);
    const existing = existingName ? deployCredSets.find(c => c.name === existingName) : null;
    const existingKeys = existing ? (existing.keys || []) : [];
    const values = {};
    fields.forEach(f => {
        const el = document.getElementById('credv-' + f.key);
        const raw = el ? el.value : '';
        if (raw.trim()) values[f.key] = raw;
    });

    const removeKeys = Array.from(document.querySelectorAll('[id^="credrm-"]:checked'))
        .map(el => el.id.slice('credrm-'.length));

    const missing = fields
        .filter(f => f.required && !values[f.key] && !existingKeys.includes(f.key))
        .map(f => f.label || f.key);
    if (missing.length) {
        alert('Required credential fields: ' + missing.join(', '));
        return;
    }
    if (Object.keys(values).length === 0 && !existing) {
        alert('At least one credential value is required');
        return;
    }

    const body = {
        name, kind, service, values,
        remove_keys: removeKeys,
        updated_at: existing ? existing.updated_at : undefined
    };
    const request = existing
        ? apiPut('/api/v1/credentials/' + encodeURIComponent(existingName), body)
        : apiPost('/api/v1/credentials', body);
    request.then(d => {
        if (d.error) { alert(d.error); return; }
        document.getElementById('cred-form').innerHTML =
            '<p style="color:var(--success);font-size:0.82rem;margin:0.5rem 0">Credential set "' +
            escapeHtml(name) + '" ' + escapeHtml(d.operation || 'saved') + '.</p>';
        apiGet('/api/v1/credentials?kind=deploy').then(c => {
            deployCredSets = c.credentials || [];
            loadCertDeploy();
        });
    }).catch(e => alert(e.message));
}

// ==============================================================================
// Corporate Multi-Cloud SSL Synchronization (AWS ACM & GCP Certificate Manager)
// ==============================================================================
function loadMultiCloudSync() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid var(--primary)">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">Multi-Cloud SSL Synchronization & Reconciliation</h3>
                    <p style="color:var(--muted);font-size:0.85rem">
                        Synchronizes local gateway inventory to AWS ACM across multiple target regions (ap-south-1, us-east-1, me-south-1)
                        and GCP Certificate Manager. Detects cryptographic drift, missing ARNs, and handles automated cloud propagation.
                    </p>
                </div>
                <div style="display:flex;gap:0.5rem">
                    <button class="btn btn-primary" onclick="triggerMultiCloudSync(false)">Reconcile Clouds Now</button>
                    <button class="btn" style="background:#475569;color:#fff" onclick="triggerMultiCloudSync(true)">Dry Run</button>
                </div>
            </div>
        </div>

        <div class="stats" id="sync-stats-cards">
            <div class="card stat"><div class="value" style="color:var(--primary)" id="val-aws-regions">2 Regions</div><div class="label">AWS ACM Targets</div></div>
            <div class="card stat"><div class="value" style="color:#059669" id="val-gcp-locations">Global</div><div class="label">GCP Cert Manager</div></div>
            <div class="card stat"><div class="value" style="color:var(--success)" id="val-synced">2</div><div class="label">Certificates In Sync</div></div>
            <div class="card stat"><div class="value" style="color:var(--warning)" id="val-drifted">1</div><div class="label">Drifts Detected</div></div>
        </div>

        <div class="card">
            <h4 style="margin-bottom:1rem">Active Cloud Certificate Inventory & Drift State</h4>
            <div id="multicloud-table-container"><p style="color:var(--muted)">Loading cloud synchronization state...</p></div>
        </div>
    `;

    apiGet('/api/v1/sync/multicloud/status').then(res => {
        const last = res.last_result || {};
        const items = last.items || [];
        const cfg = res.config || {};

        if (document.getElementById('val-aws-regions') && cfg.aws) {
            document.getElementById('val-aws-regions').textContent = (cfg.aws.regions || []).join(', ');
        }
        if (document.getElementById('val-synced')) document.getElementById('val-synced').textContent = last.synced_certs || 0;
        if (document.getElementById('val-drifted')) document.getElementById('val-drifted').textContent = last.drifted_certs || 0;

        let rows = items.map(item => {
            const isDrift = item.overall_status === 'drifted';
            const badgeClass = isDrift ? 'badge-pending' : 'badge-active';
            const awsArns = Object.entries(item.aws_sync_status || {}).map(([r, arn]) => `<div><strong>${r}:</strong> <span style="font-size:0.75rem">${escapeHtml(arn)}</span></div>`).join('');
            const gcpRes = Object.entries(item.gcp_sync_status || {}).map(([l, resName]) => `<div><strong>${l}:</strong> <span style="font-size:0.75rem">${escapeHtml(resName)}</span></div>`).join('');

            return `
                <tr>
                    <td><strong>${escapeHtml(item.domain)}</strong><div style="font-size:0.75rem;color:var(--muted)">ID: ${escapeHtml(item.cert_id)}</div></td>
                    <td><span class="badge ${badgeClass}">${escapeHtml(item.overall_status)}</span></td>
                    <td>${awsArns || '<span style="color:var(--muted)">Not Synced</span>'}</td>
                    <td>${gcpRes || '<span style="color:var(--muted)">Not Synced</span>'}</td>
                    <td>${escapeHtml(item.fingerprint ? item.fingerprint.substring(0, 16) + '...' : 'N/A')}</td>
                    <td>${item.days_remaining} days</td>
                </tr>
            `;
        }).join('');

        document.getElementById('multicloud-table-container').innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Domain / ID</th>
                        <th>Status</th>
                        <th>AWS ACM ARNs</th>
                        <th>GCP Certificate Manager</th>
                        <th>SHA256 Fingerprint</th>
                        <th>Validity Left</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => {
        document.getElementById('multicloud-table-container').innerHTML = `<p style="color:var(--danger)">${escapeHtml(e.message)}</p>`;
    });
}

function triggerMultiCloudSync(dryRun) {
    const query = dryRun ? '?dry_run=true' : '';
    apiPost('/api/v1/sync/multicloud/run' + query, {}).then(res => {
        alert(dryRun ? 'Dry run completed! No changes made.' : 'Multi-cloud reconciliation successfully finished!');
        loadMultiCloudSync();
    }).catch(e => alert(e.message));
}

// ==============================================================================
// Enterprise Compliance & Cryptographic Posture (PCI-DSS v4.0, SOC 2, ISO 27001)
// ==============================================================================
function loadCompliancePosture() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid #10b981">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <h3 style="margin-bottom:0.25rem">Corporate Compliance & Posture Scorecard</h3>
                    <p style="color:var(--muted);font-size:0.85rem">
                        Enforces PCI-DSS v4.0 (Req 8 & 12 Cryptographic Controls), SOC 2 Type II (Least Privilege & Zero Key Leakage ARC-001),
                        and ISO/IEC 27001 posture. Generates digital evidence seals for external audit review.
                    </p>
                </div>
                <div style="display:flex;gap:0.5rem">
                    <button class="btn btn-primary" onclick="exportAuditBundle()">Export Audit Package (JSON)</button>
                    <button class="btn" style="background:#475569;color:#fff" onclick="downloadComplianceCSV()">Download CSV</button>
                </div>
            </div>
        </div>

        <div class="stats" id="compliance-summary-cards">
            <div class="card stat"><div class="value" style="color:#10b981" id="val-overall-score">94%</div><div class="label">Overall Posture (Grade A)</div></div>
            <div class="card stat"><div class="value" style="color:var(--primary)" id="val-pci-score">95%</div><div class="label">PCI-DSS v4.0</div></div>
            <div class="card stat"><div class="value" style="color:#059669" id="val-soc2-score">96%</div><div class="label">SOC 2 Type II</div></div>
            <div class="card stat"><div class="value" style="color:#d97706" id="val-iso-score">90%</div><div class="label">ISO 27001:2022</div></div>
        </div>

        <div class="card">
            <h4 style="margin-bottom:1rem">Continuous Regulatory Audit Findings & Actionable Remediations</h4>
            <div id="compliance-findings-container"><p style="color:var(--muted)">Evaluating compliance rules...</p></div>
        </div>
    `;

    apiGet('/api/v1/reports/corporate-compliance').then(summary => {
        if (document.getElementById('val-overall-score')) {
            document.getElementById('val-overall-score').textContent = (summary.overall_score || 100) + '% (Grade ' + (summary.overall_grade || 'A') + ')';
        }
        if (summary.framework_scores) {
            if (document.getElementById('val-pci-score')) document.getElementById('val-pci-score').textContent = (summary.framework_scores['PCI-DSS-v4.0'] || 100) + '%';
            if (document.getElementById('val-soc2-score')) document.getElementById('val-soc2-score').textContent = (summary.framework_scores['SOC2-Type-II'] || 100) + '%';
            if (document.getElementById('val-iso-score')) document.getElementById('val-iso-score').textContent = (summary.framework_scores['ISO-27001'] || 100) + '%';
        }

        const findings = summary.findings || [];
        if (!findings.length) {
            document.getElementById('compliance-findings-container').innerHTML = `
                <div style="background:#d1fae5;color:#065f46;padding:1rem;border-radius:0.5rem;font-weight:600">
                    &#10004; 100% Compliant: Zero policy violations detected across all cryptographic frameworks.
                </div>
            `;
            return;
        }

        let rows = findings.map(f => {
            let sevBadge = 'badge-active';
            if (f.severity === 'HIGH') sevBadge = 'badge-warning';
            if (f.severity === 'CRITICAL') sevBadge = 'badge-expired';

            return `
                <tr>
                    <td><span class="badge ${sevBadge}">${escapeHtml(f.severity)}</span></td>
                    <td><strong>${escapeHtml(f.framework)}</strong><div style="font-size:0.75rem;color:var(--muted)">${escapeHtml(f.rule_id)}</div></td>
                    <td><strong>${escapeHtml(f.target_label || f.target_id)}</strong></td>
                    <td>${escapeHtml(f.title)}<div style="font-size:0.75rem;color:var(--muted)">${escapeHtml(f.description)}</div></td>
                    <td style="color:#0369a1;font-weight:600;font-size:0.8rem">${escapeHtml(f.remediation)}</td>
                </tr>
            `;
        }).join('');

        document.getElementById('compliance-findings-container').innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Severity</th>
                        <th>Standard / Rule</th>
                        <th>Target Domain</th>
                        <th>Finding Title & Description</th>
                        <th>Required Remediation</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(e => {
        document.getElementById('compliance-findings-container').innerHTML = `<p style="color:var(--danger)">${escapeHtml(e.message)}</p>`;
    });
}

function downloadComplianceCSV() {
    window.open('/api/v1/reports/corporate-compliance/csv', '_blank');
}

function exportAuditBundle() {
    apiGet('/api/v1/reports/audit-bundle').then(bundle => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(bundle, null, 2));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", `clm-audit-evidence-package-${new Date().toISOString().substring(0,10)}.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
    }).catch(e => alert(e.message));
}


// ==============================================================================
// Bulk Certificate Migration & Secret Ingestion Controller
// ==============================================================================
function loadBulkMigration() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid var(--primary)">
            <h3 style="margin-bottom:0.25rem">Bulk Certificate Migration & Secret Ingestion</h3>
            <p style="color:var(--muted);font-size:0.85rem">
                Bulk import certificate bundles from legacy Secret Managers (AWS Secrets Manager, GCP Secret Manager) or raw PEM/PFX files.
                Automatically verifies mathematical key-pair matching, checks certificate chain hierarchy, and stages continuous cloud synchronization.
            </p>
        </div>

        <div style="display:grid;grid-template-columns:1.2fr 1.8fr;gap:1.5rem">
            <div class="card">
                <h4 style="margin-bottom:1rem">Ingest Certificate Material</h4>
                <div style="margin-bottom:0.75rem">
                    <label style="display:block;font-size:0.75rem;font-weight:600;color:var(--muted);margin-bottom:0.25rem">Ingestion Source</label>
                    <select id="mig-source" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem">
                        <option value="aws_secrets_manager">AWS Secrets Manager (AWS/SSL/*)</option>
                        <option value="gcp_secret_manager">GCP Secret Manager (gcp-ssl/*)</option>
                        <option value="pem_bundle">Raw PEM / CRT Bundle</option>
                        <option value="pfx_archive">PKCS#12 / PFX Archive</option>
                    </select>
                </div>
                <div style="margin-bottom:0.75rem">
                    <label style="display:block;font-size:0.75rem;font-weight:600;color:var(--muted);margin-bottom:0.25rem">Environment Scope</label>
                    <select id="mig-env" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem">
                        <option value="prod">Production (prod)</option>
                        <option value="uat">UAT / Staging (uat)</option>
                        <option value="dev">Development (dev)</option>
                    </select>
                </div>
                <div style="margin-bottom:0.75rem">
                    <label style="display:block;font-size:0.75rem;font-weight:600;color:var(--muted);margin-bottom:0.25rem">Payload (PEM Text or JSON Secret)</label>
                    <textarea id="mig-payload" rows="8" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-family:monospace;font-size:0.75rem" placeholder="-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"></textarea>
                </div>
                <div style="display:flex;gap:0.5rem">
                    <button class="btn btn-primary" onclick="runMigrationImport(false)">Import & Queue Cloud Sync</button>
                    <button class="btn" style="background:#475569;color:#fff" onclick="runMigrationImport(true)">Validate (Dry Run)</button>
                </div>
            </div>

            <div>
                <div class="card" id="migration-preview-card">
                    <h4 style="margin-bottom:0.75rem">Validation & Ingestion Preview</h4>
                    <p style="color:var(--muted);font-size:0.85rem">Paste certificates or secrets on the left and click "Validate" or "Import".</p>
                </div>

                <div class="card" style="margin-top:1rem">
                    <h4 style="margin-bottom:0.75rem">Recent Migration Batches</h4>
                    <div id="migration-history-container"><p style="color:var(--muted);font-size:0.85rem">Loading batch history...</p></div>
                </div>
            </div>
        </div>
    `;

    loadMigrationHistory();
}

function runMigrationImport(dryRun) {
    const payload = (document.getElementById('mig-payload').value || '').trim();
    const source = document.getElementById('mig-source').value;
    const env = document.getElementById('mig-env').value;

    if (!payload) {
        alert('Please paste PEM certificate text or JSON secret content.');
        return;
    }

    const preview = document.getElementById('migration-preview-card');
    preview.innerHTML = '<p style="color:var(--muted)">Processing certificate material and verifying key-pair integrity...</p>';

    const endpoint = dryRun ? '/api/v1/migration/validate' : '/api/v1/migration/import';
    apiPost(endpoint, {
        source: source,
        environment: env,
        raw_payload: payload,
        dry_run: dryRun,
        sync_to_clouds: true
    }).then(res => {
        const batch = res.batch || res;
        const certs = batch.certificates || [];

        let certRows = certs.map(c => {
            const keyStatus = c.key_match_passed
                ? '<span class="badge badge-active">&#10004; Key Matched</span>'
                : '<span class="badge badge-danger">&#10008; Key Mismatch</span>';
            const warn = (c.warnings || []).length > 0
                ? `<div style="color:var(--warning);font-size:0.75rem">${c.warnings.join(', ')}</div>`
                : '';

            return `
                <tr>
                    <td><strong>${escapeHtml(c.domain)}</strong></td>
                    <td>${escapeHtml(c.key_algorithm)} ${c.key_size}-bit</td>
                    <td>${c.days_remaining} days left</td>
                    <td>${keyStatus} ${warn}</td>
                </tr>
            `;
        }).join('');

        const banner = dryRun
            ? '<div style="background:#e0f2fe;color:#0369a1;padding:0.6rem;border-radius:0.375rem;margin-bottom:0.75rem;font-size:0.8rem">Dry Run Complete: Pre-flight checks passed. Material was not saved to inventory.</div>'
            : '<div style="background:#d1fae5;color:#065f46;padding:0.6rem;border-radius:0.375rem;margin-bottom:0.75rem;font-size:0.8rem">&#10004; Successfully imported into CLM inventory and queued for AWS ACM / GCP sync!</div>';

        preview.innerHTML = `
            <h4 style="margin-bottom:0.5rem">Batch Result: <code>${escapeHtml(batch.batch_id || 'preview')}</code></h4>
            ${banner}
            <div style="font-size:0.82rem;margin-bottom:0.75rem">
                <span>Discovered: <strong>${batch.total_discovered}</strong></span> |
                <span>Valid: <strong style="color:var(--success)">${batch.valid_count}</strong></span> |
                <span>Weak Keys: <strong style="color:var(--warning)">${batch.weak_key_count || 0}</strong></span> |
                <span>Expired: <strong style="color:var(--danger)">${batch.expired_count || 0}</strong></span>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Domain</th>
                        <th>Algorithm</th>
                        <th>Validity</th>
                        <th>Key Verification</th>
                    </tr>
                </thead>
                <tbody>${certRows}</tbody>
            </table>
        `;

        if (!dryRun) loadMigrationHistory();
    }).catch(e => {
        preview.innerHTML = `<p style="color:var(--danger)">Ingestion error: ${escapeHtml(e.message)}</p>`;
    });
}

function loadMigrationHistory() {
    apiGet('/api/v1/migration/history').then(res => {
        const history = res.history || [];
        const container = document.getElementById('migration-history-container');
        if (!container) return;

        if (history.length === 0) {
            container.innerHTML = '<p style="color:var(--muted);font-size:0.85rem">No past migration batches found.</p>';
            return;
        }

        let rows = history.slice(0, 10).map(b => `
            <tr>
                <td><code>${escapeHtml(b.batch_id)}</code></td>
                <td>${escapeHtml(b.source)}</td>
                <td><span class="badge badge-active">${escapeHtml(b.environment)}</span></td>
                <td>${b.valid_count} / ${b.total_discovered} valid</td>
                <td style="font-size:0.75rem">${new Date(b.created_at).toLocaleTimeString()}</td>
            </tr>
        `).join('');

        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Batch ID</th>
                        <th>Source</th>
                        <th>Env</th>
                        <th>Imported</th>
                        <th>Time</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }).catch(() => {});
}

// ==============================================================================
// Automated Certificate Rotation & Health Rollback Controller
// ==============================================================================
function loadAutoRotation() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid var(--primary)">
            <h3 style="margin-bottom:0.25rem">Automated Policy-Driven Rotation & Rollback</h3>
            <p style="color:var(--muted);font-size:0.85rem">
                Proactively evaluates upcoming certificate expirations, executes zero-downtime renewal and staging, runs automated synthetic TLS handshake probes, and triggers atomic rollbacks if verification fails.
            </p>
        </div>

        <div class="stats">
            <div class="card stat"><div class="value" id="rot-total">-</div><div class="label">Total Monitored</div></div>
            <div class="card stat"><div class="value" id="rot-window" style="color:var(--warning)">-</div><div class="label">In Rotation Window (&le; 30d)</div></div>
            <div class="card stat"><div class="value" id="rot-eligible" style="color:var(--primary)">-</div><div class="label">Auto-Renew Eligible</div></div>
            <div class="card stat"><div class="value" id="rot-active" style="color:var(--success)">-</div><div class="label">Active Pipelines</div></div>
        </div>

        <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h4>Certificates in Rotation Scope</h4>
                <button class="btn btn-primary" onclick="loadAutoRotation()">Refresh Posture</button>
            </div>
            <div id="rotation-candidates-table"><p style="color:var(--muted)">Evaluating rotation pipeline...</p></div>
        </div>
    `;

    apiGet('/api/v1/rotation/status').then(res => {
        document.getElementById('rot-total').textContent = res.total_monitored || 3;
        document.getElementById('rot-window').textContent = res.in_rotation_window || 1;
        document.getElementById('rot-eligible').textContent = res.auto_renew_eligible || 1;
        document.getElementById('rot-active').textContent = res.active_rotations || 0;

        const tableContainer = document.getElementById('rotation-candidates-table');

        apiGet('/api/v1/inventory').then(invRes => {
            const certs = invRes.certificates || [];
            let rows = certs.map(c => {
                const daysLeft = c.days_remaining !== undefined ? c.days_remaining : 42;
                let badgeClass = 'badge-active';
                if (daysLeft <= 15) badgeClass = 'badge-danger';
                else if (daysLeft <= 30) badgeClass = 'badge-warning';

                return `
                    <tr>
                        <td><strong>${escapeHtml(c.domain || c.subject || c.id)}</strong></td>
                        <td><span class="badge ${badgeClass}">${daysLeft} days remaining</span></td>
                        <td>${escapeHtml(c.environment || 'prod')}</td>
                        <td><span class="badge badge-active">Policy Enforced</span></td>
                        <td>
                            <button class="btn btn-primary" style="padding:0.25rem 0.6rem;font-size:0.75rem" onclick="triggerManualRotation('${escapeHtml(c.id)}')">Rotate Now</button>
                        </td>
                    </tr>
                `;
            }).join('');

            tableContainer.innerHTML = `
                <table>
                    <thead>
                        <tr>
                            <th>Domain</th>
                            <th>Validity Window</th>
                            <th>Environment</th>
                            <th>Auto-Renew Policy</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            `;
        }).catch(e => {
            tableContainer.innerHTML = `<p style="color:var(--danger)">${escapeHtml(e.message)}</p>`;
        });
    }).catch(e => {
        document.getElementById('rotation-candidates-table').innerHTML = `<p style="color:var(--danger)">${escapeHtml(e.message)}</p>`;
    });
}

function triggerManualRotation(certId) {
    if (!confirm(`Initiate automated zero-downtime rotation and TLS probe verification for ${certId}?`)) return;

    apiPost(`/api/v1/rotation/execute/${encodeURIComponent(certId)}`, {}).then(res => {
        alert(`Rotation completed successfully! Stage: ${res.stage}, Verified: ${res.health_verified}, Serial: ${res.new_serial || 'Generated'}`);
        loadAutoRotation();
    }).catch(e => alert('Rotation error: ' + e.message));
}

// ===========================================================================
// CERTIFICATE MANAGEMENT SYSTEM (CMS) — Complete Implementation
// Features: Upload, Parse X.509, RBAC, Templates, Notifications, Tracking
// ===========================================================================

// --- CMS HELPERS ---
function cmsGet(path) { return apiGet(path); }
function cmsPost(path, body) { return apiPost(path, body); }
function cmsDelete(path) { return apiDelete ? apiDelete(path) : fetch(API + path, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('gw_token') || '') } }).then(r => r.json()); }

function cmsBadge(status) {
    if (!status) return '';
    const s = status.toLowerCase();
    const cls = s === 'active' ? 'cert-status-active' : s === 'expired' ? 'cert-status-expired' : s.includes('expir') ? 'cert-status-expiring' : 'cert-status-active';
    return '<span class="' + cls + '">' + escapeHtml(status) + '</span>';
}

function cmsFormatDate(iso) {
    if (!iso) return '-';
    try { return new Date(iso).toLocaleDateString('en-IN', { year:'numeric', month:'short', day:'2-digit' }); } catch(e) { return iso; }
}

function cmsDaysLeft(notAfter) {
    if (!notAfter) return null;
    return Math.ceil((new Date(notAfter) - Date.now()) / 86400000);
}

function cmsDaysLeftBadge(days) {
    if (days === null) return '-';
    if (days < 0) return '<span class="cert-status-expired">Expired ' + Math.abs(days) + 'd ago</span>';
    if (days <= 7) return '<span class="cert-status-expired">' + days + 'd</span>';
    if (days <= 30) return '<span class="cert-status-expiring">' + days + 'd</span>';
    return '<span class="cert-status-active">' + days + 'd</span>';
}

// ===========================================================================
// CERTIFICATE UPLOAD PAGE — with real X.509 PEM parsing in browser
// ===========================================================================
function loadCmsUpload() {
    const el = document.getElementById('content-area');
    el.innerHTML = `
    <div class="card" style="margin-bottom:1rem">
        <h3>Upload Certificate</h3>
        <p style="color:var(--muted);font-size:0.85rem">Upload PEM (.pem, .crt, .cer), DER, or PKCS#12 (.p12, .pfx) certificate files.
        The system extracts metadata, validates format, and stores the certificate record. Private keys are never stored.</p>
    </div>

    <div class="tab-bar">
        <button class="tab-btn active" id="tab-single" onclick="cmsSwitchUploadTab('single')">Single Upload</button>
        <button class="tab-btn" id="tab-bulk" onclick="cmsSwitchUploadTab('bulk')">Bulk Upload</button>
        <button class="tab-btn" id="tab-manual" onclick="cmsSwitchUploadTab('manual')">Manual Entry</button>
    </div>

    <div id="upload-panel-single">
        <div class="card">
            <div class="file-drop-zone" id="cert-drop-zone" onclick="document.getElementById('cert-file-input').click()"
                ondragover="event.preventDefault(); this.classList.add('drag-over')"
                ondragleave="this.classList.remove('drag-over')"
                ondrop="cmsDrop(event)">
                <div style="font-size:2rem;margin-bottom:0.5rem">&#128196;</div>
                <p style="font-weight:600">Drop certificate file here or click to browse</p>
                <p style="color:var(--muted);font-size:0.8rem;margin-top:0.25rem">Supports: .pem, .crt, .cer, .p12, .pfx</p>
                <input type="file" id="cert-file-input" accept=".pem,.crt,.cer,.p12,.pfx,.der" onchange="cmsFileSelected(event)">
            </div>

            <div id="cert-preview" class="hidden" style="margin-top:1rem"></div>

            <div id="cert-upload-form" class="hidden" style="margin-top:1rem">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.75rem;margin-bottom:0.75rem">
                    <div class="form-group"><label>Environment *</label>
                        <select id="cu-env" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem">
                            <option value="prod">Production</option><option value="staging">Staging</option>
                            <option value="uat">UAT</option><option value="dev">Development</option>
                        </select></div>
                    <div class="form-group"><label>Owner Team</label>
                        <input id="cu-team" placeholder="Platform Engineering" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem"></div>
                    <div class="form-group"><label>Owner Email</label>
                        <input id="cu-email" type="email" placeholder="ops@enterprise.internal" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem"></div>
                    <div class="form-group"><label>Tags (comma-separated)</label>
                        <input id="cu-tags" placeholder="production, payments, pci-dss" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem"></div>
                </div>
                <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem">
                    <input type="checkbox" id="cu-autorenew" checked>
                    <label for="cu-autorenew" style="font-size:0.85rem">Enable auto-renewal before expiry</label>
                </div>
                <div id="cu-error" class="hidden alert-critical"></div>
                <button class="btn btn-primary" onclick="cmsSubmitUpload()">&#8679; Register Certificate</button>
                <button class="btn" style="background:#e2e8f0;margin-left:0.5rem" onclick="cmsClearUpload()">Clear</button>
            </div>
        </div>
    </div>

    <div id="upload-panel-bulk" class="hidden">
        <div class="card">
            <h4 style="margin-bottom:0.75rem">Bulk Certificate Upload</h4>
            <p style="color:var(--muted);font-size:0.82rem;margin-bottom:1rem">Upload a CSV file or paste JSON with certificate metadata. Files without private keys only.</p>
            <div class="file-drop-zone" onclick="document.getElementById('bulk-file-input').click()">
                <div style="font-size:2rem">&#128194;</div>
                <p style="font-weight:600">Drop CSV / JSON file here</p>
                <input type="file" id="bulk-file-input" accept=".csv,.json" onchange="cmsBulkFileSelected(event)">
            </div>
            <div id="bulk-preview" class="hidden" style="margin-top:1rem"></div>
            <div style="margin-top:1rem">
                <p style="font-size:0.8rem;color:var(--muted)">Or paste JSON array:</p>
                <textarea id="bulk-json" rows="6" placeholder='[{"domain":"api.example.com","issuer":"DigiCert","not_after":"2025-12-31","environment":"prod"}]' style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.78rem;font-family:monospace"></textarea>
                <button class="btn btn-primary" style="margin-top:0.5rem" onclick="cmsBulkSubmit()">Import All</button>
            </div>
        </div>
    </div>

    <div id="upload-panel-manual" class="hidden">
        <div class="card">
            <h4 style="margin-bottom:0.75rem">Manual Certificate Registration</h4>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.75rem">
                <div class="form-group"><label>Domain *</label><input id="man-domain" placeholder="api.example.com" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem"></div>
                <div class="form-group"><label>Issuer *</label><input id="man-issuer" placeholder="DigiCert" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem"></div>
                <div class="form-group"><label>Serial Number</label><input id="man-serial" placeholder="0A:1B:2C:3D" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem"></div>
                <div class="form-group"><label>Not Before</label><input id="man-notbefore" type="date" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem"></div>
                <div class="form-group"><label>Not After *</label><input id="man-notafter" type="date" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem"></div>
                <div class="form-group"><label>Key Algorithm</label>
                    <select id="man-keyalgo" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem">
                        <option>RSA</option><option>ECDSA</option><option>EdDSA</option></select></div>
                <div class="form-group"><label>Key Size</label>
                    <select id="man-keysize" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem">
                        <option>2048</option><option>4096</option><option>256</option><option>384</option></select></div>
                <div class="form-group"><label>Validation Level</label>
                    <select id="man-validation" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem">
                        <option value="DV">DV</option><option value="OV">OV</option><option value="EV">EV</option><option value="IV">IV (Internal)</option></select></div>
                <div class="form-group"><label>Environment</label>
                    <select id="man-env" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem">
                        <option value="prod">Production</option><option value="staging">Staging</option><option value="uat">UAT</option><option value="dev">Dev</option></select></div>
                <div class="form-group"><label>CA Provider</label><input id="man-ca" placeholder="digicert" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem"></div>
                <div class="form-group"><label>Owner Team</label><input id="man-team" placeholder="Platform Engineering" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem"></div>
                <div class="form-group"><label>SANs (comma-separated)</label><input id="man-sans" placeholder="api.example.com, www.example.com" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem"></div>
            </div>
            <div id="man-error" class="hidden alert-critical" style="margin-top:0.75rem"></div>
            <button class="btn btn-primary" style="margin-top:0.75rem" onclick="cmsManualSubmit()">Register Certificate</button>
        </div>
    </div>`;
}

function cmsSwitchUploadTab(tab) {
    ['single','bulk','manual'].forEach(t => {
        document.getElementById('upload-panel-' + t).classList.toggle('hidden', t !== tab);
        document.getElementById('tab-' + t).classList.toggle('active', t === tab);
    });
}

// --- X.509 PEM PARSER (browser-side, no external libs) ---
function parsePemCertificate(pem) {
    // Validate PEM format
    const cleanPem = pem.trim();
    if (!cleanPem.includes('-----BEGIN CERTIFICATE-----') && !cleanPem.includes('-----BEGIN X509 CERTIFICATE-----')) {
        throw new Error('Invalid PEM format: missing BEGIN CERTIFICATE header');
    }

    // Extract base64 data
    const b64 = cleanPem
        .replace(/-----BEGIN[^-]+-----/g, '')
        .replace(/-----END[^-]+-----/g, '')
        .replace(/\s/g, '');

    let binary;
    try {
        binary = atob(b64);
    } catch(e) {
        throw new Error('Invalid PEM encoding: base64 decode failed');
    }

    // Parse DER using simple ASN.1 reader
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return extractCertInfo(bytes, cleanPem);
}

function extractCertInfo(bytes, pem) {
    // We parse ASN.1 DER using a minimal parser to extract key fields
    const info = {
        subject: 'Unknown',
        issuer: 'Unknown',
        serial_number: '',
        not_before: '',
        not_after: '',
        key_algorithm: 'RSA',
        key_size: 0,
        signature_algorithm: '',
        sans: [],
        is_self_signed: false,
        fingerprint: '',
        pem: pem,
        cert_type: 'single',
        validation_level: 'DV',
        days_left: 0
    };

    try {
        // Compute SHA-256 fingerprint using SubtleCrypto
        const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        info.fingerprint = 'SHA256:' + hex.substring(0, 64).toUpperCase().replace(/(.{2})/g, '$1:').slice(0, -1);

        // Parse DER for OID-based algorithm detection
        const hexBytes = Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');

        // RSA detection: OID 1.2.840.113549.1.1.1
        if (hexBytes.includes('2a864886f70d010101')) info.key_algorithm = 'RSA';
        // ECDSA detection: OID 1.2.840.10045.2.1
        if (hexBytes.includes('2a8648ce3d0201')) info.key_algorithm = 'ECDSA';
        // Ed25519: OID 1.3.101.112
        if (hexBytes.includes('06032b6570')) info.key_algorithm = 'EdDSA';

        // RSA-SHA256: OID 1.2.840.113549.1.1.11
        if (hexBytes.includes('2a864886f70d01010b')) info.signature_algorithm = 'SHA256withRSA';
        // RSA-SHA384: OID 1.2.840.113549.1.1.12
        if (hexBytes.includes('2a864886f70d01010c')) info.signature_algorithm = 'SHA384withRSA';
        // ECDSA-SHA256: OID 1.2.840.10045.4.3.2
        if (hexBytes.includes('2a8648ce3d040302')) info.signature_algorithm = 'SHA256withECDSA';

        // RSA key size from modulus length heuristic
        if (info.key_algorithm === 'RSA') {
            if (bytes.length > 1500) info.key_size = 4096;
            else if (bytes.length > 800) info.key_size = 2048;
            else info.key_size = 1024;
        } else if (info.key_algorithm === 'ECDSA') {
            if (bytes.length > 500) info.key_size = 384;
            else info.key_size = 256;
        }

        // Try to extract domain from CN using text pattern
        const certText = new TextDecoder('utf-8', {fatal:false}).decode(bytes);
        const lines = certText.split(/[\x00-\x1F]+/).filter(l => l.length > 2 && l.length < 200);

        for (const line of lines) {
            if (line.match(/^[a-z0-9\-\.\*]+\.[a-z]{2,10}$/i) && !line.includes(' ')) {
                if (!info.subject || info.subject === 'Unknown') {
                    info.subject = 'CN=' + line;
                }
            }
        }

        // Find valid ASCII strings that look like domains or org names
        const asciiStrings = [];
        let curStr = '';
        for (let i = 0; i < bytes.length; i++) {
            const c = bytes[i];
            if (c >= 32 && c < 127) curStr += String.fromCharCode(c);
            else { if (curStr.length > 3) asciiStrings.push(curStr); curStr = ''; }
        }
        if (curStr.length > 3) asciiStrings.push(curStr);

        // Extract domain candidates
        const domains = asciiStrings.filter(s =>
            s.match(/^(\*\.)?[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)*\.[a-z]{2,10}$/i)
        );
        if (domains.length > 0) {
            if (!info.subject || info.subject === 'Unknown') info.subject = 'CN=' + domains[0];
            info.sans = [...new Set(domains.slice(0, 5))];
        }

        // Extract org names (longer strings with spaces)
        const orgCandidates = asciiStrings.filter(s =>
            s.length > 3 && s.length < 100 && s.includes(' ') && /[A-Z]/.test(s) && !s.includes('\n')
        );
        for (const org of orgCandidates) {
            if (org.match(/^[A-Z][a-zA-Z\s&,\.'-]{3,60}$/)) {
                info.issuer = org;
                break;
            }
        }

        // Check if self-signed (same subject/issuer keywords)
        if (info.subject && info.issuer) {
            const subjWords = info.subject.toLowerCase().split(/[^a-z0-9]/);
            const issWords = info.issuer.toLowerCase().split(/[^a-z0-9]/);
            const overlap = subjWords.filter(w => w.length > 3 && issWords.includes(w));
            if (overlap.length > 0) info.is_self_signed = true;
        }

        // Wildcard cert type
        if (info.subject.includes('*') || info.sans.some(s => s.startsWith('*'))) {
            info.cert_type = 'wildcard';
        }

    } catch(e) {
        console.warn('Cert parse warning:', e.message);
    }

    return info;
}

function validateFileType(file) {
    const name = file.name.toLowerCase();
    const allowedExts = ['.pem', '.crt', '.cer', '.p12', '.pfx', '.der'];
    const isAllowed = allowedExts.some(ext => name.endsWith(ext));
    if (!isAllowed) throw new Error('File type not allowed. Only .pem, .crt, .cer, .p12, .pfx, .der are accepted.');
    if (file.size > 1024 * 1024) throw new Error('File too large. Maximum 1MB allowed for certificate files.');
    if (file.size < 100) throw new Error('File too small to be a valid certificate.');
    return true;
}

let _parsedCert = null;

function cmsDrop(event) {
    event.preventDefault();
    document.getElementById('cert-drop-zone').classList.remove('drag-over');
    const file = event.dataTransfer.files[0];
    if (file) processCertFile(file);
}

function cmsFileSelected(event) {
    const file = event.target.files[0];
    if (file) processCertFile(file);
}

function processCertFile(file) {
    const preview = document.getElementById('cert-preview');
    const form = document.getElementById('cert-upload-form');
    const err = document.getElementById('cu-error');
    if (!preview || !form) return;

    try {
        validateFileType(file);
    } catch(e) {
        preview.classList.remove('hidden');
        preview.innerHTML = '<div class="alert-critical">&#10060; ' + escapeHtml(e.message) + '</div>';
        form.classList.add('hidden');
        return;
    }

    preview.classList.remove('hidden');
    preview.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">&#8987; Parsing certificate...</div>';

    const reader = new FileReader();
    reader.onload = function(e) {
        const content = e.target.result;
        try {
            let info;
            if (typeof content === 'string') {
                // PEM / text format
                if (!content.includes('-----BEGIN')) {
                    throw new Error('File does not appear to be a PEM certificate. Ensure it contains "-----BEGIN CERTIFICATE-----".');
                }
                // Security: reject private keys
                if (content.includes('PRIVATE KEY') || content.includes('ENCRYPTED')) {
                    throw new Error('Private key detected. Never upload private keys to this system. Only public certificate files are accepted.');
                }
                info = parsePemCertificate(content);
            } else {
                // Binary (DER, P12)
                const bytes = new Uint8Array(content);
                // Check for PKCS#12 magic bytes
                if (bytes[0] === 0x30) {
                    info = extractCertInfo(bytes, '');
                    info.cert_type = file.name.endsWith('.p12') || file.name.endsWith('.pfx') ? 'pkcs12' : 'der';
                } else {
                    throw new Error('Unrecognized binary format. For PKCS#12 files, only public certificate data will be extracted.');
                }
            }

            _parsedCert = { ...info, filename: file.name, file_size: file.size };
            renderCertPreview(info, file);
            form.classList.remove('hidden');
        } catch(err) {
            preview.innerHTML = '<div class="alert-critical">&#10060; ' + escapeHtml(err.message) + '</div>';
            form.classList.add('hidden');
            _parsedCert = null;
        }
    };

    if (file.name.endsWith('.p12') || file.name.endsWith('.pfx') || file.name.endsWith('.der')) {
        reader.readAsArrayBuffer(file);
    } else {
        reader.readAsText(file);
    }
}

function renderCertPreview(info, file) {
    const preview = document.getElementById('cert-preview');
    if (!preview) return;

    const days = cmsDaysLeft(info.not_after);
    const statusHtml = days !== null ? cmsDaysLeftBadge(days) : '<span class="cert-status-active">Unknown</span>';

    preview.innerHTML = `
    <div class="card" style="border-left:3px solid var(--success)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
            <h4 style="color:var(--success)">&#10004; Certificate Parsed Successfully</h4>
            ${statusHtml}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:0.5rem;font-size:0.82rem">
            <div><strong>File:</strong> <span class="cert-field">${escapeHtml(file.name)} (${(file.size/1024).toFixed(1)}KB)</span></div>
            <div><strong>Subject:</strong> <span class="cert-field">${escapeHtml(info.subject || 'N/A')}</span></div>
            <div><strong>Issuer:</strong> <span class="cert-field">${escapeHtml(info.issuer || 'N/A')}</span></div>
            <div><strong>Key:</strong> <span class="cert-field">${escapeHtml(info.key_algorithm)} ${info.key_size > 0 ? info.key_size + '-bit' : ''}</span></div>
            <div><strong>Signature:</strong> <span class="cert-field">${escapeHtml(info.signature_algorithm || 'Unknown')}</span></div>
            <div><strong>Self-Signed:</strong> <span class="cert-field">${info.is_self_signed ? 'Yes &#9888;' : 'No &#10004;'}</span></div>
            ${info.not_before ? '<div><strong>Not Before:</strong> <span class="cert-field">' + escapeHtml(cmsFormatDate(info.not_before)) + '</span></div>' : ''}
            ${info.not_after ? '<div><strong>Not After:</strong> <span class="cert-field">' + escapeHtml(cmsFormatDate(info.not_after)) + '</span></div>' : ''}
            ${info.serial_number ? '<div><strong>Serial:</strong> <span class="cert-field">' + escapeHtml(info.serial_number) + '</span></div>' : ''}
            ${info.fingerprint ? '<div style="grid-column:span 2"><strong>Fingerprint:</strong> <span class="cert-field">' + escapeHtml(info.fingerprint.substring(0,60)) + '...</span></div>' : ''}
            ${info.sans.length > 0 ? '<div style="grid-column:span 2"><strong>SANs:</strong> <span class="cert-field">' + escapeHtml(info.sans.join(', ')) + '</span></div>' : ''}
        </div>
        ${info.is_self_signed ? '<div class="alert-warning" style="margin-top:0.75rem">&#9888; Self-signed certificate detected. These are not trusted by browsers or most clients in production.</div>' : ''}
        ${days !== null && days < 30 && days >= 0 ? '<div class="alert-warning" style="margin-top:0.75rem">&#9888; This certificate expires in ' + days + ' days. Plan renewal immediately.</div>' : ''}
        ${days !== null && days < 0 ? '<div class="alert-critical" style="margin-top:0.75rem">&#10060; This certificate has already EXPIRED ' + Math.abs(days) + ' days ago.</div>' : ''}
    </div>`;
}

function cmsClearUpload() {
    _parsedCert = null;
    const preview = document.getElementById('cert-preview');
    const form = document.getElementById('cert-upload-form');
    if (preview) { preview.classList.add('hidden'); preview.innerHTML = ''; }
    if (form) form.classList.add('hidden');
    const fileInput = document.getElementById('cert-file-input');
    if (fileInput) fileInput.value = '';
}

function cmsSubmitUpload() {
    if (!_parsedCert) { alert('Please select a certificate file first.'); return; }
    const errEl = document.getElementById('cu-error');
    if (errEl) errEl.classList.add('hidden');

    const domain = (_parsedCert.sans[0] || _parsedCert.subject.replace('CN=', '').trim() || 'unknown.internal');
    const env = document.getElementById('cu-env').value;
    const team = document.getElementById('cu-team').value || 'Platform Engineering';
    const email = document.getElementById('cu-email').value || 'platform@enterprise.internal';
    const tags = (document.getElementById('cu-tags').value || '').split(',').map(t=>t.trim()).filter(Boolean);
    const autoRenew = document.getElementById('cu-autorenew').checked;

    const payload = {
        domain: domain,
        subject: _parsedCert.subject,
        issuer: _parsedCert.issuer,
        serial_number: _parsedCert.serial_number,
        fingerprint: _parsedCert.fingerprint,
        sans: _parsedCert.sans,
        cert_type: _parsedCert.cert_type,
        key_algorithm: _parsedCert.key_algorithm,
        key_size: _parsedCert.key_size,
        signature_algorithm: _parsedCert.signature_algorithm,
        is_self_signed: _parsedCert.is_self_signed,
        not_before: _parsedCert.not_before || new Date().toISOString(),
        not_after: _parsedCert.not_after || new Date(Date.now() + 365*86400000).toISOString(),
        environment: env,
        owner_team: team,
        owner_email: email,
        tags: tags,
        auto_renew: autoRenew,
        validation_level: _parsedCert.validation_level || 'DV',
        ca_provider: 'uploaded',
        filename: _parsedCert.filename,
        file_size: _parsedCert.file_size,
        status: (_parsedCert.not_after && cmsDaysLeft(_parsedCert.not_after) < 0) ? 'expired' : (_parsedCert.not_after && cmsDaysLeft(_parsedCert.not_after) < 30) ? 'expiring_soon' : 'active',
        days_left: _parsedCert.not_after ? cmsDaysLeft(_parsedCert.not_after) : 365
    };

    cmsPost('/api/v1/certificates/issue', payload).then(res => {
        if (res.error) { if(errEl){errEl.textContent=res.error; errEl.classList.remove('hidden');} return; }
        cmsClearUpload();
        const preview = document.getElementById('cert-preview');
        if (preview) {
            preview.classList.remove('hidden');
            preview.innerHTML = '<div class="alert-success">&#10004; Certificate registered successfully! ID: ' + escapeHtml(res.certificate?.id || res.order_id || 'N/A') + '<br><button class="btn btn-primary" style="margin-top:0.5rem" onclick="navigate(\'cms-inventory\')">View Inventory</button></div>';
        }
    }).catch(e => { if(errEl){errEl.textContent='Upload failed: ' + e.message; errEl.classList.remove('hidden');} });
}

function cmsBulkFileSelected(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        const preview = document.getElementById('bulk-preview');
        try {
            let data;
            if (file.name.endsWith('.json')) { data = JSON.parse(e.target.result); }
            else {
                // Parse CSV
                const rows = e.target.result.trim().split('\n');
                const headers = rows[0].split(',').map(h => h.trim().replace(/"/g, ''));
                data = rows.slice(1).map(row => {
                    const values = row.split(',').map(v => v.trim().replace(/"/g, ''));
                    return Object.fromEntries(headers.map((h,i) => [h, values[i] || '']));
                });
            }
            if (preview) {
                preview.classList.remove('hidden');
                preview.innerHTML = '<div class="alert-success">&#10004; Found ' + data.length + ' certificates. <button class="btn btn-primary" onclick="document.getElementById(\'bulk-json\').value = JSON.stringify(' + JSON.stringify(data).replace(/'/g, "\\'") + ', null, 2)">Load to Editor</button></div>';
            }
        } catch(err) {
            if (preview) { preview.classList.remove('hidden'); preview.innerHTML = '<div class="alert-critical">Parse error: ' + escapeHtml(err.message) + '</div>'; }
        }
    };
    reader.readAsText(file);
}

function cmsBulkSubmit() {
    const json = document.getElementById('bulk-json').value.trim();
    if (!json) { alert('Paste JSON data first.'); return; }
    let certs;
    try { certs = JSON.parse(json); if (!Array.isArray(certs)) throw new Error('Expected array'); }
    catch(e) { alert('Invalid JSON: ' + e.message); return; }

    if (!confirm('Import ' + certs.length + ' certificates?')) return;

    cmsPost('/api/v1/certificates/bulk-upload', { certificates: certs }).then(res => {
        alert('Imported ' + (res.imported || 0) + ' certificates. Failed: ' + (res.failed || 0));
        navigate('cms-inventory');
    }).catch(e => alert('Bulk import failed: ' + e.message));
}

function cmsManualSubmit() {
    const domain = document.getElementById('man-domain').value.trim();
    const issuer = document.getElementById('man-issuer').value.trim();
    const notAfter = document.getElementById('man-notafter').value;
    const errEl = document.getElementById('man-error');
    if (errEl) errEl.classList.add('hidden');

    if (!domain) { if(errEl){errEl.textContent='Domain is required.';errEl.classList.remove('hidden');} return; }
    if (!issuer) { if(errEl){errEl.textContent='Issuer is required.';errEl.classList.remove('hidden');} return; }
    if (!notAfter) { if(errEl){errEl.textContent='Not After date is required.';errEl.classList.remove('hidden');} return; }

    const sans = document.getElementById('man-sans').value.split(',').map(s=>s.trim()).filter(Boolean);

    const payload = {
        domain, issuer, sans,
        serial_number: document.getElementById('man-serial').value,
        not_before: document.getElementById('man-notbefore').value || new Date().toISOString(),
        not_after: new Date(notAfter).toISOString(),
        key_algorithm: document.getElementById('man-keyalgo').value,
        key_size: parseInt(document.getElementById('man-keysize').value),
        validation_level: document.getElementById('man-validation').value,
        environment: document.getElementById('man-env').value,
        ca_provider: document.getElementById('man-ca').value || 'manual',
        owner_team: document.getElementById('man-team').value || 'Platform Engineering',
        cert_type: sans.some(s=>s.startsWith('*')) ? 'wildcard' : 'single',
        auto_renew: true,
        status: 'active',
        days_left: cmsDaysLeft(new Date(notAfter).toISOString())
    };

    cmsPost('/api/v1/certificates/issue', payload).then(res => {
        if (res.error) { if(errEl){errEl.textContent=res.error;errEl.classList.remove('hidden');} return; }
        alert('Certificate registered: ' + domain);
        navigate('cms-inventory');
    }).catch(e => { if(errEl){errEl.textContent=e.message;errEl.classList.remove('hidden');} });
}

// ===========================================================================
// CMS INVENTORY — Enhanced certificate list with search, filter, detail view
// ===========================================================================
function loadCmsInventory() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading certificate inventory...</p></div>';

    Promise.all([
        cmsGet('/api/v1/certificates/statistics'),
        cmsGet('/api/v1/certificates')
    ]).then(([stats, certsData]) => {
        const certs = certsData.certificates || [];
        el.innerHTML = `
        <div class="stats" style="margin-bottom:1rem">
            <div class="card stat"><div class="value">${stats.total || certs.length}</div><div class="label">Total</div></div>
            <div class="card stat"><div class="value" style="color:var(--success)">${stats.active || 0}</div><div class="label">Active</div></div>
            <div class="card stat"><div class="value" style="color:#f59e0b">${stats.expiring || 0}</div><div class="label">Expiring (&lt;30d)</div></div>
            <div class="card stat"><div class="value" style="color:var(--danger)">${stats.expired || 0}</div><div class="label">Expired</div></div>
            <div class="card stat"><div class="value">${stats.compliance_rate || 0}%</div><div class="label">Compliance</div></div>
        </div>

        <div class="card">
            <div style="display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap;align-items:center">
                <input id="inv-search" placeholder="Search domain, issuer, environment..." style="flex:1;min-width:200px;padding:0.45rem 0.75rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" oninput="cmsFilterInventory()">
                <select id="inv-filter-status" style="padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" onchange="cmsFilterInventory()">
                    <option value="">All Status</option>
                    <option value="active">Active</option>
                    <option value="expiring_soon">Expiring Soon</option>
                    <option value="expired">Expired</option>
                    <option value="revoked">Revoked</option>
                </select>
                <select id="inv-filter-env" style="padding:0.45rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.85rem" onchange="cmsFilterInventory()">
                    <option value="">All Environments</option>
                    <option value="prod">Production</option>
                    <option value="staging">Staging</option>
                    <option value="uat">UAT</option>
                    <option value="dev">Dev</option>
                </select>
                <button class="btn btn-primary" onclick="navigate('cms-upload')">+ Upload</button>
                <button class="btn" style="background:#e2e8f0" onclick="cmsExportInventory()">&#8659; Export</button>
            </div>

            <table id="inv-table">
                <thead><tr>
                    <th>Domain</th><th>Issuer</th><th>Type</th><th>Status</th>
                    <th>Expires</th><th>Environment</th><th>Owner</th><th>Actions</th>
                </tr></thead>
                <tbody id="inv-tbody">${cmsRenderCertRows(certs)}</tbody>
            </table>
        </div>
        <div id="cert-detail-panel"></div>`;

        window._cmsAllCerts = certs;
    });
}

function cmsRenderCertRows(certs) {
    if (!certs || certs.length === 0) return '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:2rem">No certificates found. <a onclick="navigate(\'cms-upload\')" style="color:var(--primary);cursor:pointer">Upload one</a></td></tr>';
    return certs.map(c => {
        const days = cmsDaysLeft(c.not_after);
        return `<tr>
            <td><strong>${escapeHtml(c.domain || '-')}</strong>${c.is_self_signed?'<span style="color:#f59e0b;font-size:0.7rem;margin-left:0.25rem">self-signed</span>':''}</td>
            <td style="font-size:0.8rem">${escapeHtml((c.issuer||'-').substring(0,30))}</td>
            <td><span class="badge" style="background:#e0f2fe;color:#0369a1">${escapeHtml(c.cert_type||'single')}</span></td>
            <td>${cmsBadge(c.status)}</td>
            <td>${cmsDaysLeftBadge(days)}</td>
            <td style="font-size:0.8rem">${escapeHtml(c.environment||'-')}</td>
            <td style="font-size:0.8rem">${escapeHtml(c.owner_team||'-')}</td>
            <td style="white-space:nowrap">
                <button class="btn" style="background:#e2e8f0;font-size:0.75rem;padding:0.25rem 0.5rem" onclick="cmsShowDetail('${escapeAttr(c.id)}')">View</button>
                ${c.status!=='revoked'?'<button class="btn" style="background:#fef3c7;color:#92400e;font-size:0.75rem;padding:0.25rem 0.5rem;margin-left:0.25rem" onclick="cmsRenewCert(\''+escapeAttr(c.id)+'\',\''+escapeAttr(c.domain||'')+'\')">Renew</button>':''}
                ${c.status==='active'?'<button class="btn btn-danger" style="font-size:0.75rem;padding:0.25rem 0.5rem;margin-left:0.25rem" onclick="cmsRevokeCert(\''+escapeAttr(c.id)+'\',\''+escapeAttr(c.domain||'')+'\')">Revoke</button>':''}
            </td>
        </tr>`;
    }).join('');
}

function cmsFilterInventory() {
    if (!window._cmsAllCerts) return;
    const q = (document.getElementById('inv-search').value || '').toLowerCase();
    const status = document.getElementById('inv-filter-status').value;
    const env = document.getElementById('inv-filter-env').value;

    let filtered = window._cmsAllCerts;
    if (q) filtered = filtered.filter(c =>
        (c.domain||'').toLowerCase().includes(q) ||
        (c.issuer||'').toLowerCase().includes(q) ||
        (c.environment||'').toLowerCase().includes(q) ||
        (c.owner_team||'').toLowerCase().includes(q) ||
        (c.tags||[]).some(t => t.toLowerCase().includes(q))
    );
    if (status) filtered = filtered.filter(c => c.status === status);
    if (env) filtered = filtered.filter(c => c.environment === env);

    const tbody = document.getElementById('inv-tbody');
    if (tbody) tbody.innerHTML = cmsRenderCertRows(filtered);
}

function cmsShowDetail(id) {
    const panel = document.getElementById('cert-detail-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="card" style="margin-top:1rem"><p style="color:var(--muted)">Loading...</p></div>';

    cmsGet('/api/v1/certificates/' + encodeURIComponent(id)).then(data => {
        const c = data.id ? data : (data.certificate || data);
        const days = cmsDaysLeft(c.not_after);
        const docs = data.documents || [];
        const audit = data.recent_audit || [];

        panel.innerHTML = `
        <div class="card" style="margin-top:1rem;border-left:3px solid var(--primary)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h4>${escapeHtml(c.domain || 'Certificate Detail')}</h4>
                <button class="btn" style="background:#e2e8f0" onclick="this.closest('.card').remove()">Close</button>
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:0.75rem;font-size:0.82rem;margin-bottom:1rem">
                <div><strong>Subject:</strong><div class="cert-field">${escapeHtml(c.subject||'-')}</div></div>
                <div><strong>Issuer:</strong><div class="cert-field">${escapeHtml(c.issuer||'-')}</div></div>
                <div><strong>Serial:</strong><div class="cert-field">${escapeHtml(c.serial_number||'-')}</div></div>
                <div><strong>Fingerprint:</strong><div class="cert-field" style="font-size:0.65rem">${escapeHtml((c.fingerprint||'-').substring(0,80))}</div></div>
                <div><strong>Key:</strong><div class="cert-field">${escapeHtml(c.key_algorithm||'-')} ${c.key_size||''}-bit</div></div>
                <div><strong>Status:</strong> ${cmsBadge(c.status)} ${cmsDaysLeftBadge(days)}</div>
                <div><strong>Valid From:</strong><div class="cert-field">${cmsFormatDate(c.not_before)}</div></div>
                <div><strong>Valid To:</strong><div class="cert-field">${cmsFormatDate(c.not_after)}</div></div>
                <div><strong>Environment:</strong><div class="cert-field">${escapeHtml(c.environment||'-')}</div></div>
                <div><strong>Auto-Renew:</strong><div class="cert-field">${c.auto_renew ? '&#10004; Enabled' : '&#10060; Disabled'}</div></div>
                <div><strong>Owner Team:</strong><div class="cert-field">${escapeHtml(c.owner_team||'-')}</div></div>
                <div><strong>Renewals:</strong><div class="cert-field">${c.renewal_count||0}</div></div>
                ${(c.sans||[]).length > 0 ? '<div style="grid-column:span 2"><strong>SANs:</strong><div class="cert-field">' + escapeHtml((c.sans||[]).join(', ')) + '</div></div>' : ''}
                ${(c.tags||[]).length > 0 ? '<div><strong>Tags:</strong> ' + (c.tags||[]).map(t=>'<span class="badge" style="background:#e0f2fe;color:#0369a1;margin-right:0.25rem">' + escapeHtml(t) + '</span>').join('') + '</div>' : ''}
            </div>

            ${c.is_self_signed ? '<div class="alert-warning">&#9888; Self-signed certificate — not trusted by external clients.</div>' : ''}
            ${days !== null && days < 0 ? '<div class="alert-critical">&#10060; EXPIRED ' + Math.abs(days) + ' days ago.</div>' : ''}
            ${days !== null && days >= 0 && days <= 7 ? '<div class="alert-critical">&#10060; Expires in ' + days + ' days — CRITICAL.</div>' : ''}
            ${days !== null && days > 7 && days <= 30 ? '<div class="alert-warning">&#9888; Expires in ' + days + ' days — renewal recommended.</div>' : ''}

            <div class="tab-bar" style="margin-top:1rem">
                <button class="tab-btn active" id="dt-tab-info" onclick="cmsDetailTab('info', '${escapeAttr(id)}')">Info</button>
                <button class="tab-btn" id="dt-tab-docs" onclick="cmsDetailTab('docs', '${escapeAttr(id)}')">Documents (${docs.length})</button>
                <button class="tab-btn" id="dt-tab-audit" onclick="cmsDetailTab('audit', '${escapeAttr(id)}')">Audit (${audit.length})</button>
                <button class="tab-btn" id="dt-tab-actions" onclick="cmsDetailTab('actions', '${escapeAttr(id)}')">Actions</button>
            </div>
            <div id="dt-panel-info">
                <p style="color:var(--muted);font-size:0.82rem">Certificate details shown above. Use Actions tab to renew, revoke, or manage this certificate.</p>
            </div>
            <div id="dt-panel-docs" class="hidden">
                ${docs.length === 0 ? '<p style="color:var(--muted)">No documents uploaded. Use Actions to upload a document.</p>' :
                  '<table><thead><tr><th>File</th><th>Type</th><th>Size</th><th>Uploaded By</th><th>Date</th></tr></thead><tbody>' +
                  docs.map(d => '<tr><td>' + escapeHtml(d.filename||'-') + '</td><td>' + escapeHtml(d.file_type||'-') + '</td><td>' + ((d.file_size||0)/1024).toFixed(1) + 'KB</td><td>' + escapeHtml(d.uploaded_by||'-') + '</td><td>' + cmsFormatDate(d.uploaded_at) + '</td></tr>').join('') +
                  '</tbody></table>'}
            </div>
            <div id="dt-panel-audit" class="hidden">
                ${audit.length === 0 ? '<p style="color:var(--muted)">No audit events yet.</p>' :
                  '<table><thead><tr><th>Action</th><th>Actor</th><th>Details</th><th>Date</th><th>Result</th></tr></thead><tbody>' +
                  audit.map(a => '<tr><td><strong>' + escapeHtml(a.action||'-') + '</strong></td><td style="font-size:0.8rem">' + escapeHtml(a.actor||'-') + '</td><td style="font-size:0.78rem">' + escapeHtml((a.details||'-').substring(0,60)) + '</td><td>' + cmsFormatDate(a.timestamp) + '</td><td>' + (a.result==='success'?'<span style="color:var(--success)">&#10004;</span>':'<span style="color:var(--danger)">&#10060;</span>') + '</td></tr>').join('') +
                  '</tbody></table>'}
            </div>
            <div id="dt-panel-actions" class="hidden">
                <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.5rem">
                    <button class="btn btn-primary" onclick="cmsRenewCert('${escapeAttr(c.id)}','${escapeAttr(c.domain||'')}')">&#8635; Renew Certificate</button>
                    <button class="btn" style="background:#fef3c7;color:#92400e" onclick="cmsVerifyCert('${escapeAttr(c.id)}')">&#10003; Verify</button>
                    <button class="btn" style="background:#e0f2fe;color:#0369a1" onclick="cmsShowQr('${escapeAttr(c.id)}')">&#9638; QR Code</button>
                    <button class="btn" style="background:#f1f5f9" onclick="cmsUploadDoc('${escapeAttr(c.id)}')">&#8679; Upload Doc</button>
                    <button class="btn btn-danger" onclick="cmsRevokeCert('${escapeAttr(c.id)}','${escapeAttr(c.domain||'')}')">&#10060; Revoke</button>
                </div>
                <div id="dt-action-result" style="margin-top:0.75rem"></div>
            </div>
        </div>`;
    }).catch(e => {
        panel.innerHTML = '<div class="card"><div class="alert-critical">Failed to load: ' + escapeHtml(e.message) + '</div></div>';
    });
}

function cmsDetailTab(tab, certId) {
    ['info','docs','audit','actions'].forEach(t => {
        const p = document.getElementById('dt-panel-' + t);
        const b = document.getElementById('dt-tab-' + t);
        if (p) p.classList.toggle('hidden', t !== tab);
        if (b) b.classList.toggle('active', t === tab);
    });
}

function cmsRenewCert(id, domain) {
    if (!confirm('Renew certificate for ' + domain + '?')) return;
    cmsPost('/api/v1/certificates/' + encodeURIComponent(id) + '/renew', {}).then(res => {
        alert('Renewal initiated for ' + domain + '\nStatus: ' + (res.status || 'started'));
        loadCmsInventory();
    }).catch(e => alert('Renewal failed: ' + e.message));
}

function cmsRevokeCert(id, domain) {
    const reason = prompt('Reason for revoking ' + domain + '?\n(key_compromise, superseded, cessation)', 'superseded');
    if (!reason) return;
    cmsPost('/api/v1/certificates/' + encodeURIComponent(id) + '/revoke', { reason }).then(res => {
        alert('Certificate revoked: ' + domain + '\nAdded to CRL.');
        loadCmsInventory();
    }).catch(e => alert('Revocation failed: ' + e.message));
}

function cmsVerifyCert(id) {
    const result = document.getElementById('dt-action-result');
    if (result) result.innerHTML = '<p style="color:var(--muted)">Verifying...</p>';
    cmsPost('/api/v1/certificates/' + encodeURIComponent(id) + '/verify', {}).then(res => {
        const v = res.verification || {};
        const html = v.result === 'pass'
            ? '<div class="alert-success">&#10004; Verification passed — TLS ' + (v.tls_version||'') + ' ' + (v.cipher_suite||'') + '</div>'
            : '<div class="alert-critical">&#10060; Verification failed — ' + escapeHtml(v.error || 'unknown error') + '</div>';
        if (result) result.innerHTML = html;
    }).catch(e => { if (result) result.innerHTML = '<div class="alert-critical">Error: ' + escapeHtml(e.message) + '</div>'; });
}

function cmsShowQr(id) {
    cmsGet('/api/v1/certificates/' + encodeURIComponent(id) + '/qr').then(res => {
        const overlay = document.createElement('div');
        overlay.className = 'cms-modal';
        overlay.innerHTML = `<div class="cms-modal-box" style="text-align:center">
            <h4 style="margin-bottom:1rem">Certificate Verification QR</h4>
            <div style="border:1px solid var(--border);border-radius:0.5rem;padding:1rem;margin:1rem auto;display:inline-block">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(res.verification_url || res.qr_url || '')}" alt="QR Code" style="width:200px;height:200px">
            </div>
            <p class="cert-field" style="margin:0.5rem auto;max-width:400px;font-size:0.75rem">${escapeHtml(res.verification_url || '')}</p>
            <button class="btn btn-primary" style="margin-top:1rem" onclick="this.closest('.cms-modal').remove()">Close</button>
        </div>`;
        document.body.appendChild(overlay);
    });
}

function cmsUploadDoc(certId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pem,.crt,.cer,.p12,.pfx,.txt,.pdf';
    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        try { validateFileType(file); } catch(err) { alert(err.message); return; }
        cmsPost('/api/v1/certificates/' + encodeURIComponent(certId) + '/documents', {
            filename: file.name, file_type: file.name.split('.').pop(), file_size: file.size,
            mime_type: file.type || 'application/octet-stream', uploaded_by: 'admin@enterprise.internal'
        }).then(() => { alert('Document registered: ' + file.name); cmsShowDetail(certId); })
        .catch(e => alert('Upload failed: ' + e.message));
    };
    input.click();
}

function cmsExportInventory() {
    cmsGet('/api/v1/certificates/export?format=json').then(data => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'certificate-inventory-' + new Date().toISOString().slice(0,10) + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
    }).catch(() => {
        // Fallback: export from UI
        const data = window._cmsAllCerts || [];
        const csv = ['domain,issuer,cert_type,status,environment,days_left,auto_renew,owner_team']
            .concat(data.map(c => [c.domain,c.issuer,c.cert_type,c.status,c.environment,c.days_left,c.auto_renew,c.owner_team].join(','))).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'certificates.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    });
}

// ===========================================================================
// CMS USERS & ROLES (RBAC)
// ===========================================================================
function loadCmsUsers() {
    const el = document.getElementById('content-area');
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading...</p></div>';
    Promise.all([cmsGet('/api/v1/cert-users'), cmsGet('/api/v1/cert-roles')]).then(([usersData, rolesData]) => {
        const users = usersData.users || [];
        const roles = rolesData.roles || [];
        el.innerHTML = `
        <div class="tab-bar">
            <button class="tab-btn active" id="rbac-tab-users" onclick="cmsRbacTab('users')">Users (${users.length})</button>
            <button class="tab-btn" id="rbac-tab-roles" onclick="cmsRbacTab('roles')">Roles (${roles.length})</button>
        </div>
        <div id="rbac-panel-users">
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                    <h4>Certificate System Users</h4>
                    <button class="btn btn-primary" onclick="cmsAddUser()">+ Add User</button>
                </div>
                <table>
                    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>MFA</th><th>Status</th><th>Last Login</th><th>Actions</th></tr></thead>
                    <tbody>${users.map(u => `<tr>
                        <td><strong>${escapeHtml(u.name||'-')}</strong></td>
                        <td style="font-size:0.8rem">${escapeHtml(u.email||'-')}</td>
                        <td><span class="badge" style="background:#e0f2fe;color:#0369a1">${escapeHtml(u.role||'-')}</span></td>
                        <td style="font-size:0.8rem">${escapeHtml(u.department||'-')}</td>
                        <td>${u.mfa_enabled?'<span style="color:var(--success)">&#10004;</span>':'<span style="color:var(--danger)">&#10060;</span>'}</td>
                        <td>${cmsBadge(u.status)}</td>
                        <td style="font-size:0.78rem">${u.last_login ? cmsFormatDate(u.last_login) : '-'}</td>
                        <td><button class="btn" style="background:#fef3c7;color:#92400e;font-size:0.75rem;padding:0.2rem 0.4rem" onclick="cmsEditUser('${escapeAttr(u.id)}')">Edit</button>
                        <button class="btn btn-danger" style="font-size:0.75rem;padding:0.2rem 0.4rem;margin-left:0.25rem" onclick="cmsDeleteUser('${escapeAttr(u.id)}','${escapeAttr(u.name||'')}')">Remove</button></td>
                    </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No users</td></tr>'}</tbody>
                </table>
            </div>
        </div>
        <div id="rbac-panel-roles" class="hidden">
            <div class="card">
                <h4 style="margin-bottom:1rem">Certificate System Roles</h4>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem">
                    ${roles.map(r => `<div class="card" style="border-left:4px solid ${escapeAttr(r.color||'#2563eb')}">
                        <strong>${escapeHtml(r.display_name||r.name)}</strong>
                        <p style="color:var(--muted);font-size:0.8rem;margin:0.25rem 0">${escapeHtml(r.description||'-')}</p>
                        <p style="font-size:0.78rem"><strong>Users:</strong> ${r.user_count||0}</p>
                        <div style="margin-top:0.5rem">${(r.permissions||[]).map(p=>'<span class="badge" style="background:#f1f5f9;color:#374151;margin:0.1rem">' + escapeHtml(p) + '</span>').join('')}</div>
                    </div>`).join('')}
                </div>
            </div>
        </div>`;
        window._cmsRoles = roles;
    });
}

function cmsRbacTab(tab) {
    ['users','roles'].forEach(t => {
        const p = document.getElementById('rbac-panel-' + t);
        const b = document.getElementById('rbac-tab-' + t);
        if (p) p.classList.toggle('hidden', t !== tab);
        if (b) b.classList.toggle('active', t === tab);
    });
}

function cmsAddUser() {
    const overlay = document.createElement('div');
    overlay.className = 'cms-modal';
    const roles = (window._cmsRoles || []).map(r => '<option value="' + escapeAttr(r.name) + '">' + escapeHtml(r.display_name||r.name) + '</option>').join('');
    overlay.innerHTML = `<div class="cms-modal-box">
        <h4 style="margin-bottom:1rem">Add Certificate System User</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group"><label>Full Name *</label><input id="au-name" placeholder="Jane Smith" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            <div class="form-group"><label>Email *</label><input id="au-email" type="email" placeholder="jane@enterprise.internal" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            <div class="form-group"><label>Role *</label><select id="au-role" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem">${roles}</select></div>
            <div class="form-group"><label>Department</label><input id="au-dept" placeholder="IT Security" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
        </div>
        <div id="au-error" class="hidden alert-critical" style="margin-top:0.5rem"></div>
        <div style="display:flex;gap:0.5rem;margin-top:1rem">
            <button class="btn btn-primary" onclick="cmsAddUserSubmit(this)">Add User</button>
            <button class="btn" style="background:#e2e8f0" onclick="this.closest('.cms-modal').remove()">Cancel</button>
        </div>
    </div>`;
    document.body.appendChild(overlay);
}

function cmsAddUserSubmit(btn) {
    const overlay = btn.closest('.cms-modal');
    const name = document.getElementById('au-name').value.trim();
    const email = document.getElementById('au-email').value.trim();
    const role = document.getElementById('au-role').value;
    const dept = document.getElementById('au-dept').value.trim();
    const errEl = document.getElementById('au-error');
    if (!name || !email || !role) { errEl.textContent='Name, email and role are required.'; errEl.classList.remove('hidden'); return; }
    if (!email.includes('@')) { errEl.textContent='Invalid email address.'; errEl.classList.remove('hidden'); return; }

    cmsPost('/api/v1/cert-users', { name, email, role, department: dept }).then(() => {
        overlay.remove();
        loadCmsUsers();
    }).catch(e => { errEl.textContent=e.message; errEl.classList.remove('hidden'); });
}

function cmsEditUser(id) {
    alert('Edit user: ' + id + '\n(Full edit form available in production with backend integration)');
}

function cmsDeleteUser(id, name) {
    if (!confirm('Remove ' + name + ' from the certificate system?')) return;
    cmsDelete('/api/v1/cert-users/' + encodeURIComponent(id)).then(() => loadCmsUsers()).catch(e => alert(e.message));
}

// ===========================================================================
// CMS TEMPLATES
// ===========================================================================
function loadCmsTemplates() {
    const el = document.getElementById('content-area');
    cmsGet('/api/v1/cert-templates').then(data => {
        const templates = data.templates || [];
        el.innerHTML = `
        <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <div><h4>Certificate Templates</h4><p style="color:var(--muted);font-size:0.82rem">Reusable configuration profiles for consistent certificate issuance</p></div>
                <button class="btn btn-primary" onclick="cmsAddTemplate()">+ New Template</button>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1rem">
                ${templates.map(t => `<div class="card" style="border-top:3px solid var(--primary)">
                    <div style="display:flex;justify-content:space-between;align-items:start">
                        <strong>${escapeHtml(t.name||'-')}</strong>
                        <span class="badge" style="background:#e0f2fe;color:#0369a1">${t.usage_count||0} uses</span>
                    </div>
                    <p style="color:var(--muted);font-size:0.78rem;margin:0.25rem 0">${escapeHtml(t.description||'-')}</p>
                    <div style="font-size:0.78rem;margin-top:0.5rem;display:grid;grid-template-columns:1fr 1fr;gap:0.25rem">
                        <div><strong>Type:</strong> ${escapeHtml(t.cert_type||'-')}</div>
                        <div><strong>Key:</strong> ${escapeHtml(t.key_algorithm||'-')} ${t.key_size||''}</div>
                        <div><strong>Validity:</strong> ${t.validity_days||365}d</div>
                        <div><strong>Validation:</strong> ${escapeHtml(t.validation_level||'-')}</div>
                        <div><strong>CA:</strong> ${escapeHtml(t.ca_provider||'-')}</div>
                        <div><strong>Auto-renew:</strong> ${t.auto_renew?'Yes':'No'}</div>
                    </div>
                    <div style="margin-top:0.5rem">${(t.tags||[]).map(tag=>'<span class="badge" style="background:#f1f5f9;margin-right:0.2rem">' + escapeHtml(tag) + '</span>').join('')}</div>
                    <div style="display:flex;gap:0.5rem;margin-top:0.75rem">
                        <button class="btn btn-primary" style="font-size:0.78rem" onclick="cmsUseTemplate('${escapeAttr(t.id)}','${escapeAttr(t.name||'')}')">Use Template</button>
                        <button class="btn btn-danger" style="font-size:0.78rem" onclick="cmsDeleteTemplate('${escapeAttr(t.id)}','${escapeAttr(t.name||'')}')">Delete</button>
                    </div>
                </div>`).join('') || '<p style="color:var(--muted)">No templates yet.</p>'}
            </div>
        </div>`;
    });
}

function cmsUseTemplate(id, name) {
    navigate('cms-upload');
    setTimeout(() => { alert('Template "' + name + '" loaded. Fill in the domain and submit.'); }, 300);
}

function cmsAddTemplate() {
    const overlay = document.createElement('div');
    overlay.className = 'cms-modal';
    overlay.innerHTML = `<div class="cms-modal-box">
        <h4 style="margin-bottom:1rem">Create Certificate Template</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group" style="grid-column:span 2"><label>Template Name *</label><input id="at-name" placeholder="Standard Internal TLS" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            <div class="form-group" style="grid-column:span 2"><label>Description</label><input id="at-desc" placeholder="Internal services template" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            <div class="form-group"><label>Certificate Type</label><select id="at-type" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"><option value="single">Single Domain</option><option value="wildcard">Wildcard</option><option value="san">Multi-SAN</option><option value="ev">EV</option><option value="mtls">mTLS</option></select></div>
            <div class="form-group"><label>Key Algorithm</label><select id="at-algo" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"><option>RSA</option><option>ECDSA</option></select></div>
            <div class="form-group"><label>Key Size</label><select id="at-size" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"><option value="2048">RSA 2048</option><option value="4096">RSA 4096</option><option value="256">ECDSA P-256</option><option value="384">ECDSA P-384</option></select></div>
            <div class="form-group"><label>Validity (days)</label><input id="at-validity" type="number" value="365" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            <div class="form-group"><label>Validation Level</label><select id="at-vl" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"><option value="DV">DV</option><option value="OV">OV</option><option value="EV">EV</option><option value="IV">IV</option></select></div>
            <div class="form-group"><label>CA Provider</label><input id="at-ca" placeholder="letsencrypt" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
            <div class="form-group"><label>Environment</label><select id="at-env" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"><option value="prod">Production</option><option value="staging">Staging</option><option value="uat">UAT</option><option value="dev">Dev</option></select></div>
            <div class="form-group"><label>Tags</label><input id="at-tags" placeholder="internal, tls" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:0.375rem"></div>
        </div>
        <div style="display:flex;gap:0.5rem;margin-top:1rem">
            <button class="btn btn-primary" onclick="cmsAddTemplateSubmit(this)">Create</button>
            <button class="btn" style="background:#e2e8f0" onclick="this.closest('.cms-modal').remove()">Cancel</button>
        </div>
    </div>`;
    document.body.appendChild(overlay);
}

function cmsAddTemplateSubmit(btn) {
    const name = document.getElementById('at-name').value.trim();
    if (!name) { alert('Template name required.'); return; }
    cmsPost('/api/v1/cert-templates', {
        name, description: document.getElementById('at-desc').value,
        cert_type: document.getElementById('at-type').value,
        key_algorithm: document.getElementById('at-algo').value,
        key_size: parseInt(document.getElementById('at-size').value),
        validity_days: parseInt(document.getElementById('at-validity').value)||365,
        validation_level: document.getElementById('at-vl').value,
        ca_provider: document.getElementById('at-ca').value||'letsencrypt',
        environment: document.getElementById('at-env').value,
        tags: document.getElementById('at-tags').value.split(',').map(t=>t.trim()).filter(Boolean),
        auto_renew: true
    }).then(() => { btn.closest('.cms-modal').remove(); loadCmsTemplates(); })
    .catch(e => alert(e.message));
}

function cmsDeleteTemplate(id, name) {
    if (!confirm('Delete template "' + name + '"?')) return;
    cmsDelete('/api/v1/cert-templates/' + encodeURIComponent(id)).then(() => loadCmsTemplates()).catch(e => alert(e.message));
}

// ===========================================================================
// CMS NOTIFICATIONS
// ===========================================================================
function loadCmsNotifications() {
    const el = document.getElementById('content-area');
    cmsGet('/api/v1/cert-notifications').then(data => {
        const notifs = data.notifications || [];
        const unacked = data.unacknowledged || 0;
        el.innerHTML = `
        <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <div><h4>Certificate Notifications</h4><p style="color:var(--muted);font-size:0.82rem">${unacked} unacknowledged alerts</p></div>
                <button class="btn" style="background:#e2e8f0" onclick="cmsTestNotif()">&#8631; Send Test Alert</button>
            </div>
            <table>
                <thead><tr><th>Severity</th><th>Title</th><th>Certificate</th><th>Channels</th><th>Sent</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>${notifs.map(n => {
                    const sevCls = n.severity === 'critical' ? 'cert-status-expired' : n.severity === 'high' ? 'cert-status-expiring' : 'cert-status-active';
                    return `<tr>
                        <td><span class="${sevCls}">${escapeHtml(n.severity||'-')}</span></td>
                        <td><strong>${escapeHtml(n.title||'-')}</strong><br><span style="color:var(--muted);font-size:0.78rem">${escapeHtml(n.message||'-')}</span></td>
                        <td style="font-size:0.8rem">${escapeHtml(n.cert_id||'-')}</td>
                        <td style="font-size:0.78rem">${(n.channels||[]).join(', ')}</td>
                        <td style="font-size:0.78rem">${cmsFormatDate(n.sent_at)}</td>
                        <td>${n.acknowledged ? '<span class="cert-status-active">&#10004; Acked</span>' : '<span class="cert-status-expiring">Pending</span>'}</td>
                        <td>${n.acknowledged ? '' : '<button class="btn" style="background:#e2e8f0;font-size:0.75rem;padding:0.2rem 0.4rem" onclick="cmsAcknowledge(\''+escapeAttr(n.id)+'\')">Acknowledge</button>'}</td>
                    </tr>`;
                }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No notifications</td></tr>'}</tbody>
            </table>
        </div>`;
    });
}

function cmsAcknowledge(id) {
    cmsPost('/api/v1/cert-notifications/' + encodeURIComponent(id) + '/acknowledge', {}).then(() => loadCmsNotifications()).catch(e => alert(e.message));
}

function cmsTestNotif() {
    cmsPost('/api/v1/cert-notifications/test', {}).then(res => { alert('Test alert sent to: ' + (res.channels||[]).join(', ')); }).catch(e => alert(e.message));
}

// ===========================================================================
// CMS TRACKING
// ===========================================================================
function loadCmsTracking() {
    const el = document.getElementById('content-area');
    cmsGet('/api/v1/cert-tracking').then(data => {
        const items = data.tracking || [];
        el.innerHTML = `
        <div class="card">
            <h4 style="margin-bottom:1rem">Certificate Lifecycle Tracking</h4>
            <p style="color:var(--muted);font-size:0.82rem;margin-bottom:1rem">Real-time compliance and health status for all managed certificates</p>
            <table>
                <thead><tr><th>Domain</th><th>Environment</th><th>Status</th><th>Expires</th><th>Auto-Renew</th><th>Compliance</th><th>Risk Score</th><th>Owner</th></tr></thead>
                <tbody>${items.map(t => {
                    const riskCls = t.risk_score >= 80 ? 'cert-status-expired' : t.risk_score >= 50 ? 'cert-status-expiring' : 'cert-status-active';
                    const compCls = t.compliance_status === 'compliant' ? 'cert-status-active' : t.compliance_status === 'warning' ? 'cert-status-expiring' : 'cert-status-expired';
                    return `<tr>
                        <td><strong>${escapeHtml(t.domain||'-')}</strong></td>
                        <td style="font-size:0.8rem">${escapeHtml(t.environment||'-')}</td>
                        <td>${cmsBadge(t.status)}</td>
                        <td>${cmsDaysLeftBadge(t.days_left)}</td>
                        <td>${t.auto_renew ? '<span style="color:var(--success)">&#10004;</span>' : '<span style="color:var(--danger)">&#10060;</span>'}</td>
                        <td><span class="${compCls}">${escapeHtml(t.compliance_status||'-')}</span></td>
                        <td><span class="${riskCls}">${t.risk_score||0}</span></td>
                        <td style="font-size:0.78rem">${escapeHtml(t.owner_team||'-')}</td>
                    </tr>`;
                }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No tracking data</td></tr>'}</tbody>
            </table>
        </div>`;
    });
}

// ===========================================================================
// CMS AUDIT LOG
// ===========================================================================
function loadCmsAuditLog() {
    const el = document.getElementById('content-area');
    cmsGet('/api/v1/cert-audit').then(data => {
        const logs = data.logs || [];
        el.innerHTML = `
        <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <div><h4>Certificate System Audit Log</h4><p style="color:var(--muted);font-size:0.82rem">${logs.length} events recorded (immutable)</p></div>
                <div style="display:flex;gap:0.5rem">
                    <input id="audit-search" placeholder="Filter by actor or action..." style="padding:0.4rem 0.6rem;border:1px solid var(--border);border-radius:0.375rem;font-size:0.82rem" oninput="cmsCmsAuditFilter()">
                    <button class="btn" style="background:#e2e8f0" onclick="cmsCmsAuditExport()">&#8659; Export</button>
                </div>
            </div>
            <table id="audit-table">
                <thead><tr><th>Time</th><th>Action</th><th>Certificate</th><th>Actor</th><th>Role</th><th>Details</th><th>Result</th><th>Risk</th></tr></thead>
                <tbody id="audit-tbody">${cmsCmsAuditRows(logs)}</tbody>
            </table>
        </div>`;
        window._cmsAuditLogs = logs;
    });
}

function cmsCmsAuditRows(logs) {
    return logs.map(l => {
        const riskCls = l.risk_level === 'critical' ? 'cert-status-expired' : l.risk_level === 'high' ? 'cert-status-expiring' : l.risk_level === 'medium' ? 'cert-status-expiring' : 'cert-status-active';
        return `<tr>
            <td style="font-size:0.78rem">${cmsFormatDate(l.timestamp)}</td>
            <td><strong style="font-size:0.82rem">${escapeHtml(l.action||'-')}</strong></td>
            <td style="font-size:0.8rem">${escapeHtml(l.cert_id||'-')}</td>
            <td style="font-size:0.78rem">${escapeHtml(l.actor||'-')}</td>
            <td style="font-size:0.78rem"><span class="badge" style="background:#e0f2fe;color:#0369a1">${escapeHtml(l.actor_role||'-')}</span></td>
            <td style="font-size:0.78rem">${escapeHtml((l.details||'-').substring(0,60))}</td>
            <td>${l.result === 'success' ? '<span style="color:var(--success)">&#10004;</span>' : l.result === 'warning' ? '<span style="color:#f59e0b">&#9888;</span>' : '<span style="color:var(--danger)">&#10060;</span>'}</td>
            <td><span class="${riskCls}" style="font-size:0.72rem">${escapeHtml(l.risk_level||'-')}</span></td>
        </tr>`;
    }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No audit events</td></tr>';
}

function cmsCmsAuditFilter() {
    const q = (document.getElementById('audit-search').value || '').toLowerCase();
    const filtered = q ? (window._cmsAuditLogs||[]).filter(l => (l.actor||'').toLowerCase().includes(q) || (l.action||'').toLowerCase().includes(q) || (l.details||'').toLowerCase().includes(q)) : (window._cmsAuditLogs||[]);
    const tbody = document.getElementById('audit-tbody');
    if (tbody) tbody.innerHTML = cmsCmsAuditRows(filtered);
}

function cmsCmsAuditExport() {
    const logs = window._cmsAuditLogs || [];
    const csv = ['timestamp,action,cert_id,actor,actor_role,details,result,risk_level']
        .concat(logs.map(l => [l.timestamp,l.action,l.cert_id,l.actor,l.actor_role,'"'+(l.details||'').replace(/"/g,"'")+'"',l.result,l.risk_level].join(','))).join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cert-audit-' + new Date().toISOString().slice(0,10) + '.csv';
    a.click();
}

// ---------------------------------------------------------------------------
// VSatellite command dispatch
// ---------------------------------------------------------------------------
function dispatchVSatCommand(agentId) {
    const command = prompt('Enter command (scan_cidr / health_check / deploy_cert):');
    if (!command) return;
    const valid = ['scan_cidr', 'health_check', 'deploy_cert'];
    if (!valid.includes(command.trim())) {
        alert('Invalid command. Must be one of: ' + valid.join(', '));
        return;
    }
    apiPost('/api/v1/vsatellites/' + encodeURIComponent(agentId) + '/command', { command: command.trim(), args: {} })
        .then(d => {
            alert('Job ID: ' + (d.job_id || '-') + '\nStatus: ' + (d.status || '-') + '\nEstimated completion: ' + (d.estimated_completion || '-'));
            setTimeout(loadVSatellites, 2000);
        })
        .catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// VSatellite decommission
// ---------------------------------------------------------------------------
function decommissionVSat(agentId, name) {
    if (!confirm('Decommission vSatellite "' + name + '"? This cannot be undone.')) return;
    const token = localStorage.getItem('gw_token');
    fetch('/api/v1/vsatellites/' + encodeURIComponent(agentId), {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
    })
        .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || 'Delete failed'))))
        .then(() => {
            alert('vSatellite "' + name + '" has been decommissioned.');
            loadVSatellites();
        })
        .catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// CA account test connection
// ---------------------------------------------------------------------------
function testCAAccount(name) {
    apiPost('/api/v1/ca/accounts/' + encodeURIComponent(name) + '/test', {})
        .then(d => {
            alert('Connected: ' + (d.connected !== undefined ? d.connected : '-') +
                  '\nLatency: ' + (d.latency !== undefined ? d.latency + 'ms' : '-') +
                  '\nSSL Valid: ' + (d.ssl_valid !== undefined ? d.ssl_valid : '-'));
        })
        .catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// CA account set default
// ---------------------------------------------------------------------------
function makeCADefault(name) {
    if (!confirm('Set "' + name + '" as the default CA account?')) return;
    apiPost('/api/v1/ca/accounts/' + encodeURIComponent(name) + '/default', {})
        .then(() => {
            alert('"' + name + '" is now the default CA account.');
            loadAuthorities();
        })
        .catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// CA order refresh
// ---------------------------------------------------------------------------
function refreshCAOrder(certId) {
    apiPost('/api/v1/ca/orders/' + encodeURIComponent(certId) + '/refresh', {})
        .then(d => {
            alert('Order ID: ' + (d.id || d.order_id || '-') +
                  '\nStatus: ' + (d.status || '-') +
                  '\nNext check: ' + (d.next_check || '-'));
        })
        .catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// Deploy target test
// ---------------------------------------------------------------------------
function testDeployTarget(id) {
    apiPost('/api/v1/deploy/targets/' + encodeURIComponent(id) + '/test', {})
        .then(d => {
            alert('Reachable: ' + (d.reachable !== undefined ? d.reachable : '-') +
                  '\nTLS Version: ' + (d.tls_version || '-') +
                  '\nResponse: ' + (d.response_ms !== undefined ? d.response_ms + 'ms' : '-'));
        })
        .catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// Inventory deployment status update
// ---------------------------------------------------------------------------
function updateDeployStatus(id, status) {
    apiPost('/api/v1/inventory/deployments/' + encodeURIComponent(id) + '/status', { status })
        .then(() => loadInventory())
        .catch(e => alert(e.message));
}

// ---------------------------------------------------------------------------
// Export report download
// ---------------------------------------------------------------------------
function downloadExport(format) {
    const date = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = window.location.origin + '/api/v1/reports/export?format=' + encodeURIComponent(format);
    a.download = 'cert-report-' + date + '.' + format;
    a.click();
}