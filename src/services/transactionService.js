'use strict';

/**
 * Transaction Service - Automated Operational Posting Matrix (Section 5)
 * ----------------------------------------------------------------------------
 * Each method binds a user-facing business form to a compound double-entry
 * journal voucher.  Nothing here ever writes a line directly: everything goes
 * through LedgerService.recordVoucher(), so Invariant 1 (|DR - CR| == 0.00),
 * Invariant 2 (Level-5 leaves only) and the fiscal-period lock are enforced on
 * every single path.
 *
 * All amounts are integer cents (Invariant 3).
 */

const money = require('../core/money');
const { COA } = require('./coaSeed');
const { AccountService } = require('./accountService');
const { LedgerService } = require('./ledgerService');
const { InventoryService } = require('./inventoryService');
const { computeLineTotals } = require('./taxService');
const { ValidationError, InsufficientStockError } = require('../core/errors');

const DEFAULT_TAX_RATE = '0.10';

class TransactionService {
  constructor(db) {
    this.db = db;
    this.accounts = new AccountService(db);
    this.ledger = new LedgerService(db);
    this.inventory = new InventoryService(db, this.accounts);
  }

  /* ------------------------------------------------------------------ utils */

  requireEntity(entityId, type) {
    const entity = this.db.prepare('SELECT * FROM Entities WHERE EntityId = ?').get(entityId);
    if (!entity) throw new ValidationError(`Entity ${entityId} not found`);
    if (type && entity.EntityType !== type) {
      throw new ValidationError(`Expected a ${type} entity, received ${entity.EntityType}`);
    }
    return entity;
  }

  defaultAccount(code, fallback) {
    return code || fallback;
  }

  /**
   * Cash accounts (till / petty cash) get a Cash_Payment voucher, everything
   * else a Bank_Payment. The cash sub-ledger lives under 1.10.01.0001.
   */
  paymentVoucherType(account) {
    const code = String(account.AccountCode || '');
    const isCash = code === COA.CASH_TILL || code.startsWith(`${COA.CASH_TILL}.`) || /^cash/i.test(account.AccountName || '');
    return isCash ? 'Cash_Payment' : 'Bank_Payment';
  }

  receiptVoucherType(account) {
    const code = String(account.AccountCode || '');
    const isCash = code === COA.CASH_TILL || code.startsWith(`${COA.CASH_TILL}.`) || /^cash/i.test(account.AccountName || '');
    return isCash ? 'Cash_Receipt' : 'Bank_Receipt';
  }

  /* ------------------------------------------------------- sales (POS / AR) */

  /**
   * Shared engine behind POS Cash Sale and Credit Sales Invoice.
   * Lines:  DR tender/AR (gross) + DR COGS (FIFO cost)
   *         CR Revenue (net) + CR Output Tax (tax) + CR Inventory (FIFO cost)
   */
  sell({
    voucherDate, itemCode, qty, unitPriceCents, taxRate = DEFAULT_TAX_RATE,
    discountRate = '0', priceIncludesTax = false, tender = 'Cash',
    entityId = null, accountCode = null, createdBy,
    voucherType, sourceModule, narration, referenceNo = null,
  }) {
    const totals = computeLineTotals({ qty, unitPriceCents, discountRate, taxRate, priceIncludesTax });
    if (totals.totalCents <= 0) throw new ValidationError('Sale total must be greater than 0.00');
    const preview = this.inventory.previewFifoCost(itemCode, qty);

    let entity = null;
    let debitAccountCode;
    if (tender === 'Credit') {
      if (!entityId) throw new ValidationError('Credit sales require entityId (customer)');
      entity = this.requireEntity(entityId, 'Customer');
      debitAccountCode = COA.AR;
      if (entity.CreditLimit > 0 && money.add(entity.CurrentBalance, totals.totalCents) > entity.CreditLimit) {
        throw new ValidationError(
          `Credit limit exceeded for ${entity.FullName}: balance ${entity.CurrentBalance} + ${totals.totalCents} > limit ${entity.CreditLimit}`,
        );
      }
    } else {
      debitAccountCode = this.defaultAccount(accountCode, COA.CASH_TILL);
      this.accounts.assertPostingTarget(debitAccountCode);
    }

    const item = this.inventory.getItem(itemCode);
    const defaultNarration = tender === 'Credit'
      ? `Credit invoice to ${entity.FullName}: ${qty} x ${item.ItemName} @ ${money.fromCents(money.toCents(unitPriceCents))}`
      : `POS sale: ${qty} x ${item.ItemName} @ ${money.fromCents(money.toCents(unitPriceCents))} (cash)`;

    const voucher = this.db.transaction(() => {
      const posted = this.ledger.recordVoucher({
        voucherDate,
        voucherType,
        sourceModule,
        referenceNo,
        narration: narration || defaultNarration,
        createdBy,
        lines: [
          { accountCode: debitAccountCode, debit: totals.totalCents, entityId: entityId || null, lineMemo: 'Gross invoice value (incl. tax)' },
          { accountCode: COA.COGS, debit: preview.costCents, lineMemo: 'FIFO cost of goods sold' },
          { accountCode: COA.SALES_REVENUE, credit: totals.netCents, lineMemo: 'Net revenue' },
          { accountCode: COA.OUTPUT_TAX, credit: totals.taxCents, lineMemo: 'Output VAT / sales tax collected' },
          { accountCode: COA.INVENTORY, credit: preview.costCents, lineMemo: 'Perpetual FIFO stock relief' },
        ].filter((line) => line.debit > 0 || line.credit > 0),
      });

      // Inventory relief is written inside the same atomic transaction so a
      // failure rolls back voucher AND stock together.
      const consumed = this.inventory.consumeFifo({
        itemCode, qty, date: voucherDate, voucherId: posted.voucherId,
        movementType: tender === 'Credit' ? 'Sale_Consumption' : 'Sale_Consumption',
      });
      if (consumed.costCents !== preview.costCents) {
        throw new ValidationError('FIFO cost drift detected between preview and consumption');
      }
      return posted;
    });

    return {
      voucher,
      meta: {
        grossCents: totals.grossCents,
        discountCents: totals.discountCents,
        netCents: totals.netCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        cogsCents: preview.costCents,
        grossProfitCents: money.sub(totals.netCents, preview.costCents),
        itemCode,
        qty: Number(qty),
        tender,
      },
    };
  }

  posSale(args) {
    return this.sell({
      ...args,
      voucherType: args.tender === 'Credit' ? 'Sales_Invoice' : 'Cash_Receipt',
      sourceModule: 'POS_Terminal',
      narration: args.narration,
    });
  }

  salesInvoice(args) {
    return this.sell({
      ...args,
      tender: 'Credit',
      voucherType: 'Sales_Invoice',
      sourceModule: 'Sales_Invoicing',
      narration: args.narration,
    });
  }

  /**
   * Sales Return / Credit Note.
   * DR Sales Returns (net) + DR Output Tax (tax) + DR Inventory (restored cost)
   * CR Trade Debtors (gross) + CR COGS (cost removed from sales)
   */
  creditNote({
    voucherDate, itemCode, qty, unitPriceCents, taxRate = DEFAULT_TAX_RATE,
    priceIncludesTax = false, discountRate = '0', entityId, reason = null, createdBy,
    accountCode = null, narration = null,
  }) {
    if (!entityId) throw new ValidationError('Credit notes require entityId (customer)');
    const entity = this.requireEntity(entityId, 'Customer');
    const totals = computeLineTotals({ qty, unitPriceCents, discountRate, taxRate, priceIncludesTax });
    if (totals.totalCents <= 0) throw new ValidationError('Credit note total must be positive');
    const item = this.inventory.getItem(itemCode);
    // Know the restock value BEFORE the voucher exists so DR Inventory and
    // CR COGS land in the same balanced voucher (Section 5 credit-note row).
    const previewRestore = this.inventory.previewRestoreCost(itemCode, qty);

    const result = this.db.transaction(() => {
      const posted = this.ledger.recordVoucher({
        voucherDate,
        voucherType: 'Sales_Return',
        sourceModule: 'Credit_Note',
        narration: narration || `Credit note - ${qty} x ${item.ItemName} returned by ${entity.FullName}${reason ? ` (${reason})` : ''}`,
        createdBy,
        lines: [
          { accountCode: accountCode || COA.AR, credit: totals.totalCents, entityId, lineMemo: 'AR credit to customer' },
          { accountCode: COA.SALES_RETURNS, debit: totals.netCents, lineMemo: 'Revenue reversal (net)' },
          { accountCode: COA.OUTPUT_TAX, debit: totals.taxCents, lineMemo: 'Output tax reversed' },
          { accountCode: COA.INVENTORY, debit: previewRestore.valueCents, lineMemo: 'Stock restored at original cost basis' },
          { accountCode: COA.COGS, credit: previewRestore.valueCents, lineMemo: 'COGS reversal (cost removed from sales)' },
        ].filter((line) => line.debit > 0 || line.credit > 0),
      });

      const restored = this.inventory.restoreToStock({
        itemCode, qty, date: voucherDate, voucherId: posted.voucherId,
        fallbackUnitCostCents: null,
      });
      if (restored.valueCents !== previewRestore.valueCents) {
        throw new ValidationError('Restock value drift between preview and application');
      }
      return { posted, restored };
    });

    return {
      voucher: result.posted,
      meta: {
        netCents: totals.netCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        restoredCostCents: result.restored.valueCents,
        itemCode,
        qty: Number(qty),
      },
    };
  }

  /* ------------------------------------------------------------- purchasing */

  /**
   * Supplier Purchase Bill (Equation 6 / Section 5).
   * DR Inventory (net + freight) + DR Input Tax (tax)
   * CR Trade Creditors (net + tax) + CR Bank/Vendor (freight)
   * Freight is capitalised into the FIFO lot queue with the exact allocator.
   */
  purchaseBill({
    voucherDate, entityId, lines, taxRate = '0', freightCents = 0,
    freightFromAccountCode = null, createdBy, narration = null,
  }) {
    if (!entityId) throw new ValidationError('Purchase bills require entityId (vendor)');
    const vendor = this.requireEntity(entityId, 'Vendor');
    if (!Array.isArray(lines) || lines.length === 0) throw new ValidationError('At least one purchase line is required');

    let netTotal = 0;
    let taxTotal = 0;
    const prepared = lines.map((line) => {
      const qty = Number(line.qty);
      const unit = money.toCents(line.unitCostCents);
      const lineNet = money.assertCents(qty * unit, 'line net');
      const lineTax = money.applyRate(lineNet, taxRate);
      netTotal = money.add(netTotal, lineNet);
      taxTotal = money.add(taxTotal, lineTax);
      return { ...line, qty, unit, lineNet, lineTax };
    });

    const freight = money.toCents(freightCents || 0);
    const apTotal = money.add(netTotal, taxTotal);
    const freightAccount = freight > 0 ? (freightFromAccountCode || COA.BANK_MAIN) : null;
    if (freightAccount) this.accounts.assertPostingTarget(freightAccount);

    const result = this.db.transaction(() => {
      const posted = this.ledger.recordVoucher({
        voucherDate,
        voucherType: 'Purchase_Invoice',
        sourceModule: 'Vendor_Bill',
        narration: narration || `Purchase bill from ${vendor.FullName}: ${lines.length} line(s), net ${money.fromCents(netTotal)} + tax ${money.fromCents(taxTotal)}${freight > 0 ? ` + freight ${money.fromCents(freight)}` : ''}`,
        createdBy,
        lines: [
          { accountCode: COA.INVENTORY, debit: money.add(netTotal, freight), lineMemo: 'Stock at landed cost (net + freight)' },
          { accountCode: COA.INPUT_TAX, debit: taxTotal, lineMemo: 'Recoverable input tax' },
          { accountCode: COA.AP, credit: apTotal, entityId, lineMemo: 'Vendor payable' },
          ...(freight > 0 ? [{ accountCode: freightAccount, credit: freight, lineMemo: 'Inbound freight settled' }] : []),
        ].filter((line) => line.debit > 0 || line.credit > 0),
      });

      // Enqueue FIFO lots for every line, then capitalise the freight.
      for (const line of prepared) {
        this.inventory.receive({
          itemCode: line.itemCode, qty: line.qty, unitCostCents: line.unit,
          date: voucherDate, voucherId: posted.voucherId, supplierRef: vendor.FullName,
        });
      }
      let capitalised = null;
      if (freight > 0) {
        capitalised = this.inventory.capitaliseLandedCost({
          lotVoucherId: posted.voucherId,
          movementVoucherId: posted.voucherId,
          freightCents: freight, date: voucherDate,
        });
      }
      return { posted, capitalised };
    });

    return {
      voucher: result.posted,
      meta: {
        netCents: netTotal,
        taxCents: taxTotal,
        totalCents: apTotal,
        freightCents: freight,
        capitalised: result.capitalised,
      },
    };
  }

  /**
   * Purchase Return / Debit Note: reverses vendor debt and stock at the FIFO
   * cost currently sitting in the queue (Section 5).
   */
  purchaseDebitNote({
    voucherDate, entityId, itemCode, qty, unitCostCents = null, taxRate = '0', createdBy, narration = null,
  }) {
    const vendor = this.requireEntity(entityId, 'Vendor');
    const quantity = Number(qty);
    const consumed = this.inventory.previewFifoCost(itemCode, quantity);
    const unitCost = unitCostCents === null ? money.divRoundHalfUp(consumed.costCents, quantity) : money.toCents(unitCostCents);
    const lineNet = money.assertCents(quantity * unitCost, 'return net');
    const lineTax = money.applyRate(lineNet, taxRate);
    const total = money.add(lineNet, lineTax);
    const item = this.inventory.getItem(itemCode);

    const posted = this.db.transaction(() => {
      const voucher = this.ledger.recordVoucher({
        voucherDate,
        voucherType: 'Purchase_Return',
        sourceModule: 'Debit_Note',
        narration: narration || `Debit note - ${quantity} x ${item.ItemName} returned to ${vendor.FullName}`,
        createdBy,
        lines: [
          { accountCode: COA.AP, debit: total, entityId, lineMemo: 'Vendor payable reduced' },
          { accountCode: COA.INVENTORY, credit: lineNet, lineMemo: 'Stock relieved at FIFO cost' },
          { accountCode: COA.INPUT_TAX, credit: lineTax, lineMemo: 'Recoverable input tax reversed' },
        ],
      });
      this.inventory.consumeFifo({
        itemCode, qty: quantity, date: voucherDate, voucherId: voucher.voucherId,
        movementType: 'Purchase_Return',
      });
      return voucher;
    });

    return { voucher: posted, meta: { netCents: lineNet, taxCents: lineTax, totalCents: total, cogsCents: consumed.costCents } };
  }

  /* --------------------------------------------------------- cash / banking */

  arReceipt({ voucherDate, entityId, amountCents, accountCode, memo = null, createdBy }) {
    const customer = this.requireEntity(entityId, 'Customer');
    const amount = money.toCents(amountCents);
    if (amount <= 0) throw new ValidationError('Receipt amount must be positive');
    const account = this.accounts.assertPostingTarget(accountCode || COA.BANK_MAIN);

    const voucher = this.ledger.recordVoucher({
      voucherDate,
      voucherType: this.receiptVoucherType(account),
      sourceModule: 'AR_Receipt',
      narration: memo || `Receipt of ${money.fromCents(amount)} from ${customer.FullName} into ${account.AccountName}`,
      createdBy,
      lines: [
        { accountCode: account.AccountCode, debit: amount, lineMemo: 'Funds received' },
        { accountCode: COA.AR, credit: amount, entityId, lineMemo: 'Receivable settled' },
      ],
    });
    return { voucher, meta: { amountCents: amount, entityBalanceCents: this.requireEntity(entityId, 'Customer').CurrentBalance } };
  }

  apPayment({ voucherDate, entityId, amountCents, accountCode, memo = null, createdBy }) {
    const vendor = this.requireEntity(entityId, 'Vendor');
    const amount = money.toCents(amountCents);
    if (amount <= 0) throw new ValidationError('Payment amount must be positive');
    const account = this.accounts.assertPostingTarget(accountCode || COA.BANK_MAIN);

    const voucher = this.ledger.recordVoucher({
      voucherDate,
      voucherType: this.paymentVoucherType(account),
      sourceModule: 'AP_Payment',
      narration: memo || `Payment of ${money.fromCents(amount)} to ${vendor.FullName} from ${account.AccountName}`,
      createdBy,
      lines: [
        { accountCode: COA.AP, debit: amount, entityId, lineMemo: 'Vendor payable reduced' },
        { accountCode: account.AccountCode, credit: amount, lineMemo: 'Funds disbursed' },
      ],
    });
    return { voucher, meta: { amountCents: amount } };
  }

  expensePay({
    voucherDate, accountCode, amountCents, paidFromAccountCode = COA.BANK_MAIN,
    memo = null, entityId = null, createdBy,
  }) {
    const expense = this.accounts.assertPostingTarget(accountCode);
    const source = this.accounts.assertPostingTarget(paidFromAccountCode);
    const amount = money.toCents(amountCents);
    if (amount <= 0) throw new ValidationError('Expense amount must be positive');
    if (!memo) throw new ValidationError('A narration/memo is required for expense payments');

    const voucher = this.ledger.recordVoucher({
      voucherDate,
      voucherType: this.paymentVoucherType(source),
      sourceModule: 'Expense_Payment',
      narration: `${memo} - paid ${money.fromCents(amount)} from ${source.AccountName}`,
      createdBy,
      lines: [
        { accountCode: expense.AccountCode, debit: amount, lineMemo: memo },
        { accountCode: source.AccountCode, credit: amount, lineMemo: memo, entityId },
      ],
    });
    return { voucher, meta: { amountCents: amount, expenseAccountCode: expense.AccountCode } };
  }

  capitalDeposit({ voucherDate, amountCents, accountCode = COA.BANK_MAIN, memo = null, createdBy }) {
    const bank = this.accounts.assertPostingTarget(accountCode);
    const amount = money.toCents(amountCents);
    if (amount <= 0) throw new ValidationError('Capital amount must be positive');
    const voucher = this.ledger.recordVoucher({
      voucherDate,
      voucherType: this.receiptVoucherType(bank),
      sourceModule: 'Capital_Deposit',
      narration: memo || `Owner capital injection of ${money.fromCents(amount)} into ${bank.AccountName}`,
      createdBy,
      lines: [
        { accountCode: bank.AccountCode, debit: amount, lineMemo: 'Funds received' },
        { accountCode: COA.CAPITAL, credit: amount, lineMemo: 'Owner contributed capital' },
      ],
    });
    return { voucher, meta: { amountCents: amount } };
  }

  transferTillToBank({ voucherDate, amountCents, accountCode = COA.BANK_MAIN, createdBy }) {
    const bank = this.accounts.assertPostingTarget(accountCode);
    const amount = money.toCents(amountCents);
    if (amount <= 0) throw new ValidationError('Transfer amount must be positive');
    const till = this.accounts.getByCode(COA.CASH_TILL);
    const available = this.accounts.balanceOf(COA.CASH_TILL).balance;
    if (available < amount) {
      throw new ValidationError(`Till balance ${money.fromCents(available)} is less than the transfer ${money.fromCents(amount)}`);
    }

    const voucher = this.ledger.recordVoucher({
      voucherDate,
      voucherType: 'Bank_Receipt',
      sourceModule: 'Till_Sweep',
      narration: `Cash till sweep of ${money.fromCents(amount)} into ${bank.AccountName}`,
      createdBy,
      lines: [
        { accountCode: bank.AccountCode, debit: amount, lineMemo: 'Deposit received' },
        { accountCode: till.AccountCode, credit: amount, lineMemo: 'Cash drawer reduced' },
      ],
    });
    return { voucher, meta: { amountCents: amount, tillBalanceCents: available - amount } };
  }

  /**
   * Owner personal drawing (Contra Equity):
   * DR Owner Drawings (3.10.01.0002.0001) | CR Bank/Cash
   */
  ownerDrawings({ voucherDate, amountCents, accountCode = COA.BANK_MAIN, memo = null, createdBy }) {
    const source = this.accounts.assertPostingTarget(accountCode);
    const drawings = this.accounts.assertPostingTarget(COA.DRAWINGS);
    const amount = money.toCents(amountCents);
    if (amount <= 0) throw new ValidationError('Drawing amount must be positive');

    const voucher = this.ledger.recordVoucher({
      voucherDate,
      voucherType: this.paymentVoucherType(source),
      sourceModule: 'Owner_Drawings',
      narration: memo || `Owner withdrawal of ${money.fromCents(amount)} from ${source.AccountName} for personal use`,
      createdBy,
      lines: [
        { accountCode: drawings.AccountCode, debit: amount, lineMemo: 'Contra equity - personal drawings' },
        { accountCode: source.AccountCode, credit: amount, lineMemo: 'Funds withdrawn' },
      ],
    });
    return { voucher, meta: { amountCents: amount } };
  }

  /* --------------------------------------------------------------- inventory */

  /**
   * Equation 4 - physical count shrinkage: FIFO-consume the shortfall and book
   * the loss to the shrinkage expense head.
   */
  inventoryShrinkage({
    voucherDate, itemCode, countedQty, expenseAccountCode = COA.SHRINKAGE, createdBy, memo = null,
  }) {
    const item = this.inventory.getItem(itemCode);
    const bookQty = item.CurrentStock;
    const counted = Number(countedQty);
    if (!Number.isInteger(counted) || counted < 0) throw new ValidationError('countedQty must be a non-negative integer');
    if (bookQty <= counted) {
      throw new ValidationError(`No shrinkage detected for ${item.ItemCode}: book ${bookQty} vs counted ${counted} (gains require a separate count-up voucher)`);
    }
    const shortfall = bookQty - counted;
    const expense = this.accounts.assertPostingTarget(expenseAccountCode);
    const preview = this.inventory.previewFifoCost(itemCode, shortfall);
    if (preview.costCents <= 0) throw new ValidationError('Shrinkage value is zero - nothing to write off');

    const voucher = this.db.transaction(() => {
      const posted = this.ledger.recordVoucher({
        voucherDate,
        voucherType: 'General_JV',
        sourceModule: 'Inventory_Adjustment',
        narration: memo || `Stock shrinkage write-off: ${shortfall} x ${item.ItemName} missing at count (value ${money.fromCents(preview.costCents)})`,
        createdBy,
        lines: [
          { accountCode: expense.AccountCode, debit: preview.costCents, lineMemo: 'Shrinkage / write-off loss' },
          { accountCode: COA.INVENTORY, credit: preview.costCents, lineMemo: 'Inventory relieved at FIFO cost' },
        ],
      });
      this.inventory.consumeFifo({
        itemCode, qty: shortfall, date: voucherDate, voucherId: posted.voucherId,
        movementType: 'Shrinkage_WriteOff',
      });
      return posted;
    });

    return { voucher, meta: { shortfallQty: shortfall, valueCents: preview.costCents, bookQty, countedQty: counted } };
  }
}

module.exports = { TransactionService, DEFAULT_TAX_RATE };
