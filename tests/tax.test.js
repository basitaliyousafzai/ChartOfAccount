'use strict';

/**
 * Section 3.4 - Tax & Discount Engine.
 * Equation 5A (tax-exclusive) and Equation 5B (tax-inclusive), plus the
 * deterministic penny-allocation reconciliation rule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeLineTotals, reconcileHeaderTotal, splitTaxInclusive } = require('../src/services/taxService');

test('Equation 5A - POS sale: 5 x $1,600.00 + 10% = $8,800.00', () => {
  const line = computeLineTotals({ qty: 5, unitPriceCents: 160000, taxRate: '0.10' });
  assert.equal(line.grossCents, 800000);
  assert.equal(line.discountCents, 0);
  assert.equal(line.netCents, 800000);
  assert.equal(line.taxCents, 80000);
  assert.equal(line.totalCents, 880000);
});

test('Equation 5A - credit invoice: 6 x $1,700.00 + 10% = $11,220.00', () => {
  const line = computeLineTotals({ qty: 6, unitPriceCents: 170000, taxRate: '0.10' });
  assert.equal(line.netCents, 1020000);
  assert.equal(line.taxCents, 102000);
  assert.equal(line.totalCents, 1122000);
});

test('Equation 5A - purchase bill: 20 x $1,000.00 + 10% = $22,000.00', () => {
  const line = computeLineTotals({ qty: 20, unitPriceCents: 100000, taxRate: '0.10' });
  assert.deepEqual(line, {
    grossCents: 2000000, discountCents: 0, netCents: 2000000, taxCents: 200000, totalCents: 2200000,
  });
});

test('Equation 5A - trade discount applies BEFORE tax', () => {
  const line = computeLineTotals({
    qty: 4, unitPriceCents: 25000, discountRate: '0.10', taxRate: '0.10',
  });
  assert.equal(line.grossCents, 100000);
  assert.equal(line.discountCents, 10000);
  assert.equal(line.netCents, 90000);
  assert.equal(line.taxCents, 9000);
  assert.equal(line.totalCents, 99000);
});

test('Equation 5B - tax-inclusive shelf price is split back into net + tax', () => {
  const line = computeLineTotals({
    qty: 1, unitPriceCents: 110000, taxRate: '0.10', priceIncludesTax: true,
  });
  assert.equal(line.totalCents, 110000);
  assert.equal(line.netCents, 100000);
  assert.equal(line.taxCents, 10000);
  // tax never rounds into a phantom cent
  assert.equal(line.netCents + line.taxCents, line.totalCents);
});

test('Equation 5B - awkward inclusive amount still balances to the cent', () => {
  const line = computeLineTotals({
    qty: 3, unitPriceCents: 3333, taxRate: '0.05', priceIncludesTax: true,
  });
  assert.equal(line.netCents + line.taxCents, line.totalCents);
  assert.equal(line.grossCents, 9999);
  assert.equal(line.totalCents, 9999);
});

test('reconcileHeaderTotal reports zero drift when lines add up', () => {
  const lines = [
    computeLineTotals({ qty: 5, unitPriceCents: 160000, taxRate: '0.10' }),
    computeLineTotals({ qty: 6, unitPriceCents: 170000, taxRate: '0.10' }),
  ];
  const header = reconcileHeaderTotal(lines);
  assert.equal(header.netCents, 1820000);
  assert.equal(header.taxCents, 182000);
  assert.equal(header.totalCents, 2002000);
  assert.equal(header.roundingCents, 0);
  assert.equal(header.drift, 0);
});

test('reconcileHeaderTotal isolates header/line rounding drift', () => {
  const lines = [computeLineTotals({ qty: 1, unitPriceCents: 10000, taxRate: '0.10' })];
  const header = reconcileHeaderTotal([{ ...lines[0], totalCents: 11001 }]);
  assert.equal(header.roundingCents, 1);   // the penny is surfaced, not absorbed
  assert.equal(header.drift, -1);
});

test('splitTaxInclusive - tax-inclusive receipt allocation', () => {
  const split = splitTaxInclusive(880000, '0.10');
  assert.equal(split.netCents, 800000);
  assert.equal(split.taxCents, 80000);
  assert.equal(split.totalCents, 880000);
});

test('input validation rejects non-integer quantities and negative prices', () => {
  assert.throws(() => computeLineTotals({ qty: 1.5, unitPriceCents: 100 }), /positive integer/);
  assert.throws(() => computeLineTotals({ qty: 0, unitPriceCents: 100 }), /positive integer/);
  assert.throws(() => computeLineTotals({ qty: 1, unitPriceCents: -100 }), /cannot be negative/);
});
