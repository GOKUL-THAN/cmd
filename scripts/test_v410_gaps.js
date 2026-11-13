// ==============================================================================
// scripts/test_v410_gaps.js
// CLM v4.1.0 Gap Coverage Test Suite – 20 scenarios
// Tests handleMockAPI in-process (no network, no server startup required)
// ==============================================================================

'use strict';

const { EventEmitter } = require('events');
const devServer = require('../dev-server.js');

// ── helpers ────────────────────────────────────────────────────────────────

function makeMockReq(method, url, body) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = {
        'host': '127.0.0.1:3000',
        'x-test-bypass-ratelimit': '1',
        'accept': 'application/json'
    };
    if (body) {
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        req.headers['content-type'] = 'application/json';
        req.headers['content-length'] = String(Buffer.byteLength(bodyStr));
        // fire data/end asynchronously so the handler can register listeners first
        setTimeout(() => {
            req.emit('data', Buffer.from(bodyStr));
            req.emit('end');
        }, 0);
    }
    return req;
}

function makeMockRes() {
    const res = new EventEmitter();
    res.statusCode = 200;
    res._headers = {};
    res._body = '';
    res.setHeader = (k, v) => { res._headers[k.toLowerCase()] = v; };
    res.getHeader = (k) => res._headers[k.toLowerCase()];
    res.writeHead = (status, hdrs) => {
        res.statusCode = status;
        if (hdrs) {
            for (const [k, v] of Object.entries(hdrs)) {
                res._headers[k.toLowerCase()] = v;
            }
        }
    };
    res.write = (chunk) => { res._body += chunk; };
    res.end   = (chunk) => { if (chunk) res._body += chunk; };
    return res;
}

function runTest(name, method, url, body, check) {
    return new Promise((resolve) => {
        const req = makeMockReq(method, url, body);
        const res = makeMockRes();

        try {
            const handled = devServer.handleMockAPI(req, res);
            if (!handled) {
                // route not registered – give async handlers a chance anyway
            }
        } catch (err) {
            resolve({ name, passed: false, reason: `handleMockAPI threw: ${err.message}` });
            return;
        }

        // wait for async on('data')/on('end') handlers and any internal setTimeout
        setTimeout(() => {
            let parsed = null;
            try { parsed = JSON.parse(res._body); } catch (_) { /* non-JSON response is fine */ }
            try {
                check(res, parsed);
                resolve({ name, passed: true });
            } catch (err) {
                resolve({ name, passed: false, reason: err.message });
            }
        }, 100);
    });
}

// ── seed a valid session so test 19 (/api/v1/auth/session) works ──────────
function seedSession() {
    return new Promise((resolve) => {
        // Step 1: Hit /api/v1/auth/session to initialize global._sessionStore
        const initReq = makeMockReq('GET', '/api/v1/auth/session', null);
        const initRes = makeMockRes();
        try { devServer.handleMockAPI(initReq, initRes); } catch (_) {}

        // Step 2: After store is initialized, call /auth/login to seed the token
        setTimeout(() => {
            const req = makeMockReq('POST', '/auth/login', { email: 'admin@enterprise.internal', password: 'Admin@1234!' });
            req.headers['content-type'] = 'application/json';
            const res = makeMockRes();
            try { devServer.handleMockAPI(req, res); } catch (_) {}
            setTimeout(resolve, 100);
        }, 50);
    });
}

// ── 20 test definitions ───────────────────────────────────────────────────

async function main() {
    console.log('=============================================================');
    console.log('CLM v4.1.0 Gap Coverage Test Suite – 20 scenarios');
    console.log('=============================================================');

    await seedSession();

    const tests = [
        // 1
        runTest(
            '01 GET /api/v1/status',
            'GET', '/api/v1/status', null,
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (d.certificates === undefined) throw new Error('d.certificates undefined');
                if (d.expiring_30d === undefined) throw new Error('d.expiring_30d undefined');
                if (!d.agents || d.agents.online_agents === undefined) throw new Error('d.agents.online_agents undefined');
                if (!d.name) throw new Error('d.name missing');
                if (!d.saas_endpoint) throw new Error('d.saas_endpoint missing');
                if (d.pending_approvals === undefined) throw new Error('d.pending_approvals undefined');
            }
        ),

        // 2
        runTest(
            '02 GET /api/v1/lifecycle',
            'GET', '/api/v1/lifecycle', null,
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (!d.risk) throw new Error('d.risk missing');
                if (d.risk.expired === undefined) throw new Error('d.risk.expired undefined');
                if (d.risk.critical === undefined) throw new Error('d.risk.critical undefined');
                if (!Array.isArray(d.expiry_buckets)) throw new Error('d.expiry_buckets not an array');
                if (!Array.isArray(d.findings)) throw new Error('d.findings not an array');
                if (!d.hygiene) throw new Error('d.hygiene missing');
                if (!Array.isArray(d.by_issuer)) throw new Error('d.by_issuer not an array');
            }
        ),

        // 3
        runTest(
            '03 GET /api/v1/scheduler',
            'GET', '/api/v1/scheduler', null,
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (!Array.isArray(d.jobs) || d.jobs.length === 0) throw new Error('d.jobs empty or not array');
                const j = d.jobs[0];
                if (!j.job) throw new Error('d.jobs[0].job missing');
                if (!j.interval) throw new Error('d.jobs[0].interval missing');
                if (!j.detail) throw new Error('d.jobs[0].detail missing');
                if (!j.last_run || j.last_run.ok === undefined) throw new Error('d.jobs[0].last_run.ok undefined');
                if (!j.last_run.summary) throw new Error('d.jobs[0].last_run.summary missing');
            }
        ),

        // 4
        runTest(
            '04 GET /api/v1/alerts',
            'GET', '/api/v1/alerts', null,
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (!d.stats) throw new Error('d.stats missing');
                if (d.stats.enabled === undefined) throw new Error('d.stats.enabled undefined');
                if (d.stats.raised === undefined) throw new Error('d.stats.raised undefined');
                if (!Array.isArray(d.stats.channels)) throw new Error('d.stats.channels not an array');
            }
        ),

        // 5
        runTest(
            '05 PATCH /api/v1/tenants/tenant-enterprise-uat',
            'PATCH', '/api/v1/tenants/tenant-enterprise-uat', { plan: 'pro' },
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
            }
        ),

        // 6
        runTest(
            '06 POST /api/v1/tenants (create)',
            'POST', '/api/v1/tenants', { name: 'Test Corp', plan: 'pro' },
            (res, d) => {
                if (res.statusCode !== 201) throw new Error(`Expected 201, got ${res.statusCode}`);
                if (!d.tenant || !d.tenant.id) throw new Error('d.tenant.id missing');
            }
        ),

        // 7
        runTest(
            '07 DELETE /api/v1/tenants/tenant-enterprise-uat (409 with dependents)',
            'DELETE', '/api/v1/tenants/tenant-enterprise-uat', null,
            (res, d) => {
                if (res.statusCode !== 409) throw new Error(`Expected 409, got ${res.statusCode}`);
                if (!d.dependents) throw new Error('d.dependents missing');
            }
        ),

        // 8
        runTest(
            '08 POST /api/v1/vsatellites/vsat-ind-aps1-uat-01/command',
            'POST', '/api/v1/vsatellites/vsat-ind-aps1-uat-01/command', { command: 'health_check' },
            (res, d) => {
                if (res.statusCode !== 202) throw new Error(`Expected 202, got ${res.statusCode}`);
                if (d.queued !== true) throw new Error('d.queued !== true');
                if (!d.job_id) throw new Error('d.job_id missing');
            }
        ),

        // 9
        runTest(
            '09 POST /api/v1/ca/accounts/digicert/test',
            'POST', '/api/v1/ca/accounts/digicert/test', {},
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (d.connected !== true) throw new Error('d.connected !== true');
            }
        ),

        // 10
        runTest(
            '10 POST /api/v1/ca/accounts/digicert/default',
            'POST', '/api/v1/ca/accounts/digicert/default', {},
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (d.set !== true) throw new Error('d.set !== true');
            }
        ),

        // 11
        runTest(
            '11 DELETE /api/v1/vsatellites/vsat-ind-aps1-uat-01',
            'DELETE', '/api/v1/vsatellites/vsat-ind-aps1-uat-01', null,
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (d.decommissioned !== true) throw new Error('d.decommissioned !== true');
            }
        ),

        // 12
        runTest(
            '12 POST /api/v1/financials/three-way-match (mismatch)',
            'POST', '/api/v1/financials/three-way-match', { po_amount: 100000, invoice_amount: 90000 },
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (d.status !== 'mismatch') throw new Error(`d.status expected 'mismatch', got '${d.status}'`);
            }
        ),

        // 13
        runTest(
            '13 POST /api/v1/policies/evaluate (self-signed in production)',
            'POST', '/api/v1/policies/evaluate', { cert: { is_self_signed: true, environment: 'production' } },
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (d.compliant !== false) throw new Error('d.compliant should be false');
                if (!d.violations || d.violations.length === 0) throw new Error('d.violations should be non-empty');
            }
        ),

        // 14
        runTest(
            '14 GET /api/v1/reports/compliance',
            'GET', '/api/v1/reports/compliance', null,
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (d.score === undefined) throw new Error('d.score undefined');
                if (!d.grade) throw new Error('d.grade missing');
                if (!Array.isArray(d.frameworks)) throw new Error('d.frameworks not an array');
            }
        ),

        // 15
        runTest(
            '15 POST /api/v1/tenants/tenant-enterprise-uat/sso',
            'POST', '/api/v1/tenants/tenant-enterprise-uat/sso', { provider: 'oidc', domains: ['enterprise.internal'] },
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (d.saved !== true) throw new Error('d.saved !== true');
            }
        ),

        // 16
        runTest(
            '16 GET /api/v1/clm-reports/export?format=json',
            'GET', '/api/v1/clm-reports/export?format=json', null,
            (res, d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (!Array.isArray(d.contracts)) throw new Error('d.contracts not an array');
            }
        ),

        // 17
        runTest(
            '17 GET /api/v1/reports/export?format=csv',
            'GET', '/api/v1/reports/export?format=csv', null,
            (res, _d) => {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                const ct = res._headers['content-type'] || '';
                if (!ct.includes('csv')) throw new Error(`content-type '${ct}' does not include 'csv'`);
            }
        ),

        // 18
        runTest(
            '18 POST /api/v1/discover (SSRF block)',
            'POST', '/api/v1/discover', { cidr: '169.254.169.254/32' },
            (res, d) => {
                if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
            }
        ),

        // 19
        runTest(
            '19 GET /api/v1/auth/session',
            'GET', '/api/v1/auth/session', null,
            (res, d) => {
                // Attach the seeded token so the session lookup succeeds
                // We re-issue this test with the Authorization header set
                // (see special handling below – this check is replaced)
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (!d || d.valid !== true) throw new Error('d.valid !== true');
            }
        ),

        // 20
        runTest(
            '20 POST /api/v1/cert-auth/login (bad credentials → 401)',
            'POST', '/api/v1/cert-auth/login', { email: 'nonexistent@nowhere.com', password: 'wrong' },
            (res, d) => {
                if (res.statusCode !== 401) throw new Error(`Expected 401, got ${res.statusCode}`);
            }
        ),
    ];

    // Test 19 must carry the Authorization header; replace it with a custom runner
    // that uses the seeded token 'mock-jwt-token-clm-admin-access'
    tests[18] = new Promise((resolve) => {
        const req = makeMockReq('GET', '/api/v1/auth/session', null);
        req.headers['authorization'] = 'Bearer mock-jwt-token-clm-admin-access';
        const res = makeMockRes();
        try { devServer.handleMockAPI(req, res); } catch (err) {
            resolve({ name: '19 GET /api/v1/auth/session', passed: false, reason: err.message });
            return;
        }
        setTimeout(() => {
            let parsed = null;
            try { parsed = JSON.parse(res._body); } catch (_) {}
            try {
                if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
                if (!parsed || parsed.valid !== true) throw new Error('d.valid !== true');
                resolve({ name: '19 GET /api/v1/auth/session', passed: true });
            } catch (err) {
                resolve({ name: '19 GET /api/v1/auth/session', passed: false, reason: err.message });
            }
        }, 100);
    });

    const results = await Promise.all(tests);

    // ── summary ────────────────────────────────────────────────────────────
    console.log('\n=============================================================');
    const passed = results.filter(r => r.passed);
    const failed = results.filter(r => !r.passed);

    results.forEach(r => {
        if (r.passed) {
            console.log(`  ✅ PASS  ${r.name}`);
        } else {
            console.log(`  ❌ FAIL  ${r.name}  — ${r.reason}`);
        }
    });

    console.log(`\nResults: ${passed.length}/20 passed`);

    if (failed.length > 0) {
        console.log('\nFailed tests:');
        failed.forEach(r => console.log(`  - ${r.name}: ${r.reason}`));
        process.exit(1);
    } else {
        console.log('\nAll 20 tests passed.');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Fatal error in test runner:', err);
    process.exit(1);
});
