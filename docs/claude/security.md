# Sicurezza — capsuleers.ia

Leggi se tocchi renderer, preload, CSP, `mdToHtml`/`esc()`, fuses, handler IPC distruttivi o che uniscono nomi file, consenso o rete.

Hardened 2026-06-29 — full write-up in [`docs/security-review-2026-06-29.md`](../security-review-2026-06-29.md). **Invariants — don't regress:**

- **Renderer is sandboxed + isolated.** `webPreferences` sets `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` **explicitly** (already the Electron 42 defaults — explicit so a future default change can't silently weaken them). No `<webview>`, no `enableRemoteModule`. A renderer XSS therefore cannot reach Node/native code — only the narrow `preload.cjs` bridge.
- **`esc()` must stay quote-safe.** It encodes `& < > " '`. The `"`/`'` encoding is load-bearing: `esc()`'d values land inside double-quoted attributes (`title="…"`, and the model-answer markdown links built by `mdToHtml`), so dropping the quote escapes reintroduces an **attribute-breakout XSS** (the local model echoes a crafted URL → injected `onmouseover`). The link regexes in `inline()` also exclude `"` from the URL char class as defence in depth.
- **CSP `<meta>` in `renderer/index.html`.** `connect-src 'self'` contains exfiltration (the renderer makes **no** direct network calls — all egress is via IPC → main); `img-src` is pinned to `images.evetech.net`. If you add a renderer-side fetch or a new image CDN, widen **only** the matching directive.
- **Electron fuses** are flipped at pack time via `electronFuses:` in `electron-builder.yml` (inherited by the per-GPU variant configs through `extends`): `runAsNode` / `enableNodeOptionsEnvironmentVariable` / `enableNodeCliInspectArguments` off, `onlyLoadAppFromAsar` on. `enableEmbeddedAsarIntegrityValidation` is deliberately **off** pending a tested Windows build — flip + verify a Windows install before enabling.
- **Destructive bridge actions need a main-side gate.** `data:wipe-all` shows a main-process confirmation `dialog` before wiping (the renderer prompt is advisory). Backed by `wipe*` keys in `MSTR` (it/en).
- **Model-file handlers reject path traversal.** Both `deleteModelFile` and `setModel` require a bare `*.gguf` basename (`^[^/\\]+\.gguf$`) before `path.join(MODELS_DIR, …)`. Keep the guard on any new handler that joins a bridge-supplied filename.
- **No hidden egress.** Generation is 100% local; intel lookups (capsuleers.app, ESI, eve-kill as fallback and for the MCP analytics) are consented — the consent text in `main.mjs` names all three. Don't add telemetry.
