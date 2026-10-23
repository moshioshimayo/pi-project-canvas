import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./style.css";

// Font URLs are registered when the SDK module initializes, before React renders.
window.EXCALIDRAW_ASSET_PATH = new URL(
  "/excalidraw-assets/",
  location.origin,
).href;
const {
  Excalidraw,
  MainMenu,
  exportToCanvas,
  getCommonBounds,
  convertToExcalidrawElements,
} = await import("@excalidraw/excalidraw");

const project = /^\/p\/([a-f0-9]{24})\/?$/.exec(location.pathname)?.[1];
const endpoint = `/api/${project}`;
async function request(path, method = "GET", data) {
  const response = await fetch(`${endpoint}/${path}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}
const signature = (elements, files) =>
  JSON.stringify([
    elements.map((e) => [e.id, e.version, e.versionNonce, e.isDeleted]),
    Object.keys(files).sort(),
  ]);

function App({ initial }) {
  const [api, setAPI] = useState(null);
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [link, setLink] = useState("");
  const [selected, setSelected] = useState(0);
  const [commenting, setCommenting] = useState(false);
  const [hasElements, setHasElements] = useState(
    initial.elements.some((element) => !element.isDeleted),
  );
  const [capture, setCapture] = useState(null);
  const [showCapture, setShowCapture] = useState(false);
  const [sharing, setSharing] = useState(false);
  const linkInput = useRef(null);
  const captureDialog = useRef(null);
  const state = useRef({
    revision: initial.revision,
    elements: initial.elements,
    files: initial.files,
    signature: "",
    generation: 0,
    saved: 0,
    ready: false,
    saving: null,
    failed: false,
    timer: null,
  });

  async function flush() {
    const s = state.current;
    if (s.saving) {
      await s.saving;
      return flush();
    }
    if (s.failed)
      throw new Error(
        "Save is blocked. Download your draft before reloading the board.",
      );
    if (s.generation === s.saved) return;
    const generation = s.generation;
    setStatus("Saving…");
    s.saving = request("scene", "PUT", {
      revision: s.revision,
      elements: s.elements,
      files: s.files,
    })
      .then((result) => {
        s.revision = result.revision;
        s.saved = generation;
        setStatus("Saved");
      })
      .catch((error) => {
        s.failed = true;
        setError(error.message);
        setStatus("Not saved");
        throw error;
      })
      .finally(() => {
        s.saving = null;
      });
    await s.saving;
    if (s.saved !== s.generation) return flush();
  }

  function onChange(elements, appState, files) {
    setSelected(
      Object.values(appState.selectedElementIds).filter(Boolean).length,
    );
    setCommenting(appState.activeTool.type === "text");
    setHasElements(elements.some((element) => !element.isDeleted));
    const s = state.current;
    if (!s.ready) return;
    const next = signature(elements, files);
    if (s.signature === next) return;
    s.signature = next;
    s.elements = elements;
    s.files = files;
    s.generation++;
    setStatus("Unsaved");
    clearTimeout(s.timer);
    if (!s.failed) s.timer = setTimeout(() => flush().catch(() => {}), 450);
  }

  useEffect(() => {
    if (!api) return;
    const s = state.current;
    s.elements = api.getSceneElementsIncludingDeleted();
    s.files = api.getFiles();
    s.signature = signature(s.elements, s.files);
    s.ready = true;
    const query = new URL(location.href).searchParams;
    const selection = query.get("selection"),
      entry = query.get("entry");
    if (selection && entry)
      setError("A link must refer to one selection or one agent post");
    else if (selection || entry)
      request(
        `${entry ? "posts" : "selections"}/${encodeURIComponent(entry || selection)}`,
      )
        .then((saved) => {
          setCapture({ ...saved, kind: entry ? "post" : "selection" });
          const live = api
            .getSceneElements()
            .filter((element) => saved.elementIds.includes(element.id));
          api.scrollToContent(
            entry && live.length
              ? live
              : convertToExcalidrawElements([
                  { type: "rectangle", ...saved.bounds },
                ]),
            { fitToViewport: true, viewportZoomFactor: 0.8 },
          );
        })
        .catch((error) => setError(error.message));
    const beforeUnload = (event) => {
      if (s.generation !== s.saved) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      clearTimeout(s.timer);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [api]);

  function downloadDraft() {
    const s = state.current;
    const blob = new Blob(
      [
        JSON.stringify({
          type: "excalidraw",
          version: 2,
          source: "pi-project-canvas",
          elements: s.elements,
          appState: {},
          files: s.files,
        }),
      ],
      { type: "application/json" },
    );
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${initial.project.name}-draft.excalidraw`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function addComment() {
    api.setActiveTool({ type: "text" });
    setStatus(
      "Click the diagram and type your comment. Press Esc to finish; double-click to edit.",
    );
  }

  async function share(wholeDiagram = false) {
    if (!api || sharing) return;
    setSharing(true);
    try {
      await flush();
      const appState = api.getAppState();
      const elements = api.getSceneElements();
      const chosen = wholeDiagram
        ? elements
        : elements.filter((element) => appState.selectedElementIds[element.id]);
      if (!chosen.length)
        throw new Error("Select an image, annotation or rectangle first.");
      const [x1, y1, x2, y2] = getCommonBounds(chosen);
      const bounds = {
        x: x1 - 16,
        y: y1 - 16,
        width: x2 - x1 + 32,
        height: y2 - y1 + 32,
      };
      const visible = elements.filter((element) => {
        const [left, top, right, bottom] = getCommonBounds([element]);
        return (
          left < bounds.x + bounds.width &&
          right > bounds.x &&
          top < bounds.y + bounds.height &&
          bottom > bounds.y
        );
      });
      const [left, top, right, bottom] = getCommonBounds(visible);
      const rendered = await exportToCanvas({
        elements: visible,
        files: api.getFiles(),
        appState: {
          ...appState,
          exportBackground: true,
          exportWithDarkMode: false,
          viewBackgroundColor: "#ffffff",
        },
        exportPadding: 0,
        maxWidthOrHeight: 4096,
      });
      const scaleX = rendered.width / Math.max(1, right - left);
      const scaleY = rendered.height / Math.max(1, bottom - top);
      const sx = Math.max(0, (bounds.x - left) * scaleX),
        sy = Math.max(0, (bounds.y - top) * scaleY);
      const width = Math.min(rendered.width - sx, bounds.width * scaleX),
        height = Math.min(rendered.height - sy, bounds.height * scaleY);
      if (width <= 0 || height <= 0)
        throw new Error("Selection has no visible area");
      const crop = document.createElement("canvas");
      crop.width = Math.max(1, Math.ceil(width));
      crop.height = Math.max(1, Math.ceil(height));
      crop
        .getContext("2d")
        .drawImage(
          rendered,
          sx,
          sy,
          width,
          height,
          0,
          0,
          crop.width,
          crop.height,
        );
      const saved = await request("selections", "POST", {
        revision: state.current.revision,
        bounds,
        elementIds: chosen.map((element) => element.id),
        note,
        image: crop.toDataURL("image/png"),
      });
      const url = new URL(location.href);
      url.search = "";
      url.searchParams.set("selection", saved.id);
      setLink(url.href);
      setCapture(saved);
      setStatus("Selection saved — copy its link below");
    } catch (error) {
      setError(error.message);
    } finally {
      setSharing(false);
    }
  }

  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext)
        await navigator.clipboard.writeText(link);
      else {
        linkInput.current.focus();
        linkInput.current.select();
        if (!document.execCommand("copy")) throw new Error();
      }
      setStatus("Link copied — paste it into Pi");
    } catch {
      linkInput.current.focus();
      linkInput.current.select();
      setStatus("Link selected — press ⌘C / Ctrl+C");
    }
  }

  return (
    <div className="app">
      <header>
        <div className="heading">
          <strong>{initial.project.name}</strong>
          <span>Project canvas · Tailnet only</span>
        </div>
        <span className="status" role="status">
          {status}
        </span>
        {initial.posts?.length > 0 && (
          <select
            aria-label="Agent reviews"
            defaultValue={
              new URL(location.href).searchParams.get("entry") || ""
            }
            onChange={(event) => {
              if (!event.target.value) return;
              const url = new URL(location.href);
              url.search = "";
              url.searchParams.set("entry", event.target.value);
              location.assign(url.href);
            }}
          >
            <option value="">Agent reviews ({initial.posts.length})</option>
            {[...initial.posts].reverse().map((post) => (
              <option key={post.id} value={post.id}>
                {post.title}
              </option>
            ))}
          </select>
        )}
        <button onClick={downloadDraft}>Download draft</button>
        <button
          onClick={() => {
            if (
              state.current.generation === state.current.saved ||
              confirm(
                "Discard unsaved changes? Download your draft first to keep them.",
              )
            )
              location.reload();
          }}
        >
          Reload board
        </button>
        <button
          disabled={!api || sharing}
          aria-pressed={commenting}
          onClick={addComment}
        >
          Add comment
        </button>
        <div className="share-controls">
          <input
            aria-label="Selection note"
            value={note}
            maxLength={4000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional share note"
          />
          <button disabled={!selected || sharing} onClick={() => share()}>
            {sharing
              ? "Saving…"
              : `Share selection${selected ? ` (${selected})` : ""}`}
          </button>
          <button
            className="primary"
            disabled={!hasElements || sharing}
            onClick={() => share(true)}
          >
            Share diagram
          </button>
        </div>
      </header>
      {error && (
        <div className="error" role="alert">
          {error} <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {link && (
        <div className="link-row">
          <input
            ref={linkInput}
            aria-label="Selection link"
            readOnly
            value={link}
          />
          <button onClick={copy}>Copy link</button>
        </div>
      )}
      {capture && (
        <div className="capture-row">
          <span>
            {capture.kind === "post"
              ? `Agent review · ${capture.title}`
              : `Saved selection · ${capture.note || "No note"}`}{" "}
            · {new Date(capture.createdAt).toLocaleString()}
          </span>
          <button onClick={() => setShowCapture(true)}>
            {capture.kind === "post"
              ? "View original content"
              : "View saved capture"}
          </button>
        </div>
      )}
      <main>
        <Excalidraw
          excalidrawAPI={setAPI}
          initialData={{
            elements: initial.elements,
            files: initial.files,
            appState: { viewBackgroundColor: "#ffffff" },
            scrollToContent: true,
          }}
          onChange={onChange}
          validateEmbeddable={() => false}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              export: false,
            },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
        {!hasElements && (
          <p className="hint">
            Drop a PNG, JPEG or WebP here. Use Add comment, click anywhere and
            type. Share the diagram or select an area to share with Pi.
          </p>
        )}
      </main>
      {showCapture && (
        <dialog
          className="capture-dialog"
          ref={(node) => {
            captureDialog.current = node;
            if (node && !node.open) node.showModal();
          }}
          onClose={() => setShowCapture(false)}
          aria-label={
            capture.kind === "post"
              ? "Original agent review"
              : "Saved selection capture"
          }
        >
          <button autoFocus onClick={() => captureDialog.current.close()}>
            Back to live board
          </button>
          {capture.title && <h2>{capture.title}</h2>}
          {capture.text && <pre>{capture.text}</pre>}
          {capture.note && <p>{capture.note}</p>}
          {capture.image && (
            <img
              src={capture.image}
              alt={
                capture.kind === "post"
                  ? "Agent-supplied review image"
                  : "Immutable annotated selection"
              }
            />
          )}
          <p>
            {capture.kind === "post"
              ? "Agent-supplied original. Comments and drawings are not approval for protected actions."
              : "Saved capture. The live board may have changed."}{" "}
            · {new Date(capture.createdAt).toLocaleString()}
          </p>
        </dialog>
      )}
    </div>
  );
}

if (!project)
  document.getElementById("root").textContent =
    "Open a project link from /canvas in Pi.";
else
  request("scene")
    .then((initial) =>
      createRoot(document.getElementById("root")).render(
        <App initial={initial} />,
      ),
    )
    .catch((error) => {
      document.getElementById("root").textContent =
        `Could not load canvas: ${error.message}`;
    });
