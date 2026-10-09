'use strict';

/**
 * Report Service (Section 3.9 / Section 4.2) - analytical SQL formulations.
 * ----------------------------------------------------------------------------
 *  Equation 10  Trial Balance equilibrium proof
 *  Equation 11  Multi-step income statement
 *  Equation 12  Classified balance sheet with real-time equity rollup
 *
 * Every statement is produced from the same primitive: per-account
 * SUM(Debit)/SUM(Credit) in exact integer cents.  Deltas are reported so the
 * UI can show "$0.00" proofs, never an implied balance.
 */

const money = require('../core/money');
const { AccountService } = require('./accountService');
const { ValidationError } = require('../core/errors');

/** Expense prefixes treated as finance costs (excluded from operating expenses). */
const FINANCE_COST_PREFIXES = ['6.10.04.0002.', '6.10.04.0003.'];

class ReportService {
  constructor(db) {
    this.db = db;
    this.accounts = new AccountService(db);
  }

  /** Section 4.2.1 - Trial Balance Generation Query. */
  trialBalance({ asOfDate = null, includeZero = true } = {}) {
    const params = [];
    let dateFilter = '';
    if (asOfDate) { dateFilter = ' AND v.VoucherDate <= ?'; params.push(asOfDate); }

    const rows = this.db.prepare(`
      SELECT a.AccountId, a.AccountCode, a.AccountName, a.RootType, a.NormalBalance,
             a.IsContraAccount, a.AccountLevel,
             COALESCE(x.TotalDebit, 0)  AS TotalDebit,
             COALESCE(x.TotalCredit, 0) AS TotalCredit
        FROM Accounts a
        LEFT JOIN (
            SELECT l.AccountId                AS AccountId,
                   SUM(l.Debit)               AS TotalDebit,
                   SUM(l.Credit)              AS TotalCredit
              FROM JournalVoucherLines l
              JOIN JournalVouchers v ON v.VoucherId = l.VoucherId
             WHERE v.IsPosted = 1${dateFilter}
             GROUP BY l.AccountId
        ) x ON x.AccountId = a.AccountId
       WHERE a.IsPostingAllowed = 1 AND a.IsActive = 1
       ORDER BY a.AccountCode ASC
    `).all(...params);

    const detail = rows
      .map((row) => {
        const netDebit = money.sub(row.TotalDebit, row.TotalCredit);
        // NetBalance is expressed in the account's NORMAL direction
        // (positive = normal-side balance) - this is what the COA shows.
        const balance = row.NormalBalance === 'Debit' ? netDebit : -netDebit;
        return {
          AccountCode: row.AccountCode,
          AccountName: row.AccountName,
          RootType: row.RootType,
          NormalBalance: row.NormalBalance,
          IsContraAccount: row.IsContraAccount,
          TotalDebit: row.TotalDebit,
          TotalCredit: row.TotalCredit,
          NetBalance: balance,
          // Section 4.2.1: a trial-balance row lands in the DEBIT column when its
          // net movement is a debit and in the CREDIT column when it is a credit,
          // regardless of the account's normal balance (an overdrawn bank account
          // legitimately appears on the credit side).
          NetDebit: netDebit,
          DebitColumn: netDebit > 0 ? netDebit : 0,
          CreditColumn: netDebit < 0 ? -netDebit : 0,
        };
      })
      .filter((row) => includeZero || row.TotalDebit !== 0 || row.TotalCredit !== 0);

    const totalDebit = detail.reduce((s, r) => s + r.TotalDebit, 0);
    const totalCredit = detail.reduce((s, r) => s + r.TotalCredit, 0);
    const tbDebit = detail.reduce((s, r) => s + r.DebitColumn, 0);
    const tbCredit = detail.reduce((s, r) => s + r.CreditColumn, 0);

    return {
      rows: detail,
      totalDebit,
      totalCredit,
      /** Equation 10: gross ledger equilibrium (must be exactly 0) */
      delta: money.abs(money.sub(totalDebit, totalCredit)),
      tbDebit,
      tbCredit,
      tbDelta: money.abs(money.sub(tbDebit, tbCredit)),
      asOfDate,
    };
  }

  /** Aggregated balances for every leaf account (cents), optionally with children. */
  accountBalances({ asOfDate = null } = {}) {
    return this.trialBalance({ asOfDate }).rows;
  }

  /** Section 4.2.2 - Income statement aggregation for a period. */
  incomeStatement({ from, to, taxRate = '0' } = {}) {
    if (!from || !to) throw new ValidationError('incomeStatement requires { from, to } dates');
    const params = [from, to];
    const rows = this.db.prepare(`
      SELECT a.AccountId, a.AccountCode, a.AccountName, a.RootType, a.NormalBalance,
             a.IsContraAccount, a.ParentCode,
             COALESCE(SUM(l.Debit), 0)  AS TotalDebit,
             COALESCE(SUM(l.Credit), 0) AS TotalCredit
        FROM Accounts a
        JOIN JournalVoucherLines l ON a.AccountId = l.AccountId
        JOIN JournalVouchers v ON l.VoucherId = v.VoucherId
       WHERE a.RootType IN ('Revenue', 'CostOfSales', 'Expense')
         AND v.IsPosted = 1 AND v.VoucherDate BETWEEN ? AND ?
       GROUP BY a.AccountId
       ORDER BY a.AccountCode ASC
    `).all(...params);

    const net = (row) => (row.NormalBalance === 'Credit'
      ? money.sub(row.TotalCredit, row.TotalDebit)
      : money.sub(row.TotalDebit, row.TotalCredit));

    const trading = rows.filter((r) => r.RootType === 'Revenue' && !r.IsContraAccount && r.AccountCode.startsWith('4.10.'));
    const contra = rows.filter((r) => r.RootType === 'Revenue' && r.IsContraAccount);
    const otherIncome = rows.filter((r) => r.RootType === 'Revenue' && !r.IsContraAccount && !r.AccountCode.startsWith('4.10.'));
    const cogsRows = rows.filter((r) => r.RootType === 'CostOfSales');
    const expenseRows = rows.filter((r) => r.RootType === 'Expense');

    const grossSales = trading.reduce((s, r) => s + net(r), 0);
    // Contra-revenue heads carry a debit normal balance, so net(r) is already
    // the positive deduction amount (e.g. Sales Returns 1,700.00).
    const returns = contra.filter((r) => r.AccountCode.startsWith('4.10.02.0001')).reduce((s, r) => s + net(r), 0);
    const discounts = contra.filter((r) => r.AccountCode.startsWith('4.10.02.0002')).reduce((s, r) => s + net(r), 0);
    const rounding = contra.filter((r) => r.AccountCode.startsWith('4.10.02.0003')).reduce((s, r) => s + net(r), 0);
    const contraTotal = money.sum([returns, discounts, rounding]);

    const netRevenue = money.sub(grossSales, contraTotal);
    const cogs = cogsRows.reduce((s, r) => s + net(r), 0);
    const grossProfit = money.sub(netRevenue, cogs);

    const opexRows = expenseRows.filter((r) => !FINANCE_COST_PREFIXES.some((p) => r.AccountCode.startsWith(p)));
    const financeRows = expenseRows.filter((r) => FINANCE_COST_PREFIXES.some((p) => r.AccountCode.startsWith(p)));
    const operatingExpenses = opexRows.reduce((s, r) => s + net(r), 0);
    const financeCosts = financeRows.reduce((s, r) => s + net(r), 0);
    const otherIncomeTotal = otherIncome.reduce((s, r) => s + net(r), 0);

    const operatingIncome = money.sub(grossProfit, operatingExpenses);
    const ebt = money.add(money.sub(operatingIncome, financeCosts), otherIncomeTotal);
    const tax = ebt > 0 ? money.applyRate(ebt, taxRate) : 0;
    const netProfit = money.sub(ebt, tax);

    const pct = (value) => (netRevenue === 0 ? 0 : Math.round((value / netRevenue) * 10000) / 100);

    return {
      from, to,
      grossSales,
      returns,
      discounts,
      rounding,
      contraTotal,
      netRevenue,
      cogs,
      grossProfit,
      grossMarginPct: pct(grossProfit),
      operatingExpenses,
      opexLines: opexRows.map((r) => ({
        AccountCode: r.AccountCode,
        AccountName: r.AccountName,
        amount: net(r),
      })),
      financeCosts,
      financeLines: financeRows.map((r) => ({ AccountCode: r.AccountCode, AccountName: r.AccountName, amount: net(r) })),
      otherIncome: otherIncomeTotal,
      otherIncomeLines: otherIncome.map((r) => ({ AccountCode: r.AccountCode, AccountName: r.AccountName, amount: net(r) })),
      operatingIncome,
      operatingMarginPct: pct(operatingIncome),
      ebt,
      tax,
      netProfit,
      lines: rows.map((r) => ({
        AccountCode: r.AccountCode,
        AccountName: r.AccountName,
        RootType: r.RootType,
        NormalBalance: r.NormalBalance,
        amount: net(r),
      })),
    };
  }

  /** Equation 12 - classified balance sheet with equity roll-up. */
  balanceSheet({ asOfDate, from = null, taxRate = '0' } = {}) {
    if (!asOfDate) throw new ValidationError('balanceSheet requires { asOfDate }');
    // Equity carries capital + every nominal balance not yet flushed, so the
    // P&L window runs from the last close (see openPnlStart), not from the
    // calendar month - otherwise an open prior period is silently dropped.
    const periodStart = from || this.openPnlStart(asOfDate);
    const tb = this.trialBalance({ asOfDate });
    const is = this.incomeStatement({ from: periodStart, to: asOfDate, taxRate });

    // ---- Assets -----------------------------------------------------------
    const currentAssetRows = tb.rows.filter((r) => r.RootType === 'Asset' && r.AccountCode.startsWith('1.10.'));
    const nonCurrentRows = tb.rows.filter((r) => r.RootType === 'Asset' && !r.AccountCode.startsWith('1.10.'));

    const currentAssets = currentAssetRows.map((row) => ({
      AccountCode: row.AccountCode,
      AccountName: row.AccountName,
      // contra-assets inside current assets (none in the canonical COA) are subtracted
      amount: row.IsContraAccount && row.NormalBalance === 'Credit' ? -row.NetBalance : row.NetBalance,
    }));
    const nonCurrentAssets = nonCurrentRows.map((row) => ({
      AccountCode: row.AccountCode,
      AccountName: row.AccountName,
      // Accumulated Depreciation is a contra-asset: it REDUCES net book value
      amount: row.IsContraAccount ? -Math.abs(row.NetBalance) : row.NetBalance,
    }));

    const totalCurrentAssets = currentAssets.reduce((s, r) => s + r.amount, 0);
    const totalNonCurrentAssets = nonCurrentAssets.reduce((s, r) => s + r.amount, 0);
    const totalAssets = money.add(totalCurrentAssets, totalNonCurrentAssets);

    // ---- Liabilities ------------------------------------------------------
    const liabilityRows = tb.rows.filter((r) => r.RootType === 'Liability');
    const currentLiabilities = liabilityRows.filter((r) => r.AccountCode.startsWith('2.10.'))
      .map((row) => ({ AccountCode: row.AccountCode, AccountName: row.AccountName, amount: Math.abs(row.NetBalance) }));
    const longTermLiabilities = liabilityRows.filter((r) => !r.AccountCode.startsWith('2.10.'))
      .map((row) => ({ AccountCode: row.AccountCode, AccountName: row.AccountName, amount: Math.abs(row.NetBalance) }));
    const totalCurrentLiabilities = currentLiabilities.reduce((s, r) => s + r.amount, 0);
    const totalLongTermLiabilities = longTermLiabilities.reduce((s, r) => s + r.amount, 0);
    const totalLiabilities = money.add(totalCurrentLiabilities, totalLongTermLiabilities);

    // ---- Equity -----------------------------------------------------------
    const capital = tb.rows.filter((r) => r.RootType === 'Equity' && r.AccountCode.startsWith('3.10.01.0001.'))
      .reduce((s, r) => s + Math.abs(r.NetBalance), 0);
    const drawings = tb.rows.filter((r) => r.AccountCode.startsWith('3.10.01.0002.'))
      .reduce((s, r) => s + Math.abs(r.NetBalance), 0);
    const retainedPrior = tb.rows.filter((r) => r.AccountCode.startsWith('3.20.'))
      .reduce((s, r) => s + (r.NormalBalance === 'Credit' ? Math.abs(r.NetBalance) : -Math.abs(r.NetBalance)), 0);
    const netProfit = is.netProfit;

    const equity = [
      { label: 'Owner Contributed Capital', amount: capital },
      ...(retainedPrior !== 0 ? [{ label: 'Retained Earnings (prior periods)', amount: retainedPrior }] : []),
      { label: netProfit >= 0 ? 'Current Period Net Surplus' : 'Current Period Net Loss', amount: netProfit },
      { label: 'Less: Owner Personal Drawings', amount: -drawings },
    ];
    const totalEquity = equity.reduce((s, r) => s + r.amount, 0);
    const totalCapitalEmployed = money.add(totalLiabilities, totalEquity);
    const delta = money.sub(totalAssets, totalCapitalEmployed);

    return {
      asOfDate,
      periodStart,
      currentAssets,
      totalCurrentAssets,
      nonCurrentAssets,
      totalNonCurrentAssets,
      totalAssets,
      currentLiabilities,
      totalCurrentLiabilities,
      longTermLiabilities,
      totalLongTermLiabilities,
      totalLiabilities,
      equity,
      totalEquity,
      netProfit,
      delta,
      balanced: delta === 0,
      balance: `A (${money.fromCents(totalAssets)}) - [L (${money.fromCents(totalLiabilities)}) + E (${money.fromCents(totalEquity)})] = ${money.fromCents(delta)}`,
    };
  }

  /** Opening of the fiscal period containing `date` (or the calendar year). */
  defaultPeriodStart(date) {
    const iso = String(date).slice(0, 10);
    const row = this.db.prepare('SELECT StartDate FROM FiscalPeriods WHERE StartDate <= ? AND EndDate >= ?')
      .get(iso, iso);
    if (row) return row.StartDate;
    return `${iso.slice(0, 4)}-01-01`;
  }

  /**
   * Opening of the P&L window whose result is still SITTING IN EQUITY.
   * ---------------------------------------------------------------------------
   * A balance sheet only satisfies A = L + E when equity carries every nominal
   * balance that has not yet been flushed into Retained Earnings (3.20). After
   * `closePeriod` that is exactly the periods closed so far; while nothing is
   * closed it is the whole opened book.
   *
   * Defaulting to the calendar month containing `asOfDate` instead (the naive
   * `defaultPeriodStart`) strands the result of every earlier OPEN period:
   * on 2026-10-09 the case study's September loss of 233.33 fell outside the
   * window, equity came out 233.33 too high and the dashboard raised a false
   * "OUT OF BALANCE" alarm on a ledger whose trial balance was perfect.
   */
  openPnlStart(asOfDate) {
    const iso = String(asOfDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
    // Latest period closed BEFORE this date: everything after it is unflushed.
    const closed = this.db.prepare(
      'SELECT EndDate FROM FiscalPeriods WHERE IsClosed = 1 AND EndDate < ? ORDER BY EndDate DESC LIMIT 1',
    ).get(iso);
    if (closed && closed.EndDate) {
      const next = new Date(`${closed.EndDate.slice(0, 10)}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      return next.toISOString().slice(0, 10);
    }
    // Nothing closed yet: the earliest defined period, else the calendar year.
    const first = this.db.prepare('SELECT MIN(StartDate) AS s FROM FiscalPeriods').get();
    if (first && first.s) return String(first.s).slice(0, 10);
    return `${iso.slice(0, 4)}-01-01`;
  }

  /**
   * Consolidated equilibrium proof (Phase 5 acceptance criterion):
   * Trial Balance delta, Balance Sheet delta and period result together.
   */
  proof({ asOfDate, from = null, taxRate = '0' } = {}) {
    if (!asOfDate) throw new ValidationError('proof requires { asOfDate }');
    const trial = this.trialBalance({ asOfDate });
    const sheet = this.balanceSheet({ asOfDate, from, taxRate });
    const statement = this.incomeStatement({ from: sheet.periodStart, to: asOfDate, taxRate });
    return {
      asOfDate,
      trialBalance: {
        totalDebit: trial.totalDebit,
        totalCredit: trial.totalCredit,
        delta: trial.delta,
        tbDebit: trial.tbDebit,
        tbCredit: trial.tbCredit,
        tbDelta: trial.tbDelta,
        balanced: trial.delta === 0 && trial.tbDelta === 0,
      },
      balanceSheet: {
        totalAssets: sheet.totalAssets,
        totalLiabilities: sheet.totalLiabilities,
        totalEquity: sheet.totalEquity,
        delta: sheet.delta,
        balanced: sheet.delta === 0,
      },
      incomeStatement: {
        netRevenue: statement.netRevenue,
        cogs: statement.cogs,
        grossProfit: statement.grossProfit,
        operatingExpenses: statement.operatingExpenses,
        netProfit: statement.netProfit,
      },
      invariants: {
        zeroToleranceDelta: trial.delta === 0,
        balanceSheetEquilibrium: sheet.delta === 0,
        formula: `A - (L + E) = ${money.fromCents(sheet.delta)}`,
      },
    };
  }

  /** Customer / vendor sub-ledger balances (Section 5 entity tracking). */
  entities({ type = null } = {}) {
    const params = [];
    let where = '1 = 1';
    if (type) { where = 'EntityType = ?'; params.push(type); }
    return this.db.prepare(`
      SELECT EntityId, EntityType, FullName, Phone, Email, TaxNumber, CreditLimit,
             OpeningBalance, CurrentBalance, LinkedAccountId
        FROM Entities WHERE ${where} ORDER BY EntityType ASC, FullName ASC
    `).all(...params);
  }

  /** Dashboard KPIs (cash, receivables, payables, stock value, period result). */
  dashboard({ asOfDate } = {}) {
    const date = asOfDate || new Date().toISOString().slice(0, 10);
    const balanceOf = (code) => this.accounts.balanceOf(code, { asOfDate: date }).balance;
    const stock = this.db.prepare(`
      SELECT COALESCE(SUM(QtyRemaining), 0) AS qty, COALESCE(SUM(ValueCents), 0) AS value
        FROM InventoryLots
    `).get();
    // Same window the balance sheet uses: the result that is still unflushed
    // in equity, so the KPI tiles and the equilibrium proof agree.
    const statement = this.incomeStatement({ from: this.openPnlStart(date), to: date });

    return {
      asOfDate: date,
      cash: money.add(balanceOf('1.10.01.0001.0001'), balanceOf('1.10.01.0002.0001')),
      receivables: balanceOf('1.10.02.0001.0001'),
      payables: balanceOf('2.10.01.0001.0001'),
      outputTax: balanceOf('2.10.02.0001.0001'),
      inventoryValueCents: stock.value,
      inventoryQty: stock.qty,
      netProfit: statement.netProfit,
      grossProfit: statement.grossProfit,
      netRevenue: statement.netRevenue,
    };
  }
}

module.exports = { ReportService, FINANCE_COST_PREFIXES };
