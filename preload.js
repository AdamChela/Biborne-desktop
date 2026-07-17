// Pont sécurisé entre le processus principal (Electron/autoUpdater, accès Node) et l'interface (aucun accès Node,
// contextIsolation activé). Expose juste ce qu'il faut sous window.updater, sans donner accès à Node/fs/etc.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updater", {
  getVersion: () => ipcRenderer.invoke("get-app-version"),
  restart: () => ipcRenderer.send("updater-restart"),
  onChecking: (cb) => ipcRenderer.on("updater-checking", () => cb()),
  onAvailable: (cb) => ipcRenderer.on("updater-available", (_e, info) => cb(info)),
  onNotAvailable: (cb) => ipcRenderer.on("updater-not-available", () => cb()),
  onProgress: (cb) => ipcRenderer.on("updater-progress", (_e, progress) => cb(progress)),
  onDownloaded: (cb) => ipcRenderer.on("updater-downloaded", (_e, info) => cb(info)),
  onError: (cb) => ipcRenderer.on("updater-error", (_e, message) => cb(message)),
});
