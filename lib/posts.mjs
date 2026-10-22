import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicJSON, decodeImage, nextScene, sceneAt } from './store.mjs';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function wrap(text) {
  return text.split('\n').map(line => {
    const chars = [...graphemes.segment(line)].map(part => part.segment);
    const lines = [];
    for (let i = 0; i < chars.length; i += 56) lines.push(chars.slice(i, i + 56).join(''));
    return lines.join('\n');
  }).join('\n');
}

// Called only inside the shared server: no multi-process read/modify/write from Pi sessions.
export function appendPost(directory, input) {
  if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160) throw new Error('A title of 1–160 characters is required');
  if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 6000)) throw new Error('Text must be at most 6000 characters');
  let image;
  if (input.image !== undefined) {
    image = decodeImage(input.image);
    // ponytail: native PNG IHDR supplies dimensions; add a bundled decoder if JPEG/WebP posting is needed.
    if (image.mimeType !== 'image/png') throw new Error('Agent image posts currently require PNG; browser uploads also support JPEG/WebP');
  }
  const current = sceneAt(directory);
  const id = randomUUID(), timestamp = Date.now();
  const live = current.elements.filter(element => !element.isDeleted);
  const y = Math.ceil(Math.max(0, ...live.map(element => element.y + element.height / 2 + Math.hypot(element.width, element.height) / 2))) + 80;
  if (y > 95000) throw new Error('Board layout is full; move existing content before appending another review');
  const elements = [];
  let top = y;
  const base = type => ({
    id: randomUUID(), type, x: 0, y: top, width: 640, height: 30, angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1,
    strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [id], frameId: null,
    roundness: null, seed: randomInt(2147483647), version: 1, versionNonce: randomInt(2147483647),
    isDeleted: false, boundElements: null, updated: timestamp, link: null, locked: false,
  });
  function textElement(value, fontSize) {
    const text = wrap(value);
    const height = Math.max(1, text.split('\n').length) * fontSize * 1.25;
    const element = { ...base('text'), text, originalText: value, height, fontSize, fontFamily: 2, lineHeight: 1.25, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: false };
    elements.push(element); top += height + 20;
  }
  textElement(`Agent review: ${input.title}`, 22);
  if (input.text) textElement(input.text, 18);
  const files = { ...current.files };
  let assetId;
  if (image) {
    assetId = `agent-${id}`;
    files[assetId] = { id: assetId, mimeType: 'image/png', dataURL: input.image, created: timestamp };
    const scale = Math.min(1, 640 / image.width, 1000 / image.height);
    const element = { ...base('image'), width: image.width * scale, height: image.height * scale, fileId: assetId, status: 'saved', scale: [1, 1], crop: null };
    elements.push(element); top += element.height + 20;
  }
  const post = { id, title: input.title, text: input.text || '', createdAt: new Date(timestamp).toISOString(), source: 'agent', elementIds: elements.map(element => element.id), bounds: { x: 0, y, width: 640, height: top - y }, assetId, ...(image ? { image: input.image } : {}) };
  const posts = [...(current.posts || []), { id, title: post.title, createdAt: post.createdAt }].slice(-100);
  const next = nextScene({ ...current, posts }, { revision: current.revision, elements: [...current.elements, ...elements], files });
  // Same durable-reference pattern as saved selections. An interrupted write can leave an unlisted post,
  // but never replaces or deletes the user's existing elements or files.
  atomicJSON(join(directory, 'posts', `${id}.json`), post);
  atomicJSON(join(directory, 'scene.json'), next);
  return post;
}
