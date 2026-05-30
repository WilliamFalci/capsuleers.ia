// Electron main process: opens the window, initializes the RAG engine,
// and routes questions from the renderer (IPC) with streaming responses.
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, Notification, dialog, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { configurePaths, init, ask, resetConversation, shutdown, listModels, setModel, vramState } from "./engine.mjs";
import { localIntel, characterDetail } from "./intel.mjs";
import { startWatch, stopWatch, isEnabled, scanNow } from "./clipboard-watch.mjs";
import { loadManifest, assetStatus, firstRunTasks, downloadTasks, writeIndexMeta } from "./assets.mjs";
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
    webPreferences: { preload: path.join(HERE, "preload.cjs") },
  });
  win.setAspectRatio(16 / 9);     // keep 16:9 while resizing
  win.loadFile(path.join(HERE, "renderer", "index.html"));
  win.on("maximize", () => win.webContents.send("win:state", true));
  win.on("unmaximize", () => win.webContents.send("win:state", false));

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

// System notification: a Local was detected; clicking it confirms.
function onLocalDetected(names) {
  pendingLocal = names;
  if (Notification.isSupported()) {
    const m = M();
    const n = new Notification({
      title: m.notifTitle,
      body: m.notifBody(names.length),
      silent: false,
    });
    n.on("click", () => confirmLocalIntel(names));
    n.show();
  } else {
    // Fallback: bring the window forward and ask there.
    confirmLocalIntel(names);
  }
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
    dialog.showMessageBox(win, {
      type: "info", title: m.confirmTitle,
      message: m.noLocalMsg,
      detail: m.noLocalDetail,
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
function setupState() {
  if (!assetDirs) return { needed: false };
  const manifest = loadManifest();
  const status = assetStatus({ ...assetDirs, manifest });
  return { needed: !status.firstRunReady, manifest, status };
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
  Menu.setApplicationMenu(null);  // removes the File/Edit/View… menu
  await setupAssetDirs();
  createWindow();
  createTray();
  setupAutoUpdate();  // checks for app updates in the background (only if packaged)
  // Once the window is ready: if assets are missing, show setup; otherwise start the engine.
  win.webContents.once("did-finish-load", async () => {
    const st = setupState();
    if (st.needed) win?.webContents.send("setup:needed", { manifest: st.manifest, status: st.status });
    else startEngine();
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
  try { return { models: await listModels(), vram: await vramState() }; }
  catch (e) { return { error: e.message, models: [], vram: null }; }
});
ipcMain.handle("models:vram", async () => { try { return await vramState(); } catch { return null; } });
ipcMain.handle("models:set", async (_e, file) => {
  if (!ready) return { error: "Motore non ancora pronto." };
  try { return await setModel(file, (s) => win?.webContents.send("status", s)); }
  catch (e) { return { error: e.message }; }
});

// ── First-run setup: on-demand asset download ──────────────────────────────
// State (is setup needed? which models to choose?) requested by the renderer.
ipcMain.handle("setup:state", () => setupState());
// Start downloading the first-run set (embedding + index + chosen model).
// Progress via "setup:progress"; on completion, start the engine and send "setup:done".
ipcMain.handle("setup:start", async (_e, modelId) => {
  if (!assetDirs) return { error: "Asset locali già presenti." };
  if (setupAbort) return { error: "Download già in corso." };
  setupAbort = new AbortController();
  try {
    const tasks = firstRunTasks({ ...assetDirs, modelId });
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
    // Don't write to a destroyed webContents (window closed mid-response).
    return await ask(question, (t) => {
      if (!event.sender.isDestroyed()) event.sender.send("token", t);
    });  // {answer, sources, kills, lang}
  } catch (e) {
    return { error: e.message };
  }
});

