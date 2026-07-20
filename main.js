const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const { autoUpdater } = require("electron-updater");

// Retire la barre de menu native (File/Edit/View/Window) : c'est un résidu par défaut d'Electron,
// sans utilité pour une app de messagerie destinée aux employés/clients (pas un outil de dev).
Menu.setApplicationMenu(null);

let mainWin = null;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    icon: path.join(__dirname, "build/icon.png"),
    titleBarStyle: "default",
    autoHideMenuBar: true,
  });
  mainWin.loadFile("renderer/index.html");
}

// Mise à jour automatique : au lancement, l'app vérifie sur GitHub Releases s'il existe une version
// plus récente que celle installée, la télécharge en arrière-plan, et prévient l'interface à chaque
// étape (checking/available/progress/downloaded/error) via IPC pour afficher une barre de progression
// dans l'UI elle-même plutôt qu'une popup système.
function setupAutoUpdate() {
  autoUpdater.autoDownload = true;
  const send = (channel, payload) => mainWin && !mainWin.isDestroyed() && mainWin.webContents.send(channel, payload);

  autoUpdater.on("checking-for-update", () => send("updater-checking"));
  autoUpdater.on("update-available", (info) => send("updater-available", { version: info.version }));
  autoUpdater.on("update-not-available", () => send("updater-not-available"));
  autoUpdater.on("download-progress", (p) => send("updater-progress", { percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => send("updater-downloaded", { version: info.version }));
  autoUpdater.on("error", (err) => { console.error("[AutoUpdate]", err.message); send("updater-error", err.message); });

  autoUpdater.checkForUpdates().catch((err) => console.error("[AutoUpdate] check failed:", err.message));
}

ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.on("updater-restart", () => autoUpdater.quitAndInstall());

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) setupAutoUpdate(); // pas de check en dev (npm start), uniquement sur l'app installée
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
