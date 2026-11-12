// CLM Vercel API Bridge — delegates all /api/* requests to the mock API handler
// dev-server.js uses `require.main === module` so requiring it here does NOT
// start the HTTP servers; only handleMockAPI is used.
'use strict';

const { handleMockAPI } = require('../dev-server.js');

module.exports = (req, res) => {
    // CORS — required for browser clients calling the API
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-Agent-Secret');
    res.setHeader('Cache-Control', 'no-store');

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Vercel sets x-matched-path to the original URL before rewriting.
    // Restore it so pathname-based routing in handleMockAPI works correctly.
    const matchedPath = req.headers['x-matched-path'];
    if (matchedPath && matchedPath !== '/api/index.js') {
        const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
        req.url = matchedPath + qs;
    }

    // Vercel pre-parses the request body into req.body. Replay it as a stream
    // so handlers that do `req.on('data', ...)` receive the bytes correctly.
    if (req.body !== undefined) {
        const bodyData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const bodyBuffer = Buffer.from(bodyData, 'utf8');
        req.headers['content-length'] = bodyBuffer.length.toString();
        const origOn = typeof req.on === 'function' ? req.on.bind(req) : null;
        req.on = function (event, handler) {
            if (event === 'data') {
                process.nextTick(() => { try { handler(bodyBuffer); } catch (e) {} });
            } else if (event === 'end') {
                process.nextTick(() => { try { handler(); } catch (e) {} });
            } else if (origOn) {
                origOn(event, handler);
            }
            return req;
        };
    }

    try {
        const handled = handleMockAPI(req, res);
        if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Not Found',
                path: req.url,
                method: req.method
            }));
        }
    } catch (err) {
        console.error('[CLM API Error]', err.message, req.method, req.url);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Internal Server Error',
                message: err.message
            }));
        }
    }
};
