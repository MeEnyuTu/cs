const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(500); res.end('Error loading HTML'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404); res.end();
    }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    // 随机分配电报代号
    ws.id = Math.floor(100 + Math.random() * 900).toString();
    broadcast(JSON.stringify({ type: 'system', text: `[NET] NODE ${ws.id} ONLINE.` }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.morse) {
                // 只转发摩斯电码本身
                broadcast(JSON.stringify({ type: 'msg', id: ws.id, morse: data.morse }));
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        broadcast(JSON.stringify({ type: 'system', text: `[NET] NODE ${ws.id} OFFLINE.` }));
    });
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

server.listen(PORT, '0.0.0.0', () => console.log(`[MORSE SERVER] Listening on ${PORT}`));
