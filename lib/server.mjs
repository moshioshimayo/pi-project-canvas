import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA_HOME, SHARE_ID, MAX_BYTES, atomicJSON, readJSON, sceneAt, saveScene, saveSelection } from './store.mjs';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
export const SERVICE = 'pi-project-canvas/1';

function respond(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Use application/json'), { status: 415 });
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BYTES) throw Object.assign(new Error('Request exceeds 24 MiB'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON'); }
}

export function createCanvasServer({ home = DATA_HOME, host, port = 43827, dist = DIST }) {
  if (!host) throw new Error('An explicit Tailscale bind address is required');
  const startedAt = new Date().toISOString();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const authority = `${host}:${server.address().port}`;
      if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== `http://${authority}`)) return respond(res, 403, { error: 'Wrong host or cross-origin request' });
      if (!['GET', 'PUT', 'POST'].includes(req.method)) return respond(res, 405, { error: 'Method not allowed' });
      const url = new URL(req.url, `http://${authority}`);
      const path = decodeURIComponent(url.pathname);
      if (path === '/_health' && req.method === 'GET') return respond(res, 200, { service: SERVICE, home: realpathSync(home), pid: process.pid, startedAt });
      const route = /^\/api\/([a-f0-9]{24})\/(scene|selections)(?:\/([a-f0-9-]{36}))?$/.exec(path);
      if (route) {
        const [, id, kind, selectionId] = route;
        const directory = join(home, 'projects', id);
        if (!existsSync(join(directory, 'project.json'))) return respond(res, 404, { error: 'Unknown project' });
        if (req.method === 'GET' && kind === 'scene' && !selectionId) return respond(res, 200, { ...sceneAt(directory), project: readJSON(join(directory, 'project.json')) });
        if (req.method === 'PUT' && kind === 'scene' && !selectionId) {
          const input = await body(req);
          const saved = saveScene(directory, input);
          return saved ? respond(res, 200, { revision: saved.revision }) : respond(res, 409, { error: 'Another editor saved first. Your draft is kept in this browser. Download it before reloading.' });
        }
        if (req.method === 'GET' && kind === 'selections' && selectionId && SHARE_ID.test(selectionId)) {
          const selection = readJSON(join(directory, 'selections', `${selectionId}.json`), null);
          return selection ? respond(res, 200, selection) : respond(res, 404, { error: 'Unknown selection' });
        }
        if (req.method === 'POST' && kind === 'selections' && !selectionId) {
          const selection = saveSelection(directory, await body(req));
          return selection ? respond(res, 201, selection) : respond(res, 409, { error: 'The board changed; reload before sharing' });
        }
        return respond(res, 405, { error: 'Method not allowed' });
      }
      if (req.method !== 'GET') return respond(res, 404, { error: 'Not found' });
      const board = /^\/p\/([a-f0-9]{24})\/?$/.exec(path);
      if (board && !existsSync(join(home, 'projects', board[1], 'project.json'))) return respond(res, 404, { error: 'Unknown project' });
      const relative = board ? 'index.html' : path.slice(1);
      const root = realpathSync(dist);
      const target = resolve(root, relative);
      if (!target.startsWith(root + sep) || !existsSync(target) || !realpathSync(target).startsWith(root + sep) || !statSync(target).isFile()) return respond(res, 404, { error: 'Not found' });
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
      respond(res, 200, readFileSync(target), types[extname(target)] || 'application/octet-stream');
    } catch (error) {
      respond(res, error.status || 400, { error: error.code === 'ENOENT' ? 'Not found' : error.message });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(port, host);
  server.canvasStartedAt = startedAt;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [host, port = '43827'] = process.argv.slice(2);
  if (!/^100\.(?:6[4-9]|[7-9]\d|1\d\d)\./.test(host || '') || !host.split('.').every(part => Number.isInteger(+part) && +part >= 0 && +part <= 255) || +host.split('.')[1] > 127) throw new Error('Refusing a non-Tailscale bind address');
  const server = createCanvasServer({ host, port: Number(port) });
  server.on('listening', () => atomicJSON(join(DATA_HOME, 'service.json'), { pid: process.pid, host, port: server.address().port, startedAt: server.canvasStartedAt }));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(); });
}
