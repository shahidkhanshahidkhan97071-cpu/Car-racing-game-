// Node.js fallback static server (used by start_game.bat when Python is not installed).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const START_PORT = parseInt(process.env.GAME_PORT || '8765', 10);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.bin': 'application/octet-stream', '.txt': 'text/plain',
};

function listCars() {
  const dir = path.join(ROOT, 'cars');
  try { return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.glb')).sort(); } catch (e) { return []; }
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/api/cars') {
    const body = JSON.stringify(listCars());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(body);
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});

function listen(port, tries) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) listen(port + 1, tries - 1);
    else { console.error('Could not start server:', e.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    console.log('============================================================');
    console.log('  ASPHALT FOREST - racing game server running');
    console.log('  Open: ' + url);
    console.log('  (Close this window to stop the game server)');
    console.log('============================================================');
    if (!process.argv.includes('--no-browser')) {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      setTimeout(() => exec(cmd, () => {}), 600);
    }
  });
}
listen(START_PORT, 30);
