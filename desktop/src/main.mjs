// Electron main process: opens the window, initializes the RAG engine,
// and routes questions from the renderer (IPC) with streaming responses.
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, Notification, dialog, screen, clipboard } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { configurePaths, init, ask, resetConversation, shutdown, listModels, setModel, vramState, deleteModelFile } from "./engine.mjs";
import { localIntel, characterDetail } from "./intel.mjs";
import { startWatch, stopWatch, isEnabled, scanNow } from "./clipboard-watch.mjs";
import { statSync } from "node:fs";
import { loadManifest, assetStatus, firstRunTasks, downloadTasks, writeIndexMeta, indexTasks, loadCatalog, installedCatalogIds, modelTask } from "./assets.mjs";
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, "..", "assets");
let win, tray;
let ready = false;
let prevBounds = null;  // window size before mini-mode
let pendingLocal = null;  // last detected Local, awaiting user confirmation
const CONSENT_FILE = () => path.join(app.getPath("userData"), "clipboard-consent.json");

// Main-process strings (tray, dialogs, notifications), localized to the system
// language with the same logic as the renderer: Italian if the locale is it-*,
// otherwise English. M() resolves the dictionary at call time (after app ready).
const MSTR = {
  it: {
    trayShow: "Mostra Capsuleers.IA",
    trayClipboard: (on) => `Intel Local da appunti: ${on ? "ATTIVO ✓" : "spento"}`,
    trayScan: "Scansiona appunti ora", trayQuit: "Esci",
    consentTitle: "Intel Local da appunti",
    consentMsg: "Attivare il rilevamento della Local dagli appunti?",
    consentDetail: "Quando è attivo, Capsuleers.IA controlla il testo che copi (Ctrl+C) e, se " +
      "riconosce una lista di piloti (la Local di EVE), ti chiede se vuoi l'intel.\n\n" +
      "Questo comporta la LETTURA degli appunti mentre la funzione è attiva. Nessun " +
      "dato viene inviato a terzi se non i nomi dei piloti verso eve-kill.com per l'intel. " +
      "Puoi disattivarla in ogni momento dal tray.",
    btnCancel: "Annulla", btnEnable: "Attiva", dontAsk: "Non chiedere più",
    notifTitle: "Rilevata Local di EVE",
    notifBody: (n) => `${n} piloti negli appunti — clicca per l'intel`,
    confirmTitle: "Intel Local",
    confirmMsg: (n) => `Mostrare l'intel per ${n} piloti?`,
    confirmDetail: "I nomi rilevati negli appunti sembrano una Local di EVE.",
    btnNo: "No", btnShowIntel: "Sì, mostra intel",
    noLocalMsg: "Nessuna Local negli appunti.",
    noLocalDetail: "Copia la lista dei piloti dalla finestra Local di EVE (Ctrl+A, Ctrl+C) e riprova.",
    cbDiag: "Diagnosi appunti", cbLines: "righe", cbEmpty: "(appunti vuoti)",
    btnOk: "OK",
    initError: (msg) => `Errore init: ${msg}`,
    updTitle: "Aggiornamento disponibile",
    updMsg: (v) => `La versione ${v} è stata scaricata.`,
    updDetail: "Vuoi riavviare ora per installarla? Puoi anche farlo più tardi: verrà applicata alla prossima chiusura.",
    updLater: "Più tardi", updRestart: "Riavvia e installa",
  },
  en: {
    trayShow: "Show Capsuleers.IA",
    trayClipboard: (on) => `Local intel from clipboard: ${on ? "ON ✓" : "off"}`,
    trayScan: "Scan clipboard now", trayQuit: "Quit",
    consentTitle: "Local intel from clipboard",
    consentMsg: "Enable detecting the Local from the clipboard?",
    consentDetail: "When on, Capsuleers.IA inspects the text you copy (Ctrl+C) and, if it " +
      "recognizes a list of pilots (EVE's Local), asks whether you want the intel.\n\n" +
      "This entails READING the clipboard while the feature is on. No data is sent to " +
      "third parties except the pilot names to eve-kill.com for the intel. " +
      "You can disable it at any time from the tray.",
    btnCancel: "Cancel", btnEnable: "Enable", dontAsk: "Don't ask again",
    notifTitle: "EVE Local detected",
    notifBody: (n) => `${n} pilots in the clipboard — click for intel`,
    confirmTitle: "Local intel",
    confirmMsg: (n) => `Show intel for ${n} pilots?`,
    confirmDetail: "The names detected in the clipboard look like an EVE Local.",
    btnNo: "No", btnShowIntel: "Yes, show intel",
    noLocalMsg: "No Local in the clipboard.",
    noLocalDetail: "Copy the pilot list from EVE's Local window (Ctrl+A, Ctrl+C) and try again.",
    cbDiag: "Clipboard diagnostic", cbLines: "lines", cbEmpty: "(clipboard empty)",
    btnOk: "OK",
    initError: (msg) => `Init error: ${msg}`,
    updTitle: "Update available",
    updMsg: (v) => `Version ${v} has been downloaded.`,
    updDetail: "Restart now to install it? You can also do it later: it will be applied on next quit.",
    updLater: "Later", updRestart: "Restart & install",
  },
};
const M = () => MSTR[(app.getLocale() || "en").toLowerCase().startsWith("it") ? "it" : "en"];

// A 16:9 size that fits within the primary monitor's work area, positioned
// centered on that monitor.
function windowGeometry() {
  const { workArea } = screen.getPrimaryDisplay();  // primary monitor (taskbar excluded)
  let w = Math.min(1280, Math.round(workArea.width * 0.82));
  let h = Math.round(w * 9 / 16);
  if (h > workArea.height * 0.9) { h = Math.round(workArea.height * 0.9); w = Math.round(h * 16 / 9); }
  const x = workArea.x + Math.round((workArea.width - w) / 2);
  const y = workArea.y + Math.round((workArea.height - h) / 2);
  return { x, y, width: w, height: h };
}

function createWindow() {
  const geo = windowGeometry();
  win = new BrowserWindow({
    ...geo,                       // 16:9, centered on the primary monitor
    minWidth: 72, minHeight: 72,
    title: "Capsuleers.IA",
    icon: path.join(ASSETS, "icon-256.png"),
    frame: false,                 // no OS title bar/chrome
    backgroundColor: "#0a0b0d",   // avoid the white flash at startup
    // backgroundThrottling off: while you game (app in the background, maybe on
    // another monitor) the renderer must keep reacting — the Local banner + sound.
    webPreferences: { preload: path.join(HERE, "preload.cjs"), backgroundThrottling: false },
  });
  win.setAspectRatio(16 / 9);     // keep 16:9 while resizing
  win.loadFile(path.join(HERE, "renderer", "index.html"));
  win.on("maximize", () => win.webContents.send("win:state", true));
  win.on("unmaximize", () => win.webContents.send("win:state", false));
  win.on("focus", () => { try { win.flashFrame(false); } catch { /* noop */ } });

  // External links (wiki sources, capsuleers.app) open in the system browser,
  // not inside the app.
  const openExternal = (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { e.preventDefault(); openExternal(url); });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, "tray.png")));
  tray.setToolTip("Capsuleers.IA");
  refreshTrayMenu();
  tray.on("click", () => (win.isVisible() ? win.hide() : showWindow()));
}

// The tray menu includes the clipboard-watch toggle (and shows its state).
function refreshTrayMenu() {
  if (!tray) return;
  const m = M();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: m.trayShow, click: showWindow },
    { type: "separator" },
    { label: m.trayClipboard(isEnabled()), click: toggleClipboardWatch },
    { label: m.trayScan, click: scanClipboardNow },
    { type: "separator" },
    { label: m.trayQuit, click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function showWindow() {
  if (prevBounds) exitMini();  // if it was in mini-mode, restore it
  win.show();
  win.focus();
}

function enterMini() {
  prevBounds = win.getBounds();
  win.setAspectRatio(0);          // the icon is square: no 16:9 constraint
  win.setResizable(true);
  win.setSize(96, 96);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setResizable(false);
  win.webContents.send("win:mini-state", true);
}

function exitMini() {
  win.setResizable(true);
  win.setAlwaysOnTop(false);
  if (prevBounds) { win.setBounds(prevBounds); prevBounds = null; }
  else win.setBounds(windowGeometry());
  win.setAspectRatio(16 / 9);     // restore the 16:9 constraint
  win.webContents.send("win:mini-state", false);
}

// ── Local intel from the clipboard ─────────────────────────────────────────

async function hasClipboardConsent() {
  try { return JSON.parse(await readFile(CONSENT_FILE(), "utf-8"))?.accepted === true; } catch { return false; }
}
async function saveClipboardConsent() {
  try {
    await mkdir(path.dirname(CONSENT_FILE()), { recursive: true });
    await writeFile(CONSENT_FILE(), JSON.stringify({ accepted: true, ts: Date.now() }), "utf-8");
  } catch { /* best-effort */ }
}

// Enable/disable the watch. On first enable, show the privacy notice.
async function toggleClipboardWatch() {
  if (isEnabled()) { stopWatch(); refreshTrayMenu(); return; }
  if (!(await hasClipboardConsent())) {
    const m = M();
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: "info",
      title: m.consentTitle,
      message: m.consentMsg,
      detail: m.consentDetail,
      buttons: [m.btnCancel, m.btnEnable],
      defaultId: 1, cancelId: 0,
      checkboxLabel: m.dontAsk,
      noLink: true,
    });
    if (response !== 1) return;
    if (checkboxChecked) await saveClipboardConsent();
  }
  startWatch(onLocalDetected);
  refreshTrayMenu();
}

// A Local was detected: notify via OS toast (click → confirm), flash the taskbar,
// and ALSO show an in-app banner. Toasts can silently fail on Windows (Focus
// Assist, settings…), so the in-app banner is the reliable path: it's waiting when
// the user switches back to the app.
function onLocalDetected(names) {
  pendingLocal = names;
  if (Notification.isSupported()) {
    const m = M();
    const n = new Notification({ title: m.notifTitle, body: m.notifBody(names.length), silent: false });
    n.on("click", () => confirmLocalIntel(names));
    n.show();
  }
  try { if (!win?.isFocused()) win?.flashFrame(true); } catch { /* best-effort */ }
  if (!win?.isDestroyed()) win.webContents.send("local:detected", { count: names.length });
}

// Explicit confirmation (popup) and start of intel resolution.
async function confirmLocalIntel(names) {
  showWindow();
  const m = M();
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    title: m.confirmTitle,
    message: m.confirmMsg(names.length),
    detail: m.confirmDetail,
    buttons: [m.btnNo, m.btnShowIntel],
    defaultId: 1, cancelId: 0, noLink: true,
  });
  if (response === 1) runLocalIntel(names);
}

// Run the resolution and send the (incremental) results to the renderer.
async function runLocalIntel(names) {
  win?.webContents.send("local:start", { total: names.length });
  try {
    const res = await localIntel(names, {
      cap: 100, concurrency: 4,
      onProgress: (done, total) => win?.webContents.send("local:progress", { done, total }),
    });
    win?.webContents.send("local:result", res);
  } catch (e) {
    win?.webContents.send("local:result", { error: e.message, rows: [], total: names.length });
  }
}

// Tray "scan now" button: forces an immediate check of the clipboard.
function scanClipboardNow() {
  const names = scanNow();
  if (names) confirmLocalIntel(names);
  else {
    showWindow();
    const m = M();
    // Diagnostic preview of the actual clipboard, so a user whose EVE copy isn't
    // recognized can report what the client really puts on the clipboard.
    const raw = (clipboard.readText() || "");
    const lines = raw.split(/\r\n|\r|\n/);
    const preview = raw.trim()
      ? `[${m.cbLines}: ${lines.length}]\n` + lines.slice(0, 6).map((l) => "» " + l).join("\n").slice(0, 700)
      : m.cbEmpty;
    dialog.showMessageBox(win, {
      type: "info", title: m.confirmTitle,
      message: m.noLocalMsg,
      detail: `${m.noLocalDetail}\n\n— ${m.cbDiag} —\n${preview}`,
      buttons: [m.btnOk], noLink: true,
    });
  }
}

// In the packaged app the source dir is read-only and gets replaced on every
// update: models (.gguf, downloaded on-demand) and the RAG index instead live in
// userData, which persists across updates. In development (electron .) everything
// stays in the project and the assets are assumed already present (no setup flow).
let assetDirs = null;        // { modelsDir, dataDir } when packaged; null in dev
let setupAbort = null;       // AbortController for the in-progress first-run download
let modelDlAbort = null;     // AbortController for an extra model downloaded post-setup
async function setupAssetDirs() {
  if (!app.isPackaged) return;
  const modelsDir = path.join(app.getPath("userData"), "models");
  const dataDir = path.join(app.getPath("userData"), "data");
  await mkdir(modelsDir, { recursive: true }).catch(() => {});
  await mkdir(dataDir, { recursive: true }).catch(() => {});
  configurePaths({ modelsDir, dataDir });
  assetDirs = { modelsDir, dataDir };
}

// Is the setup flow (asset download) needed? Only if packaged and the embedding,
// index, or a chat model are missing. In dev the assets are in the project → never.
function setupNeeded() {
  return !!assetDirs && !assetStatus({ ...assetDirs }).firstRunReady;
}

// Full first-run info for the renderer: status, bytes still to download for the
// one-time base (embedding + index), and the model choices from the catalog.
async function setupInfo() {
  const manifest = loadManifest();
  const status = assetStatus({ ...assetDirs, manifest });
  let baseBytes = 0;
  if (!status.embeddingReady) baseBytes += manifest.embedding.size;
  if (!status.indexReady) baseBytes += manifest.index.files.reduce((s, f) => s + f.size, 0);
  const catalog = await loadCatalog();
  const installed = new Set(installedCatalogIds(catalog, assetDirs.modelsDir));
  const models = catalog.models.map((m) => ({
    id: m.id, label: m.label, sizeGB: m.sizeGB, paramsB: m.paramsB, quant: m.quant,
    recommended: m.recommended || "", default: !!m.default, installed: installed.has(m.id),
  }));
  return { needed: !status.firstRunReady, baseBytes, models };  // status is internal
}

// Rough VRAM fit for a not-yet-downloaded model (size + ~1GB context vs free VRAM).
function fitRating(sizeGB, freeGB) {
  if (freeGB == null) return "";
  if (freeGB >= sizeGB + 1) return "veloce";
  if (freeGB >= sizeGB * 0.6) return "accettabile";
  return "lento";
}

// Auto-update of the app's code (electron-updater, GitHub Releases channel). The
// download happens in the background; when ready, we ask whether to restart. Assets
// (models/index) are NOT touched: they live in userData, outside the package.
function setupAutoUpdate() {
  if (!app.isPackaged) return;  // in dev there's no package to update
  autoUpdater.autoDownload = true;
  autoUpdater.on("update-downloaded", async (info) => {
    const m = M();
    const { response } = await dialog.showMessageBox(win, {
      type: "info", title: m.updTitle, message: m.updMsg(info.version),
      detail: m.updDetail, buttons: [m.updLater, m.updRestart],
      defaultId: 1, cancelId: 0, noLink: true,
    });
    if (response === 1) {
      await shutdown();           // stop llama's native work before quitting
      shuttingDown = true;        // let before-quit not interfere
      autoUpdater.quitAndInstall();
    }
  });
  // Errors (no network, no release, unsigned app in testing…) don't bother the user.
  autoUpdater.on("error", () => {});
  autoUpdater.checkForUpdates().catch(() => {});
}

// Re-download index/data files whose size no longer matches the manifest (e.g. an
// updated names_index.json), so existing installs pick up new data without a reinstall.
// Only the changed files are fetched; the big vector index is untouched if unchanged.
// (Fitting SDE is no longer here — it's version-pinned inside the eve-fit-engine package.)
async function refreshDataFiles() {
  if (!assetDirs || setupNeeded()) return;  // first-run setup downloads everything anyway
  const manifest = loadManifest();
  const sizeNe = (p, size) => { try { return statSync(p).size !== size; } catch { return true; } };
  const stale = indexTasks(manifest, assetDirs.dataDir).filter((t) => sizeNe(t.dest, t.size));
  if (!stale.length) return;
  try {
    win?.webContents.send("status", { k: "index" });
    await downloadTasks(stale);
    writeIndexMeta(assetDirs.dataDir);
  } catch { /* keep existing files; non-fatal (the fit lookup just stays older) */ }
}

// Start the RAG engine (models + index) and notify the renderer.
async function startEngine() {
  try {
    const info = await init((s) => win?.webContents.send("status", s));
    ready = true;
    win?.webContents.send("ready", info);
  } catch (e) {
    win?.webContents.send("status", M().initError(e.message));
  }
}

app.whenReady().then(async () => {
  // Windows: without a matching AppUserModelID the OS silently drops our toast
  // notifications (so the "Local detected" prompt never appears). Must match the
  // electron-builder appId + the NSIS Start-Menu shortcut.
  app.setAppUserModelId("com.capsuleers.ia");
  Menu.setApplicationMenu(null);  // removes the File/Edit/View… menu
  await setupAssetDirs();
  createWindow();
  createTray();
  setupAutoUpdate();  // checks for app updates in the background (only if packaged)
  // Once the window is ready: if assets are missing, show setup; otherwise start the engine.
  win.webContents.once("did-finish-load", async () => {
    if (setupNeeded()) win?.webContents.send("setup:needed", await setupInfo());
    else { await refreshDataFiles(); startEngine(); }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Orderly shutdown: if the model is still generating, cancel and WAIT for the
// native work to finish before quitting. Without this, closing mid-response makes
// llama's AsyncWorker blow up with Napi::Error → terminate (zombie process).
let shuttingDown = false;
app.on("before-quit", (e) => {
  if (shuttingDown) return;        // second call: actually let it quit
  e.preventDefault();
  shuttingDown = true;
  // Abort any in-flight download (first-run setup or an extra model) so the
  // stream/connection tear down cleanly; the partial ".part" file stays on disk
  // and resumes on next launch.
  if (setupAbort) setupAbort.abort();
  if (modelDlAbort) modelDlAbort.abort();
  shutdown().finally(() => app.quit());
});

// Custom window controls (app-style title bar).
ipcMain.on("win:minimize", () => win?.hide());                 // minimize → tray icon
ipcMain.on("win:maximize", () => { if (win?.isMaximized()) win.unmaximize(); else win?.maximize(); });
ipcMain.on("win:close", () => { app.isQuitting = true; app.quit(); });
ipcMain.on("win:mini", () => enterMini());                     // shrink to always-on-top icon
ipcMain.on("win:restore", () => exitMini());
ipcMain.on("reset", () => resetConversation());                // new conversation

// Local intel from clipboard: the renderer can drive the toggle and the scan,
// and re-confirm the last detected Local.
ipcMain.handle("local:toggle", async () => { await toggleClipboardWatch(); return isEnabled(); });
ipcMain.handle("local:state", () => isEnabled());
ipcMain.on("local:scan", () => scanClipboardNow());
ipcMain.on("local:confirm", () => { if (pendingLocal) runLocalIntel(pendingLocal); });
// Intel detail for a single pilot (popup on clicking the row).
ipcMain.handle("local:detail", async (_e, who) => {
  try { return await characterDetail(who || {}); } catch (e) { return { error: e.message }; }
});

// Models: list with an estimate (given the VRAM free now), VRAM state, and hot-swap.
ipcMain.handle("models:list", async () => {
  try { return { models: await listModels(), vram: await vramState(), manage: true }; }
  catch (e) { return { error: e.message, models: [], vram: null, manage: true }; }
});
// Delete a downloaded model to free disk space (not the one in use nor the embedding).
ipcMain.handle("models:delete", async (_e, file) => deleteModelFile(file));
ipcMain.handle("models:vram", async () => { try { return await vramState(); } catch { return null; } });
ipcMain.handle("models:set", async (_e, file) => {
  if (!ready) return { error: "Motore non ancora pronto." };
  try { return await setModel(file, (s) => win?.webContents.send("status", s)); }
  catch (e) { return { error: e.message }; }
});

// Catalog of chat models NOT yet downloaded (packaged only) — so the user can
// fetch and use another model after first run. From the updatable remote catalog,
// filtered to the size range, sorted by how well they fit the free VRAM.
ipcMain.handle("models:catalog", async () => {
  if (!assetDirs) return { available: false, models: [] };
  try {
    const catalog = await loadCatalog();
    const installed = new Set(installedCatalogIds(catalog, assetDirs.modelsDir));
    const v = await vramState().catch(() => null);
    const freeGB = v ? v.freeMB / 1024 : null;
    const models = catalog.models.filter((m) => !installed.has(m.id)).map((m) => ({
      id: m.id, label: m.label, sizeGB: m.sizeGB, quant: m.quant, paramsB: m.paramsB,
      recommended: m.recommended || "", default: !!m.default, rating: fitRating(m.sizeGB, freeGB),
    }));
    const order = { veloce: 0, accettabile: 1, lento: 2, "": 3 };
    models.sort((a, b) => (order[a.rating] - order[b.rating]) || (a.sizeGB - b.sizeGB));
    return { available: true, models };
  } catch (e) { return { available: true, models: [], error: e.message }; }
});
// Download an extra chat model on demand, then switch to it. Progress via
// "models:download-progress"; cancelable via "models:download-cancel".
ipcMain.handle("models:download", async (_e, modelId) => {
  if (!assetDirs) return { error: "Download non disponibile (asset locali)." };
  if (modelDlAbort || setupAbort) return { error: "Download già in corso." };
  modelDlAbort = new AbortController();
  try {
    const catalog = await loadCatalog({ signal: modelDlAbort.signal });
    const entry = catalog.models.find((m) => m.id === modelId);
    if (!entry) { modelDlAbort = null; return { error: "Modello sconosciuto." }; }
    const t = await modelTask(entry, assetDirs.modelsDir, modelDlAbort.signal);
    await downloadTasks([t], {
      signal: modelDlAbort.signal,
      onProgress: (p) => { if (!win?.isDestroyed()) win.webContents.send("models:download-progress", { ...p, modelId }); },
    });
    modelDlAbort = null;
    if (!ready) return { ok: true };  // engine not up yet → just downloaded
    const res = await setModel(entry.file, (s) => win?.webContents.send("status", s));  // use it now
    return { ok: true, ...res };
  } catch (e) {
    modelDlAbort = null;
    const aborted = /abort/i.test(e?.name || "") || /annull/i.test(e?.message || "");
    return { error: e.message, aborted };
  }
});
ipcMain.on("models:download-cancel", () => { if (modelDlAbort) modelDlAbort.abort(); });

// ── First-run setup: on-demand asset download ──────────────────────────────
// Full first-run info (status + bytes + model choices) requested by the renderer.
ipcMain.handle("setup:state", async () => (assetDirs ? await setupInfo() : { needed: false }));
// Start downloading the first-run set (embedding + index + chosen model).
// Progress via "setup:progress"; on completion, start the engine and send "setup:done".
ipcMain.handle("setup:start", async (_e, modelId) => {
  if (!assetDirs) return { error: "Asset locali già presenti." };
  if (setupAbort) return { error: "Download già in corso." };
  setupAbort = new AbortController();
  try {
    const catalog = await loadCatalog({ signal: setupAbort.signal });
    const entry = catalog.models.find((m) => m.id === modelId) || catalog.models.find((m) => m.default) || catalog.models[0];
    const tasks = await firstRunTasks({ ...assetDirs, modelEntry: entry, signal: setupAbort.signal });
    await downloadTasks(tasks, {
      signal: setupAbort.signal,
      onProgress: (p) => { if (!win?.isDestroyed()) win.webContents.send("setup:progress", p); },
    });
    writeIndexMeta(assetDirs.dataDir);  // compatibility sidecar for the check at init()
    setupAbort = null;
    win?.webContents.send("setup:done");
    await startEngine();
    return { ok: true };
  } catch (e) {
    setupAbort = null;
    const aborted = /abort/i.test(e?.name || "") || /annull/i.test(e?.message || "");
    win?.webContents.send("setup:error", { message: e.message, aborted });
    return { error: e.message, aborted };
  }
});
ipcMain.on("setup:cancel", () => { if (setupAbort) setupAbort.abort(); });

// IPC: the renderer sends a question; we respond by streaming via events.
ipcMain.handle("ask", async (event, question) => {
  if (!ready) return { error: "Motore non ancora pronto." };
  try {
    // System language: used as the answer language for a pasted fit (whose text is
    // all-English game terms and would otherwise always be detected as English).
    const uiLang = (app.getLocale() || "en").toLowerCase().startsWith("it") ? "it" : "en";
    // Don't write to a destroyed webContents (window closed mid-response).
    return await ask(question, (t) => {
      if (!event.sender.isDestroyed()) event.sender.send("token", t);
    }, uiLang);  // {answer, sources, kills, lang}
  } catch (e) {
    return { error: e.message };
  }
});

