# Kernel API Contract (Electron IPC surface)

All amounts crossing this boundary are **integer cents** (Invariant 3). The renderer
formats them; the kernel never returns floats for money. Dates are `YYYY-MM-DD`.

Transport: `window.erp.invoke(method, args)` → `Promise<any>` (preload),
backed by `ipcMain.handle('erp:invoke', …)` → `kernel.invoke(method, args)`.

**RBAC gate.** `kernel.invoke()` is the *only* entry point the renderer has, and it
checks every method against `CAPABILITIES[method]` (see
`src/services/validationService.js`) using the **kernel-owned session role** — set by a
successful `auth.login`, cleared by `auth.logout`. The role is never taken from the
payload, so a caller cannot assert one. Methods with no entry in `CAPABILITIES` are
public (`auth.login`, `auth.bootstrap`, `coa.tree`, `system.info`, …) so the shell can
boot and the login screen can render. In-process callers (seeders, tests, the posting
pipelines inside the kernel) call services directly and are not gated.

Rejected promises carry `{ code, message, details }` where `code` is one of:
`UNBALANCED_VOUCHER`, `POSTING_LEVEL_VIOLATION`, `IMMUTABILITY_VIOLATION`,
`INSUFFICIENT_STOCK`, `CLOSED_PERIOD`, `AUTH_FAILED`, `VALIDATION_ERROR`, `NOT_FOUND`,
`FORBIDDEN`.

**Error codes cross the contextBridge inside the message.** Electron's contextBridge
clone of a thrown `Error` preserves only `stack` and `message` — `.code`, `.details`
and even `.name` are dropped. The preload therefore ships errors as
`"CODE :: human text"`; `asError()` in `src/ui/app.js` splits the prefix back off,
restores `.code`, and leaves the displayed message clean.

## system
| method | args | returns |
|---|---|---|
| `system.info` | – | `{ driver, dbPath, version, schemaVersion }` |
| `system.settings` | – | `Record<string,string>` |
| `system.setSetting` | `{ key, value }` | `ok` |

## auth (Phase 1)
| method | args | returns |
|---|---|---|
| `auth.bootstrap` | – | `{ users, accounts, periods }` – idempotent seed: admin/accountant/cashier users, canonical COA, fiscal periods |
| `auth.login` | `{ username, password }` | `{ userId, username, role, permissions }` – also stores the session role in the kernel |
| `auth.logout` | – | `{ loggedOut: true }` – clears the session role; gated methods then fail closed |
| `auth.session` | – | `{ role, permissions }` – the live session, or `{ role: null, permissions: [] }` |
| `auth.permissions` | `{ role }` | `string[]` |

## coa (Phase 2)
| method | args | returns |
|---|---|---|
| `coa.tree` | `{ search? }` | nested `[{ AccountCode, AccountName, AccountLevel, RootType, NormalBalance, IsPostingAllowed, balance, children[] }]` |
| `coa.list` | `{ postingOnly?, search?, level? }` | flat account rows |
| `coa.nextChildCode` | `{ parentCode }` | `"6.10.01.0001.0002"` |
| `coa.add` | `{ name, parentCode, isContra?, description? }` | new account row |
| `coa.balance` | `{ accountCode, asOfDate?, includeChildren? }` | `{ totalDebit, totalCredit, balance }` |
| `wizard.generate` | `{ answers }` | `{ added: string[], tree }` – deterministic COA extension from the 7-step questionnaire |

## ledger (Phase 3)
| method | args | returns |
|---|---|---|
| `ledger.record` | `{ voucherDate, voucherType, narration, referenceNo?, createdBy, sourceModule?, lines: [{ accountCode \| accountId, debit, credit, lineMemo?, entityId? }] }` | `{ voucherId, voucherNo, totalDebit, totalCredit, delta, lines }` |
| `ledger.reverse` | `{ voucherId, voucherDate?, reason?, createdBy? }` | new (mirrored) voucher |
| `ledger.get` | `{ voucherId }` | header + lines |
| `ledger.list` | `{ from?, to?, voucherType?, limit? }` | headers |
| `ledger.ledgerCard` | `{ accountCode, from?, to?, openingBalance? }` | `{ account, entries[], openingBalance, closingBalance, totalDebit, totalCredit }` (running balance per §4.2.3) |
| `ledger.grossTotals` | `{ asOfDate? }` | `{ totalDebit, totalCredit }` |

## inventory (FIFO, §3.3)
| method | args | returns |
|---|---|---|
| `inventory.items` | – | rows with `CurrentStock`, `SellingPrice` |
| `inventory.createItem` | `{ itemCode, itemName, sellingPrice, costPrice?, currentStock?, reorderLevel? }` | row |
| `inventory.lots` | `{ itemCode }` | FIFO queue `[{ LotId, QtyRemaining, UnitCost, ReceiptDate }]` |
| `inventory.valuation` | `{ itemCode }` | `{ qty, valueCents, avgCostCents }` |
| `inventory.shrinkage` | `{ voucherDate, itemCode, countedQty, expenseAccountCode?, createdBy }` | voucher (§3.3.3) |

Dry run of the write-off: see `inventory.previewFifoCost` under *dry runs* below.

## documents (Phase 4 – posting matrix §5)
Every method returns `{ voucher, meta }` where `voucher` is the ledger result.

| method | args |
|---|---|
| `pos.sale` | `{ voucherDate, itemCode, qty, unitPriceCents, taxRate?, discountRate?, priceIncludesTax?, tender: 'Cash'\|'Credit', entityId?, accountCode?, createdBy }` |
| `sales.invoice` | `{ voucherDate, itemCode, qty, unitPriceCents, taxRate?, discountRate?, priceIncludesTax?, entityId, dueDate?, createdBy }` |
| `sales.creditNote` | `{ voucherDate, itemCode, qty, unitPriceCents, taxRate?, priceIncludesTax?, entityId, reason?, createdBy }` |
| `purchase.bill` | `{ voucherDate, entityId, lines: [{ itemCode, qty, unitCostCents }], taxRate?, freightCents?, freightFromAccountCode?, createdBy }` |
| `purchase.debitNote` | `{ voucherDate, entityId, itemCode, qty, unitCostCents, taxRate?, createdBy }` |
| `ar.receipt` | `{ voucherDate, entityId, amountCents, accountCode, memo?, createdBy }` |
| `ap.payment` | `{ voucherDate, entityId, amountCents, accountCode, memo?, createdBy }` |
| `expense.pay` | `{ voucherDate, accountCode, amountCents, paidFromAccountCode, memo, createdBy }` |
| `capital.deposit` | `{ voucherDate, amountCents, accountCode, memo?, createdBy }` |
| `transfer.tillToBank` | `{ voucherDate, amountCents, accountCode, createdBy }` |
| `payroll.disburse` | `{ voucherDate, baseCents, overtimeHours, hourlyRateCents, allowancesCents?, taxWithheldCents?, pensionRate?, accountCode, entityId?, createdBy }` |
| `assets.register` | `{ voucherDate, assetCode, assetName, costCents, salvageCents, usefulLifeYears, method?, accountCode?, createdBy }` |
| `assets.runDepreciation` | `{ voucherDate, createdBy }` |
| `forex.settle` | `{ voucherDate, invoiceVoucherId, foreignAmountCents, currencyCode, originalRate, settlementRate, accountCode, createdBy }` |

## dry runs (read-only previews)

Both share their arithmetic with the posting they predict — `inventory.shrinkage`
computes its write-off *through* `inventory.previewFifoCost`, and `forex.preview`
converts with the same `convert()` that `forex.settle` posts — so the figure shown
before committing cannot drift from the figure booked
(`tests/previewParity.test.js`). Gated `run_reports`; no writes.

| method | args | returns |
|---|---|---|
| `inventory.previewFifoCost` | `{ itemCode, qty }` | `{ costCents, layers: [{ lotId, qty, valueCents }], qty }` |
| `forex.preview` | `{ foreignAmountCents, originalRate, settlementRate }` | `{ foreignAmountCents, origValueCents, settleValueCents, deltaCents, direction: 'GAIN'\|'LOSS'\|'NEUTRAL' }` |

## reports (Phase 5)
| method | args | returns |
|---|---|---|
| `report.trialBalance` | `{ asOfDate?, asOfDateEnd? }` | `{ rows[], totalDebit, totalCredit, delta, tbDebit, tbCredit }` |
| `report.incomeStatement` | `{ from, to }` | `{ grossSales, returns, discounts, netRevenue, cogs, grossProfit, grossMarginPct, opex[], operatingIncome, financeCosts, otherIncome, netProfit, lines[] }` |
| `report.balanceSheet` | `{ asOfDate }` | `{ currentAssets[], nonCurrentAssets[], totalAssets, currentLiabilities[], longTermLiabilities[], totalLiabilities, equity[], totalEquity, delta }` |
| `report.proof` | `{ from, to }` | `{ trialBalance: {debits, credits, delta}, balanceSheet: {assets, liabilities, equity, delta}, incomeStatement: {netProfit} }` |
| `report.entities` | – | customers/vendors with `CurrentBalance` |

## closing / backup / export (Phase 6)
| method | args | returns |
|---|---|---|
| `closing.status` | – | periods with `IsClosed` |
| `closing.closePeriod` | `{ periodId, createdBy }` | `{ voucher, period }` – flushes nominal accounts into Retained Earnings (§3.10) |
| `closing.reopenPeriod` | `{ periodId, createdBy }` | `{ reopened, period }` – unlocks a period for corrections; no-op when already open |
| `backup.snapshot` | `{ targetPath? }` | `{ path, bytes, verified }` |
| `backup.dumpJson` | `{ targetPath? }` | `{ path, records }` |
| `backup.list` | – | `[{ name, path, bytes, createdAt }]` – newest first, for the restore catalogue |
| `backup.restore` | `{ sourcePath }` | `{ restored, path, previous, reopened }` – current DB is copied aside (`…replaced_<stamp>`), snapshot copied in, WAL sidecars dropped, handle reopened and migrations re-applied. No restart needed. |
| `export.workbook` | `{ kind, params, targetPath? }` | `{ path }` – `kind` ∈ `trialBalance`\|`incomeStatement`\|`balanceSheet`\|`ledgerCard`\|`journal` (xlsx) |
| `export.pdf` | `{ kind, params, targetPath? }` | `{ path }` |

## UI screens (Section 7 file map)
`src/ui/login.js`, `wizard.js`, `coaTree.js`, `journalVoucher.js`, `posForm.js`,
`salesInvoice.js`, `creditNote.js`, `purchaseBill.js`, `debitNote.js`,
`receiptForm.js`, `paymentForm.js`, `payrollForm.js`, `expenseForm.js`,
`inventoryScreen.js`, `assetRegister.js`, `forexSettlement.js`,
`trialBalance.js`, `incomeStatement.js`, `balanceSheet.js`, `ledgerCard.js`,
`closing.js`.
Shell: `src/ui/app.js` + `src/ui/styles.css`, loaded by `index.html`.

Beyond the route list, three screens carry extra capability inside an existing
surface: `paymentForm.js` tab 5 posts `owner.drawings`; `payrollForm.js` re-asks
`payroll.calculate` on every settled edit and shows `Kernel ✓` (or the exact
per-field drift) so the preview can never disagree with the posted voucher;
`inventoryScreen.js` shows `inventory.previewFifoCost` inside the Physical-count
dialog before the adjustment is committed.
