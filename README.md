# Pi project canvas

A portable Pi extension: drop screenshots onto an Excalidraw board, annotate them, and give the agent a link to the exact selection. One board per project, shared by its worktrees. Tailscale is the only external service prerequisite; no cloud account or SDK license key.

## Install

Requires a current Pi installation (tested with Pi 1.2.0), Node 22+, and Tailscale installed **and connected** on the host and the viewing device.

Install the built package folder:

```sh
pi install /absolute/path/to/pi-project-canvas
```

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

The Pi host provides its SDK imports. Dependencies are build-only; the server uses Node's standard library. Built files are included in `npm pack` output. This repository/package has not been published to npm.

## Use

1. Drag a PNG, JPEG or WebP onto the board, or use Insert image.
2. Draw rectangles, arrows, freehand marks or text.
3. Select an annotation or region. Add an optional note in the top bar.
4. Click **Share selection**, then **Copy link**. Paste the link into Pi.
5. The agent calls `canvas_read` with the link. It receives the saved annotated crop, note and original image IDs. It can request an original with `asset` (include the selection for its immutable original).

A share freezes the capture, note and associated original images. Its link remains useful even after the live board changes. Opening the link focuses the region; **View saved capture** shows exactly what was shared. Sharing does not itself send a message to an agent or execute the board's text.

`canvas_read` without arguments lists recent selections and uploaded image IDs. Saved-board context is supplied to future turns in the same project. Worktrees share a canonical main-worktree identity; nested `.worktrees/` copy-on-write checkouts and symlinked project paths also resolve to the parent project. Ordinary folders work too, with identity based on their real absolute path.

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

Only explicitly uploaded files and drawing data are served. Your source tree, `.env` files and arbitrary filesystem paths are not exposed. Cross-origin requests, unexpected Host headers, web embeds, SVG uploads and non-image uploads are refused. A restrictive CSP blocks external network connections; UI code and fonts are bundled locally. Excalidraw may register its own CDN fallbacks; CSP prevents using external fallbacks.

The extension itself does not upload screenshots to an AI provider. Calling `canvas_read` includes the requested image in **your current Pi model conversation**, just like attaching a screenshot. Notes and images are untrusted reference material, not authorization or executable instructions.

## Small-version limits

- Images: at most 8 MiB each. Board snapshots/requests: at most 24 MiB.
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
