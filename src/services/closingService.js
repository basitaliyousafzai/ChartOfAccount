'use strict';

/**
 * Closing Service (Section 3.10) - fiscal year/period end flush.
 * ----------------------------------------------------------------------------
 * Nominal accounts (Revenue, COGS, Expense) are zeroed and transferred into
 * permanent Retained Earnings:
 *   DR each Revenue account (zeroing)          CR each Expense/COGS account
 *   Net_Diff = SUM(B_rev) - SUM(B_exp)
 *   Net_Diff > 0 -> CR Retained Earnings (profit)   |   Net_Diff < 0 -> DR (loss)
 * Finally the period is locked (IsClosed = 1).
 */

const money = require('../core/money');
const { COA } = require('./coaSeed');
const { AccountService } = require('./accountService');
const { LedgerService } = require('./ledgerService');
const { ValidationError, ClosedPeriodError, NotFoundError } = require('../core/errors');

const NOMINAL_ROOTS = ['Revenue', 'CostOfSales', 'Expense'];

class ClosingService {
  constructor(db) {
    this.db = db;
    this.accounts = new AccountService(db);
    this.ledger = new LedgerService(db);
  }

  /** Create 12 monthly periods for any fiscal year touched by `date`. */
  ensurePeriodsFor(date) {
    const iso = String(date).slice(0, 10);
    const year = iso.slice(0, 4);
    const existing = this.db.prepare('SELECT COUNT(*) AS c FROM FiscalPeriods WHERE StartDate LIKE ?').get(`${year}-%`).c;
    if (existing >= 12) return existing;

    const names = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const insert = this.db.prepare(`
      INSERT INTO FiscalPeriods (PeriodName, StartDate, EndDate, IsClosed)
      SELECT ?, ?, ?, 0
       WHERE NOT EXISTS (SELECT 1 FROM FiscalPeriods WHERE StartDate = ?)
    `);
    for (let month = 1; month <= 12; month += 1) {
      const mm = String(month).padStart(2, '0');
      const start = `${year}-${mm}-01`;
      // Period end = last calendar day of the month.
      const endDate = new Date(Date.UTC(Number(year), month, 0)).toISOString().slice(0, 10);
      insert.run(`${names[month - 1]} ${year}`, start, endDate, start);
    }
    return this.db.prepare('SELECT COUNT(*) AS c FROM FiscalPeriods WHERE StartDate LIKE ?').get(`${year}-%`).c;
  }

  status() {
    this.ensurePeriodsFor(new Date().toISOString().slice(0, 10));
    return this.db.prepare('SELECT * FROM FiscalPeriods ORDER BY StartDate ASC').all();
  }

  periodFor(date) {
    const iso = String(date).slice(0, 10);
    this.ensurePeriodsFor(iso);
    const row = this.db.prepare('SELECT * FROM FiscalPeriods WHERE StartDate <= ? AND EndDate >= ?').get(iso, iso);
    if (!row) throw new NotFoundError(`No fiscal period covers ${iso}`);
    return row;
  }

  /** Zero-based sweep of every open nominal balance up to `asOfDate`. */
  nominalBalances(asOfDate) {
    const params = [asOfDate, ...NOMINAL_ROOTS];
    return this.db.prepare(`
      SELECT a.AccountId, a.AccountCode, a.AccountName, a.RootType, a.NormalBalance,
             SUM(l.Debit)  AS TotalDebit,
             SUM(l.Credit) AS TotalCredit
        FROM Accounts a
        JOIN JournalVoucherLines l ON l.AccountId = a.AccountId
        JOIN JournalVouchers v ON v.VoucherId = l.VoucherId
       WHERE v.IsPosted = 1 AND v.VoucherDate <= ?
         AND a.RootType IN (?, ?, ?) AND a.IsPostingAllowed = 1
       GROUP BY a.AccountId
      HAVING SUM(l.Debit) <> SUM(l.Credit)
       ORDER BY a.AccountCode ASC
    `).all(...params);
  }

  /**
   * Close one fiscal period: post the Fiscal_Closing voucher, flush nominal
   * accounts into Retained Earnings and lock the period.
   */
  closePeriod({ periodId = null, date = null, createdBy, force = false }) {
    const period = periodId
      ? this.db.prepare('SELECT * FROM FiscalPeriods WHERE PeriodId = ?').get(periodId)
      : this.periodFor(date);
    if (!period) throw new NotFoundError('Fiscal period not found');
    if (period.IsClosed && !force) throw new ClosedPeriodError(period.PeriodName);

    const rows = this.nominalBalances(period.EndDate);
    if (rows.length === 0) {
      throw new ValidationError(`Nothing to close: ${period.PeriodName} has no open nominal balances`);
    }
    if (!createdBy) throw new ValidationError('createdBy (UserId) is required to close a period');

    let totalRevenue = 0;
    let totalExpense = 0;
    const lines = [];

    for (const row of rows) {
      // Balance expressed on the account's NORMAL side (always >= 0).
      const onNormalSide = row.NormalBalance === 'Credit'
        ? row.TotalCredit - row.TotalDebit
        : row.TotalDebit - row.TotalCredit;
      if (!Number.isFinite(onNormalSide) || onNormalSide === 0) continue;

      // Zeroing always posts the OPPOSITE side to the balance: a credit-balance
      // head is debited, a debit-balance head (e.g. Sales Returns, a contra
      // revenue) is credited.
      lines.push(row.NormalBalance === 'Credit'
        ? { accountId: row.AccountId, debit: onNormalSide, credit: 0, lineMemo: `Zeroing ${row.AccountCode}` }
        : { accountId: row.AccountId, debit: 0, credit: onNormalSide, lineMemo: `Zeroing ${row.AccountCode}` });

      // Signed contribution to the period result: revenue raises it (contra
      // revenue lowers it), COGS/expense lower it.
      const signed = row.RootType === 'Revenue'
        ? (row.NormalBalance === 'Credit' ? onNormalSide : -onNormalSide)
        : (row.NormalBalance === 'Credit' ? -onNormalSide : onNormalSide);

      if (row.RootType === 'Revenue') totalRevenue += signed;
      else totalExpense += signed;
    }

    const netDiff = totalRevenue - totalExpense;
    const retained = this.accounts.getByCode(COA.RETAINED_EARNINGS);
    if (netDiff > 0) {
      lines.push({ accountId: retained.AccountId, debit: 0, credit: netDiff, lineMemo: 'Net profit flushed to retained earnings' });
    } else if (netDiff < 0) {
      lines.push({ accountId: retained.AccountId, debit: -netDiff, credit: 0, lineMemo: 'Net loss flushed to retained earnings' });
    }

    const voucher = this.db.transaction(() => {
      const posted = this.ledger.recordVoucher({
        voucherDate: period.EndDate,
        voucherType: 'Fiscal_Closing',
        sourceModule: 'Period_Closing',
        narration: `Fiscal closing for ${period.PeriodName}: revenue ${money.fromCents(totalRevenue)} - expenses ${money.fromCents(totalExpense)} = ${money.fromCents(netDiff)}`,
        createdBy,
        lines,
      });
      this.db.prepare('UPDATE FiscalPeriods SET IsClosed = 1, ClosedAt = CURRENT_TIMESTAMP, ClosedBy = ? WHERE PeriodId = ?')
        .run(createdBy, period.PeriodId);
      return posted;
    });

    return {
      voucher,
      period: this.db.prepare('SELECT * FROM FiscalPeriods WHERE PeriodId = ?').get(period.PeriodId),
      meta: {
        totalRevenueCents: totalRevenue,
        totalExpenseCents: totalExpense,
        netResultCents: netDiff,
        resultType: netDiff >= 0 ? 'PROFIT' : 'LOSS',
        accountsFlushed: lines.length,
      },
    };
  }

  /** Unlock a period (Admin only) - required for corrections in closed books. */
  reopenPeriod({ periodId, createdBy }) {
    const period = this.db.prepare('SELECT * FROM FiscalPeriods WHERE PeriodId = ?').get(periodId);
    if (!period) throw new NotFoundError('Fiscal period not found');
    if (!period.IsClosed) return { reopened: false, period };
    this.db.prepare('UPDATE FiscalPeriods SET IsClosed = 0, ClosedAt = NULL, ClosedBy = NULL WHERE PeriodId = ?')
      .run(periodId);
    return { reopened: true, period: this.db.prepare('SELECT * FROM FiscalPeriods WHERE PeriodId = ?').get(periodId) };
  }
}

module.exports = { ClosingService };
