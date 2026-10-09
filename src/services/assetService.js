'use strict';

/**
 * Fixed Asset Service (Equations 8A / 8B, Section 3.7)
 * ----------------------------------------------------------------------------
 * 8A Straight-line (monthly):  D = (Cost - Salvage) / (Years x 12)
 *    The full-life schedule is generated with the exact integer allocator so
 *    SUM(schedule) === (Cost - Salvage) with zero drift; the run charges the
 *    next slice of that schedule each period.
 * 8B Double-declining:         r = 2/Y ; D_t = min(BV_(t-1) x r/12, BV_(t-1) - S)
 *
 * Journal:  DR Depreciation Expense   |   CR Accumulated Depreciation (contra-asset)
 */

const money = require('../core/money');
const { COA } = require('./coaSeed');
const { AccountService } = require('./accountService');
const { LedgerService } = require('./ledgerService');
const { ValidationError, NotFoundError } = require('../core/errors');

class AssetService {
  constructor(db) {
    this.db = db;
    this.accounts = new AccountService(db);
    this.ledger = new LedgerService(db);
  }

  list() {
    return this.db.prepare(`
      SELECT * FROM FixedAssets ORDER BY AcquisitionDate ASC, AssetId ASC
    `).all();
  }

  get(assetRef) {
    const row = Number.isInteger(Number(assetRef))
      ? this.db.prepare('SELECT * FROM FixedAssets WHERE AssetId = ?').get(Number(assetRef))
      : this.db.prepare('SELECT * FROM FixedAssets WHERE AssetCode = ?').get(assetRef);
    if (!row) throw new NotFoundError(`Fixed asset "${assetRef}" not found`);
    return row;
  }

  /**
   * Capitalise a fixed asset: acquisition voucher + asset register row.
   * DR Asset head | CR Bank/Cash/AP (accountCode)
   */
  register({
    voucherDate, assetCode, assetName, costCents, salvageCents = 0,
    usefulLifeYears, method = 'Straight_Line', assetAccountCode = COA.EQUIPMENT,
    accumulatedAccountCode = COA.ACCUM_DEPR,
    depreciationExpenseAccountCode = COA.DEPRECIATION,
    accountCode = COA.BANK_MAIN, createdBy, memo = null,
  }) {
    const cost = money.toCents(costCents);
    const salvage = money.toCents(salvageCents);
    if (cost <= 0) throw new ValidationError('Asset cost must be positive');
    if (salvage >= cost) throw new ValidationError('Salvage value must be lower than asset cost');
    const years = Number(usefulLifeYears);
    if (!Number.isInteger(years) || years <= 0) throw new ValidationError('usefulLifeYears must be a positive integer');
    if (this.db.prepare('SELECT 1 FROM FixedAssets WHERE AssetCode = ?').get(assetCode)) {
      throw new ValidationError(`Asset code ${assetCode} already registered`);
    }

    const assetAccount = this.accounts.assertPostingTarget(assetAccountCode);
    const funding = this.accounts.assertPostingTarget(accountCode);
    this.accounts.assertPostingTarget(accumulatedAccountCode);
    this.accounts.assertPostingTarget(depreciationExpenseAccountCode);

    const voucher = this.db.transaction(() => {
      const posted = this.ledger.recordVoucher({
        voucherDate,
        voucherType: funding.AccountCode.startsWith('2.') ? 'Purchase_Invoice' : 'Bank_Payment',
        sourceModule: 'Fixed_Asset',
        narration: memo || `Capitalisation of ${assetName} (${money.fromCents(cost)}) funded from ${funding.AccountName}`,
        createdBy,
        lines: [
          { accountCode: assetAccount.AccountCode, debit: cost, lineMemo: `Fixed asset: ${assetName}` },
          { accountCode: funding.AccountCode, credit: cost, lineMemo: 'Acquisition settlement' },
        ],
      });

      this.db.prepare(`
        INSERT INTO FixedAssets (AssetCode, AssetName, AcquisitionDate, Cost, SalvageValue,
                                 UsefulLifeYears, Method, AssetAccountId, AccumDepAccountId,
                                 DepreciationExpenseAccountId, AccumulatedDepreciation,
                                 MonthsDepreciated, IsFullyDepreciated, VoucherId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
      `).run(assetCode, assetName, voucherDate, cost, salvage, years, method,
        assetAccount.AccountId, this.accounts.getByCode(accumulatedAccountCode).AccountId,
        this.accounts.getByCode(depreciationExpenseAccountCode).AccountId, posted.voucherId);

      return posted;
    });

    return { voucher, asset: this.get(assetCode) };
  }

  /** Straight-line slice for month index `monthIndex` (0-based). */
  straightLineSchedule(asset) {
    const depreciable = money.sub(asset.Cost, asset.SalvageValue);
    const months = asset.UsefulLifeYears * 12;
    return money.amortize(depreciable, months);
  }

  /** What the next depreciation run would charge for this asset (exact cents). */
  nextCharge(asset) {
    if (asset.IsFullyDepreciated) return 0;
    if (asset.Method === 'DDB') {
      const bookValue = money.sub(asset.Cost, asset.AccumulatedDepreciation);
      const remaining = money.sub(bookValue, asset.SalvageValue);
      if (remaining <= 0) return 0;
      const rate = money.divRoundHalfUp(bookValue * 2, asset.UsefulLifeYears * 12);
      return Math.min(rate, remaining);
    }
    const schedule = this.straightLineSchedule(asset);
    if (asset.MonthsDepreciated >= schedule.length) return 0;
    return schedule[asset.MonthsDepreciated];
  }

  /**
   * Monthly depreciation runner - one balanced voucher for every active asset.
   */
  runDepreciation({ voucherDate, createdBy, memo = null }) {
    const assets = this.list().filter((a) => !a.IsFullyDepreciated);
    if (assets.length === 0) throw new ValidationError('No depreciable assets are open');

    const charges = assets
      .map((asset) => ({ asset, amount: this.nextCharge(asset) }))
      .filter((entry) => entry.amount > 0);

    if (charges.length === 0) {
      throw new ValidationError('All registered assets are fully depreciated - nothing to post');
    }

    const total = charges.reduce((sum, entry) => sum + entry.amount, 0);

    const result = this.db.transaction(() => {
      const grouped = new Map();
      for (const { asset, amount } of charges) {
        const key = `${asset.DepreciationExpenseAccountId}|${asset.AccumDepAccountId}`;
        const bucket = grouped.get(key) || {
          expenseAccountId: asset.DepreciationExpenseAccountId,
          accumAccountId: asset.AccumDepAccountId,
          amount: 0,
          assets: [],
        };
        bucket.amount += amount;
        bucket.assets.push({ assetId: asset.AssetId, amount });
        grouped.set(key, bucket);
      }

      const lines = [];
      for (const bucket of grouped.values()) {
        lines.push({ accountId: bucket.expenseAccountId, debit: bucket.amount, lineMemo: 'Monthly depreciation charge' });
        lines.push({ accountId: bucket.accumAccountId, credit: bucket.amount, lineMemo: 'Accumulated depreciation (contra-asset)' });
      }

      const posted = this.ledger.recordVoucher({
        voucherDate,
        voucherType: 'General_JV',
        sourceModule: 'Depreciation_Runner',
        narration: memo || `Monthly depreciation run: ${charges.length} asset(s), total ${money.fromCents(total)}`,
        createdBy,
        lines,
      });

      const update = this.db.prepare(`
        UPDATE FixedAssets
           SET AccumulatedDepreciation = AccumulatedDepreciation + ?,
               MonthsDepreciated = MonthsDepreciated + 1,
               IsFullyDepreciated = CASE WHEN MonthsDepreciated + 1 >= ? OR Cost - SalvageValue <= AccumulatedDepreciation + ?
                                         THEN 1 ELSE 0 END
         WHERE AssetId = ?
      `);
      for (const { asset, amount } of charges) {
        update.run(amount, asset.UsefulLifeYears * 12, amount, asset.AssetId);
      }

      this.db.prepare(`
        INSERT INTO DepreciationRuns (RunDate, PeriodId, VoucherId, TotalAmount)
        VALUES (?, ?, ?, ?)
      `).run(voucherDate, posted.lines.length ? this.periodOf(voucherDate) : null, posted.voucherId, total);

      return posted;
    });

    return {
      voucher: result,
      meta: {
        totalCents: total,
        entries: charges.map(({ asset, amount }) => ({
          assetCode: asset.AssetCode,
          assetName: asset.AssetName,
          amountCents: amount,
          method: asset.Method,
          accumulatedCents: money.add(asset.AccumulatedDepreciation, amount),
        })),
      },
    };
  }

  periodOf(date) {
    const iso = String(date).slice(0, 10);
    const row = this.db.prepare('SELECT PeriodId FROM FiscalPeriods WHERE StartDate <= ? AND EndDate >= ?')
      .get(iso, iso);
    if (!row) throw new ValidationError(`No fiscal period covers ${iso}`);
    return row.PeriodId;
  }
}

module.exports = { AssetService };
