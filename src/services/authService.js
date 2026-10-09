'use strict';

/**
 * Auth Service (Phase 1: RBAC authentication wrapper)
 * ----------------------------------------------------------------------------
 * Passwords are hashed with Node's crypto.scrypt (N=16384, r=8, p=1, 32-byte
 * key) and stored as "scrypt$<salt>$<hash>".  No plaintext credential ever
 * reaches the database or the renderer.
 */

const crypto = require('crypto');
const { AuthenticationError, ValidationError } = require('../core/errors');
const { PERMISSIONS } = require('./validationService');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };

const SEED_USERS = [
  { username: 'admin', password: 'admin123', role: 'Admin' },
  { username: 'accountant', password: 'account123', role: 'Accountant' },
  { username: 'cashier', password: 'cash123', role: 'Cashier' },
];

const DEFAULT_SETTINGS = [
  ['BaseCurrency', 'USD', 'Base (reporting) currency code'],
  ['CurrencySymbol', '$', 'Display symbol'],
  ['DefaultSalesTaxRate', '0.10', 'Default output/input tax rate (10%)'],
  ['DefaultPensionRate', '0', 'Default employee pension contribution rate'],
  ['InventoryValuationMethod', 'FIFO', 'Perpetual costing method: FIFO or MAC'],
  ['BusinessName', 'Apex Tech Store', 'Legal business name printed on reports'],
  ['FiscalYearStartMonth', '1', 'Month the fiscal year begins (1 = January)'],
];

function hashPassword(password, saltHex = null) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
  });
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const derived = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
  });
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

class AuthService {
  constructor(db) {
    this.db = db;
  }

  /** Idempotent bootstrap: default users + system settings. */
  seed() {
    const insertUser = this.db.prepare(`
      INSERT INTO Users (Username, PasswordHash, Role, IsActive) VALUES (?, ?, ?, 1)
    `);
    const insertSetting = this.db.prepare(`
      INSERT OR IGNORE INTO SystemSettings (SettingKey, SettingValue, Description) VALUES (?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const user of SEED_USERS) {
        const exists = this.db.prepare('SELECT 1 FROM Users WHERE Username = ?').get(user.username);
        if (!exists) insertUser.run(user.username, hashPassword(user.password), user.role);
      }
      for (const [key, value, description] of DEFAULT_SETTINGS) insertSetting.run(key, value, description);
    });
    return {
      users: this.db.prepare('SELECT UserId, Username, Role, IsActive FROM Users ORDER BY UserId').all(),
      settings: this.getSettings(),
    };
  }

  getSettings() {
    const rows = this.db.prepare('SELECT SettingKey, SettingValue FROM SystemSettings').all();
    return Object.fromEntries(rows.map((r) => [r.SettingKey, r.SettingValue]));
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO SystemSettings (SettingKey, SettingValue) VALUES (?, ?)
      ON CONFLICT(SettingKey) DO UPDATE SET SettingValue = excluded.SettingValue
    `).run(String(key), String(value));
    return { key: String(key), value: String(value) };
  }

  login({ username, password }) {
    if (!username || password === undefined) throw new AuthenticationError('Username and password are required');
    const user = this.db.prepare('SELECT * FROM Users WHERE Username = ?').get(String(username));
    if (!user || !user.IsActive || !verifyPassword(password, user.PasswordHash)) {
      throw new AuthenticationError();
    }
    this.db.prepare('UPDATE Users SET LastLoginAt = CURRENT_TIMESTAMP WHERE UserId = ?').run(user.UserId);
    return {
      userId: user.UserId,
      username: user.Username,
      role: user.Role,
      permissions: PERMISSIONS[user.Role] || [],
    };
  }

  permissions(role) {
    return PERMISSIONS[role] || [];
  }

  changePassword({ userId, currentPassword, newPassword }) {
    const user = this.db.prepare('SELECT * FROM Users WHERE UserId = ?').get(userId);
    if (!user) throw new ValidationError('User not found');
    if (!verifyPassword(currentPassword, user.PasswordHash)) throw new AuthenticationError('Current password is incorrect');
    if (!newPassword || String(newPassword).length < 6) throw new ValidationError('New password must be at least 6 characters');
    this.db.prepare('UPDATE Users SET PasswordHash = ? WHERE UserId = ?').run(hashPassword(newPassword), user.UserId);
    return { userId, updated: true };
  }

  listUsers() {
    return this.db.prepare('SELECT UserId, Username, Role, IsActive, CreatedAt FROM Users ORDER BY UserId').all();
  }
}

module.exports = { AuthService, hashPassword, verifyPassword, SEED_USERS, DEFAULT_SETTINGS };
