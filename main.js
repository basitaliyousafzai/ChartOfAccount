'use strict';

/**
 * Apex ERP — Electron main process.
 *
 * Responsibilities (docs/API_CONTRACT.md):
 *   • open the 1440x900 shell window with a context-isolated preload;
 *   • expose exactly ONE ipc channel, `erp:invoke`, which forwards
 *     `(method, args)` to the ledger kernel and serialises every failure as
 *     `{ code, message, details }` so the renderer can surface it in a toast.
 *
 * All money values stay integer cents across this boundary (Invariant 3) —
 * only the renderer formats them.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// A tidy per-user data directory (`%APPDATA%\Apex ERP`) rather than the full
// SRS title from package.json. This MUST precede the kernel require below:
// constructing the kernel opens the database, and an installed build derives
// its database path from this userData directory.
if (app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Apex ERP'));
}

// The kernel is owned by the backend engineer; required as-is. If it is not
// built yet the shell still launches and every call rejects with NOT_FOUND.
let kernel = null;
try {
  kernel = require('./src/main/kernel');
} catch (err) {
  console.error('[main] kernel not available yet:', err.message);
}

/** @type {BrowserWindow|null} */
let mainWindow = null;

// One window per installation. A second launch (shortcut double-clicked
// twice, Start Menu + desktop at once) focuses the running window instead of
// opening a second process onto the same SQLite ledger.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

/** Normalise any thrown value into the contract's error envelope. */
function toErrorEnvelope(err) {
  if (err && typeof err === 'object') {
    return {
      code: typeof err.code === 'string' && err.code ? err.code : 'INTERNAL_ERROR',
      message: typeof err.message === 'string' && err.message ? err.message : String(err),
      details: err.details !== undefined ? err.details : null,
    };
  }
  return { code: 'INTERNAL_ERROR', message: String(err), details: null };
}

/** Register the single IPC channel. Idempotent. */
function registerIpc() {
  ipcMain.handle('erp:invoke', async (_event, method, args) => {
    try {
      if (!kernel || typeof kernel[method] !== 'function') {
        const err = new Error(`Kernel method not found: ${String(method)}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      // Route through invoke() so the Phase 1 RBAC gate runs for every call.
      return await kernel.invoke(method, args);
    } catch (err) {
      // Electron only ships `message` across ipc, so the whole envelope is
      // embedded as JSON here and revived by preload.js (see that file).
      throw new Error(JSON.stringify(toErrorEnvelope(err)));
    }
  });
}

/** Create (or re-create) the shell window. Must only run after app ready. */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0f1117',
    show: false,
    title: 'Apex ERP — Autonomous COA & General Ledger Engine',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // The shell is fully offline: never allow spawned windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

registerIpc();

app.whenReady().then(() => {
  createWindow();

  // macOS convention: re-create the window when the dock icon is clicked.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Standard convention: quit except on macOS (where the app stays in dock).
  if (process.platform !== 'darwin') app.quit();
});
