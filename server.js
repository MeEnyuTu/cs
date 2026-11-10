const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 🛡️ 提前加载 HTML 缓存
const HTML_FILE_PATH = path.join(__dirname, 'index.html');
let cachedHtml = '';
try {
    cachedHtml = fs.readFileSync(HTML_FILE_PATH, 'utf8');
} catch (err) {
    console.warn('[WARN] index.html not found at startup, will fallback to read-per-request.');
}

// 🛡️ 端口校验（兼容 Render 动态分配的端口）
let PORT = process.env.PORT ?? 8080;
PORT = Number(PORT);
if (isNaN(PORT) || PORT < 0 || PORT > 65535) {
    console.error(`[FATAL] Invalid PORT: ${process.env.PORT}`);
    process.exit(1);
}

// 🛡️ 鉴权配置（trim 后统一，空串/纯空格归 null）
const WS_TOKEN = (process.env.WS_TOKEN ?? '').trim() || null;
const REQUIRE_TOKEN = process.env.REQUIRE_TOKEN === 'true';

// 🛡️ 启动即 fail-fast：配置错不该等到第一次握手才暴露
if (REQUIRE_TOKEN && !WS_TOKEN) {
    console.error('[FATAL] REQUIRE_TOKEN=true but WS_TOKEN is not set. Refusing to start.');
    console.error('If you are on Render, go to Environment tab and add WS_TOKEN.');
    process.exit(1);
}

const HEARTBEAT_INTERVAL = 30000;
const MAX_PAYLOAD_SIZE = 2048;
const activeIds = new Set();

// ================= 创建 HTTP Server =================
const server = http.createServer((req, res) => {
    try {
        const host = req.headers.host || 'localhost';
        const url = new URL(req.url, `http://${host}`);

        if (url.host !== host) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Bad Request'); return;
        }

        let safePath = url.pathname === '/' ? '/index.html' : url.pathname;

        if (safePath !== '/index.html') {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found'); return;
        }

        if (cachedHtml) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(cachedHtml);
        } else {
            fs.readFile(HTML_FILE_PATH, (err, data) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Internal Server Error'); return;
                }
                cachedHtml = data.toString('utf8');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(data);
            });
        }
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`[FATAL] Port ${PORT} is already in use.`);
    else if (err.code === 'EACCES') console.error(`[FATAL] Port ${PORT} requires elevated privileges.`);
    else console.error('[HTTP ERROR]', err);
    process.exit(1);
});

// ================= 创建 WebSocket Server =================
const wss = new WebSocket.Server({
    server,
    maxPayload: MAX_PAYLOAD_SIZE,
    handleProtocols: (protocols) => protocols.has('morse-v1') ? 'morse-v1' : false,
    verifyClient: (info, cb) => {
        let reqUrl;
        try {
            const host = info.req.headers.host || 'localhost';
            reqUrl = new URL(info.req.url, `http://${host}`);
        } catch (e) {
            return cb(false, 400, 'Bad Request URL');
        }

        const tokenFromQuery = reqUrl.searchParams.get('token');
        const protocols = (info.req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
        const tokenFromProtocol = protocols.find(p => p.startsWith('token-'))?.slice(6);
        const token = tokenFromQuery || tokenFromProtocol;

        if (REQUIRE_TOKEN) {
            if (!token) {
                return cb(false, 401, 'Token required');
            }
            try {
                const a = Buffer.from(String(token));
                const b = Buffer.from(WS_TOKEN);
                if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
                    return cb(true);
                }
            } catch (e) { }
            return cb(false, 401, 'Invalid Token');
        }

        if (WS_TOKEN && token) {
            try {
                const a = Buffer.from(String(token));
                const b = Buffer.from(WS_TOKEN);
                if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
                    return cb(true);
                }
            } catch (e) { }
        }

        const origin = info.origin || info.req.headers.origin;
        if (!origin) {
            return cb(false, 403, 'Origin or Token required');
        }

        try {
            const originUrl = new URL(origin);
            const host = info.req.headers.host;
            const forwardedProto = (info.req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
            const isSecure = forwardedProto === 'https' || info.req.socket.encrypted === true;
            const expectedProtocol = isSecure ? 'https:' : 'http:';

            if (originUrl.host === host && originUrl.protocol === expectedProtocol) {
                return cb(true);
            }
            cb(false, 403, 'Forbidden Origin');
        } catch (err) {
            cb(false, 400, 'Bad Request Origin Format');
        }
    }
});

wss.on('error', (err) => {
    console.error('[WSS ERROR]', err);
    if (err.code && /^(ERR_|WS_ERR_)/.test(err.code)) {
        shutdown('WSS_ERROR');
    }
});

const interval = setInterval(() => {
    const toTerminate = [];
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            ws._terminating = true;
            toTerminate.push(ws);
            return;
        }
        ws.isAlive = false;
        if (ws.readyState === WebSocket.OPEN) {
            try { ws.ping(); } catch (e) { }
        }
    });

    if (toTerminate.length > 0) {
        setImmediate(() => {
            toTerminate.forEach(ws => { try { ws.terminate(); } catch(e) {} });
        });
    }
}, HEARTBEAT_INTERVAL);
interval.unref();

wss.on('close', () => clearInterval(interval));

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.closed = false;
    ws.rateLimited = false;
    ws._terminating = false;
    ws.on('pong', () => { ws.isAlive = true; });

    let newId;
    let attempts = 0;
    do {
        newId = Math.floor(100000 + Math.random() * 900000).toString();
        attempts++;
    } while (activeIds.has(newId) && attempts < 10);

    if (attempts >= 10) {
        ws.id = "ERROR_FULL";
        return ws.close(1013, 'Server full');
    }

    ws.id = newId;
    activeIds.add(ws.id);

    ws.rateLimit = { count: 0, windowStart: Date.now() };
    broadcast(JSON.stringify({ type: 'system', text: `[NET] NODE ${ws.id} ONLINE.` }), ws);

    ws.on('message', (message) => {
        if (ws.rateLimited || ws._terminating) return;

        try {
            const now = Date.now();
            if (now - ws.rateLimit.windowStart > 5000) {
                ws.rateLimit.count = 0;
                ws.rateLimit.windowStart = now;
            }
            ws.rateLimit.count++;
            if (ws.rateLimit.count > 30) {
                ws.rateLimited = true;
                ws.close(1008, 'Rate limit exceeded');
                return;
            }

            const data = JSON.parse(message);
            if (data && typeof data.morse === 'string' && data.morse.length < 1000) {
                if (!/^[.\- ]+$/.test(data.morse)) return;
                broadcast(JSON.stringify({ type: 'msg', id: ws.id, morse: data.morse }));
            }
        } catch (e) {
            if (Math.random() < 0.01) console.warn(`[WARN] Invalid msg from ${ws.id || '?'}`);
        }
    });

    ws.on('close', () => {
        if (ws.closed) return;
        ws.closed = true;
        if (ws.id === "ERROR_FULL") return;
        activeIds.delete(ws.id);
        broadcast(JSON.stringify({ type: 'system', text: `[NET] NODE ${ws.id} OFFLINE.` }));
    });

    ws.on('error', (err) => {
        console.error(`[WS ERROR] Node ${ws.id || '?'}:`, err.message);
        ws._terminating = true;
        ws.terminate();
    });
});

let sendFailures = 0;
function broadcast(data, excludeWs = null) {
    const toTerminate = [];
    wss.clients.forEach(client => {
        if (client === excludeWs) return;
        if (client.readyState === WebSocket.OPEN) {
            if (client.bufferedAmount > 1024 * 1024) {
                if (!client._terminating) {
                    client._terminating = true;
                    toTerminate.push(client);
                }
            } else {
                try {
                    client.send(data);
                } catch (e) {
                    sendFailures++;
                    if (sendFailures % 100 === 0) console.warn(`[WARN] Total send failures: ${sendFailures}`);
                    if (!client._terminating) {
                        client._terminating = true;
                        toTerminate.push(client);
                    }
                }
            }
        }
    });
    if (toTerminate.length > 0) {
        setImmediate(() => {
            toTerminate.forEach(c => { try { c.terminate(); } catch(e) {} });
        });
    }
}

let isShuttingDown = false;
function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[SHUTDOWN] Received ${signal}, closing server gracefully...`);

    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.close(1001, 'server shutdown');
        } else if (client.readyState === WebSocket.CONNECTING) {
            client.terminate();
        }
    }

    try {
        wss.close(() => {
            console.log('[SHUTDOWN] WebSocket server closed.');
            if (typeof server.closeIdleConnections === 'function') {
                server.closeIdleConnections();
            }
            try {
                server.close(() => {
                    console.log('[SHUTDOWN] HTTP server closed. Exiting.');
                    process.exit(0);
                });
            } catch (e) {
                console.error('[SHUTDOWN] server.close() threw:', e.message);
                process.exit(1);
            }
        });
    } catch (e) {
        console.error('[SHUTDOWN] wss.close() threw:', e.message);
        process.exit(1);
    }

    setTimeout(() => {
        console.error('[SHUTDOWN] Forcefully shutting down due to timeout.');
        process.exit(1);
    }, 10000).unref();
}

const rejectionTimestamps = [];
const REJECTION_WINDOW_MS = 60 * 1000;
const REJECTION_MAX = 10;

process.on('unhandledRejection', (err) => {
    const now = Date.now();
    rejectionTimestamps.push(now);
    while (rejectionTimestamps.length > 0 && now - rejectionTimestamps[0] > REJECTION_WINDOW_MS) {
        rejectionTimestamps.shift();
    }
    console.error(`[REJECTION] ${rejectionTimestamps.length}/${REJECTION_MAX} in 60s`, err);

    if (rejectionTimestamps.length > REJECTION_MAX) {
        console.error('[FATAL] Rejection storm detected, shutting down.');
        shutdown('UNHANDLED_REJECTION');
    }
});

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err);
    process.exit(1);
});

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
    const actualPort = server.address().port;
    console.log(`[TELEGRAPH SERVER] Listening on port ${actualPort}`);
    console.log(`[TELEGRAPH SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[TELEGRAPH SERVER] Auth mode: ${REQUIRE_TOKEN ? 'REQUIRE_TOKEN (strict)' : 'Origin-based (gateway)'}`);

    if (!WS_TOKEN) {
        const isPublic = process.env.PORT || process.env.NODE_ENV === 'production';
        if (isPublic) {
            console.warn('[SECURITY WARNING] Public deployment detected without WS_TOKEN.');
            console.warn('[SECURITY WARNING] If Node is directly exposed, set REQUIRE_TOKEN=true and WS_TOKEN.');
        }
    }
});
