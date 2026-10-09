-- =============================================================================
--  MASTER ERP SCHEMA  -  SRS v3.0.0 Section 4.1 (Relational Schema DDL)
--  Engine: SQLite (better-sqlite3, with a node:sqlite fallback adapter)
--
--  PRECISION CONTRACT (Invariant 3):
--      Every column declared DECIMAL(18, 2) stores EXACT INTEGER CENTS.
--      $10.50 is written as 1050.  SQLite's NUMERIC affinity keeps integers as
--      INTEGER, so SUM()/MIN()/MAX() over the ledger is integer-exact and
--      |SUM(Debit) - SUM(Credit)| == 0 is a true integer comparison.
--      Formatting to "1,234.56" happens only at the presentation edge.
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- -----------------------------------------------------------------------------
-- 1. Security & Users (Phase 1: RBAC)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Users (
    UserId        INTEGER PRIMARY KEY AUTOINCREMENT,
    Username      VARCHAR(50) NOT NULL UNIQUE,
    PasswordHash  VARCHAR(255) NOT NULL,
    Role          VARCHAR(20) NOT NULL CHECK (Role IN ('Admin', 'Accountant', 'Cashier')),
    IsActive      BOOLEAN NOT NULL DEFAULT 1,
    CreatedAt     DATETIME DEFAULT CURRENT_TIMESTAMP,
    LastLoginAt   DATETIME NULL
);

CREATE TABLE IF NOT EXISTS SystemSettings (
    SettingKey    VARCHAR(50) PRIMARY KEY,
    SettingValue  TEXT NOT NULL,
    Description   TEXT NULL
);

-- -----------------------------------------------------------------------------
-- 2. Master Chart of Accounts (5-Level, X.XX.XX.XXXX.XXXX)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Accounts (
    AccountId        INTEGER PRIMARY KEY AUTOINCREMENT,
    AccountCode      VARCHAR(35) NOT NULL UNIQUE,
    AccountName      VARCHAR(150) NOT NULL,
    ParentCode       VARCHAR(35) NULL,
    AccountLevel     INTEGER NOT NULL CHECK (AccountLevel BETWEEN 1 AND 5),
    RootType         VARCHAR(20) NOT NULL CHECK (RootType IN ('Asset','Liability','Equity','Revenue','CostOfSales','Expense')),
    NormalBalance    VARCHAR(6) NOT NULL CHECK (NormalBalance IN ('Debit','Credit')),
    IsPostingAllowed BOOLEAN NOT NULL DEFAULT 0,
    IsContraAccount  BOOLEAN NOT NULL DEFAULT 0,
    IsSystemControl  BOOLEAN NOT NULL DEFAULT 0,
    IsActive         BOOLEAN NOT NULL DEFAULT 1,
    Description      TEXT NULL,
    CreatedAt        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ParentCode) REFERENCES Accounts(AccountCode) ON DELETE RESTRICT
);

-- Invariant 2 (Posting Level Isolation): enforced kernel-side by
-- validationService.assertPostingTarget() and by trg_accounts_leaf_only below
-- (the trigger itself is declared after JournalVoucherLines exists).

-- -----------------------------------------------------------------------------
-- 3. Business Entities (Customers, Vendors, Employees)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Entities (
    EntityId        INTEGER PRIMARY KEY AUTOINCREMENT,
    EntityType      VARCHAR(20) NOT NULL CHECK (EntityType IN ('Customer','Vendor','Employee')),
    FullName        VARCHAR(150) NOT NULL,
    Phone           VARCHAR(50) NULL,
    Email           VARCHAR(100) NULL,
    TaxNumber       VARCHAR(50) NULL,
    CreditLimit     DECIMAL(18, 2) NOT NULL DEFAULT 0,   -- cents
    OpeningBalance  DECIMAL(18, 2) NOT NULL DEFAULT 0,   -- cents
    CurrentBalance  DECIMAL(18, 2) NOT NULL DEFAULT 0,   -- cents (signed: DR positive)
    LinkedAccountId INTEGER NOT NULL,
    CreatedAt       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (LinkedAccountId) REFERENCES Accounts(AccountId)
);

-- -----------------------------------------------------------------------------
-- 4. Inventory Catalog + Perpetual FIFO Cost Queues
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS InventoryItems (
    ItemId            INTEGER PRIMARY KEY AUTOINCREMENT,
    ItemCode          VARCHAR(50) NOT NULL UNIQUE,
    ItemName          VARCHAR(150) NOT NULL,
    Barcode           VARCHAR(50) NULL,
    UnitOfMeasure     VARCHAR(20) NOT NULL DEFAULT 'Units',
    CostPrice         DECIMAL(18, 2) NOT NULL DEFAULT 0,   -- cents
    SellingPrice      DECIMAL(18, 2) NOT NULL DEFAULT 0,   -- cents
    CurrentStock      INTEGER NOT NULL DEFAULT 0,          -- whole units
    ReorderLevel      INTEGER NOT NULL DEFAULT 0,          -- whole units
    ValuationMethod   VARCHAR(10) NOT NULL DEFAULT 'FIFO' CHECK (ValuationMethod IN ('FIFO','MAC')),
    InventoryAccountId INTEGER NOT NULL,
    CogsAccountId     INTEGER NOT NULL,
    RevenueAccountId  INTEGER NOT NULL,
    CreatedAt         DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (InventoryAccountId) REFERENCES Accounts(AccountId),
    FOREIGN KEY (CogsAccountId) REFERENCES Accounts(AccountId),
    FOREIGN KEY (RevenueAccountId) REFERENCES Accounts(AccountId)
);

-- FIFO purchase-lot queue: ordered by receipt, consumed strictly front-to-back.
CREATE TABLE IF NOT EXISTS InventoryLots (
    LotId         INTEGER PRIMARY KEY AUTOINCREMENT,
    ItemId        INTEGER NOT NULL,
    ReceiptDate   DATE NOT NULL,
    ReceiptSeq    INTEGER NOT NULL,
    VoucherId     INTEGER NULL,
    QtyReceived   INTEGER NOT NULL CHECK (QtyReceived > 0),
    QtyRemaining  INTEGER NOT NULL CHECK (QtyRemaining >= 0),
    UnitCost      DECIMAL(18, 2) NOT NULL,   -- cents per unit (incl. capitalised landed cost) - display/derived
    ValueCents    DECIMAL(18, 2) NOT NULL DEFAULT 0,  -- AUTHORITATIVE remaining lot value in cents
    SupplierRef   VARCHAR(100) NULL,
    FOREIGN KEY (ItemId) REFERENCES InventoryItems(ItemId) ON DELETE RESTRICT,
    FOREIGN KEY (VoucherId) REFERENCES JournalVouchers(VoucherId) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_lots_item ON InventoryLots(ItemId, ReceiptSeq);

-- Immutable stock movement ledger (audit trail for COGS / shrinkage / returns).
CREATE TABLE IF NOT EXISTS InventoryMovements (
    MovementId   INTEGER PRIMARY KEY AUTOINCREMENT,
    ItemId       INTEGER NOT NULL,
    VoucherId    INTEGER NULL,   -- NULL only for pre-posting staging; linked when the voucher commits
    MoveDate     DATE NOT NULL,
    MovementType VARCHAR(25) NOT NULL CHECK (MovementType IN (
        'Purchase_Receipt','Sale_Consumption','Return_Restock','Purchase_Return',
        'Shrinkage_WriteOff','Landed_Cost_Capitalisation','Opening_Balance')),
    QtyDelta     INTEGER NOT NULL,
    ValueDelta   DECIMAL(18, 2) NOT NULL,   -- cents
    LotId        INTEGER NULL,
    FOREIGN KEY (ItemId) REFERENCES InventoryItems(ItemId) ON DELETE RESTRICT,
    FOREIGN KEY (VoucherId) REFERENCES JournalVouchers(VoucherId) ON DELETE RESTRICT,
    FOREIGN KEY (LotId) REFERENCES InventoryLots(LotId) ON DELETE RESTRICT
);

-- -----------------------------------------------------------------------------
-- 5. Fiscal Periods Management
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FiscalPeriods (
    PeriodId    INTEGER PRIMARY KEY AUTOINCREMENT,
    PeriodName  VARCHAR(50) NOT NULL,
    StartDate   DATE NOT NULL,
    EndDate     DATE NOT NULL,
    IsClosed    BOOLEAN NOT NULL DEFAULT 0,
    ClosedAt    DATETIME NULL,
    ClosedBy    INTEGER NULL,
    FOREIGN KEY (ClosedBy) REFERENCES Users(UserId)
);

-- -----------------------------------------------------------------------------
-- 6. Journal Vouchers Header (append-only, Invariant 4)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS JournalVouchers (
    VoucherId         INTEGER PRIMARY KEY AUTOINCREMENT,
    VoucherNo         VARCHAR(50) NOT NULL UNIQUE,
    VoucherDate       DATE NOT NULL,
    PeriodId          INTEGER NOT NULL,
    VoucherType       VARCHAR(25) NOT NULL CHECK (VoucherType IN (
                        'General_JV', 'Sales_Invoice', 'Sales_Return',
                        'Purchase_Invoice', 'Purchase_Return',
                        'Cash_Payment', 'Cash_Receipt',
                        'Bank_Payment', 'Bank_Receipt', 'Payroll_Voucher', 'Fiscal_Closing')),
    SourceModule      VARCHAR(30) NULL,
    ReferenceNo       VARCHAR(100) NULL,
    Narration         TEXT NOT NULL,
    IsReversal        BOOLEAN NOT NULL DEFAULT 0,
    ReversesVoucherId INTEGER NULL,
    IsPosted          BOOLEAN NOT NULL DEFAULT 0,   -- flipped 0 -> 1 only after Invariant 1 passes
    TotalDebit        DECIMAL(18, 2) NOT NULL DEFAULT 0,   -- cents
    TotalCredit       DECIMAL(18, 2) NOT NULL DEFAULT 0,   -- cents
    CreatedBy         INTEGER NOT NULL,
    CreatedAt         DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (PeriodId) REFERENCES FiscalPeriods(PeriodId),
    FOREIGN KEY (CreatedBy) REFERENCES Users(UserId),
    FOREIGN KEY (ReversesVoucherId) REFERENCES JournalVouchers(VoucherId)
);

-- Invariant 4: committed (posted) voucher headers are append-only.
CREATE TRIGGER IF NOT EXISTS trg_vouchers_immutable_update
BEFORE UPDATE ON JournalVouchers
FOR EACH ROW
WHEN OLD.IsPosted = 1
BEGIN
    SELECT RAISE(ABORT, 'IMMUTABILITY_VIOLATION: posted journal vouchers cannot be altered (Invariant 4)');
END;

CREATE TRIGGER IF NOT EXISTS trg_vouchers_immutable_delete
BEFORE DELETE ON JournalVouchers
FOR EACH ROW
WHEN OLD.IsPosted = 1
BEGIN
    SELECT RAISE(ABORT, 'IMMUTABILITY_VIOLATION: posted journal vouchers cannot be deleted (Invariant 4)');
END;

-- -----------------------------------------------------------------------------
-- 7. Journal Voucher Detail Lines
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS JournalVoucherLines (
    LineId     INTEGER PRIMARY KEY AUTOINCREMENT,
    VoucherId  INTEGER NOT NULL,
    AccountId  INTEGER NOT NULL,
    Debit      DECIMAL(18, 2) NOT NULL DEFAULT 0,   -- cents
    Credit     DECIMAL(18, 2) NOT NULL DEFAULT 0,   -- cents
    LineMemo   VARCHAR(255) NULL,
    EntityId   INTEGER NULL,
    FOREIGN KEY (VoucherId) REFERENCES JournalVouchers(VoucherId) ON DELETE CASCADE,
    FOREIGN KEY (AccountId) REFERENCES Accounts(AccountId) ON DELETE RESTRICT,
    FOREIGN KEY (EntityId) REFERENCES Entities(EntityId) ON DELETE RESTRICT,
    CHECK ((Debit > 0 AND Credit = 0) OR (Credit > 0 AND Debit = 0))
);

-- Invariant 2 (Posting Level Isolation): Level 1-4 summary heads, inactive or
-- deactivated accounts can never receive a journal line - enforced both by the
-- kernel (validationService.assertPostingTarget) and inside SQLite itself.
CREATE TRIGGER IF NOT EXISTS trg_accounts_leaf_only
BEFORE INSERT ON JournalVoucherLines
FOR EACH ROW
WHEN EXISTS (
    SELECT 1 FROM Accounts a
     WHERE a.AccountId = NEW.AccountId
       AND (a.IsPostingAllowed = 0 OR a.AccountLevel <> 5 OR a.IsActive = 0)
)
BEGIN
    SELECT RAISE(ABORT, 'POSTING_LEVEL_VIOLATION: only active Level-5 leaf accounts accept journal lines');
END;

-- Invariant 4: lines can never be appended to an already-committed voucher.
CREATE TRIGGER IF NOT EXISTS trg_lines_frozen_after_post
BEFORE INSERT ON JournalVoucherLines
FOR EACH ROW
WHEN (SELECT v.IsPosted FROM JournalVouchers v WHERE v.VoucherId = NEW.VoucherId) = 1
BEGIN
    SELECT RAISE(ABORT, 'IMMUTABILITY_VIOLATION: voucher already committed (Invariant 4)');
END;

-- Invariant 1 (Zero-Tolerance Double-Entry Kernel Invariant):
-- the database itself refuses to commit unless
--     |SUM(Debit) - SUM(Credit)| == 0
-- The check runs exactly once, when the kernel flips IsPosted 0 -> 1 with the
-- final header totals - i.e. the moment the voucher becomes a committed fact.
CREATE TRIGGER IF NOT EXISTS trg_voucher_post_balance_check
BEFORE UPDATE ON JournalVouchers
FOR EACH ROW
WHEN OLD.IsPosted = 0 AND NEW.IsPosted = 1
BEGIN
    -- (a) a voucher must carry at least one line
    SELECT CASE WHEN (SELECT COUNT(*) FROM JournalVoucherLines WHERE VoucherId = NEW.VoucherId) = 0
      THEN RAISE(ABORT, 'UNBALANCED_VOUCHER: voucher has no journal lines') END;

    -- (b) zero-tolerance equilibrium: |SUM(DR) - SUM(CR)| must be exactly 0.00
    SELECT CASE WHEN (
                 SELECT ABS(COALESCE(SUM(l.Debit), 0) - COALESCE(SUM(l.Credit), 0))
                   FROM JournalVoucherLines l WHERE l.VoucherId = NEW.VoucherId
               ) > 0
      THEN RAISE(ABORT, 'UNBALANCED_VOUCHER: |SUM(Debit) - SUM(Credit)| must equal 0.00 (Delta > 0 aborts the atomic transaction)') END;

    -- (c) header totals must equal the line sums (no header/line drift)
    SELECT CASE WHEN (
                 SELECT COALESCE(SUM(l.Debit), 0) FROM JournalVoucherLines l WHERE l.VoucherId = NEW.VoucherId
               ) <> NEW.TotalDebit
      THEN RAISE(ABORT, 'VOUCHER_TOTAL_MISMATCH: TotalDebit does not equal SUM(lines.Debit)') END;

    SELECT CASE WHEN (
                 SELECT COALESCE(SUM(l.Credit), 0) FROM JournalVoucherLines l WHERE l.VoucherId = NEW.VoucherId
               ) <> NEW.TotalCredit
      THEN RAISE(ABORT, 'VOUCHER_TOTAL_MISMATCH: TotalCredit does not equal SUM(lines.Credit)') END;
END;

-- -----------------------------------------------------------------------------
-- 8. Fixed Assets & Depreciation (Equation 8A / 8B)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FixedAssets (
    AssetId          INTEGER PRIMARY KEY AUTOINCREMENT,
    AssetCode        VARCHAR(50) NOT NULL UNIQUE,
    AssetName        VARCHAR(150) NOT NULL,
    AcquisitionDate  DATE NOT NULL,
    Cost             DECIMAL(18, 2) NOT NULL,          -- cents
    SalvageValue     DECIMAL(18, 2) NOT NULL DEFAULT 0,-- cents
    UsefulLifeYears  INTEGER NOT NULL CHECK (UsefulLifeYears > 0),
    Method           VARCHAR(12) NOT NULL DEFAULT 'Straight_Line' CHECK (Method IN ('Straight_Line','DDB')),
    AssetAccountId   INTEGER NOT NULL,
    AccumDepAccountId INTEGER NOT NULL,
    DepreciationExpenseAccountId INTEGER NOT NULL,
    AccumulatedDepreciation DECIMAL(18, 2) NOT NULL DEFAULT 0, -- cents
    MonthsDepreciated  INTEGER NOT NULL DEFAULT 0,
    IsFullyDepreciated BOOLEAN NOT NULL DEFAULT 0,
    VoucherId        INTEGER NULL,
    FOREIGN KEY (AssetAccountId) REFERENCES Accounts(AccountId),
    FOREIGN KEY (AccumDepAccountId) REFERENCES Accounts(AccountId),
    FOREIGN KEY (DepreciationExpenseAccountId) REFERENCES Accounts(AccountId)
);

CREATE TABLE IF NOT EXISTS DepreciationRuns (
    RunId      INTEGER PRIMARY KEY AUTOINCREMENT,
    RunDate    DATE NOT NULL,
    PeriodId   INTEGER NOT NULL,
    VoucherId  INTEGER NULL,
    TotalAmount DECIMAL(18, 2) NOT NULL DEFAULT 0,   -- cents
    CreatedAt  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (PeriodId) REFERENCES FiscalPeriods(PeriodId)
);

-- -----------------------------------------------------------------------------
-- 9. Multi-currency: exchange rates & settlement audit (Equation 9, IAS 21)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Currencies (
    CurrencyCode VARCHAR(3) PRIMARY KEY,
    Symbol       VARCHAR(5) NOT NULL,
    CurrencyName VARCHAR(60) NOT NULL,
    IsBase       BOOLEAN NOT NULL DEFAULT 0,
    IsActive     BOOLEAN NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ForexRates (
    RateId    INTEGER PRIMARY KEY AUTOINCREMENT,
    CurrencyCode VARCHAR(3) NOT NULL,
    RateDate  DATE NOT NULL,
    Rate      DECIMAL(18, 6) NOT NULL,   -- 1 unit of foreign currency in base units
    FOREIGN KEY (CurrencyCode) REFERENCES Currencies(CurrencyCode)
);

CREATE TABLE IF NOT EXISTS ReceivableSettlements (
    SettlementId   INTEGER PRIMARY KEY AUTOINCREMENT,
    InvoiceVoucherId INTEGER NOT NULL,
    SettlementVoucherId INTEGER NOT NULL,
    ForeignAmount  DECIMAL(18, 2) NOT NULL,   -- cents, foreign currency
    CurrencyCode   VARCHAR(3) NOT NULL,
    OriginalRate   DECIMAL(18, 6) NOT NULL,
    SettlementRate DECIMAL(18, 6) NOT NULL,
    OrigValueBase  DECIMAL(18, 2) NOT NULL,   -- cents
    SettleValueBase DECIMAL(18, 2) NOT NULL,  -- cents
    ForexDelta     DECIMAL(18, 2) NOT NULL,   -- cents (signed)
    FOREIGN KEY (InvoiceVoucherId) REFERENCES JournalVouchers(VoucherId),
    FOREIGN KEY (SettlementVoucherId) REFERENCES JournalVouchers(VoucherId),
    FOREIGN KEY (CurrencyCode) REFERENCES Currencies(CurrencyCode)
);

-- -----------------------------------------------------------------------------
-- 10. Customer / Vendor invoice & payment allocation audit
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS DocumentAllocations (
    AllocationId     INTEGER PRIMARY KEY AUTOINCREMENT,
    SourceVoucherId  INTEGER NOT NULL,   -- invoice / credit note
    ClearingVoucherId INTEGER NOT NULL,  -- receipt / payment
    AllocatedAmount  DECIMAL(18, 2) NOT NULL,  -- cents
    AllocatedAt      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (SourceVoucherId) REFERENCES JournalVouchers(VoucherId),
    FOREIGN KEY (ClearingVoucherId) REFERENCES JournalVouchers(VoucherId)
);

-- -----------------------------------------------------------------------------
-- 11. High-Performance Indexes (Section 4.1 item 8)
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_acc_code       ON Accounts(AccountCode);
CREATE INDEX IF NOT EXISTS idx_acc_parent     ON Accounts(ParentCode);
CREATE INDEX IF NOT EXISTS idx_voucher_lookup ON JournalVouchers(VoucherDate, VoucherType);
CREATE INDEX IF NOT EXISTS idx_lines_rollup   ON JournalVoucherLines(AccountId, Debit, Credit);
CREATE INDEX IF NOT EXISTS idx_lines_entity   ON JournalVoucherLines(EntityId);
CREATE INDEX IF NOT EXISTS idx_lines_voucher  ON JournalVoucherLines(VoucherId);
CREATE INDEX IF NOT EXISTS idx_period_close   ON FiscalPeriods(StartDate, EndDate);
