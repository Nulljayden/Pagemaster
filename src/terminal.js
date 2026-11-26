// Web terminal over WebSocket (xterm.js in the browser, node-pty here).
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const cookieParser = require('cookie-parser');
const config = require('./config');
const auth = require('./auth');

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });
  const parseCookies = cookieParser();

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws/terminal')) return socket.destroy();
    // Reject cross-site WebSocket connections
    const origin = req.headers.origin;
    try {
      if (!origin || new URL(origin).host !== req.headers.host) return socket.destroy();
    } catch (_) { return socket.destroy(); }
    parseCookies(req, {}, () => {
      const user = auth.userFromToken(req.cookies && req.cookies[auth.COOKIE]);
      if (!auth.can(user, 'terminal')) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => session(ws, user));
    });
  });
}

function session(ws, user) {
  const shell = process.env.SHELL_CMD || '/bin/bash';
  const term = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: config.SITES_DIR,
    env: { ...process.env, TERM: 'xterm-256color', PAGEMASTER_USER: user.username },
  });
  console.log(`[terminal] opened by ${user.username}`);
  term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  term.onExit(() => { try { ws.close(); } catch (_) {} });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.type === 'input' && typeof msg.data === 'string') term.write(msg.data);
    else if (msg.type === 'resize') {
      const cols = Math.max(10, Math.min(500, msg.cols | 0));
      const rows = Math.max(5, Math.min(200, msg.rows | 0));
      try { term.resize(cols, rows); } catch (_) {}
    }
  });
  ws.on('close', () => { try { term.kill(); } catch (_) {} });
}

module.exports = { attach };
