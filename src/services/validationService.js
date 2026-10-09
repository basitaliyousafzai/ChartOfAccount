'use strict';

/**
 * Validation Service (Phase 3) - the gatekeeper for every posting.
 * ----------------------------------------------------------------------------
 * Implements:
 *   Equation 2  Double-Entry Equality & Tolerance Check  (|DR - CR| == 0.00)
 *   Invariant 2 Posting Level Isolation (Level 5 leaves only)
 *   Invariant 4 Append-Only Immutability
 *   Fiscal-period locking and RBAC authorisation.
 */

const {
  UnbalancedVoucherException,
  ValidationError,
  ClosedPeriodError,
  ForbiddenError,
} = require('../core/errors');

const VOUCHER_TYPES = [
  'General_JV', 'Sales_Invoice', 'Sales_Return',
  'Purchase_Invoice', 'Purchase_Return',
  'Cash_Payment', 'Cash_Receipt',
  'Bank_Payment', 'Bank_Receipt', 'Payroll_Voucher', 'Fiscal_Closing',
];

/** Role capability matrix (Phase 1: RBAC authentication wrapper). */
const PERMISSIONS = {
  Admin: ['post', 'reverse', 'manage_coa', 'manage_users', 'run_reports', 'close_period', 'backup', 'export', 'configure'],
  Accountant: ['post', 'reverse', 'manage_coa', 'run_reports', 'close_period', 'backup', 'export'],
  Cashier: ['post', 'run_reports'],
};

/**
 * Kernel method -> capability required to invoke it (Phase 1 RBAC).
 * Methods absent from this table are public (login/bootstrap/read-only
 * introspection) so the shell can boot before a session exists.
 */
const CAPABILITIES = {
  // --- configuration -----------------------------------------------------
  'system.setSetting': 'configure',
  'auth.users': 'manage_users',
  'closing.ensurePeriods': 'configure',

  // --- chart of accounts -------------------------------------------------
  'coa.add': 'manage_coa',
  'coa.nextChildCode': 'manage_coa',
  'wizard.generate': 'manage_coa',

  // --- posting (Section 5 matrix) ---------------------------------------
  'ledger.record': 'post',
  'inventory.createItem': 'post',
  'inventory.shrinkage': 'post',
  'pos.sale': 'post',
  'sales.invoice': 'post',
  'sales.creditNote': 'post',
  'purchase.bill': 'post',
  'purchase.debitNote': 'post',
  'ar.receipt': 'post',
  'ap.payment': 'post',
  'expense.pay': 'post',
  'capital.deposit': 'post',
  'owner.drawings': 'post',
  'transfer.tillToBank': 'post',
  'payroll.disburse': 'post',
  'payroll.calculate': 'post',
  'assets.register': 'post',
  'assets.runDepreciation': 'post',
  'forex.settle': 'post',

  // --- reversal ----------------------------------------------------------
  'ledger.reverse': 'reverse',

  // --- reporting ---------------------------------------------------------
  'ledger.list': 'run_reports',
  'ledger.get': 'run_reports',
  'ledger.findByVoucherNo': 'run_reports',
  'ledger.ledgerCard': 'run_reports',
  'ledger.grossTotals': 'run_reports',
  'inventory.items': 'run_reports',
  'inventory.lots': 'run_reports',
  'inventory.valuation': 'run_reports',
  'inventory.movements': 'run_reports',
  'inventory.previewFifoCost': 'run_reports',
  'assets.list': 'run_reports',
  'forex.history': 'run_reports',
  'forex.preview': 'run_reports',
  'report.trialBalance': 'run_reports',
  'report.incomeStatement': 'run_reports',
  'report.balanceSheet': 'run_reports',
  'report.proof': 'run_reports',
  'report.entities': 'run_reports',
  'report.dashboard': 'run_reports',
  'report.accountBalances': 'run_reports',
  'closing.status': 'run_reports',

  // --- period control ----------------------------------------------------
  'closing.closePeriod': 'close_period',
  'closing.reopenPeriod': 'close_period',

  // --- backup / export ---------------------------------------------------
  'backup.snapshot': 'backup',
  'backup.dumpJson': 'backup',
  'backup.list': 'backup',
  'backup.restore': 'backup',
  'export.workbook': 'export',
  'export.pdf': 'export',
};

/** Capability required by a kernel method (null = public / no gate). */
function capabilityFor(method) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, method) ? CAPABILITIES[method] : null;
}

class ValidationService {
  constructor(db, accountService) {
    this.db = db;
    this.accounts = accountService;
  }

  /** Equation 2: returns Delta in cents; 0.00 is the only acceptable value. */
  static discrepancy(lines) {
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of lines) {
      const debit = Number(line.debit ?? line.Debit ?? 0);
      const credit = Number(line.credit ?? line.Credit ?? 0);
      if (!Number.isInteger(debit) || !Number.isInteger(credit)) {
        throw new ValidationError(`Line amounts must be integer cents (received debit=${line.debit}, credit=${line.credit})`);
      }
      if (debit < 0 || credit < 0) throw new ValidationError('Negative debit/credit amounts are not permitted; use the opposite side');
      if (debit > 0 && credit > 0) throw new ValidationError('A journal line cannot carry both a debit and a credit');
      if (debit === 0 && credit === 0) throw new ValidationError('A journal line must carry a non-zero debit or credit');
      totalDebit += debit;
      totalCredit += credit;
    }
    return { totalDebit, totalCredit, delta: Math.abs(totalDebit - totalCredit) };
  }

  /** Throws UnbalancedVoucherException unless Delta === 0.00 exactly. */
  assertBalanced(lines) {
    if (!Array.isArray(lines) || lines.length < 2) {
      throw new ValidationError('A journal voucher requires at least two lines (one debit and one credit)');
    }
    const { totalDebit, totalCredit, delta } = ValidationService.discrepancy(lines);
    if (delta !== 0) throw new UnbalancedVoucherException(delta, totalDebit, totalCredit);
    return { totalDebit, totalCredit, delta };
  }

  /** Invariant 2: every line must target an active Level-5 leaf account. */
  assertPostingTargets(lines) {
    for (const line of lines) {
      const ref = line.accountId ?? line.accountCode;
      if (ref === undefined || ref === null || ref === '') {
        throw new ValidationError('Every journal line requires an accountId or accountCode');
      }
      this.accounts.assertPostingTarget(ref);
    }
    return true;
  }

  /** Fiscal period lock (Section 3.10): closed periods reject new postings. */
  periodFor(date) {
    const iso = String(date).slice(0, 10);
    const period = this.db.prepare(
      'SELECT * FROM FiscalPeriods WHERE StartDate <= ? AND EndDate >= ?',
    ).get(iso, iso);
    if (!period) {
      throw new ValidationError(`No fiscal period covers the posting date ${iso}`);
    }
    if (period.IsClosed) throw new ClosedPeriodError(period.PeriodName);
    return period;
  }

  assertPermissions(role, capability) {
    const granted = PERMISSIONS[role] || [];
    if (!granted.includes(capability)) {
      throw new ForbiddenError(role, capability);
    }
    return true;
  }

  /**
   * Phase 1 RBAC gate for the IPC boundary: resolves the capability a kernel
   * method needs and checks it against the caller's role. Methods with no
   * entry in CAPABILITIES are public (login, bootstrap, schema introspection).
   * @param {string} method dotted kernel method name
   * @param {string|null} role signed-in role, or null/undefined when anonymous
   * @returns {boolean} true when the call is allowed
   */
  assertAuthorized(method, role) {
    const capability = capabilityFor(method);
    if (!capability) return true;
    if (!role) throw new ForbiddenError(null, capability, method);
    if (!(PERMISSIONS[role] || []).includes(capability)) {
      throw new ForbiddenError(role, capability, method);
    }
    return true;
  }

  /**
   * Full pre-commit validation pipeline for a voucher payload.
   * Returns normalized header + line values in exact integer cents.
   */
  validateVoucherPayload(payload) {
    const {
      voucherDate, voucherType, narration, lines, referenceNo = null,
    } = payload;

    if (!voucherDate || !/^\d{4}-\d{2}-\d{2}/.test(String(voucherDate))) {
      throw new ValidationError('voucherDate must be an ISO date (YYYY-MM-DD)');
    }
    if (!VOUCHER_TYPES.includes(voucherType)) {
      throw new ValidationError(`Unknown voucherType "${voucherType}"`, { allowed: VOUCHER_TYPES });
    }
    if (!narration || !String(narration).trim()) throw new ValidationError('Narration is required');

    this.assertPostingTargets(lines);
    const totals = this.assertBalanced(lines);
    const period = this.periodFor(voucherDate);

    return {
      voucherDate: String(voucherDate).slice(0, 10),
      voucherType,
      narration: String(narration).trim(),
      referenceNo: referenceNo ? String(referenceNo) : null,
      periodId: period.PeriodId,
      periodName: period.PeriodName,
      lines: lines.map((line) => ({
        accountId: line.accountId ?? this.accounts.getByCode(line.accountCode).AccountId,
        debit: Number(line.debit ?? 0),
        credit: Number(line.credit ?? 0),
        lineMemo: line.lineMemo ?? line.memo ?? null,
        entityId: line.entityId ?? null,
      })),
      ...totals,
    };
  }
}

module.exports = {
  ValidationService,
  VOUCHER_TYPES,
  PERMISSIONS,
  CAPABILITIES,
  capabilityFor,
};
