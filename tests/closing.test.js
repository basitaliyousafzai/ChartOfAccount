'use strict';

/**
 * Section 3.10 - Fiscal period closing and reopening.
 * Nominal accounts are flushed to Retained Earnings and the period is locked.
 */

process.env.ERP_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getKernel } = require('../src/main/kernel');
const { COA } = require('../src/services/coaSeed');

const kernel = getKernel();
kernel.auth.bootstrap();

const adminId = kernel.db.prepare("SELECT UserId FROM Users WHERE Role = 'Admin'").get().UserId;
const today = new Date().toISOString().slice(0, 10);
/**
 * The closing voucher is dated at the period END, so once the period is closed
 * every balance assertion must be evaluated as of that end date.
 */
let asOf = today;

function post(lines, extra = {}) {
  return kernel.ledger.record({
    voucherDate: today, voucherType: 'General_JV',
    narration: 'closing unit test', createdBy: adminId, lines, ...extra,
  });
}

function balance(accountCode) {
  return kernel.coa.balance({ accountCode, asOfDate: asOf }).netDebitMinusCredit;
}

test('twelve monthly fiscal periods exist for the current year', () => {
  const periods = kernel.closing.status();
  const year = today.slice(0, 4);
  const current = periods.filter((p) => p.StartDate.startsWith(year));
  assert.equal(current.length, 12);
  assert.ok(current.every((p) => p.IsClosed === 0));
});

test('a profitable period is flushed into Retained Earnings on close', () => {
  post([
    { accountCode: COA.AR, debit: 500000, lineMemo: 'revenue' },
    { accountCode: COA.SALES_REVENUE, credit: 500000 },
  ]);
  post([
    { accountCode: COA.RENT, debit: 300000, lineMemo: 'expense' },
    { accountCode: COA.BANK_MAIN, credit: 300000 },
  ]);

  assert.equal(balance(COA.SALES_REVENUE), -500000);
  assert.equal(balance(COA.RENT), 300000);

  const result = kernel.closing.closePeriod({ date: today, createdBy: adminId });
  assert.equal(result.meta.totalRevenueCents, 500000);
  assert.equal(result.meta.totalExpenseCents, 300000);
  assert.equal(result.meta.netResultCents, 200000);
  assert.equal(result.meta.resultType, 'PROFIT');
  assert.equal(result.voucher.voucherType, 'Fiscal_Closing');
  assert.equal(result.period.IsClosed, 1);
  assert.equal(result.period.ClosedBy, adminId);

  asOf = result.period.EndDate; // the closing entry is dated at period end
});

test('every nominal account is zero after the closing entry', () => {
  assert.equal(balance(COA.SALES_REVENUE), 0);
  assert.equal(balance(COA.RENT), 0);
  assert.equal(balance(COA.UTILITIES), 0);
  assert.equal(balance(COA.COGS), 0);
  assert.equal(balance(COA.SALARIES), 0);
  assert.equal(balance(COA.RETAINED_EARNINGS), -200000); // $200.00 profit, credit side
});

test('the ledger still satisfies every invariant after closing', () => {
  const gross = kernel.report.trialBalance({ asOfDate: asOf });
  assert.equal(gross.delta, 0);
  assert.equal(gross.tbDelta, 0);
  assert.equal(gross.tbDebit, gross.tbCredit);

  const proof = kernel.report.proof({ asOfDate: asOf });
  assert.equal(proof.balanceSheet.delta, 0);
  assert.equal(proof.trialBalance.balanced, true);
});

test('a closed period refuses further postings', () => {
  assert.throws(
    () => post([
      { accountCode: COA.RENT, debit: 100 },
      { accountCode: COA.BANK_MAIN, credit: 100 },
    ]),
    (error) => error.code === 'CLOSED_PERIOD',
  );
});

test('re-opening the period unlocks postings again', () => {
  const period = kernel.closing.status().find((p) => p.StartDate.slice(0, 7) === today.slice(0, 7));
  const reopened = kernel.closing.reopenPeriod({ periodId: period.PeriodId, createdBy: adminId });
  assert.equal(reopened.reopened, true);
  assert.equal(reopened.period.IsClosed, 0);

  const posted = post([
    { accountCode: COA.RENT, debit: 100 },
    { accountCode: COA.BANK_MAIN, credit: 100 },
  ]);
  assert.equal(posted.totalDebit, 100);
});

test('closing a period with no nominal balances is refused', () => {
  // Undo the re-opening probe so every nominal head sits at exactly zero...
  post([{ accountCode: COA.BANK_MAIN, debit: 100 }, { accountCode: COA.RENT, credit: 100 }]);
  assert.equal(balance(COA.RENT), 0);

  // ...then there is nothing left to flush and the close must be refused.
  assert.throws(
    () => kernel.closing.closePeriod({ date: today, createdBy: adminId }),
    /Nothing to close/,
  );
});
