// Secure bridge between the renderer and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capsuleers", {
  ask: (question) => ipcRenderer.invoke("ask", question),
  reset: () => ipcRenderer.send("reset"),
  // Models: list with performance estimate (given the free VRAM), and hot-swap.
  models: {
    list: () => ipcRenderer.invoke("models:list"),
    vram: () => ipcRenderer.invoke("models:vram"),
    set: (file) => ipcRenderer.invoke("models:set", file),
    delete: (file) => ipcRenderer.invoke("models:delete", file),
    // Download an extra model on demand (catalog of not-yet-downloaded ones).
    catalog: () => ipcRenderer.invoke("models:catalog"),
    download: (id) => ipcRenderer.invoke("models:download", id),
    cancelDownload: () => ipcRenderer.send("models:download-cancel"),
    onDownloadProgress: (cb) => ipcRenderer.on("models:download-progress", (_e, p) => cb(p)),
  },
  onToken: (cb) => ipcRenderer.on("token", (_e, t) => cb(t)),
  onStatus: (cb) => ipcRenderer.on("status", (_e, s) => cb(s)),
  onReady: (cb) => ipcRenderer.on("ready", (_e, info) => cb(info)),
  // First-run setup: on-demand download of models and index.
  setup: {
    state: () => ipcRenderer.invoke("setup:state"),
    start: (modelId) => ipcRenderer.invoke("setup:start", modelId),
    cancel: () => ipcRenderer.send("setup:cancel"),
    onNeeded: (cb) => ipcRenderer.on("setup:needed", (_e, p) => cb(p)),
    onProgress: (cb) => ipcRenderer.on("setup:progress", (_e, p) => cb(p)),
    onDone: (cb) => ipcRenderer.on("setup:done", () => cb()),
    onError: (cb) => ipcRenderer.on("setup:error", (_e, p) => cb(p)),
  },
  // Custom window controls
  win: {
    minimize: () => ipcRenderer.send("win:minimize"),
    maximize: () => ipcRenderer.send("win:maximize"),
    close: () => ipcRenderer.send("win:close"),
    mini: () => ipcRenderer.send("win:mini"),
    restore: () => ipcRenderer.send("win:restore"),
    onState: (cb) => ipcRenderer.on("win:state", (_e, max) => cb(max)),
    onMiniState: (cb) => ipcRenderer.on("win:mini-state", (_e, mini) => cb(mini)),
  },
  // Local intel from clipboard
  local: {
    toggle: () => ipcRenderer.invoke("local:toggle"),
    state: () => ipcRenderer.invoke("local:state"),
    scan: () => ipcRenderer.send("local:scan"),
    detail: (who) => ipcRenderer.invoke("local:detail", who),
    onStart: (cb) => ipcRenderer.on("local:start", (_e, p) => cb(p)),
    onProgress: (cb) => ipcRenderer.on("local:progress", (_e, p) => cb(p)),
    onResult: (cb) => ipcRenderer.on("local:result", (_e, p) => cb(p)),
  },
});
