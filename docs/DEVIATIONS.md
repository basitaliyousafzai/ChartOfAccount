# Documented Deviations from the SRS (MASTER_ERP_SPECIFICATION_FULL.docx)

Every deviation below is deliberate, traceable, and non-destructive to the
ledger invariants (Section 2): exact integer-cent money, zero-tolerance
balance proof, Level-5-leaf postings, append-only vouchers.

---

## 1. Section 6 case-study arithmetic typo ($1,000.00)

The published Section 6 tables contain one inconsistent bank figure. The
seeder posts the 15 transactions exactly as written, so the engine's own
double-entry result is the self-consistent one:

| Location | SRS figure | Engine figure |
|---|---|---|
| 6.1 bank balance | $49,400.00 | **$48,400.00** |
| 6.1 trial balance columns | $91,283.33 / $91,283.33 | **$90,283.33 / $90,283.33** |
| 6.3 total assets | $71,766.67 | **$70,766.67** |

Proof that the engine is right and the doc is wrong:

```
Assets 70,766.67  ==  Liabilities 12,000.00 + Equity 58,766.67  ->  0.00   (engine)
Assets 71,766.67  -  (12,000.00 + 58,766.67)                   ->  1,000.00 (doc's own numbers)
```

The doc's own P&L is internally consistent with the engine
(GP $6,200.00, Π −$233.33), and the P&L result feeds equity, so only the
asset/bank side of the doc's tables is off by $1,000. Root cause: a single
wrong cash/bank cell in the source spreadsheet.

**Every other published figure in Section 6 matches to the cent.**
`npm run verify` asserts 87/87 of them.

---

## 2. Database driver fallback (`better-sqlite3` vs `node:sqlite`)

`src/database/` prefers `better-sqlite3@12.11.1` and transparently falls
back to Node's built-in `node:sqlite` driver.

* Under `npm test` / `npm run seed` / `npm run verify` (Node 24 LTS CLI) the
  native `better-sqlite3` driver is used — output prints
  `Database driver : better-sqlite3 (native)`.
* Inside Electron 35.7.5 the prebuilt native module's ABI does not match
  (`NODE_MODULE_VERSION 137` vs `133`), so the adapter falls back to
  `node:sqlite`. Both drivers are exercised through the same SQL layer
  (schema.sql + migrations.js); no query text differs.

**Implementation note:** `require('better-sqlite3')` *succeeds* under
Electron — the `.node` binding is loaded lazily, so a bare require cannot
detect an ABI mismatch. `loadDriver()` therefore opens a throwaway
`:memory:` database and runs `SELECT 1` as the probe, and the `Database`
constructor keeps a second try/catch fallback so a construct-time failure
degrades to `node:sqlite` instead of crashing the shell.

Deviation from spec: the spec assumes a single driver. The adapter keeps a
single connection factory (`src/database/db.js`), so services are unaware of
which driver is live.

**Electron uses the same database file as the CLI.** `resolveDataPath()`
derives the path from `__dirname` (`<project>/data/apex_erp.db`) rather than
`app.getPath('userData')`, so `npm start` opens exactly the ledger seeded by
`npm run seed`. `ERP_DB_PATH` still overrides everything (tests use
`:memory:`), and a read-only install falls back to `userData`.

---

## 3. Payroll tax slab conflict (Section 3.7)

The spec's annual progressive slab yields **$0.00** tax for a monthly gross of
$3,500.00 (annualized $42,000 under the stated 0% band), yet the Section 6
case study (Tx 13) requires **$350.00** withheld.

Resolution: the seeder passes the case-study amount explicitly
(`taxWithheldCents: 35000`) rather than deriving it from the slab. The slab
itself is implemented verbatim and unit-tested
(`tests/tax.test.js` → "documented deviation: the slab gives 0 for a $3,500
monthly gross").

Voucher totals are unaffected: DR Gross Wages / CR Net Payable / CR Payroll
Tax Payable still balance to $0.00.

---

## 4. Chart of Accounts additions (intermediate nodes + 1 head)

The spec's §4 COA table omits some Level-4 intermediate nodes required by
Invariant 2 (only Level 5 may be posted), and §6 references an expense head
that collides with the depreciation head. Added/adjusted:

| Code | Name | Why |
|---|---|---|
| `1.10.01.0002.0000` | Bank Accounts | Level-4 parent for bank leaves |
| `6.10.04.0001.0000` | Bank & Depreciation Control | Level-4 parent |
| `6.10.04.0002.0000` | Bank Charges Control | Level-4 parent |
| `6.10.04.0001.0001` | Office Equipment Depreciation | resolves code collision (below) |
| `6.10.04.0002.0001` | Bank Fees & Merchant Charges | resolves code collision (below) |

**Code collision resolved:** the spec assigns `6.10.04.0001.0001` to both
"Depreciation Expense" and a bank-charges head. Resolved as
`6.10.04.0001.0001 = Office Equipment Depreciation` and
`6.10.04.0002.0001 = Bank Fees & Merchant Charges`, which keeps Tx 12
(utility/bank charges) and Tx 14 (depreciation) on distinct Level-5 leaves.

---

## 5. Extra movement rows for audit completeness (Section 4.6)

`inventoryService.receive()` and `createItem()` opening balances now write
`Purchase_Receipt` / `Opening_Balance` rows into `InventoryMovements`. The
spec's §4.6 table defines the movement types but §5 posting rules only
mandated movement rows for sales/consumption, which left received stock with
no audit trail. This is additive: lot queues, FIFO valuation, and stock counts
are unchanged (`10 units × $1,030.00 = $10,300.00` still holds).

---

## 6. Closing service bug fixes (Section 3.10)

Two genuine engine bugs found by `tests/closing.test.js`, fixed in
`src/services/closingService.js`:

1. The closing entry read `row.Debit` / `row.Credit` instead of the grouped
   aggregates `row.TotalDebit` / `row.TotalCredit`, so the period-close
   voucher posted `NaN`/0 and never zeroed P&L accounts.
2. The zeroing direction for **contra-revenue** accounts (debit-balance
   Revenue, e.g. Sales Returns) used the root-type normal balance rather than
   the account's own normal side, producing a one-sided closing voucher that
   failed the balance proof.

The rewrite posts from the account's normal side to the opposite side and
carries a **signed** P&L contribution into Income Retained, so
`closingService.closePeriod()` yields a balanced `Fiscal_Closing` voucher and
P&L accounts read exactly 0.00 after close.

---

## 7. Voucher-type selection is now source-account aware

`expensePay`, `apPayment`, `arReceipt`, `ownerDrawings`, and `capitalDeposit`
previously hardcoded `Bank_Payment` / `Bank_Receipt` / `Cash_Receipt` even
when the counter-account was the cash till. They now derive the type from the
funding/receipt account (`paymentVoucherType` / `receiptVoucherType`):

* cash till `1.10.01.0001.0001` (or an account named "cash…") → `Cash_Payment`
  / `Cash_Receipt` (prefix `CP` / `CR`)
* anything else → `Bank_Payment` / `Bank_Receipt` (prefix `BP` / `BR`)

This affects **voucher numbering only** — every account, amount, and balance
is identical, so the Section 6 figures and all 87 verify assertions are
unaffected. `transferTillToBank()` intentionally stays `Bank_Receipt` (the
bank side receives).

---

## 8. Trial Balance column sign convention

The §6 Trial Balance must present `ΣDebit-column = ΣCredit-column`. The first
implementation drove the columns from each account's *normal balance*, which
made contra accounts (e.g. Accumulated Depreciation, Sales Returns) print on
the wrong side and broke `Equation 10`. `reportService.trialBalance()` now
splits rows by the **signed net (DR − CR)**, while `NetBalance` keeps the
normal-signed convention for COA/ledger display. Result: both columns are
exactly `90,283.33` and the column delta is `0.00`.

---

## 9. Test runner

`npm test` runs bare `node --test`. On this Node 24 / Windows combination
`node --test tests/` fails with `MODULE_NOT_FOUND`, so the directory argument
was dropped (the runner picks up `tests/*.test.js` automatically).

---

## 10. Renderer money formatter (`fmt` / `fmtNeg`)

`src/ui/app.js`'s documented contract is `123456 → "1,234.56"`, but the
implementation ran `.toFixed(2)` on the raw cent integer, so it rendered
`123,456.00` — every amount 100× too large. Fixed to scale cents
(`Math.floor(abs/100)` + `abs%100`) while keeping the exact signature:

```
fmt(100) → "1.00"      fmt(9028333) → "90,283.33"
fmtNeg(-23333) → "(233.33)"        fmt(0) → "0.00"
```

The 14 screen modules additionally probe the formatter they receive
(`fmt(100)` must contain `"1.00"`) and fall back to a local cents-scaler if
the probe fails, so screens are correct regardless.

---

## 11. Trial Balance screen reads the spec's column fields

`src/ui/trialBalance.js` looked up `Debit`/`Credit`/`totalDebit` on each row,
but `reportService.trialBalance()` returns `DebitColumn` / `CreditColumn`
(signed net, per §4.2.1) plus `TotalDebit` / `TotalCredit`. Every cell
therefore rendered `—` and the footer showed the gross ledger sums instead of
the published TB columns. The screen now reads `DebitColumn`/`CreditColumn`,
totals from `tbDebit`/`tbCredit`, Δ from `tbDelta`, and shows the gross
ledger Σ as a secondary meta line. Live output: cash `800.00`, bank
`48,400.00`, columns `90,283.33 = 90,283.33`, `Δ = $0.00`.

---

## 12. Shell smoke harness (`npm run smoke`)

`scripts/smokeShell.js` boots the real `index.html` + `preload.js` + kernel
in Electron, signs in through the actual login form (`admin`/`admin123`),
visits all 21 routes, clicks **Run** on Trial Balance / Income Statement /
Balance Sheet, and asserts: no placeholder screens, no failed screens, no
console or page errors, correct formatter output, TB `90,283.33` present, GP
`6,200.00`, assets `70,766.67`, and no 100× values. It additionally checks the
Debit Note form (14), the RBAC gate and confirmation dialogs (14-16), the
remaining engine screens (18), and runs
Phase 6 close/reopen/backup-restore against an isolated throwaway database.
**The exit code is now meaningful** — Electron otherwise always exits 0, so
failures were invisible to `&&`-chaining and CI; the harness forces the code via
`app.exit(bad === 0 ? 0 : 1)` after stdout flushes, and `SMOKE_FORCE_FAIL=1`
proves the failure path reports `exit=1`. Current status:
`SMOKE_SHELL PASS bad=0 exit=0`.

---

## 13. Debit Note screen (Section 7 Phase 4)

Phase 4 mandates a Debit Note form alongside the Credit Note; the kernel
`purchase.debitNote` existed but had no screen. Added `src/ui/debitNote.js`,
the `debit-note` nav button in `index.html`, and the `REMOTE_SCREENS` /
`ROUTE_TITLES` entries in `src/ui/app.js`. It posts
`purchase.debitNote { voucherDate, entityId, itemCode, qty, unitCostCents,
taxRate, narration, createdBy }` and shows the returned FIFO cost relieved from
stock in the receipt. Unit cost is prefilled from the item's `CostPrice` and
quantity is clamped to on-hand stock before the Post button enables.

---

## 14. RBAC enforcement at the IPC boundary (Phase 1)

`validationService.assertPermissions()` had no call sites. Added:

* `CAPABILITIES` — a kernel-method → capability map (post / reverse /
  manage_coa / run_reports / close_period / backup / export / configure) and
  `capabilityFor(method)`. Methods absent from the map are public so the shell
  can boot and the login screen can render.
* `Kernel.invoke()` calls `validationSvc.assertAuthorized(method, sessionRole)`
  before dispatching. **The role lives in the kernel**, set by `auth.login` and
  cleared by `auth.logout` — it is deliberately *not* read from the payload, so
  a caller cannot assert `role: 'Admin'`. A failed login clears any previous
  role first.
* `main.js` now routes every IPC call through `kernel.invoke()` instead of
  `kernel[method](args)`, so the gate cannot be bypassed. In-process callers
  (seeders, tests, the kernel's own posting pipelines) call services directly
  and are not gated — they are trusted code, and gating them would force a
  session onto the batch jobs.
* UI: `src/ui/app.js` gains `can()`, a `ROUTE_CAPABILITY` map, nav items hidden
  for capabilities the role lacks, and a route guard that bounces a restricted
  role to the dashboard with an explanatory toast. `login.js` picks a home route
  the role is actually allowed to open.

Covered by `tests/rbac.test.js` (15 tests) — including that a forged
`__role`/`role` payload field has no effect.

---

## 15. Error codes travel inside the message across the contextBridge

Electron's contextBridge clones a thrown `Error` keeping **only** `stack` and
`message`; `.code`, `.details` and `.name` are dropped before the renderer sees
them (verified: `Object.getOwnPropertyNames(err)` → `["stack","message"]`,
`err.name` → `"Error"`). So `preload.js` ships errors as `"CODE :: human text"`,
and `asError()` in `src/ui/app.js` splits the prefix off, restores `.code`, and
leaves the displayed toast message clean. Without this, every `FORBIDDEN`,
`CLOSED_PERIOD` and `UNBALANCED_VOUCHER` would arrive as an untyped error.

---

## 16. Confirmation dialog, backup restore, period reopen (Phase 6)

* **`window.confirm` is disabled in Electron** — it is present as a function but
  always returns `false`. The Close-period, Reopen-period and Restore-backup
  buttons therefore used a dialog that could only ever answer "no", i.e. they
  silently did nothing. Added a Promise-based `confirm(message, opts)` to
  `src/ui/app.js` (built on `modal()`; ✕ / overlay / Escape / Cancel all resolve
  `false`), exposed it through the screen context, and switched `closing.js` to
  it. `closing.js` still falls back to `window.confirm` in a standalone browser,
  but only trusts it when it answers `true`.
* **Period reopen** — `closing.reopenPeriod` worked but had no UI. Closed
  periods now render a **Reopen period** button next to the closed badge.
* **Backup restore** — `backup.list` / `backup.restore` were unused. The Closing
  screen now lists snapshots with size/date and a **Restore** button.
  `BackupService.restore()` previously left the database handle closed, which
  would have killed the kernel; `Database.reopen()` re-points the live wrapper at
  the restored file (statements are prepared per call, so no service holds a stale
  handle), drops stale `-wal`/`-shm` sidecars, and `kernel.backup.restore`
  re-applies migrations so an older snapshot catches up. **No restart required.**

The smoke harness exercises all three, serving a *synthetic* closed period
through a test-only `closing.status` override so no real period in the
case-study ledger is ever closed; the `reopenPeriod` call it makes lands on an
already-open period and is a documented no-op.

---

## 17. Case-study dates are anchored to the previous calendar month

`seedDemoData.js` originally dated the 15 vouchers `d(1)..d(15)` of the
**running** month. Every report screen defaults its as-of date to *today*, so
for the first ~14 days of any month the Trial Balance, Income Statement and
Balance Sheet silently excluded the vouchers dated later in that month: the
demo booted showing till `8,800.00` and bank `52,000.00` instead of `800.00`
and `48,400.00`, with gross profit missing entirely — while `npm run verify`
still passed, because it derives `asOf` from `MAX(VoucherDate)`.

The seed is now anchored on days 1-15 of the **previous** month, so every
voucher date is in the past on any day of the year and "as of today" always
equals the full Section 6 proof. This is what `npm run smoke` asserts, which
makes the regression visible instead of calendar-dependent.

While there, `d(day)` was building dates with `String(day).padStart(2, '0')`,
which for the Net-30 invoice's `dueDate: d(38)` produced the malformed
`2026-09-38`. It now does real date arithmetic, so out-of-range days roll over
into the following month.

---

## 18. Screens for engine-only capabilities

Several kernel capabilities had no dedicated form. Two already had UI — the
Inventory screen carried `inventory.shrinkage` from the start — but the rest
were reachable only through a generic journal entry:

| Capability | Where it lives now |
|---|---|
| `owner.drawings` | **tab 5** of the Payments hub (`paymentForm.js`) |
| `assets.register` / `assets.list` / `assets.runDepreciation` | new `src/ui/assetRegister.js` (3 tabs) |
| `forex.settle` / `forex.history` | new `src/ui/forexSettlement.js` (2 tabs) |
| `payroll.calculate` | live kernel cross-check line on the Payroll screen |
| shrinkage write-off value | dry run shown in the Physical-count dialog *before* posting |

Two read-only kernel methods back the dry runs: `inventory.previewFifoCost`
and `forex.preview`, both gated `run_reports`.

A preview that can disagree with the voucher it predicts is worse than no
preview — it shows the operator a confident wrong number. So neither is a
re-implementation: `inventory.shrinkage` already computed its write-off via
`previewFifoCost`, and `forex.preview` calls the same `convert()` that
`forex.settle` posts through. `tests/previewParity.test.js` (6 tests) pins the
identity for both a gain and a loss, including the FIFO layer breakdown
(5 @ 10.00 + 2 @ 12.00 = 74.00) and the Phase 1 gate on both methods.

The Payroll screen's local arithmetic is likewise only a convenience for fast
feedback — `payroll.disburse` is built by `payroll.calculate` — so the screen
re-asks the kernel on every settled keystroke and renders `Kernel ✓` when the
four figures agree, or the exact per-field drift in red when they do not. The
smoke asserts the agreeing case on the default form.

Routes: **19 → 21** (`fixed-assets`, `forex`); screens **20 → 22**.

---

## 19. Windows installer (packaged distribution)

Section 7 specifies an offline desktop shell but says nothing about how the
engine reaches a machine that does not have this repository. `npm run dist`
builds `release\ApexERP-Setup-3.0.0.exe` (electron-builder → NSIS, per-user,
x64, ~83 MB) with Start Menu and Desktop shortcuts and an uninstaller.

Four things had to change for packaging. None of them touch the ledger.

1. **The seeded ledger is baked at build time.** A packaged app has no Node
   CLI, so `npm run seed` does not exist on the target machine.
   `scripts/buildAppDb.js` runs the real seeder into `build/apex_erp.db`, then
   re-opens that file and asserts the published figures — TB columns
   90,283.33 = 90,283.33, assets 70,766.67, ledger/TB/balance-sheet deltas all
   0.00, 15 posted vouchers — and **fails the build** if any differ. It also
   proves the file is self-contained (no `-wal`/`-shm` sidecar survived the
   checkpoint). The file ships as an `extraResource`
   (`resources/seed/apex_erp.db`); `resolveDataPath()` copies it into
   `%APPDATA%\Apex ERP\apex_erp.db` on first open, via temp-file + `rename` and
   only when the target does not already exist, so an interrupted first run
   cannot leave a half-written ledger that the next launch would trust.

   Seeding at build time rather than on first launch also keeps every
   installation's numbers fixed. Seeding at runtime would reintroduce the
   drift §17 exists to prevent.

2. **`node:sqlite` carries the packaged app.** `better-sqlite3` is excluded
   from the package (`files` negation, `npmRebuild: false`) because its native
   binding is compiled for the system Node ABI, not Electron's. This is
   deviation §2's fallback doing exactly what it was written for: `loadDriver()`
   probes with a real statement rather than a bare `require`, the native load
   fails, and the engine opens through Electron's built-in SQLite. Nothing in
   `src/` knows the difference, and the build needs no compiler toolchain on
   the build machine.

3. **The database path is decided before the kernel loads.** The kernel is a
   module-load singleton (`const kernel = getKernel()`), and an installed build
   derives its path from `app.getPath('userData')`. So `main.js` sets
   `%APPDATA%\Apex ERP` *before* requiring the kernel, and `resolveDataPath()`
   skips the `<app.asar>/data` probe when running from the archive — asar is
   read-only, and failing there would only surface as a confusing `mkdir`
   error. Dev runs are untouched: they still resolve to the project's
   `data/apex_erp.db`.

4. **Single instance.** `app.requestSingleInstanceLock()` makes a second launch
   focus the existing window instead of opening a second process. Two writers
   on one SQLite file is legal under WAL, but it is never what the user meant.

Deliberately out of scope: code signing (no certificate on this machine, so
SmartScreen shows "Windows protected your PC"), auto-update, and macOS/Linux
targets (not cross-buildable from Windows).

---

## 20. Dashboard equilibrium proof: equity window + `classList` token (UI bugs)

Two defects surfaced when the screenshot tour (`npm run shots`) rendered the
dashboard. Both are renderer/engine bugs, not spec deviations — they are written
down because they changed published numbers.

**a) Equity dropped the unflushed result of every open period.**
`balanceSheet()` derived its P&L window from `defaultPeriodStart(asOfDate)` —
the *calendar month* containing the as-of date. On 2026-10-09 (a month after the
September case study, October still open and empty) that window was
`2026-10-01 → 2026-10-09`, so `netProfit` came out `0.00` while the September
loss of `233.33` was still sitting, unflushed, in the nominal accounts. Equity
landed at `59,000.00` instead of `58,766.67` and the dashboard raised a false
`OUT OF BALANCE` / `A − (L + E) = -233.33` alarm on a ledger whose trial
balance was perfect.

Fix: a new `ReportService.openPnlStart(asOfDate)` returns the opening of the
window whose result is *still in equity* — the day after the most recent
**closed** period, or the earliest defined period when nothing has been closed
yet. `balanceSheet()` and `dashboard()` both use it, so the KPI tiles, the
balance-sheet screen and `report.proof` now agree. The case-study figures are
unchanged (all activity sits in one period): assets `70,766.67` = liabilities
`12,000.00` + equity `58,766.67`, Δ `0.00`, and `proof.incomeStatement` still
reports `netRevenue 16,500.00`, `grossProfit 6,200.00`, `netProfit (233.33)` —
the same window `verify` §4.o/§6.e asserts. After a real `closePeriod` the
window moves past the closed period and the flushed result is picked up from
`Retained Earnings (3.20)` instead, so the identity survives closing too
(`tests/closing.test.js` proof assertion).

**b) One bad class string aborted the whole dashboard data load.**
`setTile()` called `value.classList.add(tone)` with `tone = 'badge badge-success'`.
`DOMTokenList.add()` rejects a token containing a space, so the promise rejected
at the net-profit tile: the equilibrium proof kept its em-dashes, "Recent
vouchers" stayed on *Loading recent activity…* and the card showed
`Could not read the ledger: Failed to execute 'add' on 'DOMTokenList'`. The tile
tones are now split on whitespace before they are added.

`scripts/smokeShell.js` gained a `dashboard` probe group (KPI tiles populated,
both proofs read `BALANCED`, no ledger error, recent vouchers rendered) so
neither regression can return silently, and `npm run shots` writes the
`docs/screenshots/*.png` tour used by the README.

---

## Verification

```
npm test      -> 86/86 pass, 0 fail  (65 baseline + 15 RBAC + 6 preview parity)
npm run verify -> 87/87 Section 6 assertions pass (exit 0)
npm run smoke  -> SMOKE_SHELL PASS bad=0 exit=0
                 (21 routes + dashboard proofs + live reports + RBAC + Phase 6 UI)
npm run seed -- --fresh -> 15 vouchers, TB 90,283.33 = 90,283.33, A-(L+E) = 0.00
npm run shots  -> 11 PNG -> docs/screenshots/ (the README tour)
npm run dist   -> release\ApexERP-Setup-3.0.0.exe (83.1 MB); build fails unless the
                 baked ledger is balanced (90,283.33 = 90,283.33, assets 70,766.67)
install audit  -> silent /S install, first launch copies the seed, close, uninstall:
                 npm run check:install -> CHECK OK 11/11 (TB 90,283.33 = 90,283.33,
                 assets 70,766.67, liabilities 12,000.00, equity 58,766.67, all deltas 0.00),
                 uninstaller removes the exe + both shortcuts and KEEPS the ledger
```
