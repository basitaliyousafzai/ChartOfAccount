'use strict';

/**
 * Demo data seeder - executes the complete SRS Section 6 case study
 * ("Apex Tech Store", 15 transactions) with 100% verified math.
 *
 * Usage:
 *   npm run seed            # seed ./data/apex_erp.db
 *   npm run seed -- --fresh # wipe and re-seed
 *
 * Every amount below is expressed in INTEGER CENTS (Invariant 3).
 */

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const root = path.resolve(__dirname, '..');
process.env.ERP_DB_PATH = process.env.ERP_DB_PATH || path.join(root, 'data', 'apex_erp.db');

if (fresh) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${process.env.ERP_DB_PATH}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file);
  }
}

const { getKernel } = require('../src/main/kernel');
const { COA } = require('../src/services/coaSeed');
const money = require('../src/core/money');

const kernel = getKernel({ fresh });

/**
 * Case-study dates: days 1-15 of the PREVIOUS calendar month.
 *
 * Every report screen defaults its as-of date to *today*, so a case study
 * dated days 1-15 of the *running* month is half in the future for the first
 * two weeks of each month — the Trial Balance silently drops up to 9 of the
 * 15 vouchers (bank read 52,000 instead of 48,400, gross profit vanished).
 * Anchoring the whole study in the past keeps "as of today" equal to the full
 * Section 6 proof on any day of the year, which is exactly what
 * `npm run smoke` asserts. `asOf = d(15)` still covers every voucher.
 */
const now = new Date();
const anchor = new Date(now.getFullYear(), now.getMonth() - 1, 1);

/**
 * ISO date for `day` of the anchored month. Values past the end of the month
 * roll over, so `d(38)` is a real date (Net-30 from day 8) instead of the
 * malformed "2026-09-38" a plain padStart would produce.
 * @param {number} day 1-based day of the anchored month
 * @returns {string} `YYYY-MM-DD`
 */
const d = (day) => {
  const dt = new Date(anchor.getFullYear(), anchor.getMonth(), day);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
};

const C = (dollars) => Math.round(dollars * 100); // helper for readability only

function ensureEntities(adminId) {
  const { AccountService } = require('../src/services/accountService');
  const accounts = new AccountService(kernel.db);

  const ensure = (type, name, linkedCode, extra = {}) => {
    const existing = kernel.db.prepare('SELECT * FROM Entities WHERE EntityType = ? AND FullName = ?').get(type, name);
    if (existing) return existing;
    const linked = accounts.getByCode(linkedCode);
    kernel.db.prepare(`
      INSERT INTO Entities (EntityType, FullName, Phone, Email, TaxNumber, CreditLimit,
                            OpeningBalance, CurrentBalance, LinkedAccountId)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
    `).run(type, name, extra.phone || null, extra.email || null, extra.tax || null,
      extra.creditLimit || 0, linked.AccountId);
    return kernel.db.prepare('SELECT * FROM Entities WHERE EntityType = ? AND FullName = ?').get(type, name);
  };

  void adminId;
  const vendor = ensure('Vendor', 'ABC Wholesale', COA.AP, { phone: '+1 555 0100', email: 'billing@abcwholesale.test' });
  const customer = ensure('Customer', 'Client Y', COA.AR, { phone: '+1 555 0199', email: 'ap@clienty.test', creditLimit: C(50000) });
  return { vendor, customer };
}

function ensureItem() {
  const existing = kernel.inventory.items().find((i) => i.ItemCode === 'LAPTOP-001');
  if (existing) return existing;
  return kernel.inventory.createItem({
    itemCode: 'LAPTOP-001',
    itemName: 'High-End Laptop',
    unitOfMeasure: 'Units',
    sellingPrice: C(1600),
    costPrice: C(1000),
    currentStock: 0,
    reorderLevel: 5,
    valuationMethod: 'FIFO',
  });
}

function main() {
  const bootstrap = kernel.auth.bootstrap();
  const admin = kernel.db.prepare("SELECT UserId, Username FROM Users WHERE Role = 'Admin' LIMIT 1").get();
  const createdBy = admin.UserId;

  const existingVouchers = kernel.ledger.list({ limit: 1 });
  if (existingVouchers.length > 0 && !fresh) {
    console.log('Database already contains vouchers. Re-run with --fresh to rebuild the case study from scratch.');
    console.log(`  Existing vouchers: ${kernel.db.prepare('SELECT COUNT(*) AS c FROM JournalVouchers').get().c}`);
    return;
  }

  const { vendor, customer } = ensureEntities(createdBy);
  const item = ensureItem();

  const steps = [];
  const run = (label, fn) => {
    try {
      const result = fn();
      steps.push({
        label,
        voucherNo: (result.voucher && (result.voucher.VoucherNo || result.voucher.voucherNo))
          || result.voucherNo || '-',
        meta: result.meta || {},
      });
      return result;
    } catch (error) {
      console.error(`\nFAILED at: ${label}\n  ${error.code || ''} ${error.message}`);
      throw error;
    }
  };

  console.log('Seeding the 15-transaction case study (Apex Tech Store)...\n');

  /* Tx 1 - Capital inflow: $60,000.00 into Chase Operating Bank */
  run('Tx 1  Capital inflow (owner deposit)', () => kernel.documents['capital.deposit']({
    voucherDate: d(1), amountCents: C(60000), accountCode: COA.BANK_MAIN,
    memo: 'Owner deposits $60,000.00 startup cash into Chase Operating Bank A/C', createdBy,
  }));

  /* Tx 2 - Facility rent $2,400.00 */
  run('Tx 2  Facility rent', () => kernel.documents['expense.pay']({
    voucherDate: d(2), accountCode: COA.RENT, amountCents: C(2400),
    paidFromAccountCode: COA.BANK_MAIN,
    memo: 'Pays commercial shop rent of $2,400.00 for the month via Chase Bank', createdBy,
  }));

  /* Tx 3 - Fixed asset $5,000.00 */
  run('Tx 3  Fixed asset acquisition (POS equipment)', () => kernel.documents['assets.register']({
    voucherDate: d(3), assetCode: 'POS-EQUIP-001', assetName: 'Store Equipment & POS Hardware',
    costCents: C(5000), salvageCents: 0, usefulLifeYears: 5, method: 'Straight_Line',
    accountCode: COA.BANK_MAIN,
    memo: 'Purchases store equipment & POS hardware for $5,000.00 via Bank', createdBy,
  }));

  /* Tx 4 - Stock purchase: 20 laptops @ $1,000 + 10% tax = $22,000 on credit */
  const purchase = run('Tx 4  Inventory procurement on credit (20 laptops)', () => kernel.documents['purchase.bill']({
    voucherDate: d(4), entityId: vendor.EntityId, taxRate: '0.10',
    lines: [{ itemCode: item.ItemCode, qty: 20, unitCostCents: C(1000) }],
    narration: 'Purchases 20 High-End Laptops on credit from ABC Wholesale @ $1,000.00 = $20,000.00 net + 10% Input Tax ($2,000.00). Total Bill: $22,000.00.',
    createdBy,
  }));

  /* Tx 5 - Inbound freight $600.00 capitalised into the inventory cost basis */
  run('Tx 5  Inbound freight capitalisation', () => {
    const freightVoucher = kernel.ledger.record({
      voucherDate: d(5),
      voucherType: 'Bank_Payment',
      sourceModule: 'Freight',
      narration: 'Pays $600.00 freight for Laptop shipment via Bank (capitalised to inventory cost basis).',
      createdBy,
      lines: [
        { accountCode: COA.INVENTORY, debit: C(600), lineMemo: 'Landed freight capitalised into stock' },
        { accountCode: COA.BANK_MAIN, credit: C(600), lineMemo: 'Freight settled from bank' },
      ],
    });
    const capitalised = kernel.inventorySvc.capitaliseLandedCost({
      lotVoucherId: purchase.voucher.voucherId,
      movementVoucherId: freightVoucher.voucherId,
      freightCents: C(600),
      date: d(5),
    });
    return { voucher: freightVoucher, meta: { freightCents: C(600), capitalised } };
  });

  /* Tx 6 - POS cash sale: 5 laptops @ $1,600 -> $8,800 collected, FIFO COGS $5,150 */
  run('Tx 6  POS cash sale (5 laptops)', () => kernel.documents['pos.sale']({
    voucherDate: d(6), itemCode: item.ItemCode, qty: 5, unitPriceCents: C(1600),
    taxRate: '0.10', tender: 'Cash', accountCode: COA.CASH_TILL,
    narration: 'Sells 5 Laptops at POS for $1,600.00/unit cash ($8,000.00 net + 10% tax = $8,800.00). FIFO Cost basis = 5 x ($1,000 + $30 freight) = $5,150.00.',
    createdBy,
  }));

  /* Tx 7 - Till sweep $8,000.00 to bank */
  run('Tx 7  Cash till deposit to bank', () => kernel.documents['transfer.tillToBank']({
    voucherDate: d(7), amountCents: C(8000), accountCode: COA.BANK_MAIN, createdBy,
  }));

  /* Tx 8 - Credit invoice: 6 laptops @ $1,700 -> $11,220 AR, FIFO COGS $6,180 */
  run('Tx 8  Credit sales invoice (6 laptops)', () => kernel.documents['sales.invoice']({
    voucherDate: d(8), itemCode: item.ItemCode, qty: 6, unitPriceCents: C(1700),
    taxRate: '0.10', entityId: customer.EntityId, dueDate: d(38),
    narration: 'Issues Net-30 credit invoice to Corporate Client Y for 6 Laptops @ $1,700.00 = $10,200.00 net + 10% tax ($1,020.00) = $11,220.00. FIFO Cost basis = 6 x $1,030.00 = $6,180.00.',
    createdBy,
  }));

  /* Tx 9 - Sales return: 1 laptop, credit note $1,870.00, restock at $1,030.00 */
  run('Tx 9  Customer sales return (credit note)', () => kernel.documents['sales.creditNote']({
    voucherDate: d(9), itemCode: item.ItemCode, qty: 1, unitPriceCents: C(1700),
    taxRate: '0.10', entityId: customer.EntityId, reason: 'Defective unit returned by Client Y',
    narration: 'Client Y returns 1 defective Laptop. Credit Note $1,700.00 net + $170.00 tax = $1,870.00 AR credit. Restocks inventory at $1,030.00 cost.',
    createdBy,
  }));

  /* Tx 10 - AR receipt $5,000.00 */
  run('Tx 10 Customer payment received', () => kernel.documents['ar.receipt']({
    voucherDate: d(10), entityId: customer.EntityId, amountCents: C(5000),
    accountCode: COA.BANK_MAIN, memo: 'Client Y pays $5,000.00 partial balance via Bank transfer', createdBy,
  }));

  /* Tx 11 - AP payment $12,000.00 */
  run('Tx 11 Vendor bill payment', () => kernel.documents['ap.payment']({
    voucherDate: d(11), entityId: vendor.EntityId, amountCents: C(12000),
    accountCode: COA.BANK_MAIN, memo: 'Pays ABC Wholesale $12,000.00 partial bill via Chase Bank', createdBy,
  }));

  /* Tx 12 - Utilities $450.00 */
  run('Tx 12 Utility bill settlement', () => kernel.documents['expense.pay']({
    voucherDate: d(12), accountCode: COA.UTILITIES, amountCents: C(450),
    paidFromAccountCode: COA.BANK_MAIN,
    memo: 'Pays store electricity & water bill of $450.00 via Bank', createdBy,
  }));

  /* Tx 13 - Payroll: gross $3,500.00, withholding $350.00, net $3,150.00 */
  run('Tx 13 Monthly staff payroll', () => kernel.documents['payroll.disburse']({
    voucherDate: d(13), baseCents: C(3500), overtimeHours: 0, hourlyRateCents: 0,
    allowancesCents: 0, pensionRate: '0',
    taxWithheldCents: C(350),
    accountCode: COA.BANK_MAIN,
    memo: 'Processes monthly payroll: Gross Salaries $3,500.00, Tax Withheld $350.00, Net Salaries $3,150.00 paid via Bank.',
    createdBy,
  }));

  /* Tx 14 - Straight-line depreciation $5,000 / 60 = $83.33 */
  run('Tx 14 Fixed asset depreciation', () => kernel.documents['assets.runDepreciation']({
    voucherDate: d(14), createdBy,
  }));

  /* Tx 15 - Owner drawings $1,000.00 */
  run('Tx 15 Owner personal drawing', () => kernel.documents['owner.drawings']({
    voucherDate: d(15), amountCents: C(1000), accountCode: COA.BANK_MAIN,
    memo: 'Owner withdraws $1,000.00 cash from Bank for personal use (Contra Equity).', createdBy,
  }));

  // ---------------------------------------------------------------- proofs ---
  const asOf = d(15);
  const proof = kernel.report.proof({ asOfDate: asOf });
  const balanceSheet = kernel.report.balanceSheet({ asOfDate: asOf });
  const statement = kernel.report.incomeStatement({ from: balanceSheet.periodStart, to: asOf });
  const trial = kernel.report.trialBalance({ asOfDate: asOf, includeZero: false });

  const fmt = (c) => money.formatCents(c);

  console.log('\n================================================================');
  console.log('  CASE STUDY POSTED - SECTION 6 PROOF');
  console.log('================================================================');
  console.log(`  Fiscal period        : ${balanceSheet.periodStart} .. ${asOf}`);
  console.log(`  Vouchers posted      : ${kernel.db.prepare('SELECT COUNT(*) AS c FROM JournalVouchers').get().c}`);
  console.log(`  Database driver      : ${kernel.system.info().driverLabel}`);
  console.log('----------------------------------------------------------------');
  for (const step of steps) console.log(`  ${step.label.padEnd(46, '.')} ${step.voucherNo}`);
  console.log('----------------------------------------------------------------');
  console.log(`  Trial Balance  SUM(DR)      ${fmt(trial.totalDebit).padStart(14)}`);
  console.log(`  Trial Balance  SUM(CR)      ${fmt(trial.totalCredit).padStart(14)}`);
  console.log(`  Gross ledger Delta          ${fmt(trial.delta).padStart(14)}   (Invariant 1)`);
  console.log(`  TB Debit column             ${fmt(trial.tbDebit).padStart(14)}`);
  console.log(`  TB Credit column            ${fmt(trial.tbCredit).padStart(14)}`);
  console.log(`  TB column Delta             ${fmt(trial.tbDelta).padStart(14)}   (Equation 10)`);
  console.log('----------------------------------------------------------------');
  console.log(`  Net sales revenue           ${fmt(statement.netRevenue).padStart(14)}`);
  console.log(`  Cost of goods sold          ${fmt(statement.cogs).padStart(14)}`);
  console.log(`  Gross profit                ${fmt(statement.grossProfit).padStart(14)}`);
  console.log(`  Operating expenses          ${fmt(statement.operatingExpenses).padStart(14)}`);
  console.log(`  Net profit / (loss)         ${fmt(statement.netProfit).padStart(14)}`);
  console.log('----------------------------------------------------------------');
  console.log(`  Total assets                ${fmt(balanceSheet.totalAssets).padStart(14)}`);
  console.log(`  Total liabilities           ${fmt(balanceSheet.totalLiabilities).padStart(14)}`);
  console.log(`  Total owner equity          ${fmt(balanceSheet.totalEquity).padStart(14)}`);
  console.log(`  A - (L + E)                 ${fmt(balanceSheet.delta).padStart(14)}   (Invariant: equilibrium)`);
  console.log('----------------------------------------------------------------');
  console.log(`  Trial balance balanced  : ${proof.trialBalance.balanced ? 'YES' : 'NO'}`);
  console.log(`  Balance sheet balanced  : ${proof.balanceSheet.balanced ? 'YES' : 'NO'}`);
  console.log('================================================================\n');

  if (args.includes('--json')) {
    console.log(JSON.stringify({ proof, steps: steps.map((s) => s.voucherNo) }, null, 2));
  }
}

main();
