import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';

export const DATA_HOME = process.env.PI_CANVAS_HOME || join(homedir(), '.pi', 'project-canvas');
export const MAX_BYTES = 24 * 1024 * 1024;
export const ID = /^[a-f0-9]{24}$/;
export const SHARE_ID = /^[a-f0-9-]{36}$/;
export const ASSET_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function projectRoot(cwd) {
  const path = realpathSync(cwd);
  try {
    const git = (...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let root = git('worktree', 'list', '--porcelain', '-z').split('\0')[0].replace(/^worktree /, '');
    // cc-worktree also supports nested copy-on-write checkouts, not just linked git worktrees.
    const marker = `${join('', '.worktrees')}/`;
    const index = root.lastIndexOf(`/${marker}`);
    if (index >= 0 && existsSync(join(root.slice(0, index), '.git'))) root = root.slice(0, index);
    return realpathSync(root);
  } catch { return path; }
}

export function atomicJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}

export function ensureProject(cwd, home = DATA_HOME) {
  const root = projectRoot(cwd);
  const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
  const directory = join(home, 'projects', id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const project = { id, name: basename(root), root };
  atomicJSON(join(directory, 'project.json'), project);
  return { ...project, directory };
}

export function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export function sceneAt(directory) {
  return readJSON(join(directory, 'scene.json'), { revision: 0, elements: [], files: {}, shares: [] });
}

export function decodeImage(dataURL) {
  if (typeof dataURL !== 'string') throw new Error('Expected image data');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataURL);
  if (!match) throw new Error('Only PNG, JPEG and WebP images are supported');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('Each image must be between 1 byte and 8 MiB');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!({ 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp }[match[1]])) throw new Error('Image content does not match its type');
  return { mimeType: match[1], bytes };
}

export function saveScene(directory, input) {
  const current = sceneAt(directory);
  if (input.revision !== current.revision) return null;
  if (!Array.isArray(input.elements) || input.elements.length > 10000 || !input.files || typeof input.files !== 'object' || Array.isArray(input.files)) throw new Error('Invalid scene');
  const ids = new Set();
  for (const element of input.elements) {
    if (!element || typeof element.id !== 'string' || ids.has(element.id) || !['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'freedraw', 'text', 'image', 'frame', 'magicframe', 'embeddable', 'iframe'].includes(element.type)) throw new Error('Invalid or duplicate element');
    ids.add(element.id);
    if (![element.x, element.y, element.width, element.height, element.angle].every(Number.isFinite) || Math.max(Math.abs(element.x), Math.abs(element.y), element.width, element.height) > 100000) throw new Error('Invalid element bounds');
    if (['embeddable', 'iframe'].includes(element.type)) throw new Error('Web embeds are disabled');
  }
  if (Object.keys(input.files).length > 200) throw new Error('Maximum 200 images per board');
  for (const [id, file] of Object.entries(input.files)) {
    if (!ASSET_ID.test(id) || !file || file.id !== id) throw new Error('Invalid image ID');
    const image = decodeImage(file.dataURL);
    if (file.mimeType !== image.mimeType) throw new Error('Image MIME type mismatch');
  }
  // ponytail: bounded full snapshots (24 MiB); separate asset storage if boards outgrow this.
  const next = { revision: current.revision + 1, elements: input.elements, files: input.files, shares: current.shares };
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw new Error('Board exceeds 24 MiB; use smaller screenshots');
  atomicJSON(join(directory, 'scene.json'), next);
  return next;
}

export function saveSelection(directory, input) {
  const scene = sceneAt(directory);
  if (input.revision !== scene.revision) return null;
  const { bounds, elementIds, note = '' } = input;
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) || bounds.width <= 0 || bounds.height <= 0 || bounds.width > 100000 || bounds.height > 100000) throw new Error('Invalid selection bounds');
  if (!Array.isArray(elementIds) || !elementIds.length || elementIds.length > 10000 || elementIds.some(id => !scene.elements.some(element => element.id === id && !element.isDeleted))) throw new Error('Select saved elements first');
  if (typeof note !== 'string' || note.length > 4000) throw new Error('Note must be at most 4000 characters');
  const image = decodeImage(input.image);
  if (image.mimeType !== 'image/png') throw new Error('Selection must be PNG');
  const selection = {
    id: randomUUID(), createdAt: new Date().toISOString(), revision: scene.revision,
    bounds, elementIds, note,
    texts: scene.elements.filter(element => !element.isDeleted && element.type === 'text' && element.x < bounds.x + bounds.width && element.x + element.width > bounds.x && element.y < bounds.y + bounds.height && element.y + element.height > bounds.y).map(element => element.text).join('\n').slice(0, 12000),
    assetIds: [...new Set(scene.elements.filter(element => element.type === 'image' && !element.isDeleted && element.x < bounds.x + bounds.width && element.x + element.width > bounds.x && element.y < bounds.y + bounds.height && element.y + element.height > bounds.y).map(element => element.fileId))],
    image: input.image,
  };
  selection.files = Object.fromEntries(selection.assetIds.filter(id => scene.files[id]).map(id => [id, scene.files[id]]));
  atomicJSON(join(directory, 'selections', `${selection.id}.json`), selection);
  scene.shares = [...scene.shares, { id: selection.id, note, createdAt: selection.createdAt }].slice(-100);
  // A share doesn't change the drawing revision, so it cannot invalidate an editor's saved scene.
  atomicJSON(join(directory, 'scene.json'), scene);
  return selection;
}
