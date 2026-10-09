'use strict';

/**
 * Preview parity - the two read-only dry runs must agree with the vouchers
 * they foreshadow:
 *
 *   forex.preview            vs forex.settle        (Equation 9, IAS 21)
 *   inventory.previewFifoCost vs inventory.shrinkage (Equation 4, FIFO)
 *
 * A preview that can disagree with the posting it predicts is worse than no
 * preview at all: it teaches the operator the wrong number with a confident
 * face. Both pairs therefore share their arithmetic rather than duplicating
 * it, and these tests pin that identity down.
 *
 * Also covers the Phase 1 RBAC gate on the two new read methods.
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

const ITEM = 'PREVIEW-PARITY-001';

/** A sales invoice to settle against (ReceivableSettlements needs the FK). */
function salesInvoice() {
  return kernel.ledger.record({
    voucherDate: today,
    voucherType: 'Sales_Invoice',
    narration: 'preview parity invoice',
    createdBy: adminId,
    lines: [
      { accountCode: COA.AR, debit: 100000, credit: 0 },
      { accountCode: COA.SALES_REVENUE, credit: 100000 },
    ],
  });
}

/* ------------------------------------------------------ forex: Equation 9 */

test('forex.preview predicts the exact figures forex.settle books (gain)', () => {
  const invoice = salesInvoice();
  const args = {
    voucherDate: today,
    invoiceVoucherId: invoice.voucherId,
    foreignAmountCents: 100000,
    currencyCode: 'EUR',
    originalRate: '1.000000',
    settlementRate: '1.050000',
    accountCode: COA.BANK_MAIN,
    createdBy: adminId,
  };

  const dry = kernel.forexSvc.preview({
    foreignAmountCents: args.foreignAmountCents,
    originalRate: args.originalRate,
    settlementRate: args.settlementRate,
  });
  assert.equal(dry.origValueCents, 100000, 'V_orig = 1,000.00 x 1.000000');
  assert.equal(dry.settleValueCents, 105000, 'V_settle = 1,000.00 x 1.050000');
  assert.equal(dry.deltaCents, 5000, 'realised gain 50.00');
  assert.equal(dry.direction, 'GAIN');

  const posted = kernel.forexSvc.settle(args);
  assert.equal(posted.meta.origValueCents, dry.origValueCents);
  assert.equal(posted.meta.settleValueCents, dry.settleValueCents);
  assert.equal(posted.meta.deltaCents, dry.deltaCents);
  assert.equal(posted.meta.direction, dry.direction);
});

test('forex.preview predicts a realised loss too', () => {
  const invoice = salesInvoice();
  const args = {
    voucherDate: today,
    invoiceVoucherId: invoice.voucherId,
    foreignAmountCents: 100000,
    currencyCode: 'EUR',
    originalRate: '1.000000',
    settlementRate: '0.950000',
    accountCode: COA.BANK_MAIN,
    createdBy: adminId,
  };

  const dry = kernel.forexSvc.preview({
    foreignAmountCents: args.foreignAmountCents,
    originalRate: args.originalRate,
    settlementRate: args.settlementRate,
  });
  assert.equal(dry.settleValueCents, 95000);
  assert.equal(dry.deltaCents, -5000);
  assert.equal(dry.direction, 'LOSS');

  const posted = kernel.forexSvc.settle(args);
  assert.equal(posted.meta.deltaCents, dry.deltaCents);
  assert.equal(posted.meta.direction, dry.direction);

  // The loss rides on the expense head; the ledger must still balance to 0.00.
  const lossBalance = kernel.coa.balance({ accountCode: COA.FOREX_LOSS, asOfDate: today }).netDebitMinusCredit;
  assert.equal(lossBalance, 5000, 'IAS 21 loss debited 50.00');
});

test('forex.preview refuses a non-positive amount without touching the db', () => {
  assert.throws(
    () => kernel.forexSvc.preview({ foreignAmountCents: 0, originalRate: '1.0', settlementRate: '1.1' }),
    /positive/i,
  );
  assert.throws(
    () => kernel.forexSvc.preview({ foreignAmountCents: -1, originalRate: '1.0', settlementRate: '1.1' }),
    /positive/i,
  );
});

/* ------------------------------------------------- inventory: Equation 4 */

test('inventory.previewFifoCost layers FIFO exactly as inventory.shrinkage posts it', () => {
  kernel.inventory.createItem({
    itemCode: ITEM,
    itemName: 'Preview parity widget',
    unitOfMeasure: 'Units',
    costPrice: 1000,
    sellingPrice: 1600,
    currentStock: 0,
    reorderLevel: 2,
    valuationMethod: 'FIFO',
  });

  // Two lots: 5 @ 10.00 then 5 @ 12.00 -> book 10, value 110.00.
  kernel.inventorySvc.receive({ itemCode: ITEM, qty: 5, unitCostCents: 1000, date: today });
  kernel.inventorySvc.receive({ itemCode: ITEM, qty: 5, unitCostCents: 1200, date: today });

  // Demand of 7 must drain lot 1 whole and part of lot 2: 50.00 + 24.00.
  const dry = kernel.inventorySvc.previewFifoCost(ITEM, 7);
  assert.equal(dry.costCents, 7400);
  assert.deepEqual(dry.layers.map((l) => l.qty), [5, 2], 'FIFO consumes front lot first');
  assert.deepEqual(dry.layers.map((l) => l.valueCents), [5000, 2400]);

  const posted = kernel.inventory.shrinkage({
    voucherDate: today,
    itemCode: ITEM,
    countedQty: 3, // 10 on book, 3 counted -> shortfall 7
    expenseAccountCode: COA.SHRINKAGE,
    createdBy: adminId,
  });

  assert.equal(posted.meta.shortfallQty, 7);
  assert.equal(posted.meta.bookQty, 10);
  assert.equal(posted.meta.valueCents, dry.costCents, 'the write-off IS the preview');

  const expense = kernel.coa.balance({ accountCode: COA.SHRINKAGE, asOfDate: today }).netDebitMinusCredit;
  const stock = kernel.coa.balance({ accountCode: COA.INVENTORY, asOfDate: today }).netDebitMinusCredit;
  assert.equal(expense, 7400, 'write-off loss debited 74.00');
  assert.equal(stock, -7400, 'inventory relieved 74.00');
});

test('inventory.previewFifoCost refuses to invent stock', () => {
  assert.throws(() => kernel.inventorySvc.previewFifoCost(ITEM, 999), /insufficient|stock/i);
  assert.throws(() => kernel.inventorySvc.previewFifoCost(ITEM, 0), /positive integer/i);
});

/* ------------------------------------------------------- Phase 1 RBAC gate */

test('both new read methods are gated at the IPC boundary', async () => {
  assert.equal(kernel.sessionRole, null, 'starts anonymous');

  await assert.rejects(
    () => kernel.invoke('forex.preview', {
      foreignAmountCents: 100000, originalRate: '1.000000', settlementRate: '1.050000',
    }),
    (err) => err.code === 'FORBIDDEN',
    'forex.preview must need run_reports',
  );

  await assert.rejects(
    () => kernel.invoke('inventory.previewFifoCost', { itemCode: ITEM, qty: 1 }),
    (err) => err.code === 'FORBIDDEN',
    'inventory.previewFifoCost must need run_reports',
  );

  // A Cashier holds run_reports, so the screens these back still work.
  await kernel.invoke('auth.login', { username: 'cashier', password: 'cash123' });
  const dry = await kernel.invoke('forex.preview', {
    foreignAmountCents: 100000, originalRate: '1.000000', settlementRate: '1.050000',
  });
  assert.equal(dry.deltaCents, 5000, 'Cashier may dry-run a settlement');
  await kernel.invoke('auth.logout', {});
});
