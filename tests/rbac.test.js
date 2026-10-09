'use strict';

/**
 * Phase 1 - RBAC authentication wrapper.
 *
 *   • PERMISSIONS matrix  Admin / Accountant / Cashier
 *   • CAPABILITIES map    kernel method -> capability
 *   • kernel.invoke()     the IPC boundary that actually enforces the gate
 *   • session role        set by auth.login, cleared by auth.logout
 *
 * The gate lives in invoke() only: services are called directly by the
 * engine (seeders, closing, posting pipelines) and must not need a session.
 */

process.env.ERP_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getKernel } = require('../src/main/kernel');
const {
  PERMISSIONS, CAPABILITIES, capabilityFor, ValidationService,
} = require('../src/services/validationService');
const { ForbiddenError } = require('../src/core/errors');

const kernel = getKernel();
kernel.auth.bootstrap();

/* ------------------------------------------------------- the matrix */

test('the role capability matrix matches the spec (Phase 1)', () => {
  assert.deepEqual(PERMISSIONS.Admin, [
    'post', 'reverse', 'manage_coa', 'manage_users', 'run_reports', 'close_period', 'backup', 'export', 'configure',
  ]);
  assert.deepEqual(PERMISSIONS.Accountant, ['post', 'reverse', 'manage_coa', 'run_reports', 'close_period', 'backup', 'export']);
  assert.deepEqual(PERMISSIONS.Cashier, ['post', 'run_reports']);
});

test('every capability referenced by CAPABILITIES exists in PERMISSIONS', () => {
  const known = new Set(Object.values(PERMISSIONS).flat());
  for (const [method, capability] of Object.entries(CAPABILITIES)) {
    assert.ok(known.has(capability), `${method} needs unknown capability "${capability}"`);
  }
});

test('capabilityFor: public methods resolve to null, unknown methods too', () => {
  assert.equal(capabilityFor('auth.login'), null, 'login must stay public');
  assert.equal(capabilityFor('auth.bootstrap'), null, 'bootstrap must stay public');
  assert.equal(capabilityFor('coa.tree'), null, 'the shell needs the tree to render');
  assert.equal(capabilityFor('no.suchMethod'), null);
  assert.equal(capabilityFor('ledger.record'), 'post');
  assert.equal(capabilityFor('closing.closePeriod'), 'close_period');
  assert.equal(capabilityFor('backup.restore'), 'backup');
});

/* -------------------------------------------------- the session role */

test('auth.login sets the kernel session role and auth.logout clears it', async () => {
  assert.equal(kernel.sessionRole, null, 'starts anonymous');

  const user = await kernel.invoke('auth.login', { username: 'admin', password: 'admin123' });
  assert.equal(user.role, 'Admin');
  assert.equal(kernel.sessionRole, 'Admin');

  await kernel.invoke('auth.logout', {});
  assert.equal(kernel.sessionRole, null, 'logout drops the role');
});

test('a failed login never leaves a previous role behind', async () => {
  await kernel.invoke('auth.login', { username: 'admin', password: 'admin123' });
  assert.equal(kernel.sessionRole, 'Admin');
  assert.throws(() => kernel.auth.login({ username: 'admin', password: 'wrong' }));
  assert.equal(kernel.sessionRole, null, 'stale role cleared before credential check');
});

test('auth.session reports the live role and its permissions', async () => {
  await kernel.invoke('auth.login', { username: 'accountant', password: 'account123' });
  const session = await kernel.invoke('auth.session', {});
  assert.equal(session.role, 'Accountant');
  assert.ok(session.permissions.includes('close_period'));
  await kernel.invoke('auth.logout', {});
});

/* ------------------------------------------------------- enforcement */

test('anonymous callers are rejected for gated methods (fails closed)', async () => {
  await kernel.invoke('auth.logout', {});
  await assert.rejects(
    () => kernel.invoke('ledger.record', {}),
    (err) => err instanceof ForbiddenError && err.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => kernel.invoke('report.trialBalance', {}),
    (err) => err.code === 'FORBIDDEN',
  );
});

test('anonymous callers can still reach public methods', async () => {
  await kernel.invoke('auth.logout', {});
  const tree = await kernel.invoke('coa.tree', {});
  assert.ok(Array.isArray(tree) ? tree.length > 0 : Object.keys(tree).length > 0);
  const info = await kernel.invoke('system.info', {});
  assert.ok(info.dbPath, 'system.info is public introspection');
});

test('the role is taken from the kernel session, never the payload', async () => {
  await kernel.invoke('auth.login', { username: 'cashier', password: 'cash123' });
  // A forged role field in the arguments must have no effect.
  await assert.rejects(
    () => kernel.invoke('closing.closePeriod', { __role: 'Admin', role: 'Admin', periodId: 1 }),
    (err) => err.code === 'FORBIDDEN',
  );
  await kernel.invoke('auth.logout', {});
});

test('Cashier can post and report but cannot close, reverse, backup or manage the COA', async () => {
  await kernel.invoke('auth.login', { username: 'cashier', password: 'cash123' });

  // allowed
  assert.equal(await kernel.invoke('auth.can', { role: 'Cashier', capability: 'post' }), true);
  assert.equal(await kernel.invoke('auth.can', { role: 'Cashier', capability: 'run_reports' }), true);

  // denied at the gate
  for (const method of ['closing.closePeriod', 'closing.reopenPeriod', 'ledger.reverse', 'coa.add']) {
    await assert.rejects(() => kernel.invoke(method, {}), (err) => err.code === 'FORBIDDEN', method);
  }
  for (const method of ['backup.snapshot', 'backup.list', 'backup.restore']) {
    await assert.rejects(() => kernel.invoke(method, {}), (err) => err.code === 'FORBIDDEN', method);
  }

  // reporting stays open to Cashier
  const tb = await kernel.invoke('report.trialBalance', {});
  assert.ok(Array.isArray(tb.rows));
  await kernel.invoke('auth.logout', {});
});

test('Accountant can close and back up but cannot manage users or settings', async () => {
  await kernel.invoke('auth.login', { username: 'accountant', password: 'account123' });

  assert.equal(await kernel.invoke('auth.can', { role: 'Accountant', capability: 'close_period' }), true);
  assert.equal(await kernel.invoke('auth.can', { role: 'Accountant', capability: 'backup' }), true);
  assert.equal(await kernel.invoke('auth.can', { role: 'Accountant', capability: 'manage_users' }), false);

  for (const method of ['auth.users', 'system.setSetting']) {
    await assert.rejects(() => kernel.invoke(method, {}), (err) => err.code === 'FORBIDDEN', method);
  }
  await kernel.invoke('auth.logout', {});
});

test('Admin passes the gate for every capability', async () => {
  await kernel.invoke('auth.login', { username: 'admin', password: 'admin123' });
  for (const capability of PERMISSIONS.Admin) {
    assert.equal(kernel.validationSvc.assertPermissions('Admin', capability), true, capability);
  }
  const users = await kernel.invoke('auth.users', {});
  assert.ok(Array.isArray(users) && users.length >= 3, 'Admin can list users');
  await kernel.invoke('auth.logout', {});
});

test('assertAuthorized is a no-op for methods outside CAPABILITIES', () => {
  const v = kernel.validationSvc;
  assert.equal(v.assertAuthorized('auth.login', null), true);
  assert.equal(v.assertAuthorized('coa.tree', null), true);
  assert.equal(v.assertAuthorized('definitely.not.a.method', null), true);
  assert.throws(() => v.assertAuthorized('ledger.record', null), ForbiddenError);
});

test('a denial message names the role and the capability', () => {
  const err = new ForbiddenError('Cashier', 'close_period', 'closing.closePeriod');
  assert.equal(err.code, 'FORBIDDEN');
  assert.match(err.message, /Cashier/);
  assert.match(err.message, /close_period/);
  assert.match(err.message, /closing\.closePeriod/);
  assert.equal(err.details.method, 'closing.closePeriod');
});

test('ValidationService.assertPermissions still rejects unknown roles', () => {
  const v = new ValidationService(kernel.db, kernel.accountSvc);
  assert.throws(() => v.assertPermissions('Intern', 'post'), ForbiddenError);
  assert.throws(() => v.assertPermissions(null, 'post'), ForbiddenError);
  assert.equal(v.assertPermissions('Accountant', 'manage_coa'), true);
});
