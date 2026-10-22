import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@excalidraw/excalidraw/index.css';
import './style.css';

// Font URLs are registered when the SDK module initializes, before React renders.
window.EXCALIDRAW_ASSET_PATH = new URL('/excalidraw-assets/', location.origin).href;
const { Excalidraw, MainMenu, exportToCanvas, getCommonBounds, convertToExcalidrawElements } = await import('@excalidraw/excalidraw');

const project = /^\/p\/([a-f0-9]{24})\/?$/.exec(location.pathname)?.[1];
const endpoint = `/api/${project}`;
async function request(path, method = 'GET', data) {
  const response = await fetch(`${endpoint}/${path}`, {
    method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}
const signature = (elements, files) => JSON.stringify([elements.map(e => [e.id, e.version, e.versionNonce, e.isDeleted]), Object.keys(files).sort()]);

function App({ initial }) {
  const [api, setAPI] = useState(null);
  const [status, setStatus] = useState('Saved');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [link, setLink] = useState('');
  const [selected, setSelected] = useState(0);
  const [hasElements, setHasElements] = useState(initial.elements.some(element => !element.isDeleted));
  const [capture, setCapture] = useState(null);
  const [showCapture, setShowCapture] = useState(false);
  const [sharing, setSharing] = useState(false);
  const linkInput = useRef(null);
  const state = useRef({ revision: initial.revision, elements: initial.elements, files: initial.files, signature: '', generation: 0, saved: 0, ready: false, saving: null, failed: false, timer: null });

  async function flush() {
    const s = state.current;
    if (s.saving) { await s.saving; return flush(); }
    if (s.failed) throw new Error('Save is blocked. Download your draft before reloading the board.');
    if (s.generation === s.saved) return;
    const generation = s.generation;
    setStatus('Saving…');
    s.saving = request('scene', 'PUT', { revision: s.revision, elements: s.elements, files: s.files }).then(result => {
      s.revision = result.revision; s.saved = generation; setStatus('Saved');
    }).catch(error => { s.failed = true; setError(error.message); setStatus('Not saved'); throw error; }).finally(() => { s.saving = null; });
    await s.saving;
    if (s.saved !== s.generation) return flush();
  }

  function onChange(elements, appState, files) {
    setSelected(Object.values(appState.selectedElementIds).filter(Boolean).length);
    setHasElements(elements.some(element => !element.isDeleted));
    const s = state.current;
    if (!s.ready) return;
    const next = signature(elements, files);
    if (s.signature === next) return;
    s.signature = next; s.elements = elements; s.files = files; s.generation++;
    setStatus('Unsaved');
    clearTimeout(s.timer);
    if (!s.failed) s.timer = setTimeout(() => flush().catch(() => {}), 450);
  }

  useEffect(() => {
    if (!api) return;
    const s = state.current;
    s.elements = api.getSceneElementsIncludingDeleted(); s.files = api.getFiles();
    s.signature = signature(s.elements, s.files); s.ready = true;
    const selection = new URL(location.href).searchParams.get('selection');
    if (selection) request(`selections/${encodeURIComponent(selection)}`).then(saved => {
      setCapture(saved);
      api.scrollToContent(convertToExcalidrawElements([{ type: 'rectangle', ...saved.bounds }]), { fitToViewport: true, viewportZoomFactor: 0.8 });
    }).catch(error => setError(error.message));
    const beforeUnload = event => {
      if (s.generation !== s.saved) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { clearTimeout(s.timer); window.removeEventListener('beforeunload', beforeUnload); };
  }, [api]);

  function downloadDraft() {
    const s = state.current;
    const blob = new Blob([JSON.stringify({ type: 'excalidraw', version: 2, source: 'pi-project-canvas', elements: s.elements, appState: {}, files: s.files })], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = href; anchor.download = `${initial.project.name}-draft.excalidraw`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  async function share() {
    if (!api || sharing) return;
    setSharing(true);
    try {
      await flush();
      const appState = api.getAppState();
      const elements = api.getSceneElements();
      const chosen = elements.filter(element => appState.selectedElementIds[element.id]);
      if (!chosen.length) throw new Error('Select an image, annotation or rectangle first.');
      const [x1, y1, x2, y2] = getCommonBounds(chosen);
      const bounds = { x: x1 - 16, y: y1 - 16, width: x2 - x1 + 32, height: y2 - y1 + 32 };
      const visible = elements.filter(element => {
        const [left, top, right, bottom] = getCommonBounds([element]);
        return left < bounds.x + bounds.width && right > bounds.x && top < bounds.y + bounds.height && bottom > bounds.y;
      });
      const [left, top, right, bottom] = getCommonBounds(visible);
      const rendered = await exportToCanvas({ elements: visible, files: api.getFiles(), appState: { ...appState, exportBackground: true, exportWithDarkMode: false, viewBackgroundColor: '#ffffff' }, exportPadding: 0, maxWidthOrHeight: 4096 });
      const scaleX = rendered.width / Math.max(1, right - left);
      const scaleY = rendered.height / Math.max(1, bottom - top);
      const sx = Math.max(0, (bounds.x - left) * scaleX), sy = Math.max(0, (bounds.y - top) * scaleY);
      const width = Math.min(rendered.width - sx, bounds.width * scaleX), height = Math.min(rendered.height - sy, bounds.height * scaleY);
      if (width <= 0 || height <= 0) throw new Error('Selection has no visible area');
      const crop = document.createElement('canvas'); crop.width = Math.max(1, Math.ceil(width)); crop.height = Math.max(1, Math.ceil(height));
      crop.getContext('2d').drawImage(rendered, sx, sy, width, height, 0, 0, crop.width, crop.height);
      const saved = await request('selections', 'POST', { revision: state.current.revision, bounds, elementIds: chosen.map(element => element.id), note, image: crop.toDataURL('image/png') });
      const url = new URL(location.href); url.search = ''; url.searchParams.set('selection', saved.id);
      setLink(url.href); setCapture(saved); setStatus('Selection saved — copy its link below');
    } catch (error) { setError(error.message); }
    finally { setSharing(false); }
  }

  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(link);
      else { linkInput.current.focus(); linkInput.current.select(); if (!document.execCommand('copy')) throw new Error(); }
      setStatus('Link copied — paste it into Pi');
    } catch { linkInput.current.focus(); linkInput.current.select(); setStatus('Link selected — press ⌘C / Ctrl+C'); }
  }

  return <div className="app">
    <header>
      <div className="heading"><strong>{initial.project.name}</strong><span>Project canvas · Tailnet only</span></div>
      <span className="status" role="status">{status}</span>
      <button onClick={downloadDraft}>Download draft</button>
      <button onClick={() => { if (state.current.generation === state.current.saved || confirm('Discard unsaved changes? Download your draft first to keep them.')) location.reload(); }}>Reload board</button>
      <div className="share-controls">
        <input aria-label="Selection note" value={note} maxLength={4000} onChange={event => setNote(event.target.value)} placeholder="What should the agent look at?" />
        <button className="primary" disabled={!selected || sharing} onClick={share}>{sharing ? 'Saving selection…' : `Share selection${selected ? ` (${selected})` : ''}`}</button>
      </div>
    </header>
    {error && <div className="error" role="alert">{error} <button onClick={() => setError('')}>Dismiss</button></div>}
    {link && <div className="link-row"><input ref={linkInput} aria-label="Selection link" readOnly value={link} /><button onClick={copy}>Copy link</button></div>}
    {capture && <div className="capture-row"><span>Saved selection · {capture.note || 'No note'} · {new Date(capture.createdAt).toLocaleString()}</span><button onClick={() => setShowCapture(true)}>View saved capture</button></div>}
    <main>
      <Excalidraw excalidrawAPI={setAPI} initialData={{ elements: initial.elements, files: initial.files, appState: { viewBackgroundColor: '#ffffff' }, scrollToContent: true }} onChange={onChange} validateEmbeddable={() => false} UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}>
        <MainMenu><MainMenu.DefaultItems.SaveAsImage /><MainMenu.DefaultItems.ToggleTheme /><MainMenu.DefaultItems.ChangeCanvasBackground /></MainMenu>
      </Excalidraw>
      {!hasElements && <p className="hint">Drop a PNG, JPEG or WebP here. Draw or annotate, select an area, then share its link with Pi.</p>}
    </main>
    {showCapture && <div className="modal" role="dialog" aria-modal="true" aria-label="Saved selection capture"><div><button autoFocus onClick={() => setShowCapture(false)}>Back to live board</button><p>{capture.note}</p><img src={capture.image} alt="Immutable annotated selection" /><p>Captured {new Date(capture.createdAt).toLocaleString()}. The live board may have changed.</p></div></div>}
  </div>;
}

if (!project) document.getElementById('root').textContent = 'Open a project link from /canvas in Pi.';
else request('scene').then(initial => createRoot(document.getElementById('root')).render(<App initial={initial} />)).catch(error => { document.getElementById('root').textContent = `Could not load canvas: ${error.message}`; });
