const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
// 允许的最大报文大小：2KB (防止 JSON 炸弹 / 内存溢出)
const MAX_PAYLOAD_SIZE = 2 * 1024; 
// 心跳间隔：30秒
const HEARTBEAT_INTERVAL = 30000;

const server = http.createServer((req, res) => {
    // 修复 Bug: 路径穿越漏洞防御
    const safeUrl = req.url === '/' ? '/index.html' : req.url;
    // 确保请求的文件是在当前目录下，防止 ../../etc/passwd
    const filePath = path.join(__dirname, path.normalize(safeUrl).replace(/^(\.\.[\/\\])+/, ''));

    if (filePath.endsWith('index.html')) {
        fs.readFile(filePath, (err, data) => {
            if (err) { 
                res.writeHead(500); 
                res.end('Internal Server Error'); 
                return; 
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404); 
        res.end('Not Found');
    }
});

// 修复 Bug: 限制 wss 最大接收数据量
const wss = new WebSocket.Server({ 
    server,
    maxPayload: MAX_PAYLOAD_SIZE 
});

// ================= 🛡️ 心跳保活机制 =================
// 修复 Bug: 客户端异常断电/断网导致 TCP 连接假死，服务器内存泄漏
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate(); // 强制干掉死连接
        ws.isAlive = false;
        ws.ping(); // 发送 ping 帧
    });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => {
    clearInterval(interval);
});

// ================= WebSocket 逻辑 =================
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; }); // 收到 pong 证明还活着

    // 随机分配极客代号 (100-999)
    ws.id = Math.floor(100 + Math.random() * 900).toString();
    
    broadcast(JSON.stringify({ type: 'system', text: `[NET] NODE ${ws.id} ONLINE.` }));

    ws.on('message', (message) => {
        try {
            // 修复 Bug: 确保 JSON 解析不会导致崩溃
            const data = JSON.parse(message);
            
            // 校验数据格式，必须是纯文本摩斯电码
            if (data && typeof data.morse === 'string' && data.morse.length < 1000) {
                broadcast(JSON.stringify({ type: 'msg', id: ws.id, morse: data.morse }));
            }
        } catch (e) {
            // 静默丢弃非法格式的包，不打日志防刷屏
        }
    });

    ws.on('close', () => {
        broadcast(JSON.stringify({ type: 'system', text: `[NET] NODE ${ws.id} OFFLINE.` }));
    });

    ws.on('error', (err) => {
        // 修复 Bug: 捕获 socket 错误
        console.error(`[WS ERROR] Node ${ws.id}:`, err.message);
        ws.terminate();
    });
});

// 修复 Bug: 广播时如果某个 ws 抛错，不能中断其他人的广播
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(data);
            } catch (e) {
                // 单个发送失败不影响其他人
            }
        }
    });
}

// ================= 🛑 优雅停机 (Graceful Shutdown) =================
// 修复 Bug: 强制关闭进程会导致 502 错误，必须让连接平滑断开
function shutdown() {
    console.log('\n[SHUTDOWN] Received kill signal, closing server...');
    // 停止接收新连接
    wss.close(() => {
        console.log('[SHUTDOWN] WebSocket Server closed.');
        // 关闭 HTTP 服务器
        server.close(() => {
            console.log('[SHUTDOWN] HTTP Server closed. Process exiting.');
            process.exit(0);
        });
    });

    // 强制超时退出：如果 10 秒内没关干净，强行退出
    setTimeout(() => {
        console.error('[SHUTDOWN] Forcefully shutting down.');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// 启动
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[TELEGRAPH SERVER] Listening on port ${PORT}`);
    console.log(`[TELEGRAPH SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);
});
