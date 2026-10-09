'use strict';

/**
 * Payroll Service (Equation 7, Section 3.6)
 * ----------------------------------------------------------------------------
 *   Gross   = Base + (OT x 1.5 x Rate) + Allowances
 *   Tax     = PiecewiseSlab(Gross)            [or an explicit withholding]
 *   Pension = Gross x r_pension
 *   Net     = Gross - Tax - Pension
 *   BALANCING RULE:  Gross == Tax + Pension + Net     (asserted before posting)
 *
 * Posting matrix (Section 5):
 *   DR Staff Salaries & Wages (6.10.02.0001.0001) [Gross]
 *   CR Employee Payroll Tax Withheld (2.10.02.0002.0001) [Tax]
 *   CR Accrued Salaries Payable (2.10.03.0001.0001) [Pension withheld, if any]
 *   CR Bank/Cash [Net]
 */

const money = require('../core/money');
const { COA } = require('./coaSeed');
const { AccountService } = require('./accountService');
const { LedgerService } = require('./ledgerService');
const { ValidationError } = require('../core/errors');

/**
 * Progressive withholding tax (piecewise slab function, all values in cents).
 * Thresholds are annual; divide a monthly gross by 12 before applying it.
 */
const TAX_SLABS = [
  { upTo: 5000000, base: 0, rate: '0', label: '0 - 50,000: 0%' },
  { upTo: 10000000, base: 0, rate: '0.05', label: '50,001 - 100,000: 5% of excess' },
  { upTo: 20000000, base: 250000, rate: '0.15', label: '100,001 - 200,000: 2,500 + 15% of excess' },
  { upTo: Infinity, base: 1750000, rate: '0.25', label: '> 200,000: 17,500 + 25% of excess' },
];

function progressiveTax(grossCents) {
  let slab = TAX_SLABS[0];
  let previousCeiling = 0;
  for (const candidate of TAX_SLABS) {
    slab = candidate;
    if (grossCents <= candidate.upTo) break;
    previousCeiling = candidate.upTo;
  }
  const excess = Math.max(grossCents - previousCeiling, 0);
  return money.add(slab.base, money.applyRate(excess, slab.rate));
}

class PayrollService {
  constructor(db) {
    this.db = db;
    this.accounts = new AccountService(db);
    this.ledger = new LedgerService(db);
  }

  /** Pure calculation - never touches the ledger. */
  calculate({
    baseCents = 0, overtimeHours = 0, hourlyRateCents = 0, allowancesCents = 0,
    pensionRate = '0', taxWithheldCents = null, annualiseMonths = 1,
  }) {
    const base = money.toCents(baseCents);
    const allowances = money.toCents(allowancesCents);
    const rate = money.toCents(hourlyRateCents);

    // OT pay = hours x 1.5 x rate, computed with integer cents only.
    const hundredths = Math.round(Number(overtimeHours) * 100);
    if (!Number.isFinite(hundredths)) throw new ValidationError('overtimeHours must be numeric');
    const otPay = money.divRoundHalfUp(hundredths * 150 * rate, 10000);

    const gross = money.add(money.add(base, otPay), allowances);
    const tax = taxWithheldCents === null || taxWithheldCents === undefined
      ? progressiveTax(money.divRoundHalfUp(gross, Number(annualiseMonths) || 1))
      : money.toCents(taxWithheldCents);
    const pension = money.applyRate(gross, pensionRate);
    const net = money.sub(money.sub(gross, tax), pension);

    const balancing = money.sub(gross, money.add(money.add(tax, pension), net));
    if (balancing !== 0) {
      throw new ValidationError(`Payroll balancing rule violated: Gross - (Tax + Pension + Net) = ${money.fromCents(balancing)}`);
    }
    if (tax < 0 || pension < 0 || net < 0) throw new ValidationError('Payroll deductions cannot exceed gross pay');

    return {
      baseCents: base,
      overtimePayCents: otPay,
      allowancesCents: allowances,
      grossCents: gross,
      taxCents: tax,
      pensionCents: pension,
      netCents: net,
      balancingCents: balancing,
      formula: `Gross ${money.fromCents(gross)} = Tax ${money.fromCents(tax)} + Pension ${money.fromCents(pension)} + Net ${money.fromCents(net)}`,
    };
  }

  disburse({
    voucherDate, baseCents, overtimeHours = 0, hourlyRateCents = 0, allowancesCents = 0,
    pensionRate = '0', taxWithheldCents = null, annualiseMonths = 1,
    accountCode = COA.BANK_MAIN, entityId = null, createdBy, memo = null,
  }) {
    const calc = this.calculate({
      baseCents, overtimeHours, hourlyRateCents, allowancesCents,
      pensionRate, taxWithheldCents, annualiseMonths,
    });
    if (calc.netCents <= 0) throw new ValidationError('Net payroll must be greater than 0.00');
    const bank = this.accounts.assertPostingTarget(accountCode);

    const lines = [
      { accountCode: COA.SALARIES, debit: calc.grossCents, lineMemo: 'Gross salaries & wages' },
      { accountCode: bank.AccountCode, credit: calc.netCents, lineMemo: 'Net salaries paid', entityId },
    ];
    if (calc.taxCents > 0) {
      lines.push({ accountCode: COA.PAYROLL_TAX, credit: calc.taxCents, lineMemo: 'PAYE / withholding tax withheld' });
    }
    if (calc.pensionCents > 0) {
      lines.push({ accountCode: COA.ACCRUED_SALARIES, credit: calc.pensionCents, lineMemo: 'Employee pension contribution withheld' });
    }

    const voucher = this.ledger.recordVoucher({
      voucherDate,
      voucherType: 'Payroll_Voucher',
      sourceModule: 'Payroll',
      narration: memo || `Monthly payroll disbursal: gross ${money.fromCents(calc.grossCents)}, net ${money.fromCents(calc.netCents)} via ${bank.AccountName}`,
      createdBy,
      lines,
    });

    return { voucher, meta: calc };
  }

  /** Slab documentation for the UI. */
  static get slabs() { return TAX_SLABS; }
}

module.exports = { PayrollService, progressiveTax, TAX_SLABS };
