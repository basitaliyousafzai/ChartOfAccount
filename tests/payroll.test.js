'use strict';

/**
 * Section 3.6 - Payroll & Progressive Withholding Tax.
 * The pure calculator never touches the ledger, so no database is required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PayrollService, progressiveTax, TAX_SLABS } = require('../src/services/payrollService');

const C = (dollars) => Math.round(dollars * 100);

test('case study Tx 13: gross $3,500.00, withholding $350.00, net $3,150.00', () => {
  const calc = new PayrollService(null).calculate({
    baseCents: C(3500), taxWithheldCents: C(350), pensionRate: '0',
  });
  assert.equal(calc.grossCents, 350000);
  assert.equal(calc.taxCents, 35000);
  assert.equal(calc.pensionCents, 0);
  assert.equal(calc.netCents, 315000);
  assert.equal(calc.balancingCents, 0);
  assert.equal(calc.grossCents, calc.taxCents + calc.pensionCents + calc.netCents);
});

test('overtime is paid at hours x 1.5 x rate, in exact cents', () => {
  const calc = new PayrollService(null).calculate({
    baseCents: C(3000), overtimeHours: 5, hourlyRateCents: C(20), taxWithheldCents: 0,
  });
  assert.equal(calc.overtimePayCents, C(150));   // 5 x 1.5 x $20.00
  assert.equal(calc.grossCents, C(3150));
  assert.equal(calc.netCents, C(3150));
});

test('pension deduction is computed on gross and never breaks the balance rule', () => {
  const calc = new PayrollService(null).calculate({
    baseCents: C(1000), pensionRate: '0.05', taxWithheldCents: C(100),
  });
  assert.equal(calc.pensionCents, C(50));
  assert.equal(calc.grossCents, calc.taxCents + calc.pensionCents + calc.netCents);
  assert.equal(calc.netCents, C(850));
});

test('the balancing rule rejects deductions that exceed gross pay', () => {
  assert.throws(
    () => new PayrollService(null).calculate({ baseCents: C(100), taxWithheldCents: C(200) }),
    /cannot exceed gross|balancing/i,
  );
});

test('progressive tax slabs: piecewise thresholds are exact', () => {
  assert.equal(TAX_SLABS.length, 4);
  assert.equal(TAX_SLABS[0].upTo, 5000000);          // $50,000
  assert.equal(progressiveTax(C(50000)), 0);          // inside slab 1
  assert.equal(progressiveTax(C(75000)), C(1250));    // 5% of ($75k - $50k)
  assert.equal(progressiveTax(C(150000)), C(10000));  // 2,500 + 15% of $50k
  assert.equal(progressiveTax(C(300000)), C(42500));  // 17,500 + 25% of $100k
});

test('progressive tax is monotonic across the slab boundaries', () => {
  let previous = -1;
  for (const gross of [0, 5000000, 5000001, 7500000, 10000000, 10000001, 15000000, 20000000, 20000001, 40000000]) {
    const tax = progressiveTax(gross);
    assert.ok(tax >= previous, `tax must never decrease at ${gross}`);
    assert.ok(tax <= gross, `tax can never exceed gross at ${gross}`);
    previous = tax;
  }
});

test('documented deviation: the slab gives 0 for a $3,500 monthly gross', () => {
  // The SRS case study posts $350.00 of withholding on a $3,500.00 month, but
  // its own slab table is ANNUAL and returns 0 below $50,000.  The engine
  // therefore exposes an explicit taxWithheldCents override - see
  // docs/DEVIATIONS.md.
  assert.equal(progressiveTax(C(3500)), 0);
  const override = new PayrollService(null).calculate({ baseCents: C(3500), taxWithheldCents: C(350) });
  assert.equal(override.taxCents, C(350));
  const derived = new PayrollService(null).calculate({ baseCents: C(3500) });
  assert.equal(derived.taxCents, 0);
});
