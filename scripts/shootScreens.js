'use strict';
/**
 * Screenshot tour - boots the real index.html + preload + kernel in Electron,
 * signs in through the login form, walks the flagship screens and writes a
 * PNG per screen into docs/screenshots/ (used by README.md).
 *
 *   node_modules\.bin\electron.cmd scripts/shootScreens.js   (or: npm run shots)
 *
 * The window is VISIBLE on purpose: capturePage() returns an empty frame for
 * hidden windows on some Windows GPU stacks. Nothing here writes to the
 * ledger except reads through the normal kernel path.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');

// Same single IPC channel as main.js so the renderer reaches the kernel.
const kernel = require(path.join(ROOT, 'src', 'main', 'kernel'));

ipcMain.handle('erp:invoke', async (_event, method, args) => {
  try {
    return await kernel.invoke(method, args);
  } catch (err) {
    throw new Error(JSON.stringify({
      code: err.code || 'INTERNAL_ERROR',
      message: err.message,
      details: err.details !== undefined ? err.details : null,
    }));
  }
});

/** name = output file, route = app route, run = click the report's Run button. */
const SHOTS = [
  { name: '01-login', route: 'login' },
  { name: '02-dashboard', route: 'dashboard' },
  { name: '03-chart-of-accounts', route: 'coa' },
  { name: '04-coa-wizard', route: 'wizard' },
  { name: '05-journal-voucher', route: 'journal' },
  { name: '06-trial-balance', route: 'trial-balance', run: true },
  { name: '07-income-statement', route: 'income-statement', run: true },
  { name: '08-balance-sheet', route: 'balance-sheet', run: true },
  { name: '09-inventory', route: 'inventory' },
  { name: '10-payroll', route: 'payroll' },
  { name: '11-closing-backup', route: 'closing' },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Wait until #view has rendered the route and no spinner/toast is left. */
async function settle(win) {
  for (let i = 0; i < 80; i += 1) {
    const ready = await win.webContents.executeJavaScript(
      `!document.querySelector('#view .screen-loading') && !!document.querySelector('#view .screen, #view .card')`);
    if (ready) break;
    await sleep(100);
  }
  // Let charts/tables paint and any toast retire so it is not in the shot.
  await sleep(900);
  for (let i = 0; i < 40; i += 1) {
    const toasts = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.toast, .toast-container .toast').length`);
    if (!toasts) break;
    await sleep(200);
  }
  await sleep(250);
}

async function shoot(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(` SHOT  ${name}.png  ${kb} KB`);
  return kb;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 1440, height: 900, show: true,
    title: 'Apex ERP - Autonomous COA & General Ledger Engine',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(1200);

  // --- 1. login screen (before any session exists) -----------------------
  await settle(win);
  let bad = 0;
  try {
    await shoot(win, SHOTS[0].name);
  } catch (e) {
    console.log(` FAIL  ${SHOTS[0].name}: ${e.message}`);
    bad += 1;
  }

  // --- 2. sign in through the real form ----------------------------------
  const loggedIn = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const user = document.getElementById('login-username');
    if (!user) return false;
    user.value = 'admin';
    document.getElementById('login-password').value = 'admin123';
    document.querySelector('.login-form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 50 && !document.querySelector('.nav-btn.active'); i += 1) await sleep(100);
    return !!document.querySelector('.nav-btn.active');
  })()`);
  if (!loggedIn) {
    console.log(' FAIL  login did not complete');
    app.exit(1);
    return;
  }
  await settle(win);

  // --- 3. every remaining screen -----------------------------------------
  for (const shot of SHOTS.slice(1)) {
    try {
      await win.webContents.executeJavaScript(
        `(async () => {
          const app = await import('./src/ui/app.js');
          await app.go(${JSON.stringify(shot.route)});
        })()`);
      await settle(win);

      if (shot.run) {
        await win.webContents.executeJavaScript(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const btn = [...document.querySelectorAll('#view button')]
            .find((b) => /^run$/i.test((b.textContent || '').trim()));
          if (btn) { btn.click(); }
          for (let i = 0; i < 60; i += 1) {
            if (!document.querySelector('#view .screen-loading')) break;
            await sleep(100);
          }
          await sleep(700);
        })()`);
        await settle(win);
      }

      await shoot(win, shot.name);
    } catch (e) {
      console.log(` FAIL  ${shot.name}: ${e.message}`);
      bad += 1;
    }
  }

  console.log(bad === 0 ? `SHOTS PASS (${SHOTS.length} png -> docs/screenshots)` : `SHOTS FAIL bad=${bad}`);
  setTimeout(() => app.exit(bad === 0 ? 0 : 1), 200);
}).catch((err) => {
  console.log('SHOTS FAIL boot:', err.stack);
  setTimeout(() => app.exit(1), 200);
});
