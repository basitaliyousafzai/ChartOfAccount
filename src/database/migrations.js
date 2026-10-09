'use strict';

/**
 * Schema versioning (Phase 1).  The DDL in schema.sql is idempotent
 * (CREATE ... IF NOT EXISTS); this runner records the applied version and
 * applies forward-only patches so existing databases upgrade in place.
 */

const PATCHES = [
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec('CREATE TABLE IF NOT EXISTS SchemaVersion (Version INTEGER PRIMARY KEY, AppliedAt DATETIME DEFAULT CURRENT_TIMESTAMP);');
    },
  },
  {
    version: 2,
    name: 'fifo-lots-and-fixed-assets',
    up(db) {
      const hasLots = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='InventoryLots'").get();
      if (!hasLots) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS InventoryLots (
            LotId         INTEGER PRIMARY KEY AUTOINCREMENT,
            ItemId        INTEGER NOT NULL,
            ReceiptDate   DATE NOT NULL,
            ReceiptSeq    INTEGER NOT NULL,
            VoucherId     INTEGER NULL,
            QtyReceived   INTEGER NOT NULL CHECK (QtyReceived > 0),
            QtyRemaining  INTEGER NOT NULL CHECK (QtyRemaining >= 0),
            UnitCost      DECIMAL(18, 2) NOT NULL,
            SupplierRef   VARCHAR(100) NULL
          );`);
      }
      const posted = db.prepare('PRAGMA table_info(JournalVouchers)').all()
        .some((col) => col.name === 'IsPosted');
      if (!posted) {
        db.exec("ALTER TABLE JournalVouchers ADD COLUMN IsPosted BOOLEAN NOT NULL DEFAULT 0;");
      }
    },
  },
];

function currentVersion(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SchemaVersion'").get();
  if (!table) return 0;
  const row = db.prepare('SELECT COALESCE(MAX(Version), 0) AS v FROM SchemaVersion').get();
  return row.v;
}

function runMigrations(db) {
  const from = currentVersion(db);
  for (const patch of PATCHES) {
    if (patch.version > from) {
      db.transaction(() => {
        patch.up(db);
        db.prepare('INSERT INTO SchemaVersion (Version) VALUES (?)').run(patch.version);
      });
    }
  }
  return { from, to: currentVersion(db) };
}

module.exports = { runMigrations, currentVersion, PATCHES };
