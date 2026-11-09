// logger-server.js - Local diagnostic log collector for Gemini Chat Exporter
const http = require('http');

const PORT = 3040;
const logs = [];
const MAX_LOGS = 5000;

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/log') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const entry = {
          time: new Date().toLocaleTimeString(),
          version: data.version || 'v1.3.0',
          source: data.source || 'unknown',
          level: data.level || 'info',
          message: data.message || '',
          details: data.details || null
        };
        logs.push(entry);
        if (logs.length > MAX_LOGS) logs.shift();

        const color = entry.level === 'error' ? '\x1b[31m'
                    : entry.level === 'warn' ? '\x1b[33m'
                    : entry.level === 'success' ? '\x1b[32m'
                    : '\x1b[36m';
        const verStr = entry.version ? ` [${entry.version}]` : '';
        console.log(`${color}[${entry.time}]${verStr} [${entry.source.toUpperCase()}] ${entry.message}\x1b[0m`);
        if (entry.details) {
          console.log('   Details:', JSON.stringify(entry.details).substring(0, 300));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: logs.length }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/logs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(logs, null, 2));
    return;
  }

  if (req.method === 'POST' && req.url === '/clear') {
    logs.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Logs cleared' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Gemini Chat Exporter Diagnostics Server running on port ${PORT}.\nTotal logs: ${logs.length}\n`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Diagnostic Server] Listening on http://localhost:${PORT}`);
});
