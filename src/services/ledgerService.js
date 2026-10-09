'use strict';

/**
 * Ledger Service (Phase 3) - the double-entry kernel.
 * ----------------------------------------------------------------------------
 * recordVoucher() is the single write path into the general ledger.  It:
 *   1. validates the payload (Equation 2, Invariant 2, period lock),
 *   2. inserts a draft header + lines inside ONE atomic transaction,
 *   3. commits by flipping IsPosted 0 -> 1, which re-triggers the same
 *      |SUM(DR) - SUM(CR)| == 0.00 proof inside SQLite itself,
 *   4. refreshes customer/vendor sub-ledger balances from posted lines.
 *
 * Postings are append-only: corrections go through reverseVoucher()
 * (Invariant 4 - reversing contra-voucher linked to the original).
 */

const { ValidationService, VOUCHER_TYPES } = require('./validationService');
const { AccountService } = require('./accountService');
const { ImmutabilityViolation, NotFoundError, ValidationError } = require('../core/errors');

const VOUCHER_PREFIX = {
  General_JV: 'JV',
  Sales_Invoice: 'SI',
  Sales_Return: 'CN',
  Purchase_Invoice: 'PI',
  Purchase_Return: 'DN',
  Cash_Payment: 'CP',
  Cash_Receipt: 'CR',
  Bank_Payment: 'BP',
  Bank_Receipt: 'BR',
  Payroll_Voucher: 'PR',
  Fiscal_Closing: 'FC',
};

class LedgerService {
  constructor(db) {
    this.db = db;
    this.accounts = new AccountService(db);
    this.validator = new ValidationService(db, this.accounts);
  }

  nextVoucherNo(voucherDate, voucherType) {
    const prefix = VOUCHER_PREFIX[voucherType] || 'JV';
    const yyyymm = String(voucherDate).slice(0, 4) + String(voucherDate).slice(5, 7);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c FROM JournalVouchers
       WHERE VoucherType = ? AND strftime('%Y-%m', VoucherDate) = ?
    `).get(voucherType, `${String(voucherDate).slice(0, 4)}-${String(voucherDate).slice(5, 7)}`);
    return `${prefix}-${yyyymm}-${String(row.c + 1).padStart(4, '0')}`;
  }

  /**
   * Atomically post a journal voucher.
   * @param {object} payload
   * @param {string} payload.voucherDate  YYYY-MM-DD
   * @param {string} payload.voucherType  one of VOUCHER_TYPES
   * @param {string} payload.narration
   * @param {Array}  payload.lines        [{ accountCode|accountId, debit, credit, lineMemo?, entityId? }]
   * @param {number} payload.createdBy    Users.UserId
   * @returns {{voucherId:number, voucherNo:string, totalDebit:number, totalCredit:number, lines:Array}}
   */
  recordVoucher(payload) {
    const validated = this.validator.validateVoucherPayload(payload);
    const createdBy = payload.createdBy ?? payload.userId;
    if (!createdBy) throw new ValidationError('createdBy (UserId) is required to post a voucher');

    return this.db.transaction(() => {
      const voucherNo = this.nextVoucherNo(validated.voucherDate, validated.voucherType);

      const header = this.db.prepare(`
        INSERT INTO JournalVouchers (VoucherNo, VoucherDate, PeriodId, VoucherType, SourceModule,
                                     ReferenceNo, Narration, IsReversal, ReversesVoucherId,
                                     IsPosted, TotalDebit, TotalCredit, CreatedBy)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
      `).run(
        voucherNo, validated.voucherDate, validated.periodId, validated.voucherType,
        payload.sourceModule || null, validated.referenceNo, validated.narration,
        payload.reversesVoucherId ? 1 : 0, payload.reversesVoucherId || null, createdBy,
      );
      const voucherId = header.lastInsertRowid;

      const insertLine = this.db.prepare(`
        INSERT INTO JournalVoucherLines (VoucherId, AccountId, Debit, Credit, LineMemo, EntityId)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const line of validated.lines) {
        insertLine.run(voucherId, line.accountId, line.debit, line.credit, line.lineMemo, line.entityId);
      }

      // Commit step: fires trg_voucher_post_balance_check inside SQLite.
      this.db.prepare(`
        UPDATE JournalVouchers
           SET IsPosted = 1, TotalDebit = ?, TotalCredit = ?
         WHERE VoucherId = ?
      `).run(validated.totalDebit, validated.totalCredit, voucherId);

      this.refreshEntityBalances(validated.lines.map((l) => l.entityId).filter(Boolean));

      return {
        voucherId,
        voucherNo,
        voucherDate: validated.voucherDate,
        voucherType: validated.voucherType,
        narration: validated.narration,
        totalDebit: validated.totalDebit,
        totalCredit: validated.totalCredit,
        delta: validated.delta,
        lines: this.getVoucher(voucherId).lines,
      };
    });
  }

  /**
   * Invariant 4 - automated reversing Contra-Voucher linked to the original.
   * The original voucher is never touched; the reversal mirrors every line.
   */
  reverseVoucher(voucherId, { voucherDate = null, reason = null, createdBy = null } = {}) {
    const original = this.getVoucher(voucherId);
    if (original.IsReversal) throw new ValidationError(`Voucher ${original.VoucherNo} is already a reversal`);
    const alreadyReversed = this.db.prepare(
      'SELECT VoucherNo FROM JournalVouchers WHERE ReversesVoucherId = ?',
    ).get(voucherId);
    if (alreadyReversed) {
      throw new ImmutabilityViolation(original.VoucherNo);
    }

    const date = voucherDate || original.VoucherDate;
    return this.recordVoucher({
      voucherDate: date,
      voucherType: original.VoucherType === 'Fiscal_Closing' ? 'General_JV' : original.VoucherType,
      narration: `REVERSAL of ${original.VoucherNo}: ${original.Narration}${reason ? ` | Reason: ${reason}` : ''}`,
      referenceNo: original.VoucherNo,
      sourceModule: 'Reversal',
      reversesVoucherId: voucherId,
      createdBy: createdBy || original.CreatedBy,
      lines: original.lines.map((line) => ({
        accountId: line.AccountId,
        debit: line.Credit,
        credit: line.Debit,
        lineMemo: `Reversal of line ${line.LineId}`,
        entityId: line.EntityId,
      })),
    });
  }

  getVoucher(voucherId) {
    const header = this.db.prepare('SELECT * FROM JournalVouchers WHERE VoucherId = ?').get(voucherId);
    if (!header) throw new NotFoundError(`Voucher ${voucherId} not found`);
    const lines = this.db.prepare(`
      SELECT l.*, a.AccountCode, a.AccountName, a.NormalBalance, a.RootType
        FROM JournalVoucherLines l
        JOIN Accounts a ON a.AccountId = l.AccountId
       WHERE l.VoucherId = ?
       ORDER BY l.LineId ASC
    `).all(voucherId);
    return { ...header, lines };
  }

  findByVoucherNo(voucherNo) {
    const row = this.db.prepare('SELECT VoucherId FROM JournalVouchers WHERE VoucherNo = ?').get(voucherNo);
    if (!row) throw new NotFoundError(`Voucher ${voucherNo} not found`);
    return this.getVoucher(row.VoucherId);
  }

  listVouchers({ from = null, to = null, voucherType = null, limit = 500 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (from) { where.push('VoucherDate >= ?'); params.push(from); }
    if (to) { where.push('VoucherDate <= ?'); params.push(to); }
    if (voucherType) { where.push('VoucherType = ?'); params.push(voucherType); }
    params.push(limit);
    return this.db.prepare(`
      SELECT * FROM JournalVouchers WHERE ${where.join(' AND ')}
       ORDER BY VoucherDate DESC, VoucherId DESC LIMIT ?
    `).all(...params);
  }

  /**
   * Section 4.2.3 - Running General Ledger Card (window function).
   * RunningBalance_{i,m} = RunningBalance_{i,m-1} +/- (Debit - Credit)
   */
  ledgerCard(accountCode, { from = null, to = null, openingBalance = 0 } = {}) {
    const account = this.accounts.getByCode(accountCode);
    const where = ['a.AccountCode = ?', 'v.IsPosted = 1'];
    const params = [accountCode];
    if (from) { where.push('v.VoucherDate >= ?'); params.push(from); }
    if (to) { where.push('v.VoucherDate <= ?'); params.push(to); }

    const rows = this.db.prepare(`
      SELECT v.VoucherDate, v.VoucherNo, v.VoucherType, v.Narration, v.IsReversal,
             l.LineMemo, l.Debit, l.Credit, l.LineId, v.VoucherId,
             CASE
               WHEN a.NormalBalance = 'Debit' THEN
                 SUM(l.Debit - l.Credit) OVER (PARTITION BY l.AccountId ORDER BY v.VoucherDate, v.VoucherId, l.LineId)
               WHEN a.NormalBalance = 'Credit' THEN
                 SUM(l.Credit - l.Debit) OVER (PARTITION BY l.AccountId ORDER BY v.VoucherDate, v.VoucherId, l.LineId)
             END AS RunningBalance
        FROM JournalVoucherLines l
        JOIN JournalVouchers v ON l.VoucherId = v.VoucherId
        JOIN Accounts a ON l.AccountId = a.AccountId
       WHERE ${where.join(' AND ')}
       ORDER BY v.VoucherDate ASC, v.VoucherId ASC, l.LineId ASC
    `).all(...params);

    let running = openingBalance;
    const entries = rows.map((row) => {
      running += account.NormalBalance === 'Debit'
        ? row.Debit - row.Credit
        : row.Credit - row.Debit;
      return { ...row, RunningBalance: running };
    });

    const totals = rows.reduce((acc, row) => ({
      totalDebit: acc.totalDebit + row.Debit,
      totalCredit: acc.totalCredit + row.Credit,
    }), { totalDebit: 0, totalCredit: 0 });

    return {
      account: {
        AccountCode: account.AccountCode,
        AccountName: account.AccountName,
        NormalBalance: account.NormalBalance,
        RootType: account.RootType,
      },
      openingBalance,
      entries,
      closingBalance: running,
      ...totals,
    };
  }

  /** Recompute Customer/Vendor sub-ledger balances from posted lines (exact). */
  refreshEntityBalances(entityIds) {
    const unique = [...new Set(entityIds)];
    if (unique.length === 0) return;
    const stmt = this.db.prepare(`
      UPDATE Entities
         SET CurrentBalance = COALESCE((
               SELECT SUM(CASE WHEN a.NormalBalance = 'Debit'
                               THEN l.Debit - l.Credit
                               ELSE l.Credit - l.Debit END)
                 FROM JournalVoucherLines l
                 JOIN Accounts a ON a.AccountId = l.AccountId
                 JOIN JournalVouchers v ON v.VoucherId = l.VoucherId
                WHERE l.EntityId = ? AND v.IsPosted = 1), 0)
       WHERE EntityId = ?
    `);
    for (const id of unique) stmt.run(id, id);
  }

  /** Section 4.2.1 helper: gross debit/credit totals over the whole ledger. */
  grossTotals({ asOfDate = null } = {}) {
    const params = [];
    let filter = '';
    if (asOfDate) { filter = ' AND v.VoucherDate <= ?'; params.push(asOfDate); }
    return this.db.prepare(`
      SELECT COALESCE(SUM(l.Debit), 0)  AS totalDebit,
             COALESCE(SUM(l.Credit), 0) AS totalCredit
        FROM JournalVoucherLines l
        JOIN JournalVouchers v ON v.VoucherId = l.VoucherId
       WHERE v.IsPosted = 1${filter}
    `).get(...params);
  }

  static get VOUCHER_TYPES() { return VOUCHER_TYPES; }
}

module.exports = { LedgerService, VOUCHER_PREFIX };
