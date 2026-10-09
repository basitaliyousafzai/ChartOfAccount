'use strict';

/**
 * Tax & Discount Engine (Section 3.4)
 * ----------------------------------------------------------------------------
 * Equation 5A  Tax-Exclusive:  G = Q*P, D = G*d, R = G-D, T = R*r, A = R+T
 * Equation 5B  Tax-Inclusive:  A = Q*P*(1-d), R = A/(1+r), T = A-R
 * Deterministic penny allocation: line rounding happens in integer cents and
 * any residual is allocated explicitly, never absorbed by float noise.
 */

const money = require('../core/money');
const { ValidationError } = require('../core/errors');

/**
 * Compute the commercial maths for ONE invoice line, in exact cents.
 *
 * @param {object} input
 * @param {number} input.qty               whole units
 * @param {number} input.unitPriceCents    integer cents
 * @param {string|number} [input.discountRate='0'] trade discount rate 0..1
 * @param {string|number} [input.taxRate='0.10']    sales tax rate
 * @param {boolean} [input.priceIncludesTax=false]  shelf price already contains tax
 * @returns {{grossCents:number, discountCents:number, netCents:number, taxCents:number, totalCents:number}}
 */
function computeLineTotals({
  qty, unitPriceCents, discountRate = '0', taxRate = '0.10', priceIncludesTax = false,
}) {
  const quantity = Number(qty);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new ValidationError('qty must be a positive integer');
  const unit = money.toCents(unitPriceCents);
  if (unit < 0) throw new ValidationError('unitPriceCents cannot be negative');

  const grossCents = money.assertCents(quantity * unit, 'line gross');
  const discountCents = money.applyRate(grossCents, discountRate);

  if (priceIncludesTax) {
    // Equation 5B
    const totalCents = money.sub(grossCents, discountCents);
    const netCents = money.netOfGross(totalCents, taxRate);
    const taxCents = money.sub(totalCents, netCents);
    return { grossCents, discountCents, netCents, taxCents, totalCents };
  }

  // Equation 5A
  const netCents = money.sub(grossCents, discountCents);
  const taxCents = money.applyRate(netCents, taxRate);
  const totalCents = money.add(netCents, taxCents);
  return { grossCents, discountCents, netCents, taxCents, totalCents };
}

/**
 * Sum several line computations and reconcile the header total against the sum
 * of rounded lines (Deterministic Penny Allocation Rule, Section 3.4).
 * Any mismatch between header total and Σ(lines) is assigned to the dedicated
 * Rounding Adjustment account (4.10.02.0003.0001).
 */
function reconcileHeaderTotal(lines) {
  const net = lines.reduce((s, l) => s + l.netCents, 0);
  const tax = lines.reduce((s, l) => s + l.taxCents, 0);
  const total = lines.reduce((s, l) => s + l.totalCents, 0);
  const computed = money.add(net, tax);
  return { netCents: net, taxCents: tax, totalCents: total, roundingCents: money.sub(total, computed), drift: money.sub(computed, total) };
}

/**
 * Split a tax-inclusive receipt across net/tax for a payment that may include
 * several invoices (used by AR receipts on tax-inclusive settlements).
 */
function splitTaxInclusive(amountCents, taxRate) {
  const gross = money.toCents(amountCents);
  const net = money.netOfGross(gross, taxRate);
  return { netCents: net, taxCents: money.sub(gross, net), totalCents: gross };
}

module.exports = { computeLineTotals, reconcileHeaderTotal, splitTaxInclusive };
