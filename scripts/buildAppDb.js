'use strict';

/**
 * Build-time step: produce the fully-seeded ledger that ships inside the
 * installer.
 *
 *     node scripts/buildAppDb.js   ->   build/apex_erp.db
 *
 * Why at build time rather than on first launch:
 *   • a packaged app has no Node CLI, so `npm run seed` does not exist for the
 *     person who installs it;
 *   • seeding at runtime would make every installation's numbers depend on the
 *     day it was first opened, which is exactly the trap the case study fell
 *     into (see DEVIATIONS §17).
 *
 * Building the file once means every install opens showing precisely the
 * figures `npm run verify` asserts — TB 90,283.33 = 90,283.33, assets
 * 70,766.67 — on any machine. The build FAILS if they differ.
 *
 * The result is shipped as an extraResource and copied into Electron's
 * userData on first run (see resolveDataPath in src/main/kernel.js).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');
const DB_PATH = path.join(OUT_DIR, 'apex_erp.db');

/** Expected case-study figures, in integer cents (Invariant 3). */
const EXPECT = {
  vouchers: 15,
  tbDebit: 9028333,   // 90,283.33 - the NETTED Trial Balance debit column
  tbCredit: 9028333,  // 90,283.33 - the NETTED Trial Balance credit column
  totalAssets: 7076667, // 70,766.67
};

function fail(msg) {
  console.error(`BUILD_DB FAIL  ${msg}`);
  process.exit(1);
}

/* ------------------------------------------------- 1. clean slate ------ */
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${DB_PATH}${suffix}`, { force: true });

/* ---------------------------------- 2. seed through the real CLI ------- */
console.log('BUILD_DB  seeding', DB_PATH);
const seeded = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seedDemoData.js'), '--fresh'], {
  cwd: ROOT,
  env: { ...process.env, ERP_DB_PATH: DB_PATH },
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});
if (seeded.status !== 0) {
  if (seeded.stdout) process.stdout.write(seeded.stdout);
  if (seeded.stderr) process.stderr.write(seeded.stderr);
  fail(`seedDemoData.js exited ${seeded.status}`);
}

/* --------------------------- 3. re-open and assert the figures --------- */
process.env.ERP_DB_PATH = DB_PATH;
const { getKernel } = require('../src/main/kernel'); // eslint-disable-line global-require

let kernel;
try {
  kernel = getKernel();

  const vouchers = kernel.db.prepare(
    'SELECT COUNT(*) AS c FROM JournalVouchers WHERE IsPosted = 1',
  ).get().c;
  if (vouchers !== EXPECT.vouchers) {
    fail(`posted ${vouchers} vouchers, expected ${EXPECT.vouchers}`);
  }

  const asOf = kernel.db.prepare('SELECT MAX(VoucherDate) AS d FROM JournalVouchers').get().d;
  const tb = kernel.report.trialBalance({ asOfDate: asOf, includeZero: false });
  const bs = kernel.report.balanceSheet({ asOfDate: asOf });

  const checks = [
    // The published TB figures are the NETTED columns (ΣDR per account, split
    // by sign) - the same fields verifyCaseStudy.js asserts at 2.a / 2.b.
    // `totalDebit`/`totalCredit` are the gross ledger sums and are larger;
    // they are checked below only for the zero-tolerance delta.
    ['trial balance DR column', tb.tbDebit, EXPECT.tbDebit],
    ['trial balance CR column', tb.tbCredit, EXPECT.tbCredit],
    ['total assets', bs.totalAssets, EXPECT.totalAssets],
  ];
  for (const [label, got, want] of checks) {
    if (got !== want) fail(`${label}: ${(got / 100).toFixed(2)}, expected ${(want / 100).toFixed(2)}`);
    console.log(`BUILD_DB  ${label.padEnd(22)} ${(got / 100).toFixed(2).padStart(12)}`);
  }

  // Invariant 1: |Sigma DR - Sigma CR| = 0.00, on both the gross ledger and
  // the netted columns. Equation 10 + the balance-sheet equilibrium.
  const invariants = [
    ['ledger delta (Invariant 1)', tb.delta],
    ['TB column delta (Equation 10)', tb.tbDelta],
    ['balance sheet delta', bs.delta],
  ];
  for (const [label, got] of invariants) {
    if (got !== 0) fail(`${label}: ${(got / 100).toFixed(2)}, expected 0.00`);
    console.log(`BUILD_DB  ${label.padEnd(22)} ${'0.00'.padStart(12)}`);
  }

  console.log(`BUILD_DB  driver=${kernel.system.info().driverLabel}  vouchers=${vouchers}  asOf=${asOf}`);
} catch (err) {
  fail(`verification threw: ${err && err.stack ? err.stack : err}`);
} finally {
  // close() runs PRAGMA wal_checkpoint(TRUNCATE) first, so the shipped file is
  // self-contained: no -wal/-shm sidecars need to travel with it.
  try { if (kernel) kernel.close(); } catch (_e) { /* ignore */ }
}

/* -------------------------------------- 4. prove it is self-contained -- */
for (const suffix of ['-wal', '-shm']) {
  if (fs.existsSync(`${DB_PATH}${suffix}`)) fail(`sidecar ${suffix} survived the checkpoint`);
}

const bytes = fs.statSync(DB_PATH).size;
if (bytes < 4096) fail(`database is implausibly small (${bytes} bytes)`);

console.log(`BUILD_DB OK  ${DB_PATH}  ${(bytes / 1024).toFixed(0)} KB`);
