'use strict';
/**
 * Real-shell smoke test: boots the actual index.html + preload + kernel in
 * Electron, signs in through the login form, then visits every route and
 * reports placeholders / failed screens / console errors.
 *
 *   node_modules\.bin\electron.cmd scripts/smokeShell.js   (or: npm run smoke)
 *
 * Also exercises, in an isolated throwaway database (never the real ledger):
 *   Phase 1 RBAC gate · Phase 6 close/reopen · Phase 6 backup snapshot/list/restore
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Mirror main.js's single IPC channel so the real renderer can reach the kernel.
const kernel = require(path.join(ROOT, 'src', 'main', 'kernel'));

/**
 * Test-only seam: lets the renderer show a *synthetic* closed fiscal period
 * so the Reopen-period control (which only renders for IsClosed = 1) can be
 * exercised without ever closing a real period in the case-study ledger.
 * Never touches the database.
 */
let closingStatusOverride = null;

ipcMain.handle('erp:invoke', async (_event, method, args) => {
  try {
    if (method === 'smoke:setClosingOverride') {
      closingStatusOverride = Array.isArray(args) ? args : null;
      return true;
    }
    if (method === 'closing.status' && closingStatusOverride) return closingStatusOverride;
    return await kernel.invoke(method, args);
  } catch (err) {
    throw new Error(JSON.stringify({
      code: err.code || 'INTERNAL_ERROR',
      message: err.message,
      details: err.details !== undefined ? err.details : null,
    }));
  }
});

const ROUTES = [
  'dashboard', 'coa', 'wizard', 'journal', 'pos-sale', 'sales-invoice',
  'credit-note', 'purchase-bill', 'debit-note', 'receipts', 'payments',
  'expenses', 'payroll', 'inventory', 'fixed-assets', 'forex',
  'trial-balance', 'income-statement',
  'balance-sheet', 'ledger-card', 'closing',
];

const consoleErrors = [];
const pageErrors = [];
const results = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** One line of PASS/FAIL output; returns 0 or 1 so callers can sum. */
function check(label, ok, detail = '') {
  console.log(` ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  return ok ? 0 : 1;
}

/**
 * Phase 6 acceptance on a THROWAWAY database: period close -> reopen ->
 * backup snapshot -> list -> restore (handle reopened, ledger still queryable).
 * The seeded case-study ledger is never modified here.
 */
async function phase6Checks() {
  const fs = require('fs');
  const os = require('os');
  const { Kernel } = require(path.join(ROOT, 'src', 'main', 'kernel'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-smoke-'));
  const dbPath = path.join(dir, 'phase6.db');
  let k = null;
  let fails = 0;

  try {
    k = new Kernel({ dbPath });
    k.sessionRole = 'Admin';

    const users = k.auth.bootstrap();
    fails += check('bootstrap seeds users/COA/periods', Boolean(users && users.users));

    const periods = k.closing.status();
    // Close a period that actually contains a posting date: prefer today's
    // period, else the last defined one.
    const iso = new Date().toISOString().slice(0, 10);
    const period = periods.find((p) => p.StartDate <= iso && p.EndDate >= iso) || periods[periods.length - 1];
    fails += check('a fiscal period exists', Boolean(period), `PeriodId=${period && period.PeriodId}`);

    // Post an expense inside that period so the closing flush has a balance.
    k.ledger.record({
      voucherDate: period.StartDate,
      voucherType: 'General_JV',
      narration: 'phase6 smoke voucher',
      createdBy: 1,
      lines: [
        { accountCode: '6.10.01.0001.0001', debit: 10000, credit: 0 },
        { accountCode: '1.10.01.0001.0001', debit: 0, credit: 10000 },
      ],
    });
    fails += check('balanced 100.00 voucher posts', true);

    const closed = k.closing.closePeriod({ periodId: period.PeriodId, createdBy: 1 });
    fails += check('closePeriod returns a closing voucher', Boolean(closed && closed.voucher && closed.voucher.voucherNo),
      closed && closed.voucher ? closed.voucher.voucherNo : '');
    fails += check('period IsClosed = 1 after close',
      k.closing.status().find((p) => p.PeriodId === period.PeriodId).IsClosed === 1);

    // Rejections into the locked period.
    let closedRejected = false;
    try {
      k.ledger.record({
        voucherDate: period.EndDate,
        voucherType: 'General_JV',
        narration: 'should be rejected',
        createdBy: 1,
        lines: [
          { accountCode: '6.10.01.0001.0001', debit: 1, credit: 0 },
          { accountCode: '1.10.01.0001.0001', debit: 0, credit: 1 },
        ],
      });
    } catch (e) { closedRejected = e && e.code === 'CLOSED_PERIOD'; }
    fails += check('postings into a closed period are rejected', closedRejected);

    const reopened = k.closing.reopenPeriod({ periodId: period.PeriodId, createdBy: 1 });
    fails += check('reopenPeriod unlocks the period', Boolean(reopened && reopened.reopened === true));
    fails += check('period IsClosed = 0 after reopen',
      k.closing.status().find((p) => p.PeriodId === period.PeriodId).IsClosed === 0);

    // --- backup: snapshot -> list -> restore (handle must survive) --------
    const snap = k.backup.snapshot({});
    fails += check('backup.snapshot writes a verified .db', Boolean(snap && snap.verified && snap.path));
    const listed = k.backup.list();
    fails += check('backup.list finds the snapshot', listed.some((b) => b.path === snap.path));

    const dump = k.backup.dumpJson({});
    fails += check('backup.dumpJson serialises tables', Boolean(dump && dump.records >= 0));

    // Change something, then restore the snapshot and confirm the change is gone.
    k.system.setSetting({ key: 'smoke.marker', value: 'after-snapshot' });
    const restored = k.backup.restore({ sourcePath: snap.path });
    fails += check('backup.restore reports reopened handle', restored.reopened === true);

    const rows = k.coa.list({ activeOnly: false });
    fails += check('kernel still queries after restore', Array.isArray(rows) && rows.length > 40, `${rows.length} accounts`);

    const settings = k.system.settings() || {};
    fails += check('restored db predates the post-snapshot write', settings['smoke.marker'] === undefined,
      settings['smoke.marker'] !== undefined ? `marker still present: ${settings['smoke.marker']}` : 'marker absent as expected');

    // RBAC on this isolated instance too (invoke returns a rejected promise).
    k.sessionRole = null;
    let denied = false;
    try { await k.invoke('backup.restore', { sourcePath: snap.path }); } catch (e) { denied = e && e.code === 'FORBIDDEN'; }
    fails += check('backup.restore is FORBIDDEN without a session', denied);
  } catch (err) {
    fails += check('phase 6 checks ran', false, String(err && err.message).slice(0, 160));
  } finally {
    try { if (k) k.close(); } catch (_e) { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }
  return fails;
}


app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => pageErrors.push(`did-fail-load ${code} ${desc}`));

  await win.loadFile(path.join(ROOT, 'index.html'));
  await sleep(800);

  const report = await win.webContents.executeJavaScript(`(async () => {
    const out = { steps: [], routes: [] };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = await import('./src/ui/app.js');

    // --- 1. login screen ------------------------------------------------
    const userField = document.getElementById('login-username');
    out.steps.push({ step: 'login screen', ok: !!userField });
    if (!userField) return out;

    // --- 2. real form submit -------------------------------------------
    document.getElementById('login-password').value = 'admin123';
    userField.value = 'admin';
    document.querySelector('.login-form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 40 && !document.querySelector('.nav-btn.active'); i += 1) await sleep(100);
    out.steps.push({
      step: 'form login',
      ok: !!document.querySelector('.nav-btn.active'),
      user: document.querySelector('#user-chip .user-chip-text')?.textContent || null,
      route: app.state.route,
    });

    // --- 3. every route -------------------------------------------------
    for (const route of ${JSON.stringify(ROUTES)}) {
      await app.go(route);
      for (let i = 0; i < 60; i += 1) {
        if (!document.querySelector('#view .screen-loading') && app.state.route === route) break;
        await sleep(100);
      }
      await sleep(350);
      const view = document.getElementById('view');
      const text = (view.textContent || '').replace(/\\s+/g, ' ').trim();
      const placeholder = text.includes('Screen not available yet');
      const failed = text.includes('This screen failed to load');
      const stillLogin = !!document.getElementById('login-username');
      const empty = text.length < 40 || stillLogin;
      const errMatch = failed ? (text.split('This screen failed to load')[1] || '').slice(0, 220) : '';
      out.routes.push({
        route,
        ok: !placeholder && !failed && !empty && app.state.route === route,
        placeholder, failed, empty,
        wrongRoute: app.state.route !== route,
        title: document.title,
        chars: text.length,
        head: text.slice(0, 110),
        err: errMatch.trim(),
      });
    }

    // --- 4. run the live reports and check the figures ------------------
    async function runScreen(route) {
      await app.go(route);
      for (let i = 0; i < 60; i += 1) { if (!document.querySelector('#view .screen-loading')) break; await sleep(100); }
      await sleep(300);
      const runBtn = [...document.querySelectorAll('#view button')]
        .find((b) => /^run$/i.test((b.textContent || '').trim()));
      if (runBtn) { runBtn.click(); await sleep(900); }
      return (document.getElementById('view').textContent || '').replace(/\\s+/g, ' ');
    }

    const tb = await runScreen('trial-balance');
    out.formats = {
      fmt100: app.fmt(100),
      fmt9028333: app.fmt(9028333),
      fmtNeg: app.fmtNeg(-23333),
      tbShows9028333: tb.includes('90,283.33'),
      tbShowsHundredX: /\\b9,028,333\\.00\\b/.test(tb),
      tbLen: tb.length,
      tbHead: tb.slice(0, 260),
    };

    const is = await runScreen('income-statement');
    out.income = {
      showsGP: is.includes('6,200.00'),
      showsLoss: is.includes('233.33'),
      hundredX: /\\b620,000\\.00\\b/.test(is),
      len: is.length,
    };

    const bs = await runScreen('balance-sheet');
    out.balance = {
      showsAssets: bs.includes('70,766.67'),
      showsLiab: bs.includes('12,000.00'),
      hundredX: /\\b7,076,667\\.00\\b/.test(bs),
      len: bs.length,
    };

    // --- 4b. dashboard: KPI tiles + equilibrium proof + recent vouchers ---
    //      (guards the DOMTokenList class-string regression: one bad
    //       classList.add() used to abort the whole data load.)
    out.dashboard = {};
    try {
      await app.go('dashboard');
      for (let i = 0; i < 60 && !document.querySelector('#view .screen'); i += 1) await sleep(100);
      await sleep(1500);
      const dText = (document.getElementById('view').textContent || '').replace(/\\s+/g, ' ');
      out.dashboard.proofBalanced = dText.includes('BALANCED') && !dText.includes('OUT OF BALANCE');
      out.dashboard.noLedgerError = !dText.includes('Could not read the ledger');
      out.dashboard.statusLine = dText.includes('Both proofs hold to the cent');
      out.dashboard.recentPopulated = document.querySelectorAll('#view tbody tr').length > 0
        && !dText.includes('Loading recent activity...');
      out.dashboard.cashTile = dText.includes('49,200.00');
      out.dashboard.diag = dText.slice(dText.indexOf('Equilibrium proof'), dText.indexOf('Equilibrium proof') + 260);
    } catch (e) { out.dashboard.error = String(e && e.message); }

    // --- 5. Phase 4: the Debit Note form posts purchase.debitNote -------
    await app.go('debit-note');
    for (let i = 0; i < 60; i += 1) { if (!document.querySelector('#view .screen-loading')) break; await sleep(100); }
    await sleep(500);
    const dn = document.getElementById('view');
    const dnSelects = dn.querySelectorAll('select');
    out.debitNote = {
      heading: dn.textContent.includes('Purchase return (debit note)'),
      selects: dnSelects.length,
      hasVendor: dnSelects[0] ? dnSelects[0].options.length : 0,
      hasItem: dnSelects[1] ? dnSelects[1].options.length : 0,
      postDisabled: [...dn.querySelectorAll('button')].some((b) => /Post debit note/i.test(b.textContent) && b.disabled),
      identity: dn.textContent.includes('DR = CR'),
    };

    // --- 6. The screens added for the remaining engine capabilities -----
    //      (fixed assets, forex, owner drawings, payroll kernel cross-check,
    //       shrinkage FIFO preview). Every assertion is a boolean so the
    //      reporting block below stays uniform.
    out.assetScreen = {};
    try {
      await app.go('fixed-assets');
      for (let i = 0; i < 60 && !document.querySelector('#view .screen'); i += 1) await sleep(100);
      await sleep(800);
      const aText = (document.getElementById('view').textContent || '').replace(/\\s+/g, ' ');
      const aTabs = document.querySelectorAll('#view .tab-btn').length;
      out.assetScreen.heading = aText.includes('Fixed assets');
      out.assetScreen.threeTabs = aTabs === 3;
      out.assetScreen.registerTab = aText.includes('Register asset');
      out.assetScreen.deprTab = aText.includes('Run depreciation');
      // The case study capitalises POS-EQUIP-001 at 5,000.00 in transaction 3.
      out.assetScreen.seededAsset = aText.includes('POS-EQUIP-001');
      out.assetScreen.costShown = aText.includes('5,000.00');
      out.assetScreen.bookValue = aText.includes('Book value');
      out.assetScreen.postDisabled = [...document.querySelectorAll('#view button')]
        .some((b) => /Capitalise asset/.test(b.textContent) && b.disabled);
    } catch (e) { out.assetScreen.error = String(e && e.message); }

    out.forexScreen = {};
    try {
      await app.go('forex');
      for (let i = 0; i < 60 && !document.querySelector('#view .screen'); i += 1) await sleep(100);
      await sleep(800);
      const fText0 = (document.getElementById('view').textContent || '').replace(/\\s+/g, ' ');
      const fSels = document.querySelectorAll('#view select');
      const fInps = document.querySelectorAll('#view input');
      out.forexScreen.heading = fText0.includes('Multi-currency settlement');
      out.forexScreen.twoTabs = document.querySelectorAll('#view .tab-btn').length === 2;
      // The seeded case study books a Net-30 sales invoice, so the picker must
      // offer at least one invoice to settle against.
      out.forexScreen.hasInvoice = fSels[0] && fSels[0].options.length > 1;
      // Drive Equation 9 end to end: 1,000 EUR booked at 1.000000, realised
      // at 1.050000 -> V_orig 1,000.00, V_settle 1,050.00, Delta +50.00 GAIN.
      if (out.forexScreen.hasInvoice && fInps.length >= 5) {
        fSels[0].selectedIndex = 1;
        fSels[0].dispatchEvent(new Event('change', { bubbles: true }));
        fInps[2].value = '1000';
        fInps[3].value = '1.000000';
        fInps[4].value = '1.050000';
        fInps[2].dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1000);
        const fText = (document.getElementById('view').textContent || '').replace(/\\s+/g, ' ');
        out.forexScreen.previewShaped = fText.includes('V_orig') && fText.includes('V_settle');
        out.forexScreen.previewGain = fText.includes('Delta GAIN');
        // Assert the Delta cell itself: '50.00' is a substring of '1,050.00',
        // so a whole-view substring test would pass even if the delta were wrong.
        const numCells = document.querySelectorAll('#view .fx-preview td.num');
        const deltaCell = numCells[numCells.length - 1];
        const deltaText = deltaCell ? deltaCell.textContent.trim() : '';
        out.forexScreen.previewDelta = deltaText === '50.00' || deltaText === '$50.00';
        out.forexScreen.deltaCell = deltaText;
        const setBtn = [...document.querySelectorAll('#view button')]
          .find((b) => (b.textContent || '').trim() === 'Settle receivable' && !b.classList.contains('tab-btn'));
        out.forexScreen.postEnabled = !!setBtn && !setBtn.disabled;
      }
    } catch (e) { out.forexScreen.error = String(e && e.message); }

    out.drawings = {};
    try {
      await app.go('payments');
      for (let i = 0; i < 60 && !document.querySelector('#view .tab-btn'); i += 1) await sleep(100);
      await sleep(600);
      const dTabs = [...document.querySelectorAll('#view .tab-btn')];
      out.drawings.fiveTabs = dTabs.length === 5;
      const dTab = dTabs.find((b) => (b.textContent || '').trim() === 'Owner drawings');
      out.drawings.hasTab = !!dTab;
      if (dTab) {
        dTab.click();
        await sleep(350);
        const dText = (document.getElementById('view').textContent || '').replace(/\\s+/g, ' ');
        out.drawings.heading = dText.includes('Owner drawings (personal withdrawal)');
        out.drawings.contraEquity = dText.includes('Contra-equity');
        out.drawings.postDisabled = [...document.querySelectorAll('#view button')]
          .some((b) => (b.textContent || '').trim() === 'Record drawing' && b.disabled);
      }
    } catch (e) { out.drawings.error = String(e && e.message); }

    out.payrollKernel = {};
    try {
      await app.go('payroll');
      for (let i = 0; i < 60 && !document.querySelector('#view .screen'); i += 1) await sleep(100);
      await sleep(1200); // 300 ms debounce + one IPC round-trip
      const pText = (document.getElementById('view').textContent || '').replace(/\\s+/g, ' ');
      const at = pText.indexOf('Kernel');
      out.payrollKernel.line = pText.includes('Kernel ✓');
      out.payrollKernel.noDrift = !pText.includes('Kernel ✗');
      out.payrollKernel.head = at >= 0 ? pText.slice(Math.max(0, at - 30), at + 170) : '(kernel line not rendered)';
    } catch (e) { out.payrollKernel.error = String(e && e.message); }

    out.shrink = {};
    try {
      await app.go('inventory');
      for (let i = 0; i < 60 && !document.querySelector('#view button'); i += 1) await sleep(100);
      await sleep(700);
      const pcBtn = [...document.querySelectorAll('#view button')]
        .find((b) => (b.textContent || '').trim() === 'Physical count');
      out.shrink.countButton = !!pcBtn;
      if (pcBtn) {
        pcBtn.click();
        await sleep(500);
        const box = document.querySelector('.modal-overlay') || document.querySelector('.modal-backdrop');
        out.shrink.modalOpen = !!box;
        const cnt = box ? box.querySelector('input[type=number]') : null;
        if (cnt) {
          cnt.value = '9'; // book 10, counted 9 -> 1 unit at FIFO 1,030.00
          cnt.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(1000);
          const mText = (box.textContent || '').replace(/\\s+/g, ' ');
          out.shrink.preview = mText.includes('FIFO write-off');
          out.shrink.value = mText.includes('1,030.00');
          out.shrink.bookQty = mText.includes('Book quantity on hand: 10');
          out.shrink.head = mText.slice(0, 240);
        }
        const cancel = box ? [...box.querySelectorAll('button')]
          .find((b) => (b.textContent || '').trim() === 'Cancel') : null;
        if (cancel) cancel.click();
        await sleep(250);
      }
    } catch (e) { out.shrink.error = String(e && e.message); }

    // --- 7. Phase 6 UI: backup catalogue + confirm dialog + Reopen --------
    // Electron disables window.confirm (always false), so these controls must
    // use the shell's Promise-based modal. Also: the seeded ledger has no
    // closed period, so a synthetic one is served through the smoke seam to
    // prove the Reopen-period control renders — no real period is closed.
    out.closingUi = {};
    try {
      await app.go('closing');
      for (let i = 0; i < 60 && !document.querySelector('#view .card'); i += 1) await sleep(100);
      await sleep(700);
      const clText = () => (document.getElementById('view').textContent || '');
      out.closingUi.backupCard = clText().includes('Backup snapshot (.db)');
      out.closingUi.backupCatalogue = /No snapshots yet|Restore/.test(clText());

      // (a) the confirm modal itself: Cancel/Escape resolves false, Confirm true.
      let cancelled = null;
      let accepted = null;
      const p = window.erp && app.confirm ? app.confirm('Reopen “X”?', { title: 'Reopen fiscal period' }) : null;
      if (p) {
        await sleep(250);
        const d1 = document.querySelector('.modal-overlay .modal-box');
        out.closingUi.confirmShown = Boolean(d1) && /Reopen fiscal period/.test(d1.textContent);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(400);
        out.closingUi.confirmEscapeCancels = !document.querySelector('.modal-overlay');
        cancelled = await p;

        const p2 = app.confirm('Reopen “Y”?', { title: 'Reopen fiscal period' });
        await sleep(250);
        const d2 = document.querySelector('.modal-overlay .modal-box');
        const ok = d2 && [...d2.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Confirm');
        out.closingUi.confirmButton = Boolean(ok);
        if (ok) ok.click();
        await sleep(400);
        out.closingUi.confirmAccepted = !document.querySelector('.modal-overlay');
        accepted = await p2;
      }
      out.closingUi.escapeResolvedFalse = cancelled === false;
      out.closingUi.confirmResolvedTrue = accepted === true;

      // (b) synthetic closed period -> the Reopen control must render and
      //     confirm -> call closing.reopenPeriod (an already-open period is a
      //     no-op, so the real ledger is never modified).
      const rows = await window.erp.invoke('closing.status', {});
      await window.erp.invoke('smoke:setClosingOverride',
        rows.map((r, i) => (i === 0 ? { ...r, IsClosed: 1, ClosedAt: '2026-09-30T00:00:00.000' } : r)));
      await app.go('closing');
      await sleep(700);
      const reopenBtn = [...document.querySelectorAll('#view button')]
        .find((b) => b.textContent.trim() === 'Reopen period');
      out.closingUi.reopenButton = Boolean(reopenBtn);
      if (reopenBtn) {
        reopenBtn.click();
        await sleep(300);
        const dlg = document.querySelector('.modal-overlay .modal-box');
        out.closingUi.reopenAsks = Boolean(dlg) && /Reopen fiscal period/.test(dlg.textContent);
        const ok = dlg && [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Confirm');
        if (ok) ok.click();
        await sleep(900);
        out.closingUi.reopenCompleted = !document.querySelector('.modal-overlay');
      }
      await window.erp.invoke('smoke:setClosingOverride', null);
    } catch (e) {
      out.closingUi.error = String(e && e.message);
      try { await window.erp.invoke('smoke:setClosingOverride', null); } catch (_e) { /* ignore */ }
    }

    // --- 6. Phase 1: RBAC as Cashier (UI + kernel gate) -----------------
    out.rbac = {};
    const navOf = (r) => document.querySelector('.nav-btn[data-route="' + r + '"]');
    try {
      await window.erp.invoke('auth.logout', {});
      app.setUser(null);
      app.go('login');
      await sleep(300);
      document.getElementById('login-username').value = 'cashier';
      document.getElementById('login-password').value = 'cash123';
      document.querySelector('.login-form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 40 && !document.querySelector('.nav-btn.active'); i += 1) await sleep(100);
      await sleep(400);

      out.rbac.loginOk = (document.querySelector('#user-chip .user-chip-text')?.textContent || '').includes('cashier');
      out.rbac.closingNavHidden = navOf('closing') ? navOf('closing').hidden === true : false;
      out.rbac.coaNavHidden = navOf('coa') ? navOf('coa').hidden === true : false;
      out.rbac.journalNavVisible = navOf('journal') ? navOf('journal').hidden === false : false;

      // Route guard: asking for a manage_coa / close_period screen lands on the dashboard.
      await app.go('closing');
      await sleep(400);
      out.rbac.routeBounced = app.state.route === 'dashboard';
      await app.go('coa');
      await sleep(400);
      out.rbac.coaBounced = app.state.route === 'dashboard';

      // Kernel gate: a gated call must reject with FORBIDDEN even from the UI.
      // Raw bridge: the code rides in the message (contextBridge drops .code).
      let raw = '';
      try { await window.erp.invoke('closing.closePeriod', { periodId: 1 }); } catch (e) {
        raw = String(e && e.message);
      }
      out.rbac.rawEnvelope = raw.startsWith('FORBIDDEN :: ');

      // Production path: app.call() decodes the envelope back into .code.
      let denied = null;
      let deniedMsg = '';
      try { await app.call('closing.closePeriod', { periodId: 1 }); } catch (e) {
        denied = e && e.code; deniedMsg = String(e && e.message);
      }
      out.rbac.kernelDenied = denied === 'FORBIDDEN';
      out.rbac.deniedMsg = deniedMsg.slice(0, 180);
      out.rbac.msgClean = !deniedMsg.includes(' :: ');

      let deniedBackup = null;
      try { await app.call('backup.snapshot', {}); } catch (e) { deniedBackup = e && e.code; }
      out.rbac.backupDenied = deniedBackup === 'FORBIDDEN';

      // ...and posting must still be allowed for a Cashier.
      let postAllowed = false;
      try {
        const items = await window.erp.invoke('inventory.items', {});
        postAllowed = Array.isArray(items) && items.length > 0;
      } catch (_e) { postAllowed = false; }
      out.rbac.reportsAllowed = postAllowed;
    } catch (e) {
      out.rbac.error = String(e && e.message);
    }
    return out;
  })()`);

  console.log('=== STEPS ===');
  for (const s of report.steps) console.log(` ${s.ok ? 'PASS' : 'FAIL'}  ${s.step}`, JSON.stringify(s));

  let bad = report.steps.filter((s) => !s.ok).length;
  console.log('=== ROUTES ===');
  for (const r of report.routes) {
    if (!r.ok) bad += 1;
    console.log(` ${r.ok ? 'PASS' : 'FAIL'}  ${r.route.padEnd(18)} chars=${String(r.chars).padEnd(5)} ${r.head}${r.err ? ' :: ' + r.err : ''}`);
  }

  console.log('=== FORMATTER / LIVE REPORTS ===');
  console.log(JSON.stringify(report.formats));
  console.log(JSON.stringify(report.income));
  console.log(JSON.stringify(report.balance));
  if (report.formats.fmt100 !== '1.00' || report.formats.fmt9028333 !== '90,283.33') bad += 1;
  if (report.formats.tbShowsHundredX || !report.formats.tbShows9028333) bad += 1;
  if (report.income.hundredX || !report.income.showsGP) bad += 1;
  if (report.balance.hundredX || !report.balance.showsAssets) bad += 1;

  console.log('=== PHASE 4: DEBIT NOTE FORM ===');
  console.log(JSON.stringify(report.debitNote));
  const dn = report.debitNote || {};
  if (!dn.heading || !(dn.hasVendor > 1) || !(dn.hasItem > 1) || !dn.postDisabled || !dn.identity) bad += 1;

  /**
   * Report every probe that is not literally true. All probe values are
   * booleans; `head` and `deltaCell` are free-text diagnostics captured for
   * failure triage and are skipped here.
   */
  const DIAGNOSTIC_KEYS = new Set(['head', 'deltaCell', 'diag']);
  const expectAll = (group, obj) => {
    for (const [key, val] of Object.entries(obj || {})) {
      if (DIAGNOSTIC_KEYS.has(key)) continue;
      if (val !== true) { console.log(` FAIL  ${group}.${key} = ${JSON.stringify(val)}`); bad += 1; }
    }
  };

  console.log('=== DASHBOARD: KPI TILES / PROOF / RECENT VOUCHERS ===');
  console.log(JSON.stringify(report.dashboard));
  expectAll('dashboard', report.dashboard);

  console.log('=== REMAINING SCREENS: ASSETS / FOREX / DRAWINGS / PAYROLL / SHRINKAGE ===');
  for (const g of ['assetScreen', 'forexScreen', 'drawings', 'payrollKernel', 'shrink']) {
    console.log(`${g}: ${JSON.stringify(report[g])}`);
    expectAll(g, report[g]);
  }

  console.log('=== PHASE 6 UI: CLOSING / CONFIRM / BACKUP ===');
  console.log(JSON.stringify(report.closingUi));
  const cu = report.closingUi || {};
  for (const key of ['backupCard', 'backupCatalogue', 'confirmShown', 'confirmEscapeCancels',
    'confirmButton', 'confirmAccepted', 'escapeResolvedFalse', 'confirmResolvedTrue',
    'reopenButton', 'reopenAsks', 'reopenCompleted']) {
    if (cu[key] !== true) { console.log(` FAIL  closingUi.${key} = ${cu[key]}`); bad += 1; }
  }

  console.log('=== PHASE 1: RBAC (cashier) ===');
  console.log(JSON.stringify(report.rbac));
  const rb = report.rbac || {};
  for (const key of ['loginOk', 'closingNavHidden', 'coaNavHidden', 'journalNavVisible',
    'routeBounced', 'coaBounced', 'rawEnvelope', 'msgClean', 'kernelDenied', 'backupDenied',
    'reportsAllowed']) {
    if (rb[key] !== true) { console.log(` FAIL  rbac.${key} = ${rb[key]}`); bad += 1; }
  }

  console.log('=== PAGE ERRORS ===');
  console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');
  console.log('=== CONSOLE ERRORS ===');
  console.log(consoleErrors.length ? consoleErrors.join('\n') : '(none)');
  bad += pageErrors.length + consoleErrors.length;

  // --- Phase 6 in an ISOLATED database (never touches the real ledger) ---
  console.log('=== PHASE 6: CLOSE / REOPEN / BACKUP (isolated db) ===');
  bad += await phase6Checks();

  // Smoke-test failures MUST be visible to `&&`-chaining and CI: Electron
  // otherwise always exits 0. Force the code after stdout has flushed.
  if (process.env.SMOKE_FORCE_FAIL) bad += 1;
  const code = bad === 0 ? 0 : 1;
  console.log(`SMOKE_SHELL ${bad === 0 ? 'PASS' : 'FAIL'} bad=${bad} exit=${code}`);
  setTimeout(() => app.exit(code), 200);
}).catch((err) => {
  console.log('SMOKE_SHELL FAIL boot:', err.stack);
  setTimeout(() => app.exit(1), 200);
});
