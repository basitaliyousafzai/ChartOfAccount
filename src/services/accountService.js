'use strict';

/**
 * Account Service (Phase 2: COA Engine)
 * ----------------------------------------------------------------------------
 *  - deterministic seeding of the canonical 5-level chart of accounts
 *  - sequential child-code generation (".0001" -> ".0002" -> ".0003")
 *  - hierarchical tree assembly with search
 *  - balance accumulation (Equation 1) and parent rollups
 */

const { CANONICAL_COA, COA, ROOT_TYPES, CONTRA_NORMAL, levelOfCode, parentOfCode } = require('./coaSeed');
const { ValidationError, NotFoundError, PostingLevelViolation } = require('../core/errors');

function normalizeLevel(level) {
  if (!Number.isInteger(level) || level < 1 || level > 5) {
    throw new ValidationError(`AccountLevel must be an integer between 1 and 5 (received ${level})`);
  }
  return level;
}

function normalBalanceFor(code, rootType, isContra) {
  if (CONTRA_NORMAL[code]) return CONTRA_NORMAL[code];
  const major = String(code).charAt(0);
  const meta = ROOT_TYPES[major];
  if (!meta) throw new ValidationError(`Unknown major element for account code ${code}`);
  if (rootType && rootType !== meta.root) {
    throw new ValidationError(`RootType mismatch for ${code}: expected ${meta.root}, received ${rootType}`);
  }
  // Contra accounts invert the natural balance of their root type.
  if (isContra) return meta.normal === 'Debit' ? 'Credit' : 'Debit';
  return meta.normal;
}

/**
 * Structural prefix used for descendant rollups:
 *   '1.00.00.0000.0000' -> '1.%'
 *   '1.10.00.0000.0000' -> '1.10.%'
 *   '1.10.01.0000.0000' -> '1.10.01.%'
 *   '1.10.01.0001.0000' -> '1.10.01.0001.%'
 *   '1.10.01.0001.0001' -> '1.10.01.0001.0001'   (leaf: exact match only)
 */
function descendantPrefix(code) {
  const level = levelOfCode(code);
  const [l1, l2, l3, l4] = String(code).split('.');
  if (level === 1) return `${l1}.%`;
  if (level === 2) return `${l1}.${l2}.%`;
  if (level === 3) return `${l1}.${l2}.${l3}.%`;
  if (level === 4) return `${l1}.${l2}.${l3}.${l4}.%`;
  return String(code);
}

class AccountService {
  constructor(db) {
    this.db = db;
  }

  /** Idempotent seeding of the master COA taxonomy (Section 2.3). */
  seedChartOfAccounts() {
    const existing = this.db.prepare('SELECT COUNT(*) AS c FROM Accounts').get().c;
    if (existing > 0) return { seeded: false, count: existing };

    const insert = this.db.prepare(`
      INSERT INTO Accounts (AccountCode, AccountName, ParentCode, AccountLevel, RootType,
                            NormalBalance, IsPostingAllowed, IsContraAccount, IsSystemControl,
                            IsActive, Description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);

    this.db.transaction(() => {
      for (const [code, name, isContra, description] of CANONICAL_COA) {
        const level = normalizeLevel(levelOfCode(code));
        const rootType = ROOT_TYPES[Number(code.charAt(0))].root;
        const normal = normalBalanceFor(code, rootType, isContra);
        const parent = parentOfCode(code);
        // Parent must already exist (parents are always listed first).
        if (parent && !this.db.prepare('SELECT 1 FROM Accounts WHERE AccountCode = ?').get(parent)) {
          throw new ValidationError(`COA seed ordering error: parent ${parent} of ${code} not yet inserted`);
        }
        insert.run(
          code, name, parent, level, rootType, normal,
          level === 5 ? 1 : 0,           // IsPostingAllowed: Level 5 leaves only (Invariant 2)
          isContra ? 1 : 0,
          level < 5 ? 1 : 0,             // IsSystemControl: summary heads are system rollups
          description,
        );
      }
    });

    return { seeded: true, count: CANONICAL_COA.length };
  }

  getByCode(code) {
    const row = this.db.prepare('SELECT * FROM Accounts WHERE AccountCode = ?').get(code);
    if (!row) throw new NotFoundError(`Account ${code} does not exist in the chart of accounts`);
    return row;
  }

  getById(accountId) {
    const row = this.db.prepare('SELECT * FROM Accounts WHERE AccountId = ?').get(accountId);
    if (!row) throw new NotFoundError(`AccountId ${accountId} does not exist`);
    return row;
  }

  findByName(name) {
    return this.db.prepare('SELECT * FROM Accounts WHERE LOWER(AccountName) = LOWER(?)').get(name) || null;
  }

  list({ level = null, postingOnly = false, activeOnly = true, rootType = null, search = null } = {}) {
    const where = [];
    const params = [];
    if (activeOnly) where.push('IsActive = 1');
    if (postingOnly) where.push('IsPostingAllowed = 1');
    if (level) { where.push('AccountLevel = ?'); params.push(level); }
    if (rootType) { where.push('RootType = ?'); params.push(rootType); }
    if (search) { where.push('(AccountCode LIKE ? OR AccountName LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const sql = `SELECT * FROM Accounts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY AccountCode ASC`;
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Sequential code generator for a new child under `parentCode`.
   * e.g. nextChildCode('6.10.01.0001.0000') -> '6.10.01.0001.0002'
   *      nextChildCode('6.10.01.0000.0000') -> '6.10.01.0002.0000'
   */
  nextChildCode(parentCode) {
    const parent = this.getByCode(parentCode);
    if (parent.AccountLevel >= 5) {
      throw new ValidationError(`Level 5 leaf ${parentCode} cannot have children (5-level hierarchy is closed)`);
    }
    const childLevel = parent.AccountLevel + 1;
    const parts = parentCode.split('.');
    const slots = { 2: 1, 3: 2, 4: 3, 5: 4 };
    const index = slots[childLevel];
    const siblingRows = this.db.prepare(
      'SELECT AccountCode FROM Accounts WHERE ParentCode = ?',
    ).all(parentCode);

    const taken = new Set(siblingRows.map((r) => Number(r.AccountCode.split('.')[index])));
    let next = 1;
    while (taken.has(next)) {
      if (next >= 9999) throw new ValidationError(`No free code left under ${parentCode}`);
      next += 1;
    }
    const digits = childLevel <= 3 ? 2 : 4;
    const candidate = parts.slice();
    candidate[index] = String(next).padStart(digits, '0');
    return candidate.join('.');
  }

  /**
   * Create a new account. The code is either supplied explicitly or generated
   * sequentially under the given parent.
   */
  addAccount({ code = null, name, parentCode = null, description = null, isContra = false, postingAllowed = null }) {
    if (!name || !String(name).trim()) throw new ValidationError('AccountName is required');
    const cleanName = String(name).trim();

    let finalCode = code;
    if (!finalCode) {
      if (!parentCode) throw new ValidationError('Either code or parentCode must be supplied');
      finalCode = this.nextChildCode(parentCode);
    }
    const level = normalizeLevel(levelOfCode(finalCode));
    const parent = parentOfCode(finalCode) || parentCode;
    if (parent && !this.db.prepare('SELECT 1 FROM Accounts WHERE AccountCode = ?').get(parent)) {
      throw new ValidationError(`Parent account ${parent} does not exist`);
    }
    if (this.db.prepare('SELECT 1 FROM Accounts WHERE AccountCode = ?').get(finalCode)) {
      throw new ValidationError(`Account code ${finalCode} already exists`);
    }
    const rootType = ROOT_TYPES[Number(finalCode.charAt(0))].root;
    const normal = normalBalanceFor(finalCode, rootType, isContra);
    const canPost = postingAllowed === null ? level === 5 : Boolean(postingAllowed);
    if (canPost && level !== 5) {
      throw new ValidationError('IsPostingAllowed = 1 is reserved for Level 5 leaf accounts (Invariant 2)');
    }

    this.db.prepare(`
      INSERT INTO Accounts (AccountCode, AccountName, ParentCode, AccountLevel, RootType,
                            NormalBalance, IsPostingAllowed, IsContraAccount, IsSystemControl,
                            IsActive, Description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(finalCode, cleanName, parent || null, level, rootType, normal,
      canPost ? 1 : 0, isContra ? 1 : 0, level < 5 ? 1 : 0, description || null);

    return this.getByCode(finalCode);
  }

  /** Invariant 2 - reject any posting target that is not an active L5 leaf. */
  assertPostingTarget(accountRef) {
    const account = typeof accountRef === 'number' ? this.getById(accountRef) : this.getByCode(accountRef);
    if (!account.IsPostingAllowed || account.AccountLevel !== 5 || !account.IsActive) {
      throw new PostingLevelViolation(account.AccountCode, account.AccountLevel);
    }
    return account;
  }

  /**
   * Equation 1 - Account Net Balance Accumulator.
   * Returns { totalDebit, totalCredit, balance } in exact cents.
   */
  balanceOf(accountRef, { asOfDate = null, includeChildren = false } = {}) {
    const account = typeof accountRef === 'number' ? this.getById(accountRef) : this.getByCode(accountRef);
    const params = [account.AccountId];
    let accountFilter = 'l.AccountId = ?';
    if (includeChildren && account.AccountLevel < 5) {
      // Descendant match on the structural prefix: '1.10.00.0000.0000' -> '1.10.%'
      accountFilter = '(l.AccountId = ? OR l.AccountId IN (SELECT AccountId FROM Accounts WHERE AccountCode LIKE ?))';
      params.push(descendantPrefix(account.AccountCode));
    }
    if (asOfDate) { accountFilter += ' AND v.VoucherDate <= ?'; params.push(asOfDate); }

    const row = this.db.prepare(`
      SELECT COALESCE(SUM(l.Debit), 0)  AS totalDebit,
             COALESCE(SUM(l.Credit), 0) AS totalCredit
        FROM JournalVoucherLines l
        JOIN JournalVouchers v ON v.VoucherId = l.VoucherId
       WHERE ${accountFilter} AND v.IsPosted = 1
    `).get(...params);

    const { totalDebit, totalCredit } = row;
    const signed = account.NormalBalance === 'Debit'
      ? totalDebit - totalCredit
      : totalCredit - totalDebit;
    return {
      accountCode: account.AccountCode,
      accountName: account.AccountName,
      normalBalance: account.NormalBalance,
      totalDebit,
      totalCredit,
      balance: signed,
      /** raw net (DR - CR) for trial-balance gross columns */
      netDebitMinusCredit: totalDebit - totalCredit,
    };
  }

  /**
   * Parent rollups: a summary head's balance is strictly the mathematical sum
   * of all descendant leaf balances (Invariant 2).
   */
  rollupBalance(accountRef, options = {}) {
    return this.balanceOf(accountRef, { ...options, includeChildren: true });
  }

  /** Full hierarchical tree for the COA viewer, with live balances. */
  buildTree({ search = null, asOfDate = null, withBalances = true } = {}) {
    const accounts = this.list({ search, activeOnly: true });
    if (!withBalances) return this.toTree(accounts, []);

    const balances = new Map();
    for (const account of accounts) {
      if (account.AccountLevel === 5) {
        const b = this.balanceOf(account.AccountCode, { asOfDate });
        balances.set(account.AccountCode, b.balance);
      }
    }
    // Roll parents up from their descendant leaves.
    for (const account of accounts) {
      if (account.AccountLevel < 5) {
        let total = 0;
        for (const [code, value] of balances.entries()) {
          if (code.startsWith(account.AccountCode)) total += value;
        }
        balances.set(account.AccountCode, total);
      }
    }
    return this.toTree(accounts, balances);
  }

  toTree(accounts, balances) {
    const nodes = new Map();
    for (const account of accounts) {
      nodes.set(account.AccountCode, {
        ...account,
        balance: balances ? (balances.get(account.AccountCode) || 0) : null,
        children: [],
      });
    }
    const roots = [];
    for (const node of nodes.values()) {
      const parent = node.ParentCode ? nodes.get(node.ParentCode) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  static get systemCodes() { return COA; }
  static get canonical() { return CANONICAL_COA; }
}

module.exports = { AccountService, normalBalanceFor, descendantPrefix };
