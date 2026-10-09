'use strict';

/**
 * Sections 3.1 / 3.2 / 4.2 - the double-entry kernel itself:
 *   Invariant 1  zero-tolerance |SUM(DR) - SUM(CR)| == 0.00
 *   Invariant 2  postings land only on active Level-5 leaf accounts
 *   Invariant 4  append-only vouchers, corrections via reversal only
 */

process.env.ERP_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getKernel } = require('../src/main/kernel');
const { COA } = require('../src/services/coaSeed');

const kernel = getKernel();
kernel.auth.bootstrap();

const adminId = kernel.db.prepare("SELECT UserId FROM Users WHERE Role = 'Admin'").get().UserId;
const today = new Date().toISOString().slice(0, 10);

function post(lines, extra = {}) {
  return kernel.ledger.record({
    voucherDate: today,
    voucherType: 'General_JV',
    narration: 'unit test voucher',
    createdBy: adminId,
    lines,
    ...extra,
  });
}

function balance(accountCode) {
  return kernel.coa.balance({ accountCode, asOfDate: today }).netDebitMinusCredit;
}

/* ------------------------------------------------------------ the chart */

test('the canonical chart of accounts is seeded and structurally sound', () => {
  const accounts = kernel.coa.list({ activeOnly: false });
  assert.ok(accounts.length > 40, 'expected a full 5-level chart');

  for (const code of Object.values(COA)) {
    const account = kernel.coa.get({ accountCode: code });
    assert.ok(account, `COA constant ${code} must exist`);
    assert.equal(account.AccountCode, code);
  }

  // Invariant 2 precondition: only Level-5 accounts may be posting targets.
  for (const account of accounts.filter((a) => a.IsPostingAllowed)) {
    assert.equal(account.AccountLevel, 5, `${account.AccountCode} is posting-allowed but not Level 5`);
  }

  // Every parent must exist (referential integrity of the hierarchy).
  const codes = new Set(accounts.map((a) => a.AccountCode));
  for (const account of accounts) {
    if (account.ParentCode) assert.ok(codes.has(account.ParentCode), `${account.AccountCode} has an orphan parent`);
  }
});

/* --------------------------------------------------------- Invariant 1 */

test('Invariant 1: a balanced voucher posts with delta exactly 0.00', () => {
  const result = post([
    { accountCode: COA.BANK_MAIN, debit: 6000000, lineMemo: 'capital in' },
    { accountCode: COA.CAPITAL, credit: 6000000, lineMemo: 'owner equity' },
  ]);

  assert.equal(result.totalDebit, 6000000);
  assert.equal(result.totalCredit, 6000000);
  assert.equal(result.delta, 0);
  assert.match(result.voucherNo, /^JV-\d{6}-\d{4}$/);

  const header = kernel.ledger.get({ voucherId: result.voucherId });
  assert.equal(header.IsPosted, 1);
  assert.equal(header.TotalDebit, 6000000);
  assert.equal(header.TotalCredit, 6000000);
  assert.equal(header.lines.length, 2);
  assert.equal(balance(COA.BANK_MAIN), 6000000);
});

test('Invariant 1: a voucher that is one cent out is rejected', () => {
  assert.throws(
    () => post([
      { accountCode: COA.BANK_MAIN, debit: 1000 },
      { accountCode: COA.CAPITAL, credit: 999 },
    ]),
    (error) => /Unbalanced/.test(error.message) && /0\.00/.test(error.message),
  );
  // ...and nothing was written.
  assert.equal(
    kernel.db.prepare('SELECT COUNT(*) AS c FROM JournalVouchers WHERE Narration = ?').get('unit test voucher').c,
    1,
    'the rejected voucher must not have been recorded',
  );
});

test('Invariant 1: a completely unbalanced pair (10.00 vs 8.00) is rejected', () => {
  assert.throws(
    () => post([
      { accountCode: COA.BANK_MAIN, debit: 1000 },
      { accountCode: COA.CAPITAL, credit: 800 },
    ]),
    /Unbalanced/,
  );
});

/* --------------------------------------------------------- Invariant 2 */

test('Invariant 2: summary heads (Levels 1-4) cannot receive journal lines', () => {
  const summary = kernel.coa.list({ level: 2, activeOnly: true })[0];
  assert.ok(summary, 'expected at least one Level-2 summary head');
  assert.equal(summary.AccountLevel, 2);

  assert.throws(
    () => post([
      { accountCode: summary.AccountCode, debit: 100 },
      { accountCode: COA.BANK_MAIN, credit: 100 },
    ]),
    (error) => /Level 1 summary|POSTING_LEVEL|Level-5|leaf/i.test(error.message),
  );
});

test('Invariant 2: an unknown account code is rejected before anything is written', () => {
  assert.throws(
    () => post([
      { accountCode: '9.99.99.9999.9999', debit: 100 },
      { accountCode: COA.BANK_MAIN, credit: 100 },
    ]),
    /does not exist/,
  );
});

test('Invariant 2: an inactive account cannot be posted to', () => {
  const code = COA.ADVERTISING;
  const account = kernel.coa.get({ accountCode: code });
  assert.equal(account.IsActive, 1, 'test precondition: account starts active');

  kernel.db.prepare('UPDATE Accounts SET IsActive = 0 WHERE AccountCode = ?').run(code);
  try {
    assert.throws(
      () => post([
        { accountCode: code, debit: 100 },
        { accountCode: COA.BANK_MAIN, credit: 100 },
      ]),
      /POSTING_LEVEL|inactive|leaf/i,
    );
  } finally {
    kernel.db.prepare('UPDATE Accounts SET IsActive = 1 WHERE AccountCode = ?').run(code);
  }
});

/* ------------------------------------------------------- line structure */

test('a journal line cannot carry a debit and a credit at the same time', () => {
  assert.throws(
    () => post([
      { accountCode: COA.BANK_MAIN, debit: 100, credit: 100 },
      { accountCode: COA.CAPITAL, credit: 100 },
    ]),
    /both a debit and a credit/,
  );
});

test('a journal line must carry a non-zero amount', () => {
  assert.throws(
    () => post([
      { accountCode: COA.BANK_MAIN, debit: 0 },
      { accountCode: COA.CAPITAL, credit: 0 },
    ]),
    /non-zero/,
  );
});

test('a voucher needs at least one debit and one credit', () => {
  assert.throws(
    () => post([{ accountCode: COA.BANK_MAIN, debit: 100 }]),
    /at least two lines/,
  );
});

test('amounts must be integer cents (Invariant 3 at the API boundary)', () => {
  assert.throws(
    () => post([
      { accountCode: COA.BANK_MAIN, debit: 10.5 },
      { accountCode: COA.CAPITAL, credit: 10.5 },
    ]),
    /integer cents/,
  );
});

test('a posting date with no covering fiscal period is rejected', () => {
  assert.throws(
    () => post([
      { accountCode: COA.BANK_MAIN, debit: 100 },
      { accountCode: COA.CAPITAL, credit: 100 },
    ], { voucherDate: '1999-01-01' }),
    /No fiscal period covers/,
  );
});

/* --------------------------------------------------------- Invariant 4 */

test('Invariant 4: a posted voucher header cannot be altered or deleted', () => {
  const voucher = post([
    { accountCode: COA.RENT, debit: 240000 },
    { accountCode: COA.BANK_MAIN, credit: 240000 },
  ]);

  assert.throws(
    () => kernel.db.prepare('UPDATE JournalVouchers SET Narration = ? WHERE VoucherId = ?')
      .run('tampered', voucher.voucherId),
    /IMMUTABILITY_VIOLATION/,
  );
  assert.throws(
    () => kernel.db.prepare('DELETE FROM JournalVouchers WHERE VoucherId = ?').run(voucher.voucherId),
    /IMMUTABILITY_VIOLATION/,
  );

  const frozen = kernel.ledger.get({ voucherId: voucher.voucherId });
  assert.equal(frozen.Narration, 'unit test voucher');
});

test('Invariant 4: no line may be appended to a committed voucher', () => {
  const voucher = post([
    { accountCode: COA.UTILITIES, debit: 45000 },
    { accountCode: COA.BANK_MAIN, credit: 45000 },
  ]);
  assert.throws(
    () => kernel.db.prepare(`
      INSERT INTO JournalVoucherLines (VoucherId, AccountId, Debit, Credit, LineMemo)
      VALUES (?, (SELECT AccountId FROM Accounts WHERE AccountCode = ?), 1, 0, 'late line')
    `).run(voucher.voucherId, COA.ADVERTISING),
    /already committed/,
  );
});

test('Invariant 4: reversal APPENDS a mirroring contra-voucher', () => {
  const bankBefore = balance(COA.BANK_MAIN);
  const original = post([
    { accountCode: COA.ADVERTISING, debit: 100000 },
    { accountCode: COA.BANK_MAIN, credit: 100000 },
  ]);
  assert.equal(balance(COA.BANK_MAIN), bankBefore - 100000);

  const reversal = kernel.ledger.reverse({
    voucherId: original.voucherId, reason: 'wrong account', createdBy: adminId,
  });

  assert.notEqual(reversal.voucherId, original.voucherId);
  assert.equal(reversal.totalDebit, original.totalDebit);
  assert.equal(reversal.totalCredit, original.totalCredit);

  const header = kernel.ledger.get({ voucherId: reversal.voucherId });
  assert.equal(header.IsReversal, 1);
  assert.equal(header.ReversesVoucherId, original.voucherId);
  assert.match(header.Narration, /^REVERSAL of /);

  // The original is untouched (append-only), and every balance nets back to
  // exactly where it was before the original voucher was posted.
  const untouched = kernel.ledger.get({ voucherId: original.voucherId });
  assert.equal(untouched.Narration, 'unit test voucher');
  assert.equal(untouched.IsPosted, 1);
  assert.equal(balance(COA.ADVERTISING), 0);
  assert.equal(balance(COA.BANK_MAIN), bankBefore);
});

test('Invariant 4: a voucher (or its reversal) can never be reversed twice', () => {
  const original = post([
    { accountCode: COA.ADVERTISING, debit: 50000 },
    { accountCode: COA.BANK_MAIN, credit: 50000 },
  ]);
  const reversal = kernel.ledger.reverse({ voucherId: original.voucherId, createdBy: adminId });

  assert.throws(() => kernel.ledger.reverse({ voucherId: original.voucherId, createdBy: adminId }),
    /immutable/i);
  assert.throws(() => kernel.ledger.reverse({ voucherId: reversal.voucherId, createdBy: adminId }),
    /already a reversal/i);
});

/* --------------------------------------------------------- ledger card */

test('Section 4.2.3 - the ledger card runs a correct opening/closing balance', () => {
  const code = COA.SHRINKAGE;
  const before = balance(code);

  post([{ accountCode: code, debit: 1234 }, { accountCode: COA.BANK_MAIN, credit: 1234 }]);
  post([{ accountCode: code, debit: 5678 }, { accountCode: COA.BANK_MAIN, credit: 5678 }]);

  const card = kernel.ledger.ledgerCard({ accountCode: code });
  assert.equal(card.account.AccountCode, code);
  assert.equal(card.entries.length, 2);
  assert.equal(card.totalDebit, 1234 + 5678);
  assert.equal(card.totalCredit, 0);
  assert.equal(card.closingBalance, before + 1234 + 5678);
  assert.equal(card.closingBalance, balance(code));
  assert.equal(card.entries[0].RunningBalance, before + 1234);
  assert.equal(card.entries[1].RunningBalance, before + 1234 + 5678);
});

test('every posted voucher in the database satisfies the zero-tolerance rule', () => {
  const offenders = kernel.db.prepare(`
    SELECT v.VoucherNo,
           ABS(COALESCE(SUM(l.Debit), 0) - COALESCE(SUM(l.Credit), 0)) AS delta
      FROM JournalVouchers v
      JOIN JournalVoucherLines l ON l.VoucherId = v.VoucherId
     WHERE v.IsPosted = 1
     GROUP BY v.VoucherId
    HAVING delta > 0
  `).all();
  assert.deepEqual(offenders, []);

  const nonLeaf = kernel.db.prepare(`
    SELECT COUNT(*) AS c
      FROM JournalVoucherLines l
      JOIN Accounts a ON a.AccountId = l.AccountId
     WHERE a.AccountLevel <> 5 OR a.IsPostingAllowed = 0 OR a.IsActive = 0
  `).get().c;
  assert.equal(nonLeaf, 0);

  const gross = kernel.report.trialBalance({ asOfDate: today });
  assert.equal(gross.delta, 0, 'gross ledger delta must be exactly 0');
  assert.equal(gross.tbDelta, 0, 'trial-balance column delta must be exactly 0');
  assert.equal(gross.tbDebit, gross.tbCredit);
});
