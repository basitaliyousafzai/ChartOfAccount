'use strict';

/**
 * Invariant 3 - Complete Elimination of Floating-Point Math.
 * Every assertion here is about exact integer-cent arithmetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../src/core/money');

test('toCents parses human literals into exact integer cents', () => {
  assert.equal(money.toCents('1,234.56'), 123456);
  assert.equal(money.toCents('-83.33'), -8333);
  assert.equal(money.toCents('20000'), 2000000);
  assert.equal(money.toCents('0.1'), 10);
  assert.equal(money.toCents('10.500'), 1050); // trailing zeros beyond 2dp are exact
  assert.equal(money.toCents(1050), 1050);     // already-cents integers pass through
  assert.equal(money.toCents(-0.05), -5);
});

test('toCents rejects anything beyond DECIMAL(18,2)', () => {
  assert.throws(() => money.toCents('10.505'), /2 decimal places/);
  assert.throws(() => money.toCents('abc'), /Invalid monetary literal/);
  assert.throws(() => money.toCents(10.505), /2 decimal places/);
});

test('fromCents / formatCents render without floating point drift', () => {
  assert.equal(money.fromCents(123456), '1234.56');
  assert.equal(money.fromCents(-23333), '-233.33');
  assert.equal(money.fromCents(0), '0.00');
  assert.equal(money.fromCents(5), '0.05');
  assert.equal(money.formatCents(123456), '1,234.56');
  assert.equal(money.formatCents(-23333), '(233.33)');
  assert.equal(money.formatCents(9028333), '90,283.33');
});

test('round trip: toCents(fromCents(x)) === x for a sample of values', () => {
  for (const value of [0, 1, -1, 99, 100, 8333, -23333, 9028333, 6000000]) {
    assert.equal(money.toCents(money.fromCents(value)), value);
  }
});

test('add / sub / sum are integer-exact (no 0.1 + 0.2 drift)', () => {
  assert.equal(money.add(10, 20), 30);
  assert.equal(money.sub(10000, 9999), 1);
  assert.equal(money.sum([1, 2, 3, 4]), 10);
  assert.equal(money.add(money.toCents('0.10'), money.toCents('0.20')), 30);
  assert.throws(() => money.add(1.5, 2), /integer number of cents/);
});

test('divRoundHalfUp rounds commercial-style, away from zero on ties', () => {
  assert.equal(money.divRoundHalfUp(1, 2), 1);
  assert.equal(money.divRoundHalfUp(1, 3), 0);
  assert.equal(money.divRoundHalfUp(2, 3), 1);
  assert.equal(money.divRoundHalfUp(-1, 2), -1);
  assert.equal(money.divRoundHalfUp(500000, 60), 8333); // $5,000 / 60 months
  assert.throws(() => money.divRoundHalfUp(1, 0), /Division by zero/);
});

test('parseRate turns decimals into exact fractions', () => {
  assert.deepEqual(money.parseRate('0.10'), { num: 10, den: 100 });
  assert.deepEqual(money.parseRate(0.1), { num: 1, den: 10 });
  assert.deepEqual(money.parseRate('1.25'), { num: 125, den: 100 });
  assert.deepEqual(money.parseRate('0'), { num: 0, den: 1 });
  assert.throws(() => money.parseRate('abc'), /Invalid rate/);
});

test('applyRate: 10% of $8,000.00 is exactly $800.00', () => {
  assert.equal(money.applyRate(800000, '0.10'), 80000);
  assert.equal(money.applyRate(1122000, 0.10), 112200);
  assert.equal(money.applyRate(1020000, '0.10'), 102000);
  assert.equal(money.applyRate(100000, '0.15'), 15000);
  assert.equal(money.applyRate(33333, '0.10'), 3333); // half-up on the .5 boundary
  assert.equal(money.applyRate(5, '0.10'), 1);        // 0.5 cents -> 1 cent
  assert.equal(money.applyRate(800000, '0'), 0);
});

test('grossUp / netOfGross are exact inverses on tax-inclusive prices', () => {
  assert.equal(money.grossUp(800000, '0.10'), 880000);
  assert.equal(money.netOfGross(880000, '0.10'), 800000);
  assert.equal(money.netOfGross(1122000, '0.10'), 1020000);
  assert.equal(money.grossUp(100000, '0.05'), 105000);
});

test('allocate: parts always sum EXACTLY to the total', () => {
  assert.deepEqual(money.allocate(10000, [1, 1, 1]), [3334, 3333, 3333]);
  assert.deepEqual(money.allocate(10000, [1, 2, 7]), [1000, 2000, 7000]);
  assert.deepEqual(money.allocate(0, [1, 1]), [0, 0]);
  assert.deepEqual(money.allocate(-10000, [1, 1, 1]), [-3334, -3333, -3333]);
  assert.deepEqual(money.allocate(7, [0, 0, 0]), [3, 2, 2]); // degenerate weights
  assert.throws(() => money.allocate(100, []), /zero weights/);
  assert.throws(() => money.allocate(100, [-1, 2]), /non-negative integers/);

  // Sweep: for many totals and weight shapes, the invariant must survive.
  for (const total of [1, 7, 99, 100, 10000, 880000, -880000]) {
    for (const weights of [[1, 1], [1, 1, 1], [1, 2, 3, 4], [5, 0, 5], [12345, 6789]]) {
      const parts = money.allocate(total, weights);
      assert.equal(parts.length, weights.length, `length for ${total}`);
      assert.equal(parts.reduce((a, b) => a + b, 0), total, `sum for ${total} x ${weights}`);
      assert.ok(parts.every(Number.isInteger), 'all parts are integers');
    }
  }
});

test('allocate is deterministic across repeated calls', () => {
  const a = money.allocate(10007, [3, 3, 3, 3, 5]);
  const b = money.allocate(10007, [3, 3, 3, 3, 5]);
  assert.deepEqual(a, b);
});

test('amortize: month 1 of $5,000 over 60 months is exactly $83.33', () => {
  const schedule = money.amortize(500000, 60);
  assert.equal(schedule.length, 60);
  assert.equal(schedule[0], 8333);                              // month 1 = $83.33
  assert.equal(schedule.reduce((a, b) => a + b, 0), 500000);    // no cent lost or created
  assert.equal(schedule.slice(0, 40).every((p) => p === 8333), true); // 40 clean months
  assert.equal(schedule.slice(40).every((p) => p === 8334), true);    // 20 residual cents on the tail
  assert.throws(() => money.amortize(100, 0), /positive integer/);
});
