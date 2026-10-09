'use strict';

/**
 * Section 6 acceptance harness - independently re-seeds the 15-transaction
 * "Apex Tech Store" case study into a throwaway database and asserts every
 * figure the SRS publishes, plus the four engine invariants.
 *
 * Usage:
 *   npm run verify
 *
 * Exit code 0 = every assertion held, 1 = at least one failed.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(root, 'data', 'verify_case_study.db');

/* ------------------------------------------------------------------ setup */

function wipe(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${file}${suffix}`;
    if (fs.existsSync(target)) fs.rmSync(target);
  }
}

wipe(dbPath);

console.log('================================================================');
console.log('  SRS v3.0.0 - SECTION 6 CASE STUDY VERIFICATION');
console.log('================================================================\n');
console.log('  Step 1/2  seeding the 15 transactions into a clean database...\n');

const seed = spawnSync(process.execPath, [path.join(root, 'scripts', 'seedDemoData.js'), '--fresh'], {
  env: { ...process.env, ERP_DB_PATH: dbPath },
  stdio: 'inherit',
});
if (seed.status !== 0) {
  console.error('\nFAIL: the seeder itself crashed - see output above.');
  process.exit(1);
}

process.env.ERP_DB_PATH = dbPath;
const kernel = require(path.join(root, 'src', 'main', 'kernel.js'));
const money = require(path.join(root, 'src', 'core', 'money.js'));
const { COA } = require(path.join(root, 'src', 'services', 'coaSeed.js'));

const asOf = kernel.db.prepare('SELECT MAX(VoucherDate) AS d FROM JournalVouchers').get().d;
const from = kernel.db.prepare('SELECT MIN(VoucherDate) AS d FROM JournalVouchers').get().d;

console.log(`\n  Step 2/2  asserting figures for ${from} .. ${asOf}\n`);

/* ------------------------------------------------------------- assertion */

const results = [];
const cents = (v) => money.formatCents(v);

function expect(label, actual, expected) {
  results.push({ label, actual, expected, ok: actual === expected });
}

/** Same, but the value is a count/flag rather than an amount of money. */
function expectCount(label, actual, expected) {
  results.push({ label, actual, expected, ok: actual === expected, raw: true });
}

/** netDebitMinusCredit = signed (DR - CR) - direction-free, so it is unambiguous. */
function net(accountCode) {
  return kernel.coa.balance({ accountCode, asOfDate: asOf }).netDebitMinusCredit;
}

function section(title) {
  console.log('----------------------------------------------------------------');
  console.log(`  ${title}`);
}

/* -------------------------------------------- 1. structural / invariants */

section('1. Engine invariants');

const vouchers = kernel.db.prepare('SELECT * FROM JournalVouchers ORDER BY VoucherId').all();
expectCount('1.1  exactly 15 vouchers posted', vouchers.length, 15);
expectCount('1.2  every voucher is committed (IsPosted = 1)',
  vouchers.filter((v) => v.IsPosted === 1).length, 15);
expectCount('1.3  case study posts exactly one voucher per transaction',
  vouchers.filter((v) => v.IsReversal === 0).length, 15);

const unbalanced = kernel.db.prepare(`
  SELECT v.VoucherId FROM JournalVouchers v
   WHERE ABS((SELECT COALESCE(SUM(Debit),0) FROM JournalVoucherLines WHERE VoucherId = v.VoucherId)
           - (SELECT COALESCE(SUM(Credit),0) FROM JournalVoucherLines WHERE VoucherId = v.VoucherId)) > 0
     AND v.IsPosted = 1
`).all();
expectCount('1.4  Invariant 1: |SUM(DR) - SUM(CR)| == 0.00 for every voucher', unbalanced.length, 0);

const nonLeaf = kernel.db.prepare(`
  SELECT COUNT(*) AS c
    FROM JournalVoucherLines l
    JOIN Accounts a ON a.AccountId = l.AccountId
   WHERE a.AccountLevel <> 5 OR a.IsPostingAllowed = 0 OR a.IsActive = 0
`).get().c;
expectCount('1.5  Invariant 2: every line lands on an active Level-5 leaf', nonLeaf, 0);

const invalidLines = kernel.db.prepare(`
  SELECT COUNT(*) AS c FROM JournalVoucherLines
   WHERE NOT ((Debit > 0 AND Credit = 0) OR (Credit > 0 AND Debit = 0))
`).get().c;
expectCount('1.6  no line carries both (or neither) DR and CR', invalidLines, 0);

const headerDrift = kernel.db.prepare(`
  SELECT COUNT(*) AS c FROM JournalVouchers v
   WHERE v.TotalDebit <> (SELECT COALESCE(SUM(Debit),0) FROM JournalVoucherLines WHERE VoucherId = v.VoucherId)
      OR v.TotalCredit <> (SELECT COALESCE(SUM(Credit),0) FROM JournalVoucherLines WHERE VoucherId = v.VoucherId)
`).get().c;
expectCount('1.7  header totals equal the line sums (no drift)', headerDrift, 0);

/* ------------------------------------------ 2. trial balance (Eq. 10) */

section('2. Section 6.1 Trial Balance');

const trial = kernel.report.trialBalance({ asOfDate: asOf, includeZero: false });

const expectedRows = [
  ['1.10.01.0001.0001', 80000, 0],
  ['1.10.01.0002.0001', 4840000, 0],
  ['1.10.02.0001.0001', 435000, 0],
  ['1.10.03.0001.0001', 1030000, 0],
  ['1.10.04.0001.0001', 200000, 0],
  ['1.20.01.0001.0001', 500000, 0],
  ['1.20.02.0001.0001', 0, 8333],
  ['2.10.01.0001.0001', 0, 1000000],
  ['2.10.02.0001.0001', 0, 165000],
  ['2.10.02.0002.0001', 0, 35000],
  ['3.10.01.0001.0001', 0, 6000000],
  ['3.10.01.0002.0001', 100000, 0],
  ['4.10.01.0001.0001', 0, 1820000],
  ['4.10.02.0001.0001', 170000, 0],
  ['5.10.01.0001.0001', 1030000, 0],
  ['6.10.01.0001.0001', 240000, 0],
  ['6.10.01.0002.0001', 45000, 0],
  ['6.10.02.0001.0001', 350000, 0],
  ['6.10.04.0001.0001', 8333, 0],
];

const byCode = new Map(trial.rows.map((r) => [r.AccountCode, r]));
for (const [code, dr, cr] of expectedRows) {
  const row = byCode.get(code);
  expect(`2.x  ${code} debit column`, row ? row.DebitColumn : -1, dr);
  expect(`2.x  ${code} credit column`, row ? row.CreditColumn : -1, cr);
}

expect('2.a  Trial Balance SUM(DR)', trial.tbDebit, 9028333);
expect('2.b  Trial Balance SUM(CR)', trial.tbCredit, 9028333);
expect('2.c  Equation 10: TB delta', trial.tbDelta, 0);
expect('2.d  Invariant 1: gross ledger delta (all posted lines)', trial.delta, 0);
expectCount('2.e  no unexpected extra accounts in the TB', trial.rows.length, expectedRows.length);

/* -------------------------------------------------- 3. Section 6.2 P&L */

section('3. Section 6.2 Income Statement');

const sheet0 = kernel.report.balanceSheet({ asOfDate: asOf });
const pnl = kernel.report.incomeStatement({ from: sheet0.periodStart, to: asOf });

expect('3.a  gross merchandise sales', pnl.grossSales, 1820000);
expect('3.b  net sales revenue', pnl.netRevenue, 1650000);
expect('3.c  cost of goods sold', pnl.cogs, 1030000);
expect('3.d  gross profit', pnl.grossProfit, 620000);
expect('3.e  gross margin (37.58%)', Math.round((pnl.grossProfit / pnl.netRevenue) * 10000), 3758);
expect('3.f  operating expenses', pnl.operatingExpenses, 643333);
expect('3.g  net profit / (loss)', pnl.netProfit, -23333);

/* ------------------------------------------------- 4. Section 6.3 BS */

section('4. Section 6.3 Balance Sheet');

expect('4.a  Cash Till', net(COA.CASH_TILL), 80000);
expect('4.b  Operating Bank', net(COA.BANK_MAIN), 4840000);
expect('4.c  Trade Debtors (AR)', net(COA.AR), 435000);
expect('4.d  Finished Resale Stock', net(COA.INVENTORY), 1030000);
expect('4.e  Input Tax recoverable', net('1.10.04.0001.0001'), 200000);
expect('4.f  Office & Store Equipment', net('1.20.01.0001.0001'), 500000);
expect('4.g  Accumulated Depreciation', net('1.20.02.0001.0001'), -8333);
expect('4.h  Trade Creditors (AP)', net(COA.AP), -1000000);
expect('4.i  Sales Tax payable', net('2.10.02.0001.0001'), -165000);
expect('4.j  Payroll tax withheld', net('2.10.02.0002.0001'), -35000);
expect('4.k  Owner contributed capital', net('3.10.01.0001.0001'), -6000000);
expect('4.l  Owner drawings', net('3.10.01.0002.0001'), 100000);

expect('4.m  Total assets', sheet0.totalAssets, 7076667);
expect('4.n  Total liabilities', sheet0.totalLiabilities, 1200000);
expect('4.o  Total owner equity', sheet0.totalEquity, 5876667);
expect('4.p  A - (L + E)', sheet0.delta, 0);
expectCount('4.q  balance sheet proof flag', sheet0.balanced ? 1 : 0, 1);

/* ------------------------------------------------ 5. inventory / FIFO */

section('5. Perpetual FIFO inventory');

const valuation = kernel.inventory.valuation({ itemCode: 'LAPTOP-001' });
expectCount('5.a  units on hand (20 - 5 - 6 + 1)', valuation.qty, 10);
expect('5.b  FIFO value (10 x $1,030.00 incl. freight)', valuation.valueCents, 1030000);
expectCount('5.c  item master stock count', valuation.onHandStock, 10);
expect('5.d  inventory account equals the lot queue value',
  net(COA.INVENTORY), valuation.valueCents);

/* ----------------------------------------------------- 6. consolidated */

section('6. Consolidated proof (Phase 5 acceptance)');

const proof = kernel.report.proof({ asOfDate: asOf });
expectCount('6.a  proof.trialBalance.balanced', proof.trialBalance.balanced ? 1 : 0, 1);
expectCount('6.b  proof.balanceSheet.balanced', proof.balanceSheet.balanced ? 1 : 0, 1);
expect('6.c  proof zero-tolerance delta', proof.trialBalance.delta, 0);
expect('6.d  proof balance-sheet delta', proof.balanceSheet.delta, 0);
expect('6.e  proof net result', proof.incomeStatement.netProfit, -23333);

/* ---------------------------------- 7. destructive invariant probes (last) */

section('7. Invariant enforcement probes (write attempts)');

function probe(label, fn, matcher) {
  let error = null;
  try { fn(); } catch (err) { error = err; }
  const ok = !!error && matcher.test(String(error.message || error));
  results.push({ label, actual: error ? String(error.message).slice(0, 60) : 'NO ERROR', expected: 'rejected', ok });
}

probe('7.a  Invariant 4: posted voucher headers are immutable', () => {
  kernel.db.prepare('UPDATE JournalVouchers SET Narration = ? WHERE VoucherId = ?')
    .run('tampered', vouchers[0].VoucherId);
}, /IMMUTABILITY_VIOLATION/);

probe('7.b  Invariant 2: summary heads reject journal lines', () => {
  const summary = kernel.db.prepare(`
    SELECT AccountCode FROM Accounts
     WHERE AccountLevel < 5 AND IsActive = 1
     ORDER BY AccountId LIMIT 1
  `).get();
  if (!summary) throw new Error('no summary head found in the chart of accounts');
  kernel.ledger.record({
    voucherDate: asOf, voucherType: 'General_JV', createdBy: 1,
    narration: `attempt to post to the ${summary.AccountCode} summary head`,
    lines: [
      { accountCode: summary.AccountCode, debit: 100 },
      { accountCode: COA.BANK_MAIN, credit: 100 },
    ],
  });
}, /POSTING_LEVEL|Level-5|leaf|summary/i);

probe('7.c  Invariant 1: an unbalanced voucher cannot be committed', () => {
  kernel.ledger.record({
    voucherDate: asOf, voucherType: 'General_JV', createdBy: 1,
    narration: 'deliberately unbalanced $0.10 test voucher',
    lines: [
      { accountCode: COA.BANK_MAIN, debit: 1000 },
      { accountCode: '3.10.01.0001.0001', credit: 990 },
    ],
  });
}, /UNBALANCED|balance|Delta|0\.00/i);

/* 7.d succeeds when NO error is thrown: reversing must append a contra-voucher
 * and leave the original header byte-identical. */
{
  let error = null;
  let detail = 'appended contra-voucher';
  try {
    const first = kernel.db.prepare('SELECT VoucherId FROM JournalVouchers ORDER BY VoucherId LIMIT 1').get();
    const original = kernel.ledger.get({ voucherId: first.VoucherId });
    const reversal = kernel.ledger.reverse({ voucherId: first.VoucherId, reason: 'verification probe', createdBy: 1 });
    const after = kernel.ledger.get({ voucherId: first.VoucherId });
    if (!reversal || !reversal.voucherId) { detail = 'no reversal voucher returned'; error = new Error(detail); }
    else if (reversal.voucherId === first.VoucherId) { detail = 'reused the original voucher id'; error = new Error(detail); }
    else if (after.Narration !== original.Narration || after.IsPosted !== 1) {
      detail = 'original voucher mutated'; error = new Error(detail);
    } else {
      const postReversal = kernel.report.trialBalance({ asOfDate: asOf, includeZero: false });
      if (postReversal.tbDelta !== 0) { detail = `post-reversal TB delta ${postReversal.tbDelta}`; error = new Error(detail); }
      else detail = `appended contra-voucher ${reversal.voucherNo}`;
    }
  } catch (err) { error = err; detail = String(err.message || err); }
  results.push({ label: '7.d  Invariant 4: reversal appends, never edits', actual: detail, expected: 'appended contra-voucher', ok: !error });
}

/* ------------------------------------------------------------- report */

console.log('================================================================');
console.log('  ASSERTIONS');
console.log('================================================================');

let failed = 0;
const show = (r) => (r.raw ? String(r.actual)
  : (typeof r.actual === 'number' ? cents(r.actual) : String(r.actual)));
for (const r of results) {
  if (r.ok) {
    console.log(`  PASS  ${r.label.padEnd(52, '.')} ${show(r)}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${r.label.padEnd(52, '.')} actual=${show(r)} expected=${r.raw ? r.expected : cents(r.expected)}`);
  }
}

console.log('----------------------------------------------------------------');
console.log(`  ${results.length - failed}/${results.length} assertions passed`);
console.log('================================================================');

console.log('\n  DOCUMENTED DEVIATIONS (see docs/DEVIATIONS.md)');
console.log('  The SRS Section 6 tables contain a single $1,000.00 arithmetic typo:');
console.log('    - 6.1 bank balance      doc $49,400.00 -> engine $48,400.00');
console.log('    - 6.1 trial balance     doc $91,283.33 -> engine $90,283.33');
console.log('    - 6.3 total assets      doc $71,766.67 -> engine $70,766.67');
console.log('  Every other published figure (rows, P&L, liabilities, equity, PI)');
console.log('  matches to the cent. The engine result is the self-consistent one:');
console.log('    $70,766.67 - ($12,000.00 + $58,766.67) == $0.00');
console.log('    whereas the doc\'s own $71,766.67 leaves a $1,000.00 residue.');
console.log('');

kernel.close();
if (failed === 0) wipe(dbPath);

process.exit(failed === 0 ? 0 : 1);
