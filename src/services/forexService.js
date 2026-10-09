'use strict';

/**
 * Multi-currency / Forex Service (Equation 9, IAS 21, Section 3.8)
 * ----------------------------------------------------------------------------
 *   V_orig   = F_curr x E_orig        (recorded base-currency receivable)
 *   V_settle = F_curr x E_settle      (cash actually realised)
 *   Delta    = V_settle - V_orig
 *   Delta > 0 -> realized gain (revenue head) ; Delta < 0 -> realized loss
 *
 * Every conversion is an exact rational computation on integer cents
 * (rate strings such as "1.234567" become the fraction 1234567/1000000).
 */

const money = require('../core/money');
const { COA } = require('./coaSeed');
const { AccountService } = require('./accountService');
const { LedgerService } = require('./ledgerService');
const { ValidationError, NotFoundError } = require('../core/errors');

class ForexService {
  constructor(db) {
    this.db = db;
    this.accounts = new AccountService(db);
    this.ledger = new LedgerService(db);
  }

  ensureCurrency(code, { symbol = code, name = code, isBase = false } = {}) {
    const existing = this.db.prepare('SELECT * FROM Currencies WHERE CurrencyCode = ?').get(code);
    if (existing) return existing;
    this.db.prepare('INSERT INTO Currencies (CurrencyCode, Symbol, CurrencyName, IsBase) VALUES (?, ?, ?, ?)')
      .run(code, symbol, name, isBase ? 1 : 0);
    return this.db.prepare('SELECT * FROM Currencies WHERE CurrencyCode = ?').get(code);
  }

  recordRate({ currencyCode, rateDate, rate }) {
    this.ensureCurrency(currencyCode);
    const text = String(rate);
    this.db.prepare('INSERT INTO ForexRates (CurrencyCode, RateDate, Rate) VALUES (?, ?, ?)')
      .run(currencyCode, rateDate, text);
    return this.db.prepare('SELECT * FROM ForexRates WHERE CurrencyCode = ? AND RateDate = ? ORDER BY RateId DESC LIMIT 1')
      .get(currencyCode, rateDate);
  }

  /** Exact conversion: foreignCents x rate, rounded half-up to whole cents. */
  convert(foreignCents, rate) {
    return money.applyRate(money.toCents(foreignCents), rate);
  }

  /**
   * Dry run of `settle` — identical arithmetic, zero writes.
   *
   * Sharing `convert()` with the real posting is the point: the realised
   * gain/loss the screen shows BEFORE committing can never drift from what
   * the voucher actually books.
   */
  preview({ foreignAmountCents, originalRate, settlementRate }) {
    const foreign = money.toCents(foreignAmountCents);
    if (foreign <= 0) throw new ValidationError('foreignAmountCents must be positive');
    const origValue = this.convert(foreign, originalRate);
    const settleValue = this.convert(foreign, settlementRate);
    const delta = money.sub(settleValue, origValue);
    return {
      foreignAmountCents: foreign,
      origValueCents: origValue,
      settleValueCents: settleValue,
      deltaCents: delta,
      direction: delta > 0 ? 'GAIN' : (delta < 0 ? 'LOSS' : 'NEUTRAL'),
    };
  }

  /**
   * Settle a foreign-currency receivable at a new spot rate.
   * Returns the balanced voucher plus the recorded IAS 21 difference.
   */
  settle({
    voucherDate, invoiceVoucherId = null, foreignAmountCents, currencyCode = 'USD',
    originalRate, settlementRate, accountCode = COA.BANK_MAIN,
    entityId = null, createdBy, memo = null,
  }) {
    const foreign = money.toCents(foreignAmountCents);
    if (foreign <= 0) throw new ValidationError('foreignAmountCents must be positive');

    const origValue = this.convert(foreign, originalRate);
    const settleValue = this.convert(foreign, settlementRate);
    const delta = money.sub(settleValue, origValue);

    const bank = this.accounts.assertPostingTarget(accountCode);
    const gain = this.accounts.assertPostingTarget(COA.FOREX_GAIN);
    const loss = this.accounts.assertPostingTarget(COA.FOREX_LOSS);
    const ar = this.accounts.assertPostingTarget(COA.AR);
    this.ensureCurrency(currencyCode);

    const lines = [
      { accountCode: bank.AccountCode, debit: settleValue, lineMemo: `${currencyCode} proceeds at settlement rate ${settlementRate}` },
      { accountCode: ar.AccountCode, credit: origValue, entityId, lineMemo: `Receivable cleared at original rate ${originalRate}` },
    ];
    if (delta > 0) {
      lines.push({ accountCode: gain.AccountCode, credit: delta, lineMemo: 'Realized forex gain (IAS 21)' });
    } else if (delta < 0) {
      lines.push({ accountCode: loss.AccountCode, debit: -delta, lineMemo: 'Realized forex loss (IAS 21)' });
    }

    const result = this.db.transaction(() => {
      const posted = this.ledger.recordVoucher({
        voucherDate,
        voucherType: 'Bank_Receipt',
        sourceModule: 'Forex_Settlement',
        narration: memo || `${currencyCode} settlement of ${money.fromCents(foreign)} @ ${originalRate} -> ${settlementRate}: ${delta >= 0 ? 'gain' : 'loss'} ${money.fromCents(Math.abs(delta))}`,
        createdBy,
        lines,
      });

      this.db.prepare(`
        INSERT INTO ReceivableSettlements (InvoiceVoucherId, SettlementVoucherId, ForeignAmount, CurrencyCode,
                                           OriginalRate, SettlementRate, OrigValueBase, SettleValueBase, ForexDelta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(invoiceVoucherId, posted.voucherId, foreign, currencyCode,
        String(originalRate), String(settlementRate), origValue, settleValue, delta);

      return posted;
    });

    return {
      voucher: result,
      meta: {
        foreignAmountCents: foreign,
        currencyCode,
        originalRate: String(originalRate),
        settlementRate: String(settlementRate),
        origValueCents: origValue,
        settleValueCents: settleValue,
        deltaCents: delta,
        direction: delta > 0 ? 'GAIN' : (delta < 0 ? 'LOSS' : 'NEUTRAL'),
      },
    };
  }

  history() {
    return this.db.prepare(`
      SELECT s.*, v.VoucherNo FROM ReceivableSettlements s
        JOIN JournalVouchers v ON v.VoucherId = s.SettlementVoucherId
       ORDER BY s.SettlementId DESC
    `).all();
  }

  static get rates() { return null; }
}

module.exports = { ForexService };
