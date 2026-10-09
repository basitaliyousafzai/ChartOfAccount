'use strict';

/**
 * Kernel - single façade over the whole engine (Phase 1..6 wiring).
 * ----------------------------------------------------------------------------
 * Exposed to the renderer through `window.erp.invoke(method, args)`, where
 * `method` is a dotted path such as `ledger.record` or `report.trialBalance`.
 *
 * The surface is published THREE ways so the IPC bridge stays trivial:
 *   kernel.invoke('auth.login', args)   <- preferred
 *   kernel['auth.login'](args)          <- flat dotted key (own property)
 *   kernel.auth.login(args)             <- nested namespace
 *
 * All services share one SQLite handle; every write happens inside a
 * transaction, so a failed posting never leaves a half-written ledger.
 */

const path = require('path');
const fs = require('fs');

const { openDatabase, driverName } = require('../database/db');
const { runMigrations, currentVersion } = require('../database/migrations');

const { AccountService } = require('../services/accountService');
const { ValidationService, PERMISSIONS } = require('../services/validationService');
const { LedgerService } = require('../services/ledgerService');
const { InventoryService } = require('../services/inventoryService');
const { TransactionService } = require('../services/transactionService');
const { PayrollService } = require('../services/payrollService');
const { AssetService } = require('../services/assetService');
const { ForexService } = require('../services/forexService');
const { ReportService } = require('../services/reportService');
const { ClosingService } = require('../services/closingService');
const { AuthService } = require('../services/authService');
const { CoaGenerator } = require('../services/coaGenerator');
const { BackupService } = require('../services/backupService');
const { ExportService } = require('../services/exportService');

const VERSION = require('../../package.json').version;

/**
 * Packaged builds cannot run `npm run seed`, so the fully-seeded case-study
 * ledger ships inside the installer as an extraResource (resources/seed/
 * apex_erp.db, produced by `scripts/buildAppDb.js`) and is copied into the
 * live database location the first time the app opens it.
 *
 * Idempotent by construction - it only ever copies when the target does not
 * exist - and done via temp-file + rename so an interrupted first run cannot
 * leave a half-written ledger behind that the next launch would trust.
 */
function installSeedIfAbsent(dbPath) {
  if (!dbPath || dbPath === ':memory:' || fs.existsSync(dbPath)) return false;

  const candidates = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'seed', 'apex_erp.db'));
  }
  if (process.env.ERP_SEED_DB) candidates.push(process.env.ERP_SEED_DB);

  for (const seed of candidates) {
    try {
      if (!fs.existsSync(seed)) continue;
      const tmp = `${dbPath}.installing`;
      fs.copyFileSync(seed, tmp);
      fs.renameSync(tmp, dbPath);
      // The seed is built fully checkpointed (no sidecars travel with it), so
      // drop any stale ones rather than mix two generations of the ledger.
      for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
      // eslint-disable-next-line no-console
      console.log(`[kernel] installed demo ledger -> ${dbPath}`);
      return true;
    } catch (_err) { /* try the next candidate */ }
  }
  return false;
}

function resolveDataPath() {
  if (process.env.ERP_DB_PATH) return process.env.ERP_DB_PATH;

  const withSeed = (p) => { installSeedIfAbsent(p); return p; };

  // Packaged builds are unpacked into app.asar, which is read-only. Probing
  // `<app.asar>/data` would only ever fail after a confusing mkdir error, so
  // skip it entirely and go straight to Electron's per-user data directory.
  const inAsar = __dirname.includes(`${path.sep}app.asar${path.sep}`)
    || __dirname.endsWith(`${path.sep}app.asar`);

  // Single source of truth: the project's data/ directory (the same file the
  // CLI uses - `npm run seed`, `npm run verify`). Deriving it from __dirname
  // (not process.cwd()) keeps it stable whether the app is launched from a
  // shell, a shortcut, or double-clicked in Explorer.
  if (!inAsar) {
    const projectData = path.join(__dirname, '..', '..', 'data');
    try {
      if (!fs.existsSync(projectData)) fs.mkdirSync(projectData, { recursive: true });
      fs.accessSync(projectData, fs.constants.W_OK);
      return withSeed(path.join(projectData, 'apex_erp.db'));
    } catch (_err) { /* read-only install - fall back to Electron's userData */ }
  }

  let userData = null;
  try {
    // Only available inside the Electron main process.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      userData = electron.app.getPath('userData');
    }
  } catch (_err) { /* running under plain Node (CLI / tests) */ }
  const dir = userData || path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return withSeed(path.join(dir, 'apex_erp.db'));
}

class Kernel {
  constructor({ dbPath = null, fresh = false } = {}) {
    this.dbPath = dbPath || resolveDataPath();
    /** Phase 1 RBAC: role of the signed-in user; null = anonymous (fail closed). */
    this.sessionRole = null;
    if (fresh && this.dbPath !== ':memory:' && fs.existsSync(this.dbPath)) {
      for (const suffix of ['', '-wal', '-shm']) {
        const file = `${this.dbPath}${suffix}`;
        if (fs.existsSync(file)) fs.rmSync(file);
      }
    }
    this.db = openDatabase(this.dbPath);
    runMigrations(this.db);

    // --- services (owned by the kernel, never exposed to the renderer) ------
    this.authSvc = new AuthService(this.db);
    this.accountSvc = new AccountService(this.db);
    this.validationSvc = new ValidationService(this.db, this.accountSvc);
    this.ledgerSvc = new LedgerService(this.db);
    this.inventorySvc = new InventoryService(this.db, this.accountSvc);
    this.transactionSvc = new TransactionService(this.db);
    this.payrollSvc = new PayrollService(this.db);
    this.assetSvc = new AssetService(this.db);
    this.forexSvc = new ForexService(this.db);
    this.reportSvc = new ReportService(this.db);
    this.closingSvc = new ClosingService(this.db);
    this.generatorSvc = new CoaGenerator(this.db);
    this.backupSvc = new BackupService(this.db, { dbPath: this.dbPath, appDataDir: path.dirname(this.dbPath) });
    this.exportSvc = new ExportService(this.db, { appDataDir: path.dirname(this.dbPath) });

    // Flat dotted aliases: kernel['ledger.record'](args) works out of the box.
    Object.assign(this, this.methodTable);
  }

  close() { this.db.close(); }

  /* ------------------------------------------------------------- namespaces */

  get system() {
    return {
      info: () => ({
        driver: driverName(),
        driverLabel: driverName() === 'better-sqlite3' ? 'better-sqlite3 (native)' : 'node:sqlite (built-in)',
        dbPath: this.dbPath,
        version: VERSION,
        schemaVersion: currentVersion(this.db),
        nodeVersion: process.versions.node,
      }),
      settings: () => this.authSvc.getSettings(),
      setSetting: ({ key, value }) => this.authSvc.setSetting(key, value),
    };
  }

  get auth() {
    return {
      /** Idempotent: users + settings + canonical COA + fiscal periods. */
      bootstrap: () => {
        const users = this.authSvc.seed();
        const accounts = this.accountSvc.seedChartOfAccounts();
        const periods = this.closingSvc.ensurePeriodsFor(new Date().toISOString().slice(0, 10));
        return { ...users, accounts, periods };
      },
      login: (args) => {
        // A failed login must never leave a previous session's role behind.
        this.sessionRole = null;
        if (!this.db.prepare('SELECT COUNT(*) AS c FROM Users').get().c) this.auth.bootstrap();
        const user = this.authSvc.login(args);
        // Phase 1 RBAC: the kernel now knows who is signed in. Every gated
        // method below checks this role until auth.logout clears it.
        this.setSessionRole(user && user.role);
        return user;
      },
      logout: () => this.clearSessionRole(),
      session: () => ({ role: this.sessionRole, permissions: PERMISSIONS[this.sessionRole] || [] }),
      permissions: ({ role }) => PERMISSIONS[role] || [],
      users: () => this.authSvc.listUsers(),
      changePassword: (args) => this.authSvc.changePassword(args),
      can: ({ role, capability }) => (PERMISSIONS[role] || []).includes(capability),
    };
  }

  get coa() {
    return {
      tree: (args = {}) => this.accountSvc.buildTree({ search: args.search || null, asOfDate: args.asOfDate || null }),
      list: (args = {}) => this.accountSvc.list(args),
      nextChildCode: ({ parentCode }) => ({ code: this.accountSvc.nextChildCode(parentCode) }),
      add: (args) => this.accountSvc.addAccount(args),
      balance: ({ accountCode, asOfDate = null, includeChildren = false }) =>
        this.accountSvc.balanceOf(accountCode, { asOfDate, includeChildren }),
      get: ({ accountCode }) => this.accountSvc.getByCode(accountCode),
    };
  }

  get wizard() {
    return {
      steps: () => this.generatorSvc.steps(),
      generate: (args = {}) => this.generatorSvc.generate(args.answers || args),
    };
  }

  get ledger() {
    return {
      record: (args) => this.ledgerSvc.recordVoucher(args),
      reverse: (args) => this.ledgerSvc.reverseVoucher(args.voucherId, args),
      get: ({ voucherId }) => this.ledgerSvc.getVoucher(voucherId),
      findByVoucherNo: ({ voucherNo }) => this.ledgerSvc.findByVoucherNo(voucherNo),
      list: (args = {}) => this.ledgerSvc.listVouchers(args),
      ledgerCard: (args) => this.ledgerSvc.ledgerCard(args.accountCode, args),
      grossTotals: (args = {}) => this.ledgerSvc.grossTotals(args),
      types: () => ({ types: LedgerService.VOUCHER_TYPES }),
    };
  }

  get inventory() {
    return {
      items: () => this.inventorySvc.listItems(),
      createItem: (args) => this.inventorySvc.createItem(args),
      lots: ({ itemCode }) => this.inventorySvc.lots(itemCode),
      valuation: ({ itemCode }) => this.inventorySvc.valuation(itemCode),
      movements: (args = {}) => this.inventorySvc.movements(args.itemCode, args),
      /**
       * Read-only Equation 4 dry run: what the FIFO write-off WOULD cost,
       * before any shrinkage is posted. Shares its layering maths with
       * `inventory.shrinkage`, so the preview and the posting cannot drift.
       */
      previewFifoCost: (args) => this.inventorySvc.previewFifoCost(args.itemCode, args.qty),
      shrinkage: (args) => this.transactionSvc.inventoryShrinkage(args),
    };
  }

  get report() {
    return {
      trialBalance: (args = {}) => this.reportSvc.trialBalance(args),
      incomeStatement: (args) => this.reportSvc.incomeStatement(args),
      balanceSheet: (args) => this.reportSvc.balanceSheet(args),
      proof: (args = {}) => this.reportSvc.proof(args),
      entities: (args = {}) => this.reportSvc.entities(args),
      dashboard: (args = {}) => this.reportSvc.dashboard(args),
      accountBalances: (args = {}) => this.reportSvc.accountBalances(args),
    };
  }

  get closing() {
    return {
      status: () => this.closingSvc.status(),
      closePeriod: (args) => this.closingSvc.closePeriod(args),
      reopenPeriod: (args) => this.closingSvc.reopenPeriod(args),
      ensurePeriods: ({ date }) => ({ periods: this.closingSvc.ensurePeriodsFor(date) }),
    };
  }

  get backup() {
    return {
      snapshot: (args = {}) => this.backupSvc.snapshot(args),
      dumpJson: (args = {}) => this.backupSvc.dumpJson(args),
      list: () => this.backupSvc.list(),
      // Restore swaps the .db file under the live handle, then re-applies the
      // migration set so an older snapshot catches up to the current schema.
      restore: (args) => {
        const result = this.backupSvc.restore(args);
        runMigrations(this.db);
        return result;
      },
    };
  }

  get export() {
    return {
      workbook: (args) => this.exportSvc.workbook(args),
      pdf: (args) => this.exportSvc.pdf(args),
      kinds: () => ({ kinds: ['trialBalance', 'incomeStatement', 'balanceSheet', 'ledgerCard', 'journal'] }),
    };
  }

  /** Section 5 posting matrix - already flat names: 'pos.sale', 'ar.receipt', ... */
  get documents() {
    return {
      'pos.sale': (args) => this.transactionSvc.posSale(args),
      'sales.invoice': (args) => this.transactionSvc.salesInvoice(args),
      'sales.creditNote': (args) => this.transactionSvc.creditNote(args),
      'purchase.bill': (args) => this.transactionSvc.purchaseBill(args),
      'purchase.debitNote': (args) => this.transactionSvc.purchaseDebitNote(args),
      'ar.receipt': (args) => this.transactionSvc.arReceipt(args),
      'ap.payment': (args) => this.transactionSvc.apPayment(args),
      'expense.pay': (args) => this.transactionSvc.expensePay(args),
      'capital.deposit': (args) => this.transactionSvc.capitalDeposit(args),
      'owner.drawings': (args) => this.transactionSvc.ownerDrawings(args),
      'transfer.tillToBank': (args) => this.transactionSvc.transferTillToBank(args),
      'payroll.disburse': (args) => this.payrollSvc.disburse(args),
      'payroll.calculate': (args) => this.payrollSvc.calculate(args),
      'assets.register': (args) => this.assetSvc.register(args),
      'assets.list': () => this.assetSvc.list(),
      'assets.runDepreciation': (args) => this.assetSvc.runDepreciation(args),
      'forex.settle': (args) => this.forexSvc.settle(args),
      'forex.preview': (args) => this.forexSvc.preview(args),
      'forex.history': () => this.forexSvc.history(),
      'inventory.shrinkage': (args) => this.transactionSvc.inventoryShrinkage(args),
    };
  }

  /** Flat map of every callable method: 'namespace.name' -> function. */
  get methodTable() {
    if (this._methodTable) return this._methodTable;
    const namespaces = ['system', 'auth', 'coa', 'wizard', 'ledger', 'inventory', 'report', 'closing', 'backup', 'export'];
    const map = {};
    for (const namespace of namespaces) {
      for (const [name, fn] of Object.entries(this[namespace])) {
        map[`${namespace}.${name}`] = fn;
      }
    }
    Object.assign(map, this.documents);
    this._methodTable = map;
    return map;
  }

  /**
   * Entry point used by the IPC bridge (dotted or flat names).
   *
   * Phase 1 RBAC: the session role lives in the KERNEL (set by a successful
   * `auth.login`, cleared by `auth.logout`), never in the payload, so the
   * renderer cannot assert a role of its own. Every method with an entry in
   * CAPABILITIES is checked against PERMISSIONS[sessionRole] before it runs;
   * methods with no entry are public (login, bootstrap, introspection).
   * @param {string} method dotted kernel method name
   * @param {object} args payload
   */
  invoke(method, args = {}) {
    const handler = this.methodTable[method];
    if (typeof handler !== 'function') {
      return Promise.reject(Object.assign(new Error(`Unknown kernel method: ${method}`), { code: 'NOT_FOUND' }));
    }
    try {
      this.validationSvc.assertAuthorized(method, this.sessionRole);
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve().then(() => handler(args && typeof args === 'object' ? args : {}));
  }

  /** Record the signed-in role after a successful authentication. */
  setSessionRole(role) {
    this.sessionRole = typeof role === 'string' && role ? role : null;
    return this.sessionRole;
  }

  /** Drop the session (logout). The next gated call fails closed. */
  clearSessionRole() {
    this.sessionRole = null;
    return { loggedOut: true };
  }
}

/** Process-wide singleton (the renderer expects one shared database handle). */
let singleton = null;

function getKernel(options = {}) {
  if (!singleton) singleton = new Kernel(options);
  return singleton;
}

function resetKernel() {
  if (singleton) { try { singleton.close(); } catch (_err) { /* already closed */ } }
  singleton = null;
}

const kernel = getKernel();

module.exports = kernel;
// NOTE: `module.exports` IS the kernel instance, so this assignment would
// otherwise shadow Kernel.prototype.invoke with an arrow that calls itself.
// Bind to the prototype method explicitly instead.
module.exports.invoke = (method, args) => Kernel.prototype.invoke.call(getKernel(), method, args);
module.exports.Kernel = Kernel;
module.exports.getKernel = getKernel;
module.exports.resetKernel = resetKernel;
module.exports.PERMISSIONS = PERMISSIONS;
