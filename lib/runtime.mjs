import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_HOME, readJSON } from './store.mjs';
import { SERVICE } from './server.mjs';
const exec = promisify(execFile);

export async function tailscaleIP() {
  const candidates = [process.env.PI_CANVAS_TAILSCALE, 'tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'].filter(Boolean);
  for (const command of candidates) {
    try {
      const { stdout } = await exec(command, ['ip', '-4'], { timeout: 5000, maxBuffer: 4096 });
      const ip = stdout.trim();
      const parts = ip.split('.').map(Number);
      if (parts.length === 4 && parts.every(Number.isInteger) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127 && parts.every(n => n >= 0 && n <= 255)) return ip;
    } catch { /* Try the platform's other documented CLI location. */ }
  }
  throw new Error('Tailscale must be installed and connected. Put tailscale on PATH, or set PI_CANVAS_TAILSCALE to its executable path.');
}

export async function stopServer(home = DATA_HOME) {
  const record = readJSON(join(home, 'service.json'), null);
  if (!record) throw new Error('No owned canvas service is recorded');
  const response = await fetch(`http://${record.host}:${record.port}/_health`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  const actual = await response.json();
  if (actual.service !== SERVICE || actual.home !== realpathSync(home) || actual.pid !== record.pid || actual.startedAt !== record.startedAt) throw new Error('Service identity changed; refusing to stop an unrelated process');
  process.kill(record.pid, 'SIGTERM');
}

export async function ensureServer(home = DATA_HOME) {
  const host = await tailscaleIP();
  const port = Number(process.env.PI_CANVAS_PORT || 43827);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PI_CANVAS_PORT must be between 1024 and 65535');
  const base = `http://${host}:${port}`;
  const healthy = async () => {
    try {
      const response = await fetch(`${base}/_health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      const data = await response.json();
      if (data.service !== SERVICE || data.home !== realpathSync(home)) throw new Error(`Port ${port} belongs to another service or data directory. Set PI_CANVAS_PORT to an unused port.`);
      return true;
    } catch (error) {
      if (error.message.includes('belongs to')) throw error;
      return false;
    }
  };
  if (await healthy()) return base;
  if (!existsSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)))) throw new Error('Canvas UI is missing. Run npm run build in the package first.');
  const log = openSync(join(home, 'server.log'), 'a', 0o600);
  // Project-shared service, intentionally independent of any one Pi session's lifetime.
  const child = spawn(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('./server.mjs', import.meta.url)), host, String(port)], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, PI_CANVAS_HOME: home }, windowsHide: true,
  });
  closeSync(log);
  let failure;
  child.on('error', error => { failure = error; });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt++) {
    if (failure) throw failure;
    if (await healthy()) return base;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Canvas could not bind to ${host}:${port}. Check ${join(home, 'server.log')}. No LAN/public fallback was started.`);
}
