import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { ensureProject, sceneAt, decodeImage, atomicJSON } from '../lib/store.mjs';
import { stopServer } from '../lib/runtime.mjs';
import { createCanvasServer } from '../lib/server.mjs';
import { fileURLToPath } from 'node:url';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5RYAAAAASUVORK5CYII=';
const element = { id: 'box', type: 'rectangle', x: 2, y: 3, width: 20, height: 30, angle: 0, version: 1 };

test('project identity is shared across subfolders, symlinks and real/nested worktrees', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-canvas-project-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  const home = join(directory, 'data');
  const project = ensureProject(root, home);
  const alias = join(directory, 'alias'); symlinkSync(root, alias, 'junction');
  assert.equal(ensureProject(alias, home).id, project.id);
  mkdirSync(join(root, 'src'));
  assert.equal(ensureProject(join(root, 'src'), home).id, project.id);
  const linked = join(root, '.worktrees', 'linked');
  git('worktree', 'add', '-b', 'linked', linked);
  assert.equal(ensureProject(linked, home).id, project.id);
  const clone = join(root, '.worktrees', 'clone');
  execFileSync('git', ['clone', '--local', root, clone], { stdio: 'ignore' });
  assert.equal(ensureProject(clone, home).id, project.id);
  const other = join(directory, 'other'); mkdirSync(other);
  assert.notEqual(ensureProject(other, home).id, project.id);
});

test('HTTP board saves persist, reject stale writes and freeze shared captures/originals', async t => {
  const home = mkdtempSync(join(tmpdir(), 'pi-canvas-http-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'repo'); mkdirSync(root);
  const project = ensureProject(root, home);
  const dist = join(home, 'dist'); mkdirSync(dist); writeFileSync(join(dist, 'index.html'), '<h1>fixture</h1>');
  const server = createCanvasServer({ home, host: '127.0.0.1', port: 0, dist });
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (path, method = 'GET', value) => fetch(`${base}/api/${project.id}/${path}`, { method, headers: value ? { 'Content-Type': 'application/json' } : {}, body: value ? JSON.stringify(value) : undefined });
  assert.equal((await fetch(`${base}/p/${project.id}/`)).status, 200);
  assert.equal((await api('scene')).status, 200);
  assert.equal((await (await api('scene')).json()).revision, 0);
  const files = { original: { id: 'original', mimeType: 'image/png', dataURL: PNG, created: 1 } };
  const image = { ...element, id: 'image', type: 'image', fileId: 'original' };
  const input = { revision: 0, elements: [image, element, { ...element, id: 'note', type: 'text', text: 'Inspect this region' }], files };
  assert.equal((await api('scene', 'PUT', input)).status, 200);
  assert.equal((await api('scene', 'PUT', input)).status, 409);
  const response = await api('selections', 'POST', { revision: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, elementIds: ['box'], note: 'The screenshot is wrong', image: PNG });
  assert.equal(response.status, 201);
  const selection = await response.json();
  assert.equal(selection.texts, 'Inspect this region');
  assert.equal(selection.files.original.dataURL, PNG);
  assert.equal((await api('scene', 'PUT', { revision: 1, elements: [], files: {} })).status, 200);
  const frozen = await (await api(`selections/${selection.id}`)).json();
  assert.equal(frozen.image, PNG);
  assert.equal(frozen.files.original.dataURL, PNG);
  assert.equal(sceneAt(project.directory).shares[0].id, selection.id);
  assert.equal(JSON.parse(readFileSync(join(project.directory, 'scene.json'))).revision, 2);
  assert.equal((await fetch(`${base}/api/${project.id}/scene`, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await fetch(`${base}/api/${project.id}/scene`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await api('scene', 'PUT', { revision: 2, elements: [{ ...element, type: 'iframe' }], files: {} })).status, 400);
  assert.equal((await api('scene', 'PUT', { revision: 2, elements: [], files: { bad: { id: 'bad', mimeType: 'image/svg+xml', dataURL: 'data:image/svg+xml;base64,PHN2Zz4=' } } })).status, 400);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
  assert.equal((await fetch(`${base}/api/000000000000000000000000/scene`)).status, 404);
  // Append two agent reviews; never replace drawings, originals, or another agent's post.
  const previous = await (await api('scene')).json();
  assert.equal((await api('scene', 'PUT', { ...input, revision: previous.revision })).status, 200);
  const before = await (await api('scene')).json();
  assert.ok(before.elements.length > 0 && Object.keys(before.files).length > 0);
  const payload = { title: '  Layout review 👩🏽‍💻  ', text: 'Line one\n\n  Indented second line\n<script>reference only</script>', image: PNG };
  const responses = await Promise.all([api('posts', 'POST', payload), api('posts', 'POST', { title: 'Text-only alternative', text: 'Please compare these options.' })]);
  assert.deepEqual(responses.map(response => response.status), [201, 201]);
  const posts = await Promise.all(responses.map(response => response.json()));
  const after = await (await api('scene')).json();
  assert.equal(after.revision, before.revision + 2);
  assert.equal(after.posts.length, 2);
  assert.deepEqual(after.elements.slice(0, before.elements.length), before.elements);
  assert.deepEqual(Object.fromEntries(Object.keys(before.files).map(id => [id, after.files[id]])), before.files);
  assert.equal((await api('scene', 'PUT', { revision: before.revision, elements: [], files: {} })).status, 409);
  const original = await (await api(`posts/${posts[0].id}`)).json();
  assert.equal(original.title, payload.title);
  assert.equal(original.text, payload.text);
  assert.equal(original.image, PNG);
  assert.ok(after.elements.some(element => element.type === 'text' && element.originalText === payload.text));
  assert.ok(after.elements.some(element => element.type === 'image' && element.fileId === original.assetId));
  assert.equal((await api('scene', 'PUT', { revision: after.revision, elements: [], files: {} })).status, 200);
  assert.equal((await (await api(`posts/${posts[0].id}`)).json()).image, PNG, 'agent original survives human removal from the live board');
  assert.equal((await (await api('scene')).json()).posts.length, 2);
  assert.equal((await api('posts', 'POST', { title: ' '.repeat(3) })).status, 400);
  assert.equal((await api('posts', 'POST', { title: 'Bad', text: 'a'.repeat(6001) })).status, 400);
  assert.equal((await fetch(`${base}/api/${project.id}/posts`, { method: 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status, 403);
  const health = await (await fetch(`${base}/_health`)).json();
  const kill = t.mock.method(process, 'kill', () => true);
  atomicJSON(join(home, 'service.json'), { host: '127.0.0.1', port: server.address().port, pid: process.pid + 1, startedAt: health.startedAt });
  await assert.rejects(() => stopServer(home), /identity changed/);
  assert.equal(kill.mock.callCount(), 0, 'must never signal an unrelated/stale PID');
  atomicJSON(join(home, 'service.json'), { host: '127.0.0.1', port: server.address().port, pid: process.pid, startedAt: health.startedAt });
  await stopServer(home);
  assert.deepEqual(kill.mock.calls[0].arguments, [process.pid, 'SIGTERM']);
});

test('CLI refuses public or malformed numeric bind addresses before starting a service', () => {
  const server = fileURLToPath(new URL('../lib/server.mjs', import.meta.url));
  for (const host of ['0.0.0.0', '127.0.0.1', '100.70.0.1.2', '100.128.0.1']) {
    assert.throws(() => execFileSync(process.execPath, [server, host, '43827'], { stdio: 'pipe' }), /Refusing a non-Tailscale/);
  }
});

test('image trust boundary rejects mismatched content and SVG', () => {
  assert.equal(decodeImage(PNG).mimeType, 'image/png');
  assert.throws(() => decodeImage(PNG.replace('image/png', 'image/jpeg')), /does not match/);
  assert.throws(() => decodeImage('data:image/svg+xml;base64,PHN2Zz4='), /Only PNG/);
  assert.throws(() => decodeImage('data:image/png;base64,YWJj'), /does not match/);
  const bomb = Buffer.from(PNG.split(',')[1], 'base64');
  bomb.writeUInt32BE(32768, 16); bomb.writeUInt32BE(32768, 20);
  assert.throws(() => decodeImage(`data:image/png;base64,${bomb.toString('base64')}`), /32-megapixel/);
  const partial = Buffer.from(PNG.split(',')[1], 'base64').subarray(0, 30);
  assert.throws(() => decodeImage(`data:image/png;base64,${partial.toString('base64')}`), /Incomplete/);
});
