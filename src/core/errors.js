'use strict';

/** Domain error hierarchy for the accounting kernel. */

class LedgerError extends Error {
  constructor(message, code = 'LEDGER_ERROR', details = null) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

/** Invariant 1 violation: |SUM(Debit) - SUM(Credit)| != 0.00 */
class UnbalancedVoucherException extends LedgerError {
  constructor(deltaCents, totalDebit, totalCredit) {
    super(
      `Unbalanced voucher rejected: |${(totalDebit / 100).toFixed(2)} - ${(totalCredit / 100).toFixed(2)}| = ${(deltaCents / 100).toFixed(2)} != 0.00`,
      'UNBALANCED_VOUCHER',
      { deltaCents, totalDebit, totalCredit },
    );
  }
}

/** Invariant 2 violation: posting attempted against a Level 1-4 summary head. */
class PostingLevelViolation extends LedgerError {
  constructor(accountCode, accountLevel) {
    super(
      `Posting blocked: account ${accountCode} is a Level ${accountLevel} summary head. Only Level 5 leaf accounts (IsPostingAllowed = 1) accept journal lines.`,
      'POSTING_LEVEL_VIOLATION',
      { accountCode, accountLevel },
    );
  }
}

/** Invariant 4 violation: attempt to mutate a committed voucher. */
class ImmutabilityViolation extends LedgerError {
  constructor(voucherNo) {
    super(
      `Voucher ${voucherNo} is immutable. Post a reversing contra-voucher instead (Invariant 4).`,
      'IMMUTABILITY_VIOLATION',
      { voucherNo },
    );
  }
}

class InsufficientStockError extends LedgerError {
  constructor(itemCode, requested, available) {
    super(
      `Insufficient stock for ${itemCode}: requested ${requested}, available ${available} (perpetual FIFO queue exhausted).`,
      'INSUFFICIENT_STOCK',
      { itemCode, requested, available },
    );
  }
}

class ClosedPeriodError extends LedgerError {
  constructor(periodName) {
    super(`Fiscal period ${periodName} is closed. Postings are locked (IsClosed = 1).`, 'CLOSED_PERIOD', { periodName });
  }
}

class AuthenticationError extends LedgerError {
  constructor(message = 'Invalid credentials or inactive user.') {
    super(message, 'AUTH_FAILED');
  }
}

/** RBAC denial (Phase 1): the signed-in role lacks the required capability. */
class ForbiddenError extends LedgerError {
  constructor(role, capability, method = null) {
    super(
      `Not authorised: role "${role || 'anonymous'}" cannot "${capability}"${method ? ` (${method})` : ''}.`,
      'FORBIDDEN',
      { role: role || null, capability, method },
    );
  }
}

class ValidationError extends LedgerError {
  constructor(message, details = null) {
    super(message, 'VALIDATION_ERROR', details);
  }
}

class NotFoundError extends LedgerError {
  constructor(message) {
    super(message, 'NOT_FOUND');
  }
}

module.exports = {
  LedgerError,
  UnbalancedVoucherException,
  PostingLevelViolation,
  ImmutabilityViolation,
  InsufficientStockError,
  ClosedPeriodError,
  AuthenticationError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
};
