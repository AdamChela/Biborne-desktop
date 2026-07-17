const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const { autoUpdater } = require("electron-updater");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    icon: path.join(__dirname, "build/icon.png"),
    titleBarStyle: "default",
  });
  win.loadFile("renderer/index.html");
}

// Mise à jour automatique : au lancement, l'app vérifie sur GitHub Releases s'il existe
// une version plus récente que celle installée. Si oui, elle la télécharge en arrière-plan
// puis propose à l'utilisateur de redémarrer pour l'appliquer (aucune manip requise de sa part).
function setupAutoUpdate() {
  autoUpdater.autoDownload = true;
  autoUpdater.on("update-downloaded", () => {
    dialog.showMessageBox({
      type: "info",
      title: "Mise à jour disponible",
      message: "Une nouvelle version de Biborne Messagerie a été téléchargée. Redémarrer maintenant pour l'appliquer ?",
      buttons: ["Redémarrer", "Plus tard"],
    }).then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on("error", (err) => console.error("[AutoUpdate]", err.message));
  autoUpdater.checkForUpdates().catch((err) => console.error("[AutoUpdate] check failed:", err.message));
}

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) setupAutoUpdate(); // pas de check en dev (npm start), uniquement sur l'app installée
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
