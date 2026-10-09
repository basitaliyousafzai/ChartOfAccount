'use strict';

/**
 * Backup Service (Invariant 5 - offline resilience & portability)
 * ----------------------------------------------------------------------------
 * Single-click atomic snapshot of the live .db file, plus a structured JSON
 * dump of every table for external tooling / migration.
 */

const fs = require('fs');
const path = require('path');

class BackupService {
  constructor(db, { dbPath, appDataDir }) {
    this.db = db;
    this.dbPath = dbPath;
    this.appDataDir = appDataDir;
  }

  defaultDir() {
    const dir = path.join(this.appDataDir, 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  stamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  /** Flush WAL and copy the database file to a timestamped snapshot. */
  snapshot({ targetPath = null } = {}) {
    if (this.dbPath === ':memory:') throw new Error('Cannot snapshot an in-memory database');
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_err) { /* checkpoint best effort */ }

    const destination = targetPath || path.join(this.defaultDir(), `apex_erp_${this.stamp()}.db`);
    const dir = path.dirname(destination);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(this.dbPath, destination);

    // Verify the copy is a readable SQLite file before reporting success.
    const header = Buffer.alloc(16);
    const handle = fs.openSync(destination, 'r');
    fs.readSync(handle, header, 0, 16, 0);
    fs.closeSync(handle);
    const valid = header.slice(0, 15).toString('utf8') === 'SQLite format 3';
    if (!valid) throw new Error('Backup verification failed: destination is not a valid SQLite file');

    return { path: destination, bytes: fs.statSync(destination).size, verified: true };
  }

  list() {
    const dir = this.defaultDir();
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        return { name: f, path: full, bytes: stat.size, createdAt: stat.birthtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Structured JSON dump of the entire ledger (Invariant 5). */
  dumpJson({ targetPath = null } = {}) {
    const tables = this.db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name
    `).all();

    const payload = {
      generator: 'Apex ERP Ledger Engine v3.0.0',
      exportedAt: new Date().toISOString(),
      driver: this.db.driver,
      tables: {},
    };
    let records = 0;
    for (const { name } of tables) {
      const rows = this.db.prepare(`SELECT * FROM "${name}"`).all();
      payload.tables[name] = rows;
      records += rows.length;
    }

    const destination = targetPath || path.join(this.defaultDir(), `apex_erp_${this.stamp()}.json`);
    const dir = path.dirname(destination);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(payload, null, 2), 'utf8');
    return { path: destination, records, tables: tables.length };
  }

  /**
   * Restore a snapshot over the live database.
   *
   * The live handle is closed, the snapshot copied over the .db file (the
   * replaced copy is kept alongside), stale -wal/-shm sidecars are dropped and
   * the handle is reopened so every service keeps working without a restart.
   * @returns {{restored:boolean,path:string,previous:string,reopened:boolean}}
   */
  restore({ sourcePath }) {
    if (!fs.existsSync(sourcePath)) throw new Error(`Snapshot not found: ${sourcePath}`);
    if (this.dbPath === ':memory:') throw new Error('Cannot restore into an in-memory database');

    this.db.close();
    const backupOfCurrent = `${this.dbPath}.replaced_${this.stamp()}`;
    if (fs.existsSync(this.dbPath)) fs.copyFileSync(this.dbPath, backupOfCurrent);
    fs.copyFileSync(sourcePath, this.dbPath);
    for (const suffix of ['-wal', '-shm']) {
      const side = `${this.dbPath}${suffix}`;
      if (fs.existsSync(side)) fs.rmSync(side);
    }

    // Re-point the live handle at the restored file (services keep their ref).
    this.db.reopen();
    return { restored: true, path: this.dbPath, previous: backupOfCurrent, reopened: true };
  }
}

module.exports = { BackupService };
