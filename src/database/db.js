'use strict';

/**
 * Database adapter (Phase 1: DB Kernel)
 * ----------------------------------------------------------------------------
 * Prefers `better-sqlite3` (spec's primary engine) and transparently falls
 * back to Node's built-in `node:sqlite` when the native module is unavailable
 * (e.g. no compiler toolchain on the host).  Both drivers expose the same
 * synchronous prepare/run/get/all surface, so every service in the engine is
 * driver-agnostic.
 *
 * PRAGMAs applied on every open (Section 4.1):
 *   foreign_keys = ON      -> Referential integrity (Invariant 2 / FK isolation)
 *   journal_mode = WAL     -> Crash-safe concurrent readers
 *   synchronous  = NORMAL  -> Durable enough for WAL desktop workloads
 */

const fs = require('fs');
const path = require('path');

let DriverName = null;

function loadDriver() {
  if (DriverName) return DriverName;
  try {
    // The native binding is loaded lazily, so a bare `require` is NOT enough
    // to prove the ABI matches (it does not inside Electron). Open a throwaway
    // in-memory database and run a statement — that actually loads the .node
    // binary and throws if it was compiled for another NODE_MODULE_VERSION.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const BetterSqlite3 = require('better-sqlite3');
    const probe = new BetterSqlite3(':memory:');
    probe.exec('SELECT 1;');
    probe.close();
    DriverName = 'better-sqlite3';
  } catch (_err) {
    DriverName = 'node:sqlite';
  }
  return DriverName;
}

function normalizeParams(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString().slice(0, 10);
    return p;
  });
}

function normalizeRow(row) {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return Object.create(Object.prototype, Object.getOwnPropertyDescriptors(out));
}

class Statement {
  constructor(inner, driver) {
    this.inner = inner;
    this.driver = driver;
  }

  run(...params) {
    const result = this.inner.run(...normalizeParams(params));
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
    };
  }

  get(...params) {
    return normalizeRow(this.inner.get(...normalizeParams(params)));
  }

  all(...params) {
    return this.inner.all(...normalizeParams(params)).map(normalizeRow);
  }
}

class Database {
  constructor(filename, { verbose = false } = {}) {
    this.filename = filename;
    this.driver = loadDriver();
    this.txDepth = 0;

    if (filename !== ':memory:') {
      const dir = path.dirname(filename);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    if (this.driver === 'better-sqlite3') {
      try {
        // eslint-disable-next-line global-require, import/no-extraneous-dependencies
        const BetterSqlite3 = require('better-sqlite3');
        this.db = new BetterSqlite3(filename, { verbose: verbose ? console.log : undefined });
      } catch (err) {
        // ABI mismatch at construct time (Electron) — degrade, never crash.
        // eslint-disable-next-line global-require
        const { DatabaseSync } = require('node:sqlite');
        this.driver = 'node:sqlite';
        this.db = new DatabaseSync(filename);
        console.warn('[db] better-sqlite3 unusable, falling back to node:sqlite:', String(err.message).split('\n')[0]);
      }
    } else {
      const { DatabaseSync } = require('node:sqlite'); // eslint-disable-line global-require
      this.db = new DatabaseSync(filename);
    }

    this.exec('PRAGMA foreign_keys = ON;');
    if (filename !== ':memory:') this.exec('PRAGMA journal_mode = WAL;');
    this.exec('PRAGMA synchronous = NORMAL;');
  }

  exec(sql) {
    this.db.exec(sql);
    return this;
  }

  prepare(sql) {
    return new Statement(this.db.prepare(sql), this.driver);
  }

  pragma(statement) {
    return this.prepare(`PRAGMA ${statement}`).all();
  }

  /**
   * Atomic unit of work.  Supports nesting through SAVEPOINTs so that a
   * service (e.g. a POS sale that writes a voucher + FIFO movements) can call
   * another service that also opens a transaction.
   */
  transaction(fn) {
    const depth = this.txDepth;
    const savepoint = `sp_${depth}`;
    if (depth === 0) this.exec('BEGIN IMMEDIATE;');
    else this.exec(`SAVEPOINT ${savepoint};`);
    this.txDepth += 1;
    try {
      const result = fn(this);
      this.txDepth -= 1;
      if (depth === 0) this.exec('COMMIT;');
      else this.exec(`RELEASE ${savepoint};`);
      return result;
    } catch (error) {
      this.txDepth -= 1;
      try {
        if (depth === 0) this.exec('ROLLBACK;');
        else this.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`);
      } catch (_rollbackError) { /* the original error is the one to surface */ }
      throw error;
    }
  }

  close() {
    try { this.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_err) { /* ignore */ }
    this.db.close();
  }

  /**
   * Close and reopen the underlying handle on the same file.
   * Used by backup restore: the .db file is swapped on disk, so the live
   * handle must be re-pointed. Services keep their `Database` wrapper, so no
   * other object has to be rebuilt.
   */
  reopen() {
    try { this.db.close(); } catch (_err) { /* already closed */ }
    if (this.driver === 'better-sqlite3') {
      const BetterSqlite3 = require('better-sqlite3'); // eslint-disable-line global-require
      this.db = new BetterSqlite3(this.filename, { verbose: false });
    } else {
      const { DatabaseSync } = require('node:sqlite'); // eslint-disable-line global-require
      this.db = new DatabaseSync(this.filename);
    }
    this.txDepth = 0;
    this.exec('PRAGMA foreign_keys = ON;');
    if (this.filename !== ':memory:') this.exec('PRAGMA journal_mode = WAL;');
    this.exec('PRAGMA synchronous = NORMAL;');
    return this;
  }
}

/** Apply the full Section 4.1 DDL to a database handle. */
function initializeSchema(db, schemaPath = path.join(__dirname, 'schema.sql')) {
  const ddl = fs.readFileSync(schemaPath, 'utf8');
  db.exec(ddl);
  return db;
}

/**
 * Open (and lazily create) the application database with schema applied.
 * @param {string} filename absolute path, or ':memory:' for tests
 */
function openDatabase(filename, options = {}) {
  const db = new Database(filename, options);
  initializeSchema(db, options.schemaPath);
  return db;
}

function driverName() { return loadDriver(); }

module.exports = { Database, openDatabase, initializeSchema, driverName };
