/**
 * Apex ERP — login screen.
 *
 * Calls `auth.login`, stores the result on `state.user`, then routes to the
 * Discovery Wizard when the account tree is empty, otherwise to the
 * Chart of Accounts screen.
 */

import { el, call, state, go, toast, setUser, can } from './app.js';

/** Users seeded by `auth.bootstrap` (docs/API_CONTRACT.md §auth). */
const SEEDED_USERS = [
  { username: 'admin', password: 'admin123', role: 'Administrator', desc: 'full access, period close & backup' },
  { username: 'accountant', password: 'account123', role: 'Accountant', desc: 'COA, journals, reports' },
  { username: 'cashier', password: 'cash123', role: 'Cashier', desc: 'POS, receipts, invoices' },
];

/**
 * True when `coa.tree` returns no root nodes (fresh database → wizard).
 * Any failure is toasted by `call()` and treated as "needs setup".
 * @returns {Promise<boolean>}
 */
async function accountTreeIsEmpty() {
  try {
    const payload = await call('coa.tree', {});
    const list = Array.isArray(payload)
      ? payload
      : (payload && (payload.nodes || payload.roots || payload.tree)) || [];
    return list.length === 0;
  } catch (_err) {
    return true;
  }
}

/**
 * Render the login screen into `container` (module default export).
 * @param {HTMLElement} container
 */
export default function render(container) {
  const usernameInput = el('input', {
    class: 'input',
    id: 'login-username',
    name: 'username',
    type: 'text',
    autocomplete: 'username',
    placeholder: 'e.g. admin',
    required: true,
  });
  const passwordInput = el('input', {
    class: 'input',
    id: 'login-password',
    name: 'password',
    type: 'password',
    autocomplete: 'current-password',
    placeholder: 'Your password',
    required: true,
  });
  const errorLine = el('p', { class: 'error-text', id: 'login-error' });

  const submitBtn = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Sign in' });

  async function submit(event) {
    event.preventDefault();
    errorLine.textContent = '';
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
      errorLine.textContent = 'Enter both username and password.';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in\u2026';
    try {
      const user = await call('auth.login', { username, password });
      if (!user) {
        errorLine.textContent = 'Login returned no user record.';
        return;
      }
      setUser({ ...user, username: user.username || username });
      toast(`Welcome back, ${state.user.username} \u00b7 ${state.user.role || 'signed in'}`, 'success');
      // Home route by capability: the wizard/COA need manage_coa, so a role
      // without it (Cashier) lands on the dashboard instead.
      const route = !can('manage_coa') ? 'dashboard' : ((await accountTreeIsEmpty()) ? 'wizard' : 'coa');
      await go(route);
    } catch (err) {
      errorLine.textContent = (err && err.message) || 'Sign in failed.';
      passwordInput.value = '';
      passwordInput.focus();
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  }

  const form = el(
    'form',
    { class: 'login-form', onsubmit: submit },
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'login-username' }, 'Username'),
      usernameInput
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'login-password' }, 'Password'),
      passwordInput
    ),
    errorLine,
    submitBtn
  );

  // Role hint table with one-click "use" autofill per seeded account.
  const hintRows = SEEDED_USERS.map((u) =>
    el(
      'tr',
      {},
      el('td', {}, u.username),
      el('td', { class: 'mono' }, u.password),
      el('td', {}, `${u.role} — ${u.desc}`),
      el(
        'td',
        { class: 'right' },
        el('button', {
          class: 'btn-link',
          type: 'button',
          text: 'use',
          onclick: () => {
            usernameInput.value = u.username;
            passwordInput.value = u.password;
            passwordInput.focus();
          },
        })
      )
    )
  );

  const hint = el(
    'div',
    { class: 'role-hint' },
    el('p', { class: 'role-hint-title' }, 'Seeded demo accounts'),
    el('table', {}, el('tbody', {}, hintRows))
  );

  const seedBtn = el('button', { class: 'btn-link', type: 'button', text: 'Initialise database (seed)' });
  seedBtn.addEventListener('click', async () => {
    seedBtn.disabled = true;
    seedBtn.textContent = 'Seeding\u2026';
    try {
      const result = await call('auth.bootstrap', {});
      const users = result && result.users;
      const accounts = result && result.accounts;
      const periods = result && result.periods;
      const counts = [users, accounts, periods]
        .map((v) => (Array.isArray(v) ? v.length : v))
        .filter((v) => v !== undefined && v !== null);
      toast(
        counts.length ? `Database seeded \u2014 ${counts.join(' / ')} records` : 'Database seeded (idempotent)',
        'success'
      );
    } catch (err) {
      // toast already shown by call()
      void err;
    } finally {
      seedBtn.disabled = false;
      seedBtn.textContent = 'Initialise database (seed)';
    }
  });

  container.appendChild(
    el(
      'section',
      { class: 'screen login-screen' },
      el(
        'div',
        { class: 'card login-card' },
        el(
          'div',
          { class: 'login-hero' },
          el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'A'),
          el('h1', {}, 'Apex ERP'),
          el('p', { class: 'subtitle' }, 'Autonomous COA & General Ledger Engine \u00b7 offline desktop')
        ),
        form,
        hint,
        el(
          'div',
          { class: 'login-foot' },
          el('span', {}, 'No account? '),
          seedBtn
        )
      )
    )
  );

  usernameInput.focus();
}
