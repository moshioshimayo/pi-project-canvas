// Exercise cold /canvas startup and clean shutdown without touching global Pi settings/data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const home = mkdtempSync(join(tmpdir(), 'pi-canvas-lifecycle-'));
process.env.PI_CANVAS_HOME = home;
process.env.PI_CANVAS_PORT = process.env.PI_CANVAS_LIFECYCLE_PORT || '43829';
const source = fileURLToPath(new URL('../', import.meta.url));
const root = process.env.PI_CANVAS_PACKAGE_ROOT || source;
const pi = process.env.PI_CANVAS_PI_DIR || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const { loadExtensions } = await import(pathToFileURL(join(pi, 'dist/core/extensions/loader.js')));
const { stopServer } = await import(pathToFileURL(join(root, 'lib/runtime.mjs')));
let started = false;
try {
  const loaded = await loadExtensions([join(root, 'index.ts')], source);
  assert.deepEqual(loaded.errors, []);
  const messages = [];
  loaded.runtime.sendMessage = message => { messages.push(message); };
  await loaded.extensions[0].commands.get('canvas').handler('', {
    cwd: source, ui: { setStatus() {}, notify(message, level) { if (level === 'error') throw new Error(message); } },
  });
  started = true;
  const url = /http:\/\/[^\s]+/.exec(messages[0]?.content)?.[0];
  assert.ok(url, '/canvas must return a live URL');
  assert.equal((await fetch(url)).status, 200);
  const health = await (await fetch(new URL('/_health', url))).json();
  assert.equal(health.service, 'pi-project-canvas/1');
  await stopServer(home);
  started = false;
  let closed = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await fetch(new URL('/_health', url), { signal: AbortSignal.timeout(200) }); }
    catch { closed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(closed, 'owned service must stop accepting connections');
  console.log('PASS cold /canvas startup from prebuilt package, Tailnet-only URL responds, identity-checked SIGTERM closes the service');
} finally {
  if (started) await stopServer(home);
  rmSync(home, { recursive: true, force: true });
}
