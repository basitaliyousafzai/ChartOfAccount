'use strict';

/**
 * Section 3.3 - Perpetual FIFO Inventory Ledger
 * Reproduces the SRS worked example: 50 @ $10.00 then 30 @ $12.00, sell 60
 * -> COGS $620.00, leaving 20 @ $12.00 = $240.00.
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
const inventory = kernel.inventorySvc;

function post(lines, extra = {}) {
  return kernel.ledger.record({
    voucherDate: today, voucherType: 'General_JV',
    narration: 'inventory unit test', createdBy: adminId, lines, ...extra,
  });
}

function balance(accountCode) {
  return kernel.coa.balance({ accountCode, asOfDate: today }).netDebitMinusCredit;
}

const ITEM = 'FIFO-TEST-001';

test('an inventory item is created against posting-allowed accounts', () => {
  const item = kernel.inventory.createItem({
    itemCode: ITEM,
    itemName: 'FIFO Worked Example Widget',
    unitOfMeasure: 'Units',
    costPrice: 1000,
    sellingPrice: 1600,
    currentStock: 0,
    reorderLevel: 5,
    valuationMethod: 'FIFO',
  });
  assert.equal(item.ItemCode, ITEM);
  assert.equal(item.CurrentStock, 0);
  assert.equal(item.ValuationMethod, 'FIFO');

  const duplicate = () => kernel.inventory.createItem({ itemCode: ITEM, itemName: 'dup' });
  assert.throws(duplicate, /already exists/);
});

test('FIFO worked example: 50 @ $10.00 then 30 @ $12.00', () => {
  inventory.receive({ itemCode: ITEM, qty: 50, unitCostCents: 1000, date: today, supplierRef: 'SUP-A' });
  inventory.receive({ itemCode: ITEM, qty: 30, unitCostCents: 1200, date: today, supplierRef: 'SUP-B' });

  const lots = inventory.lots(ITEM);
  assert.equal(lots.length, 2);
  assert.deepEqual(lots.map((l) => [l.QtyRemaining, l.UnitCost]), [[50, 1000], [30, 1200]]);

  const valuation = inventory.valuation(ITEM);
  assert.equal(valuation.qty, 80);
  assert.equal(valuation.valueCents, 50 * 1000 + 30 * 1200);
  assert.equal(valuation.valueCents, 86000);
});

test('previewing the cost of 60 units does not mutate the queue', () => {
  const preview = inventory.previewFifoCost(ITEM, 60);
  assert.equal(preview.costCents, 62000); // 50 x $10.00 + 10 x $12.00 = $620.00
  assert.equal(preview.layers.length, 2);
  assert.equal(preview.layers[0].qty, 50);
  assert.equal(preview.layers[1].qty, 10);

  assert.equal(inventory.valuation(ITEM).qty, 80, 'preview must not consume stock');
});

test('consuming 60 units charges exactly the previewed FIFO cost', () => {
  const result = inventory.consumeFifo({ itemCode: ITEM, qty: 60, date: today });
  assert.equal(result.costCents, 62000);
  assert.deepEqual(result.layers.map((l) => [l.qty, l.unitCostCents]), [[50, 1000], [10, 1200]]);

  const valuation = inventory.valuation(ITEM);
  assert.equal(valuation.qty, 20);
  assert.equal(valuation.valueCents, 24000); // 20 x $12.00
  assert.equal(valuation.onHandStock, 20);
});

test('the FIFO queue is strict front-to-back', () => {
  const lots = inventory.lots(ITEM);
  assert.equal(lots.length, 1, 'the first lot must be fully exhausted');
  assert.equal(lots[0].QtyRemaining, 20);
  assert.equal(lots[0].UnitCost, 1200);
});

test('over-selling is refused instead of going negative', () => {
  assert.throws(
    () => inventory.consumeFifo({ itemCode: ITEM, qty: 21, date: today }),
    (error) => error.code === 'INSUFFICIENT_STOCK',
  );
  assert.throws(() => inventory.previewFifoCost(ITEM, 999), /INSUFFICIENT_STOCK|Insufficient stock/);
  assert.equal(inventory.valuation(ITEM).qty, 20, 'stock must be unchanged after a refusal');
});

test('a sales return restores the most recently sold layers at their cost basis', () => {
  const restored = inventory.restoreToStock({ itemCode: ITEM, qty: 10, date: today });
  assert.equal(restored.valueCents, 12000); // the last 10 sold came from the $12.00 lot
  assert.equal(restored.qty, 10);

  const valuation = inventory.valuation(ITEM);
  assert.equal(valuation.qty, 30);
  assert.equal(valuation.valueCents, 36000);
  assert.equal(valuation.onHandStock, 30);
});

test('the inventory sub-ledger movement trail is complete and signed correctly', () => {
  const moves = kernel.inventory.movements({ itemCode: ITEM });
  const qtyDelta = moves.reduce((sum, m) => sum + m.QtyDelta, 0);
  const valueDelta = moves.reduce((sum, m) => sum + m.ValueDelta, 0);
  assert.equal(qtyDelta, 30);           // 50 + 30 - 60 + 10
  assert.equal(valueDelta, 36000);      // matches the lot queue exactly
  assert.ok(moves.some((m) => m.MovementType === 'Purchase_Receipt'));
  assert.ok(moves.some((m) => m.MovementType === 'Sale_Consumption'));
  assert.ok(moves.some((m) => m.MovementType === 'Return_Restock'));
});

/* ---------------------------------------------------------- landed cost */

test('Equation 6 - inbound freight is capitalised into the lot cost basis', () => {
  const code = 'LANDED-TEST-001';
  kernel.inventory.createItem({
    itemCode: code, itemName: 'Landed Cost Item', costPrice: 20000, sellingPrice: 30000,
    currentStock: 0, valuationMethod: 'FIFO',
  });

  const purchase = post([
    { accountCode: COA.INVENTORY, debit: 200000, lineMemo: '10 units @ $200.00' },
    { accountCode: COA.AP, credit: 200000 },
  ]);
  inventory.receive({
    itemCode: code, qty: 10, unitCostCents: 20000, date: today, voucherId: purchase.voucherId,
  });

  const freight = post([
    { accountCode: COA.INVENTORY, debit: 60000, lineMemo: 'inbound freight' },
    { accountCode: COA.BANK_MAIN, credit: 60000 },
  ]);

  const result = inventory.capitaliseLandedCost({
    lotVoucherId: purchase.voucherId,
    movementVoucherId: freight.voucherId,
    freightCents: 60000,
    date: today,
  });

  assert.equal(result.freightCents, 60000);
  assert.equal(result.totalAllocatedCents, 60000, 'every freight cent must be capitalised');
  assert.equal(result.allocated.length, 1);

  const valuation = inventory.valuation(code);
  assert.equal(valuation.qty, 10);
  assert.equal(valuation.valueCents, 260000);   // $2,000.00 stock + $600.00 freight
  assert.equal(valuation.avgCostCents, 26000);  // $260.00 per unit

  // The GL inventory account and the lot queue must agree to the cent.
  assert.equal(balance(COA.INVENTORY), valuation.valueCents);

  assert.throws(
    () => inventory.capitaliseLandedCost({ freightCents: 1, date: today, itemCode: 'NOPE-1' }),
    /not found|No open purchase lots/,
  );
});

test('movement rows carry the vouchers they belong to (audit trail)', () => {
  const code = 'LANDED-TEST-001';
  const moves = kernel.inventory.movements({ itemCode: code });
  const types = moves.map((m) => m.MovementType).sort();
  assert.deepEqual(types, ['Landed_Cost_Capitalisation', 'Purchase_Receipt']);
  assert.ok(moves.every((m) => m.VoucherId !== null), 'lot/movement voucher linkage must be recorded');
});
