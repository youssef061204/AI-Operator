import { app, BrowserWindow, dialog } from "electron";

// Desktop is a sandboxed host for the primary web task console.
// Start the authenticated runtime and web server with `pnpm dev` first.
// The legacy renderer, overlays, control IPC, and agent auto-launch are retired.
const CONSOLE_URL = "http://localhost:3000/";
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 600,
    title: "AI Operator",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== CONSOLE_URL) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (url !== CONSOLE_URL) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on("closed", () => { mainWindow = null; });
  void window.loadURL(CONSOLE_URL).catch(() => {
    if (window.isDestroyed()) return;
    void dialog.showMessageBox(window, {
      type: "error",
      title: "Local console unavailable",
      message: "Start the local runtime and web console with pnpm dev, then reopen the desktop app.",
      detail: `The desktop app connects to ${CONSOLE_URL}. It does not start a separate execution engine.`,
    });
  });
}

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", createWindow);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});