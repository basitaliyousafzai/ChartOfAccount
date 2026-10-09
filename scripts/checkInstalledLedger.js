'use strict';

/**
 * Verify the ledger an INSTALLED copy actually created.
 *
 *     npm run check:install                       # default install location
 *     node scripts/checkInstalledLedger.js <path> # any database file
 *
 * This is the honest end-to-end check for the packaged app: it opens the very
 * file `resolveDataPath()` copied out of the installer on first run and
 * re-derives the Section 6 case study from it, rather than trusting that the
 * build step and the first-run copy worked.
 *
 * Exit code 0 only when every figure matches.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const defaultDb = path.join(os.homedir(), 'AppData', 'Roaming', 'Apex ERP', 'apex_erp.db');
const dbPath = process.argv[2] || process.env.ERP_DB_PATH || defaultDb;

function fail(msg) {
  console.error(`CHECK FAIL  ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(dbPath)) fail(`database not found: ${dbPath}`);
console.log(`CHECK  ${dbPath}`);

process.env.ERP_DB_PATH = dbPath;
const { getKernel } = require('../src/main/kernel');

let kernel;
let bad = 0;
let ran = 0;
try {
  kernel = getKernel();

  const asOf = kernel.db.prepare('SELECT MAX(VoucherDate) AS d FROM JournalVouchers').get().d;
  const tb = kernel.report.trialBalance({ asOfDate: asOf, includeZero: false });
  const bs = kernel.report.balanceSheet({ asOfDate: asOf });

  const vouchers = kernel.db.prepare('SELECT COUNT(*) AS c FROM JournalVouchers WHERE IsPosted = 1').get().c;
  const users = kernel.db.prepare('SELECT COUNT(*) AS c FROM Users').get().c;
  const accounts = kernel.db.prepare('SELECT COUNT(*) AS c FROM Accounts').get().c;

  /** [label, actual, expected] — counts are plain integers, money is cents. */
  const checks = [
    ['posted vouchers', vouchers, 15, 0],
    ['users', users, 3, 0],
    ['accounts seeded', accounts > 0, true, null],
    ['TB debit column', tb.tbDebit, 9028333, 2],
    ['TB credit column', tb.tbCredit, 9028333, 2],
    ['total assets', bs.totalAssets, 7076667, 2],
    ['total liabilities', bs.totalLiabilities, 1200000, 2],
    ['owner equity', bs.totalEquity, 5876667, 2],
    ['ledger delta (Invariant 1)', tb.delta, 0, 2],
    ['TB column delta (Equation 10)', tb.tbDelta, 0, 2],
    ['balance sheet delta', bs.delta, 0, 2],
  ];

  ran = checks.length;
  for (const [label, got, want, dp] of checks) {
    const ok = got === want;
    if (!ok) bad += 1;
    const shown = dp === null
      ? String(got)
      : (dp === 0 ? String(got) : (got / 100).toFixed(dp));
    const wanted = dp === null
      ? String(want)
      : (dp === 0 ? String(want) : (want / 100).toFixed(dp));
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} ${shown.padStart(12)}${ok ? '' : `   expected ${wanted}`}`);
  }

  console.log(`  ${'driver'.padEnd(28)} ${kernel.system.info().driverLabel}`);
  console.log(`  ${'as of'.padEnd(28)} ${asOf || '(no vouchers)'}`);
} catch (err) {
  fail(`could not read the ledger: ${err && err.stack ? err.stack : err}`);
} finally {
  try { if (kernel) kernel.close(); } catch (_err) { /* already closed */ }
}

console.log(`CHECK ${bad === 0 ? 'OK' : 'FAIL'}  ${ran - bad}/${ran} assertions`);
process.exit(bad === 0 ? 0 : 1);
