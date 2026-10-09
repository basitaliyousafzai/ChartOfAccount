'use strict';

/**
 * Invariant 3: Complete Elimination of Floating-Point Math
 * ----------------------------------------------------------------------------
 * Every monetary value in this engine is an INTEGER NUMBER OF CENTS (minor
 * units).  $10.50 is represented as 1050.  No float/double ever touches a
 * ledger amount.
 *
 * Percentage math (tax, discounts, depreciation, allocation) is performed with
 * exact rational arithmetic: a decimal rate such as 0.10 is parsed into the
 * integer fraction 10/100 and evaluated with integer division + explicit
 * half-up rounding, so `applyRate(800000, '0.10') === 80000` always and
 * `sum(allocate(...)) === total` always.
 */

/** @typedef {number} Cents - exact integer count of minor currency units */

const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

function assertCents(value, label = 'amount') {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of cents, received ${String(value)}`);
  }
  if (Math.abs(value) > MAX_SAFE_CENTS) {
    throw new RangeError(`${label} exceeds safe integer range: ${value}`);
  }
  return value;
}

/**
 * Parse a human monetary string ("1,234.56", "-83.33", "20000") or an integer
 * into cents.  Rejects anything with more than 2 decimal places.
 * @returns {Cents}
 */
function toCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite amount: ${value}`);
    // Accept only values that are already integer cents or exact 2dp decimals.
    if (Number.isInteger(value)) return assertCents(value, 'amount');
    const asText = value.toFixed(2);
    if (Math.abs(value - Number(asText)) > 1e-9) {
      throw new RangeError(`Amount ${value} has more than 2 decimal places`);
    }
    return fromDecimalString(asText);
  }
  if (typeof value === 'bigint') return assertCents(Number(value), 'amount');
  if (typeof value === 'string') return fromDecimalString(value);
  throw new TypeError(`Cannot convert ${typeof value} to cents: ${value}`);
}

function fromDecimalString(text) {
  const cleaned = String(text).trim().replace(/,/g, '').replace(/^\+/, '');
  const match = /^(-?)(\d*)(?:\.(\d{1,}))?$/.exec(cleaned);
  if (!match || (match[2] === '' && !match[3])) {
    throw new RangeError(`Invalid monetary literal: "${text}"`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] === '' ? '0' : match[2];
  const frac = match[3] || '';
  if (frac.length > 2) {
    // Trailing zeros beyond 2dp are tolerated ("10.500" == 10.50).
    if (/^0+$/.test(frac.slice(2))) {
      return sign * Number(whole) * 100 + sign * Number((frac + '00').slice(0, 2));
    }
    throw new RangeError(`Amount "${text}" exceeds 2 decimal places (precision standard: DECIMAL(18,2))`);
  }
  const centsWhole = Number(whole) * 100;
  const centsFrac = Number((frac + '00').slice(0, 2));
  return assertCents(sign * (centsWhole + centsFrac), 'amount');
}

/**
 * Render cents as a fixed 2dp decimal string ("123456" -> "1234.56").
 * Grouping/thousands separators are the presentation layer's concern.
 * @returns {string}
 */
function fromCents(cents) {
  assertCents(cents, 'amount');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Display helper: "1,234.56" */
function formatCents(cents, { currency = '' } = {}) {
  const text = fromCents(cents);
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [whole, frac] = body.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '(' : ''}${currency}${grouped}.${frac}${negative ? ')' : ''}`;
}

function add(a, b) { return assertCents(a + b, 'sum'); }
function sub(a, b) { return assertCents(a - b, 'difference'); }
function sum(list) { return list.reduce((acc, v) => acc + assertCents(v, 'value'), 0); }
function negate(a) { return assertCents(-a, 'negation'); }
function abs(a) { return Math.abs(assertCents(a, 'value')); }
function min(a, b) { return Math.min(a, b); }
function max(a, b) { return Math.max(a, b); }
function isZero(a) { return assertCents(a, 'value') === 0; }

/**
 * Exact integer division with half-up rounding (commercial rounding).
 * Computes round(signedNumerator / denominator) with NO floating point.
 */
function divRoundHalfUp(numerator, denominator) {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new TypeError('divRoundHalfUp expects integers');
  }
  if (denominator === 0) throw new RangeError('Division by zero');
  const sign = (numerator < 0) !== (denominator < 0) ? -1 : 1;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const r = n - q * d;
  const rounded = (2 * r >= d) ? q + 1 : q;
  return sign * rounded;
}

/**
 * Parse a decimal rate string ("0.10", "1.25", "37.5") into an exact fraction.
 * Numbers are converted through toString() so 0.1 becomes "0.1" (never 0.10000000000000001).
 */
function parseRate(rate) {
  if (rate === null || rate === undefined) return { num: 0, den: 1 };
  const text = typeof rate === 'number' ? stripFloatNoise(rate) : String(rate).trim();
  const match = /^(-?)(\d*)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2] === '' && !match[3])) throw new RangeError(`Invalid rate: "${rate}"`);
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] === '' ? '0' : match[2];
  const frac = match[3] || '';
  const den = 10 ** frac.length;
  const num = sign * (Number(whole) * den + Number(frac === '' ? '0' : frac));
  if (!Number.isSafeInteger(num)) throw new RangeError(`Rate too large: ${rate}`);
  return { num, den };
}

function stripFloatNoise(value) {
  // 0.1 + 0.2 -> 0.30000000000000004 would stringify poorly; use toPrecision
  // then trim, which is exact for any double produced by decimal literals.
  return Number(value).toString();
}

/**
 * cents * rate, rounded half-up, evaluated exactly.
 *   applyRate(800000, '0.10') === 80000
 *   applyRate(1122000, 0.10)  === 112200
 * @returns {Cents}
 */
function applyRate(cents, rate) {
  assertCents(cents, 'amount');
  const { num, den } = parseRate(rate);
  return divRoundHalfUp(cents * num, den);
}

/** Gross amount implied by a net amount and a tax rate: net * (1 + rate). */
function grossUp(netCents, rate) {
  const { num, den } = parseRate(rate);
  return divRoundHalfUp(netCents * (den + num), den);
}

/** Net amount extracted from a tax-inclusive gross amount: gross / (1 + rate). */
function netOfGross(grossCents, rate) {
  const { num, den } = parseRate(rate);
  return divRoundHalfUp(grossCents * den, den + num);
}

/**
 * Deterministic penny allocation (largest-remainder / Hamilton method).
 * Splits `totalCents` across `weights` so the parts are integers summing to
 * EXACTLY `totalCents` - the core of the spec's "Deterministic Penny
 * Allocation" rule for discounts, landed freight and rounding adjustments.
 *
 * @param {Cents} totalCents amount to distribute (may be negative)
 * @param {number[]} weights non-negative weights (invoice line values, etc.)
 * @returns {Cents[]} integer parts, same length as weights, sum === totalCents
 */
function allocate(totalCents, weights) {
  assertCents(totalCents, 'allocation total');
  if (!Array.isArray(weights) || weights.length === 0) {
    if (totalCents !== 0) throw new RangeError('Cannot allocate a non-zero total across zero weights');
    return [];
  }
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new TypeError('Allocation weights must be non-negative integers (exact line values)');
  }
  const weightSum = weights.reduce((acc, w) => acc + w, 0);
  if (weightSum <= 0) {
    // Degenerate weights: fall back to equal split so invariants still hold.
    return allocateEqual(totalCents, weights.length);
  }
  const sign = totalCents < 0 ? -1 : 1;
  const total = BigInt(Math.abs(totalCents));
  const bigWeights = weights.map((w) => BigInt(w));
  const bigSum = BigInt(weightSum);
  // Exact BigInt base: floor(total * w / weightSum) - no floating point at all.
  const products = bigWeights.map((w) => total * w);
  const base = products.map((p) => Number(p / bigSum));
  const remainders = products.map((p) => p % bigSum);
  let leftover = Math.abs(totalCents) - base.reduce((a, b) => a + b, 0);
  // Assign leftover pennies to the largest fractional parts (largest remainder),
  // ties broken by lowest index so the result is fully deterministic.
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => {
      const diff = remainders[b] > remainders[a] ? 1 : (remainders[b] < remainders[a] ? -1 : 0);
      return diff !== 0 ? diff : a - b;
    });
  const parts = base.slice();
  let cursor = 0;
  while (leftover > 0) {
    parts[order[cursor % order.length]] += 1;
    leftover -= 1;
    cursor += 1;
  }
  return parts.map((p) => sign * p);
}

function allocateEqual(totalCents, count) {
  assertCents(totalCents, 'allocation total');
  const sign = totalCents < 0 ? -1 : 1;
  const total = Math.abs(totalCents);
  const base = Math.floor(total / count);
  const parts = new Array(count).fill(base);
  let remainder = total - base * count;
  for (let i = 0; i < parts.length && remainder > 0; i += 1) { parts[i] += 1; remainder -= 1; }
  return parts.map((p) => sign * p);
}

/**
 * Allocate an amount over N future periods (depreciation, prepaid amortisation)
 * so the rounded parts sum EXACTLY to the unrounded total: no cent is lost or
 * created across the schedule.  Leftover cents are appended to the TAIL of the
 * schedule so the first periods carry the rounded-down value (month 1 of a
 * $5,000 / 60-month straight-line run is 8333 = $83.33, and the last months
 * absorb the 20 residual cents).
 * @param {number} totalCents
 * @param {number} periods
 * @returns {Cents[]}
 */
function amortize(totalCents, periods) {
  assertCents(totalCents, 'amortisation total');
  if (!Number.isInteger(periods) || periods <= 0) throw new RangeError('periods must be a positive integer');
  const sign = totalCents < 0 ? -1 : 1;
  const total = Math.abs(totalCents);
  const base = Math.floor(total / periods);
  const parts = new Array(periods).fill(base);
  let remainder = total - base * periods;
  for (let i = parts.length - 1; i >= 0 && remainder > 0; i -= 1) {
    parts[i] += 1;
    remainder -= 1;
  }
  return parts.map((p) => sign * p);
}

module.exports = {
  MAX_SAFE_CENTS,
  assertCents,
  toCents,
  fromCents,
  formatCents,
  add,
  sub,
  sum,
  negate,
  abs,
  min,
  max,
  isZero,
  divRoundHalfUp,
  parseRate,
  applyRate,
  grossUp,
  netOfGross,
  allocate,
  allocateEqual,
  amortize,
};
