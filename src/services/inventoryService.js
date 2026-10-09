'use strict';

/**
 * Inventory Service - perpetual FIFO (Section 3.3.1) with moving-average option.
 * ----------------------------------------------------------------------------
 * A purchase receipt enqueues a LOT: (qty, value).  A sale pops from the front
 * of the queue.  The authoritative number on a lot is its remaining VALUE in
 * integer cents; the split of that value across consumed/remaining units uses
 * the exact largest-remainder allocator, so inventory value never loses or
 * invents a cent no matter how awkward the unit cost is.
 */

const money = require('../core/money');
const { COA } = require('./coaSeed');
const { InsufficientStockError, ValidationError, NotFoundError } = require('../core/errors');

class InventoryService {
  constructor(db, accountService) {
    this.db = db;
    this.accounts = accountService;
  }

  listItems() {
    return this.db.prepare(`
      SELECT i.*, a.AccountCode AS InventoryAccountCode
        FROM InventoryItems i
        LEFT JOIN Accounts a ON a.AccountId = i.InventoryAccountId
       ORDER BY i.ItemCode ASC
    `).all();
  }

  getItem(itemCode) {
    const row = this.db.prepare('SELECT * FROM InventoryItems WHERE ItemCode = ? OR ItemId = ?')
      .get(itemCode, Number.isFinite(Number(itemCode)) ? Number(itemCode) : -1);
    if (!row) throw new NotFoundError(`Inventory item "${itemCode}" not found`);
    return row;
  }

  createItem({
    itemCode, itemName, sellingPrice = 0, costPrice = 0, currentStock = 0,
    reorderLevel = 0, unitOfMeasure = 'Units', barcode = null,
    valuationMethod = 'FIFO', inventoryAccountCode, cogsAccountCode, revenueAccountCode,
  }) {
    if (!itemCode || !itemName) throw new ValidationError('itemCode and itemName are required');
    if (this.db.prepare('SELECT 1 FROM InventoryItems WHERE ItemCode = ?').get(itemCode)) {
      throw new ValidationError(`Item code ${itemCode} already exists`);
    }
    const invAcc = this.accounts.assertPostingTarget(inventoryAccountCode || require('./coaSeed').COA.INVENTORY);
    const cogsAcc = this.accounts.assertPostingTarget(cogsAccountCode || require('./coaSeed').COA.COGS);
    const revAcc = this.accounts.assertPostingTarget(revenueAccountCode || require('./coaSeed').COA.SALES_REVENUE);

    this.db.prepare(`
      INSERT INTO InventoryItems (ItemCode, ItemName, Barcode, UnitOfMeasure, CostPrice, SellingPrice,
                                  CurrentStock, ReorderLevel, ValuationMethod,
                                  InventoryAccountId, CogsAccountId, RevenueAccountId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemCode, itemName, barcode, unitOfMeasure,
      money.toCents(costPrice), money.toCents(sellingPrice),
      Number(currentStock), Number(reorderLevel), valuationMethod,
      invAcc.AccountId, cogsAcc.AccountId, revAcc.AccountId);

    const item = this.getItem(itemCode);
    if (Number(currentStock) > 0) {
      // Opening balance valued at CostPrice.
      const opening = this.db.prepare(`
        INSERT INTO InventoryLots (ItemId, ReceiptDate, ReceiptSeq, VoucherId, QtyReceived, QtyRemaining,
                                   UnitCost, ValueCents, SupplierRef)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'Opening Balance')
      `).run(item.ItemId, new Date().toISOString().slice(0, 10), this.nextReceiptSeq(item.ItemId),
        Number(currentStock), Number(currentStock), money.toCents(costPrice),
        money.toCents(costPrice) * Number(currentStock));
      this.recordMovement({
        itemId: item.ItemId, voucherId: null, date: new Date().toISOString().slice(0, 10),
        movementType: 'Opening_Balance', qtyDelta: Number(currentStock),
        valueDelta: money.toCents(costPrice) * Number(currentStock), lotId: opening.lastInsertRowid,
      });
    }
    return item;
  }

  nextReceiptSeq(itemId) {
    const row = this.db.prepare('SELECT COALESCE(MAX(ReceiptSeq), 0) + 1 AS s FROM InventoryLots WHERE ItemId = ?')
      .get(itemId);
    return row.s;
  }

  /** FIFO purchase queue Q = [(q1, c1), (q2, c2), ...] ordered by receipt. */
  lots(itemCode) {
    const item = this.getItem(itemCode);
    return this.db.prepare(`
      SELECT LotId, ReceiptDate, ReceiptSeq, VoucherId, QtyReceived, QtyRemaining,
             UnitCost, ValueCents, SupplierRef
        FROM InventoryLots
       WHERE ItemId = ? AND QtyRemaining > 0
       ORDER BY ReceiptSeq ASC, LotId ASC
    `).all(item.ItemId);
  }

  valuation(itemCode) {
    const item = this.getItem(itemCode);
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(QtyRemaining), 0) AS qty, COALESCE(SUM(ValueCents), 0) AS value
        FROM InventoryLots WHERE ItemId = ?
    `).get(item.ItemId);
    return {
      itemCode: item.ItemCode,
      itemName: item.ItemName,
      qty: row.qty,
      valueCents: row.value,
      avgCostCents: row.qty > 0 ? money.divRoundHalfUp(row.value, row.qty) : 0,
      onHandStock: item.CurrentStock,
    };
  }

  /** Enqueue a purchase lot (Section 3.3.1 step 0). */
  receive({ itemCode, qty, unitCostCents, date, voucherId = null, supplierRef = null, valueCents = null }) {
    const item = this.getItem(itemCode);
    const quantity = Number(qty);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new ValidationError('Receipt quantity must be a positive integer');
    const totalValue = valueCents === null || valueCents === undefined
      ? money.toCents(unitCostCents) * quantity
      : money.toCents(valueCents);

    const lot = this.db.prepare(`
      INSERT INTO InventoryLots (ItemId, ReceiptDate, ReceiptSeq, VoucherId, QtyReceived, QtyRemaining,
                                 UnitCost, ValueCents, SupplierRef)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(item.ItemId, date, this.nextReceiptSeq(item.ItemId), voucherId,
      quantity, quantity, money.divRoundHalfUp(totalValue, quantity), totalValue, supplierRef);

    this.db.prepare('UPDATE InventoryItems SET CurrentStock = CurrentStock + ? WHERE ItemId = ?')
      .run(quantity, item.ItemId);

    const lotId = lot.lastInsertRowid;
    // Immutable movement ledger: every receipt leaves an audit row too, so the
    // stock trail (receipts -> consumption -> restocks) is complete end-to-end.
    this.recordMovement({
      itemId: item.ItemId, voucherId, date, movementType: 'Purchase_Receipt',
      qtyDelta: quantity, valueDelta: totalValue, lotId,
    });

    return this.db.prepare('SELECT * FROM InventoryLots WHERE LotId = ?').get(lotId);
  }

  /**
   * FIFO consumption algorithm (Section 3.3.1, worked example):
   *   while Remaining_Demand > 0 and Q not empty: pop from front.
   * Returns exact integer-cent cost of the consumed quantity.
   */
  consumeFifo({ itemCode, qty, date, voucherId = null, movementType = 'Sale_Consumption' }) {
    const item = this.getItem(itemCode);
    const demand = Number(qty);
    if (!Number.isInteger(demand) || demand <= 0) throw new ValidationError('Consumption quantity must be a positive integer');

    const queue = this.lots(item.ItemId);
    const available = queue.reduce((sum, lot) => sum + lot.QtyRemaining, 0);
    if (available < demand) {
      throw new InsufficientStockError(item.ItemCode, demand, available);
    }

    let remaining = demand;
    let costCents = 0;
    const layers = [];
    const movementIds = [];

    for (const lot of queue) {
      if (remaining === 0) break;
      const take = Math.min(remaining, lot.QtyRemaining);
      const parts = money.allocate(lot.ValueCents, [take, lot.QtyRemaining - take]);
      const consumedValue = parts[0];
      const restValue = parts[1];

      this.db.prepare(`
        UPDATE InventoryLots
           SET QtyRemaining = QtyRemaining - ?, ValueCents = ?, UnitCost = ?
         WHERE LotId = ?
      `).run(take, restValue, restValue > 0 ? money.divRoundHalfUp(restValue, Math.max(lot.QtyRemaining - take, 1)) : 0, lot.LotId);

      this.recordMovement({
        itemId: item.ItemId, voucherId, date, movementType,
        qtyDelta: -take, valueDelta: -consumedValue, lotId: lot.LotId,
      });

      layers.push({ lotId: lot.LotId, qty: take, unitCostCents: money.divRoundHalfUp(consumedValue, take), valueCents: consumedValue });
      movementIds.push(this.lastMovementId);
      costCents += consumedValue;
      remaining -= take;
    }

    this.db.prepare('UPDATE InventoryItems SET CurrentStock = CurrentStock - ? WHERE ItemId = ?')
      .run(demand, item.ItemId);

    return { costCents, layers, qty: demand, movementIds };
  }

  /**
   * Sales return / restock: reverses the most recent FIFO consumption layers
   * so inventory is restored at the ORIGINAL cost basis the goods were sold at
   * (Section 5 - "Restores inventory quantity at return cost basis").
   */
  restoreToStock({ itemCode, qty, date, voucherId = null, fallbackUnitCostCents = null }) {
    const item = this.getItem(itemCode);
    const demand = Number(qty);
    if (!Number.isInteger(demand) || demand <= 0) throw new ValidationError('Restock quantity must be a positive integer');

    const history = this.db.prepare(`
      SELECT MovementId, QtyDelta, ValueDelta, LotId
        FROM InventoryMovements
       WHERE ItemId = ? AND MovementType = 'Sale_Consumption' AND QtyDelta < 0
       ORDER BY MovementId DESC
    `).all(item.ItemId);

    let remaining = demand;
    let restoredValue = 0;
    const layers = [];
    const movementIds = [];

    for (const movement of history) {
      if (remaining === 0) break;
      const soldQty = Math.abs(movement.QtyDelta);
      const restoreQty = Math.min(remaining, soldQty);
      const parts = money.allocate(Math.abs(movement.ValueDelta), [restoreQty, soldQty - restoreQty]);
      const value = parts[0];

      if (movement.LotId) {
        const lot = this.db.prepare('SELECT * FROM InventoryLots WHERE LotId = ?').get(movement.LotId);
        if (lot) {
          const newQty = lot.QtyRemaining + restoreQty;
          const newValue = lot.ValueCents + value;
          this.db.prepare(`
            UPDATE InventoryLots SET QtyRemaining = ?, ValueCents = ?, UnitCost = ? WHERE LotId = ?
          `).run(newQty, newValue, money.divRoundHalfUp(newValue, newQty), lot.LotId);
        }
      }

      this.recordMovement({
        itemId: item.ItemId, voucherId, date, movementType: 'Return_Restock',
        qtyDelta: restoreQty, valueDelta: value, lotId: movement.LotId,
      });
      movementIds.push(this.lastMovementId);

      layers.push({ lotId: movement.LotId, qty: restoreQty, valueCents: value });
      restoredValue += value;
      remaining -= restoreQty;
    }

    // Any remainder without prior cost history is restocked at the FIFO head
    // (or an explicitly supplied cost) so the stock ledger still balances.
    if (remaining > 0) {
      const head = this.lots(item.ItemId)[0];
      const unit = head ? money.divRoundHalfUp(head.ValueCents, head.QtyRemaining)
        : money.toCents(fallbackUnitCostCents ?? item.CostPrice);
      const value = unit * remaining;
      if (head) {
        const newQty = head.QtyRemaining + remaining;
        const newValue = head.ValueCents + value;
        this.db.prepare('UPDATE InventoryLots SET QtyRemaining = ?, ValueCents = ?, UnitCost = ? WHERE LotId = ?')
          .run(newQty, newValue, money.divRoundHalfUp(newValue, newQty), head.LotId);
      } else {
        this.db.prepare(`
          INSERT INTO InventoryLots (ItemId, ReceiptDate, ReceiptSeq, VoucherId, QtyReceived, QtyRemaining, UnitCost, ValueCents, SupplierRef)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Return without lot history')
        `).run(item.ItemId, date, this.nextReceiptSeq(item.ItemId), voucherId, remaining, remaining, unit, value);
      }
      this.recordMovement({
        itemId: item.ItemId, voucherId, date, movementType: 'Return_Restock',
        qtyDelta: remaining, valueDelta: value, lotId: head ? head.LotId : null,
      });
      movementIds.push(this.lastMovementId);
      restoredValue += value;
      layers.push({ lotId: head ? head.LotId : null, qty: remaining, valueCents: value });
    }

    this.db.prepare('UPDATE InventoryItems SET CurrentStock = CurrentStock + ? WHERE ItemId = ?')
      .run(demand, item.ItemId);

    return { valueCents: restoredValue, layers, qty: demand, movementIds };
  }

  /**
   * Non-mutating mirror of restoreToStock(): computes exactly what value a
   * return will push back into the FIFO queue, so the credit note can carry
   * the DR Inventory / CR COGS pair inside the SAME voucher (Section 5).
   */
  previewRestoreCost(itemCode, qty) {
    const item = this.getItem(itemCode);
    const demand = Number(qty);
    if (!Number.isInteger(demand) || demand <= 0) throw new ValidationError('Quantity must be a positive integer');

    const history = this.db.prepare(`
      SELECT MovementId, QtyDelta, ValueDelta, LotId
        FROM InventoryMovements
       WHERE ItemId = ? AND MovementType = 'Sale_Consumption' AND QtyDelta < 0
       ORDER BY MovementId DESC
    `).all(item.ItemId);

    let remaining = demand;
    let restoredValue = 0;
    const layers = [];

    for (const movement of history) {
      if (remaining === 0) break;
      const soldQty = Math.abs(movement.QtyDelta);
      const restoreQty = Math.min(remaining, soldQty);
      const value = money.allocate(Math.abs(movement.ValueDelta), [restoreQty, soldQty - restoreQty])[0];
      layers.push({ lotId: movement.LotId, qty: restoreQty, valueCents: value });
      restoredValue += value;
      remaining -= restoreQty;
    }

    if (remaining > 0) {
      const head = this.lots(item.ItemId)[0];
      const unit = head ? money.divRoundHalfUp(head.ValueCents, head.QtyRemaining)
        : money.toCents(item.CostPrice);
      const value = unit * remaining;
      layers.push({ lotId: head ? head.LotId : null, qty: remaining, valueCents: value });
      restoredValue += value;
    }

    return { valueCents: restoredValue, layers, qty: demand };
  }

  /**
   * Equation 6 - landed cost: capitalise inbound freight into the lots created
   * by a purchase voucher.  The freight total is split across lots with the
   * exact integer allocator, so SUM(allocated) === freightCents to the cent.
   */
  capitaliseLandedCost({ itemCode = null, lotVoucherId = null, movementVoucherId = null, freightCents, date }) {
    const freight = money.toCents(freightCents);
    if (freight <= 0) throw new ValidationError('freightCents must be positive');

    const params = [];
    let where = 'QtyRemaining > 0';
    if (lotVoucherId) { where += ' AND VoucherId = ?'; params.push(lotVoucherId); }
    if (itemCode) {
      const item = this.getItem(itemCode);
      where += ' AND ItemId = ?';
      params.push(item.ItemId);
    }
    const lots = this.db.prepare(`SELECT * FROM InventoryLots WHERE ${where} ORDER BY ReceiptSeq ASC`).all(...params);
    if (lots.length === 0) throw new ValidationError('No open purchase lots available to capitalise landed cost');

    const weights = lots.map((lot) => lot.ValueCents);
    const parts = money.allocate(freight, weights);
    const allocated = [];

    lots.forEach((lot, index) => {
      const share = parts[index];
      if (share === 0) return;
      const newValue = lot.ValueCents + share;
      const newQty = lot.QtyRemaining;
      this.db.prepare('UPDATE InventoryLots SET ValueCents = ?, UnitCost = ? WHERE LotId = ?')
        .run(newValue, money.divRoundHalfUp(newValue, newQty), lot.LotId);
      this.recordMovement({
        itemId: lot.ItemId, voucherId: movementVoucherId, date,
        movementType: 'Landed_Cost_Capitalisation',
        qtyDelta: 0, valueDelta: share, lotId: lot.LotId,
      });
      allocated.push({ lotId: lot.LotId, share, newUnitCostCents: money.divRoundHalfUp(newValue, newQty) });
    });

    return { freightCents: freight, allocated, totalAllocatedCents: allocated.reduce((s, a) => s + a.share, 0) };
  }

  recordMovement({ itemId, voucherId = null, date, movementType, qtyDelta, valueDelta, lotId = null }) {
    const result = this.db.prepare(`
      INSERT INTO InventoryMovements (ItemId, VoucherId, MoveDate, MovementType, QtyDelta, ValueDelta, LotId)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, voucherId ?? null, date, movementType, qtyDelta, valueDelta, lotId);
    this.lastMovementId = result.lastInsertRowid;
    return this.lastMovementId;
  }

  /**
   * Non-mutating FIFO preview: exactly what consumeFifo() will charge, used by
   * the posting services so the journal lines can be built BEFORE the voucher
   * exists (the movements are then written against the real VoucherId).
   */
  previewFifoCost(itemCode, qty) {
    const item = this.getItem(itemCode);
    const demand = Number(qty);
    if (!Number.isInteger(demand) || demand <= 0) throw new ValidationError('Quantity must be a positive integer');
    const queue = this.lots(item.ItemId);
    const available = queue.reduce((sum, lot) => sum + lot.QtyRemaining, 0);
    if (available < demand) throw new InsufficientStockError(item.ItemCode, demand, available);

    let remaining = demand;
    let costCents = 0;
    const layers = [];
    for (const lot of queue) {
      if (remaining === 0) break;
      const take = Math.min(remaining, lot.QtyRemaining);
      const consumedValue = money.allocate(lot.ValueCents, [take, lot.QtyRemaining - take])[0];
      layers.push({ lotId: lot.LotId, qty: take, valueCents: consumedValue });
      costCents += consumedValue;
      remaining -= take;
    }
    return { costCents, layers, qty: demand };
  }

  movements(itemCode, { limit = 200 } = {}) {
    const item = this.getItem(itemCode);
    return this.db.prepare(`
      SELECT m.*, i.ItemCode FROM InventoryMovements m
        JOIN InventoryItems i ON i.ItemId = m.ItemId
       WHERE m.ItemId = ? ORDER BY m.MovementId DESC LIMIT ?
    `).all(item.ItemId, limit);
  }
}

module.exports = { InventoryService };
