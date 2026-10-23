# Pi project canvas

A portable Pi extension: drop screenshots onto an Excalidraw board, annotate them, and give the agent a link to the exact selection. Agents can also append screenshots or text for you to review. One board per project, shared by its worktrees. Tailscale is the only external service prerequisite; no cloud account or SDK license key.

## Install

Requires a current Pi installation (tested with Pi 1.2.0), Node 22+, and Tailscale installed **and connected** on the host and the viewing device.

Download the **prebuilt ZIP** from [GitHub Releases](https://github.com/moshioshimayo/pi-project-canvas/releases), extract the `pi-project-canvas` folder, and install that folder:

```sh
pi install /absolute/path/to/pi-project-canvas
```

Use the release ZIP, not GitHub's automatic source-code ZIP, for the no-build install. The prebuilt release contains the bundled UI and fonts; the Git repository intentionally keeps generated assets out of source control.

Then `/reload` in Pi and run:

```text
/canvas
```

Open the printed URL on either Mac. You can also drop the **whole built folder** into `~/.pi/agent/extensions/pi-project-canvas/`; keep `index.ts`, `lib/`, and `dist/` together. No React build or `npm install` is needed on a machine receiving the prebuilt package. Copying just `index.ts` is not sufficient.

To build from source instead:

```sh
npm install --legacy-peer-deps
npm run build
pi install /absolute/path/to/pi-project-canvas
```

The Pi host provides its SDK imports. Dependencies are build-only; the server uses Node's standard library. Built files are included in `npm pack` output. This project is distributed on GitHub; it is not published to npm. Direct `pi install git:...` installs omit development/build dependencies, so build a source checkout first or use the prebuilt release.

## Use

1. Drag a PNG, JPEG or WebP onto the board, or use Insert image.
2. Draw rectangles, arrows, freehand marks or text.
3. Select an annotation or region. Add an optional note in the top bar.
4. Click **Share selection**, then **Copy link**. Paste the link into Pi.
5. The agent calls `canvas_read` with the link. It receives the saved annotated crop, note and original image IDs. It can request an original with `asset` (include the selection for its immutable original).

A share freezes the capture, note and associated original images. Its link remains useful even after the live board changes. Opening the link focuses the region; **View saved capture** shows exactly what was shared. Sharing does not itself send a message to an agent or execute the board's text.

### Agent → human review

Ask your agent to post a screenshot, mockup or question:

```text
canvas_add({
  "title": "Review this menu placement",
  "text": "Does this position work? Annotate the image and share a selection with me.",
  "image_path": "/path/to/screenshot.png"
})
```

`image_path` is optional; text-only posts work too. Paths must resolve inside this project, the current working directory, or a system temporary folder; network paths and unrelated locations are refused. Use the browser's explicit file picker/upload for other locations. Agent images currently support **PNG only**, up to 8 MiB / 32 megapixels, with dimensions read from the PNG itself. The browser still accepts PNG/JPEG/WebP uploads. The title is limited to 160 characters and text to 6000. Original text and images are preserved separately from the editable drawing.

The tool returns a `?entry=...` link. Open it to focus the appended, labelled group; **View original content** shows the immutable reference. The **Agent reviews** selector lets you revisit recent posts. Annotate on the board, then **Share selection** to return exact visual feedback. `canvas_read` accepts the entry link to read its original content, or your new selection link to read current annotated feedback.

Posts are append-only **for the agent**: no tool edits or deletes existing drawings. They go through the shared server so simultaneous agents do not overwrite each other. Human editing remains single-writer: open the new link in a fresh/reloaded board before editing; an older tab's unsaved changes are protected by a conflict error, not silently overwritten. The tool does not automatically reload another browser tab.

Agent labels are descriptive, not authenticated individual identities. Review comments and drawings are not approval for production, spending or destructive actions.

`canvas_read` without arguments lists recent selections, agent review posts and uploaded image IDs. Saved-board context is supplied to future turns in the same project. Worktrees share a canonical main-worktree identity; nested `.worktrees/` copy-on-write checkouts and symlinked project paths also resolve to the parent project. Ordinary folders work too, with identity based on their real absolute path.

## Persistence and lifecycle

- Host storage: `~/.pi/project-canvas/projects/<project-id>/`, outside your repositories.
- `/canvas` starts one small shared service or reuses the existing one. It survives the initiating Pi session exiting.
- `/canvas stop` asks for confirmation, then stops **all** boards on this host. Saved boards stay on disk. `/canvas` starts the service again.
- The default port is `43827`; set `PI_CANVAS_PORT` if it is already in use. Keep the setting consistent across sessions.
- Set `PI_CANVAS_TAILSCALE` to the CLI executable if it is not on PATH. The macOS application CLI is detected automatically.
- `PI_CANVAS_HOME` changes the storage directory (useful for isolated tests).
- Service diagnostics: `<storage directory>/server.log`. No request bodies or images are logged.

One host owns the board. Other machines access it through a browser; this is **not** automatic replication between separate Pi installations on multiple hosts. The original host must remain awake, online and connected to Tailscale.

## Privacy and boundaries

The server binds **only to the host's Tailscale IPv4 address**. It does not listen on LAN/public interfaces, enable Funnel, change Tailscale Serve or request certificates. The URL uses HTTP inside Tailscale's encrypted network. Your existing **Tailscale ACLs control who can connect**: peers permitted to reach this port can access known board URLs. Project namespaces are storage separation, not per-project access controls. There is no extra login or secret URL token.

Only explicitly uploaded files, drawing data, and PNGs explicitly selected by the agent through `canvas_add` are served. Your source tree, `.env` files and arbitrary filesystem paths are not exposed. Cross-origin requests, unexpected Host headers, web embeds, SVG uploads and non-image uploads are refused. A restrictive CSP blocks external network connections; UI code and fonts are bundled locally. Excalidraw may register its own CDN fallbacks; CSP prevents using external fallbacks.

The extension itself does not upload screenshots to an AI provider. `canvas_add` copies the selected PNG into your Tailnet board, never into GitHub. Calling `canvas_read` includes the requested image in **your current Pi model conversation**, just like attaching a screenshot. Notes and images are untrusted reference material, not authorization or executable instructions.

## Small-version limits

- Images: at most 8 MiB each; PNGs are capped at 32 megapixels. Board snapshots/requests: at most 24 MiB.
- An interrupted agent post can leave an unlisted reference; a retried post can create a duplicate. Neither deletes existing drawings. No exactly-once or real-time collaboration service is added.
- Single-writer optimistic saving, **not real-time multiplayer**. If another tab saves first, your write is refused rather than overwriting it. Download your draft before reloading. Unsaved changes remain in the open tab, not durable browser storage.
- Capture rendering is capped at 4096 pixels on its longest side. Read the original when detail matters.
- Automatic cross-host sync, automatic agent notifications, PDFs, hosted sharing, user accounts and per-project ACL management are out of scope.
- Saved selections are retained until you explicitly remove their host storage. There is no automatic deletion/expiry.

## Development and checks

```sh
npm run verify
```

This builds the actual frontend, runs focused native Node tests (project/worktree identity, persistence, stale-write refusal, immutable captures/originals and request/file boundaries), and loads the extension with the installed Pi loader to verify `/canvas`, `canvas_read`, image results and project isolation. Set `PI_CANVAS_PI_DIR` if Pi is not installed under the default global npm location.

The browser acceptance journey is: drop an image → draw an annotation → save/copy a selection link → reopen the link → inspect its saved crop → verify persistence. Test with disposable images; a local Tailnet browser test alone does not prove access from a second physical Mac.

Excalidraw is MIT-licensed. See `THIRD_PARTY_NOTICES.md` and the bundled license files. Official integration references: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration and https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils/export .
