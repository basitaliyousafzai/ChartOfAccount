/**
 * Apex ERP — renderer shell (ES module router + shared screen helpers).
 *
 * Owns: session state, navigation (left rail → #view), defensive screen
 * loading (other screen modules are imported dynamically and degrade to a
 * placeholder if absent), and the helpers every screen re-uses:
 *   fmt / fmtNeg (integer cents → strings), el, modal / closeModal,
 *   toast, call (guarded window.erp.invoke).
 */

/* --------------------------------------------------- static (owned) screens */
import loginScreen from './login.js';
import wizardScreen from './wizard.js';
import coaScreen from './coaTree.js';

/* ------------------------------------------------------------ session state */
/** Shared session object. `user` is `{ userId, username, role } | null`. */
export const state = { user: null, route: null };

/* ------------------------------------------------------------ formatting */

/**
 * Format integer cents as an accounting string: 123456 → "1,234.56".
 * @param {number} cents
 * @returns {string}
 */
export function fmt(cents) {
  const value = Math.round(Number(cents) || 0);
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = String(Math.floor(abs / 100));
  const dec = String(abs % 100).padStart(2, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${dec}`;
}

/**
 * Accounting-style format: negatives in parentheses → "(1,234.56)",
 * zero/positive rendered plain. Pass deltas, drawings, contra balances.
 * @param {number} cents
 * @returns {string}
 */
export function fmtNeg(cents) {
  const value = Math.round(Number(cents) || 0);
  return value < 0 ? `(${fmt(-value)})` : fmt(value);
}

/* ----------------------------------------------------------- DOM helper */

/** Append children (nodes, arrays, primitives; skip null/undefined/false). */
function appendChildren(node, children) {
  const flat = Array.isArray(children) ? children.flat(Infinity) : [children];
  for (const child of flat) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * Tiny DOM builder.
 * el('div', { class: 'card', onclick: fn }, child1, [child2, child3])
 * Reserved keys: class, text, html, style (object), dataset (object),
 * on<Event> (function). Every other key is set as an attribute.
 * @param {string} tag
 * @param {object|null} attrs
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  const a = attrs || {};
  for (const key of Object.keys(a)) {
    const v = a[key];
    if (v === null || v === undefined || v === false) continue;
    if (key === 'class') node.className = v;
    else if (key === 'text') node.textContent = String(v);
    else if (key === 'html') node.innerHTML = v;
    else if (key === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (key === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (/^on[a-z]+$/i.test(key) && typeof v === 'function') node.addEventListener(key.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(v));
  }
  appendChildren(node, children);
  return node;
}

/* -------------------------------------------------------------- modal */

/** @type {HTMLElement|null} */
let modalEl = null;
let modalGeneration = 0;
let escapeHandler = null;

/**
 * Open a modal dialog over the shell.
 * `actions`: [{ label, kind?, onClick? }] — clicking runs onClick; the modal
 * closes afterwards unless onClick returns false or it opened/closed a modal
 * itself. An action without onClick simply closes the dialog.
 * @param {{title?:string, body?:Node|string|Array<Node>, actions?:Array<object>, size?:string}} opts
 * @returns {HTMLElement} the overlay element
 */
export function modal({ title, body, actions = [], size = '' } = {}) {
  closeModal();
  modalGeneration += 1;
  const generation = modalGeneration;

  const overlay = el('div', {
    class: 'modal-overlay',
    onclick: (e) => {
      if (e.target === overlay) closeModal();
    },
  });
  const box = el('div', {
    class: `modal-box${size ? ' ' + size : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title || 'Dialog',
  });

  box.appendChild(
    el(
      'div',
      { class: 'modal-head' },
      el('span', { class: 'modal-title' }, title || ''),
      el('button', {
        class: 'modal-close',
        type: 'button',
        'aria-label': 'Close dialog',
        text: '\u00d7',
        onclick: () => closeModal(),
      })
    )
  );

  const bodyEl = el('div', { class: 'modal-body' });
  if (body instanceof Node) bodyEl.appendChild(body);
  else if (Array.isArray(body)) body.forEach((n) => n instanceof Node && bodyEl.appendChild(n));
  else if (body !== null && body !== undefined) bodyEl.textContent = String(body);
  box.appendChild(bodyEl);

  if (actions.length) {
    const foot = el('div', { class: 'modal-foot' });
    for (const action of actions) {
      const btn = el('button', {
        class: action.kind || 'btn btn-ghost',
        type: 'button',
        text: action.label,
        disabled: action.disabled === true,
      });
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        let result;
        try {
          result = action.onClick ? await action.onClick() : undefined;
        } catch (err) {
          const e = asError(err);
          if (!e.__toasted) toast(e.message, 'error');
          return;
        }
        if (result === false) return;
        // Only close if the handler did not swap in another modal itself.
        if (generation === modalGeneration) closeModal();
      });
      foot.appendChild(btn);
    }
    box.appendChild(foot);
  }

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  escapeHandler = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', escapeHandler);

  const focusable = box.querySelector('input, select, textarea, button.btn-primary') || box;
  if (focusable.focus) focusable.focus();

  modalEl = overlay;
  return overlay;
}

/** Close the open modal, if any. */
export function closeModal() {
  if (!modalEl) return;
  const node = modalEl;
  modalEl = null;
  modalGeneration += 1;
  node.classList.remove('open');
  setTimeout(() => node.remove(), 160);
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler);
    escapeHandler = null;
  }
}

/* ------------------------------------------------------------ confirm */

/**
 * Promise-based confirmation dialog built on {@link modal}.
 *
 * Electron disables the synchronous `window.confirm` (it always returns
 * `false`), so destructive actions must not rely on it — otherwise "Close
 * period", "Reopen period" and "Restore backup" silently do nothing.
 *
 * Resolves `true` only when the confirm button is pressed; ✕, overlay click,
 * Escape and the cancel button all resolve `false`.
 *
 * @param {string} message body text
 * @param {object} [opts] `{ title, confirmLabel, cancelLabel, danger }`
 * @returns {Promise<boolean>}
 */
export function confirm(message, opts = {}) {
  const {
    title = 'Please confirm',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
  } = opts || {};

  return new Promise((resolve) => {
    let settled = false;
    let watch = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (watch !== null) clearInterval(watch);
      resolve(value);
    };

    const overlay = modal({
      title,
      body: el('p', { class: 'confirm-message' }, String(message ?? '')),
      actions: [
        { label: cancelLabel, kind: 'btn btn-ghost', onClick: () => finish(false) },
        {
          label: confirmLabel,
          kind: danger ? 'btn btn-danger btn-primary' : 'btn btn-primary',
          onClick: () => finish(true),
        },
      ],
    });

    // ✕ / overlay click / Escape all tear the node down without running an
    // action, which must count as "cancelled".
    watch = setInterval(() => {
      if (!document.body.contains(overlay)) finish(false);
    }, 60);
  });
}

/* -------------------------------------------------------------- toast */

const TOAST_ICONS = { info: '\u2139', success: '\u2713', error: '\u2715', warn: '\u26a0' };

/**
 * Bottom-right notification. kind: 'info' | 'success' | 'error' | 'warn'.
 * @param {string} message
 * @param {string} [kind]
 */
export function toast(message, kind = 'info') {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  while (stack.children.length >= 5) stack.removeChild(stack.firstElementChild);

  const node = el(
    'div',
    { class: `toast ${kind}`, role: 'status' },
    el('span', { class: 'toast-icon' }, TOAST_ICONS[kind] || TOAST_ICONS.info),
    el('span', { class: 'toast-msg', text: String(message === undefined || message === null ? '' : message) })
  );

  const timer = setTimeout(() => dismiss(), kind === 'error' ? 7000 : 4200);
  function dismiss() {
    clearTimeout(timer);
    if (!node.isConnected) return;
    node.classList.add('hide');
    setTimeout(() => node.remove(), 260);
  }
  node.addEventListener('click', dismiss);
  stack.appendChild(node);
}

/* --------------------------------------------------------- IPC wrapper */

/** `CODE :: text` envelope written by preload.js — the only channel the
 *  contextBridge lets through for a thrown Error (it drops .code/.details). */
const BRIDGE_ENVELOPE = /^([A-Z][A-Z0-9_]{2,}) :: ([\s\S]*)$/;

/**
 * Normalise any thrown value into an Error carrying `.code`/`.details`.
 *
 * Errors arriving from the IPC bridge arrive as cross-realm clones whose only
 * surviving fields are `stack` and `message`, so the kernel error code is
 * recovered from the `CODE :: text` prefix (and stripped again for display).
 */
function asError(err) {
  const src = err && typeof err === 'object' ? err : null;
  const rawMsg = src && typeof src.message === 'string' ? src.message : String(err);
  const m = BRIDGE_ENVELOPE.exec(rawMsg);
  const code = m ? m[1] : undefined;
  const message = m ? m[2] : rawMsg;

  const e = err instanceof Error ? err : new Error(message);
  if (m) {
    try { e.message = message; } catch (_frozen) { /* leave as-is */ }
  }
  if (!e.code) e.code = code;
  if (src) {
    if (!e.code && src.code) e.code = src.code;
    if (e.details === undefined && src.details !== undefined) e.details = src.details;
  }
  return e;
}

/**
 * Guarded kernel call: `window.erp.invoke(method, args)` with an error toast
 * on failure. Rethrows (so the caller can react); marks the error as already
 * toasted to avoid duplicate notifications up the stack.
 * @param {string} method e.g. 'coa.tree'
 * @param {any} [args]
 * @returns {Promise<any>}
 */
export async function call(method, args) {
  try {
    if (!window.erp || typeof window.erp.invoke !== 'function') {
      const e = new Error('IPC bridge unavailable (window.erp.invoke is missing)');
      e.code = 'NO_BRIDGE';
      throw e;
    }
    return await window.erp.invoke(method, args);
  } catch (err) {
    const e = asError(err);
    try {
      if (!e.__toasted) {
        toast(e.message, 'error');
        e.__toasted = true;
      }
    } catch (_frozen) {
      /* never let notification bookkeeping break the throw */
    }
    throw e;
  }
}

/* --------------------------------------------------------- screen registry */

/** Screens this file owns (static imports above). */
const LOCAL_SCREENS = {
  login: loginScreen,
  wizard: wizardScreen,
  coa: coaScreen,
};

/**
 * Screens owned by other agents, listed defensively: each route tries the
 * candidate module files in order and degrades to a placeholder when the
 * module is missing, so the shell works with or without them.
 */
const REMOTE_SCREENS = {
  dashboard: ['dashboard.js', 'dashboardScreen.js'],
  journal: ['journalVoucher.js'],
  'pos-sale': ['posForm.js'],
  'sales-invoice': ['salesInvoice.js'],
  'credit-note': ['creditNote.js'],
  'purchase-bill': ['purchaseBill.js'],
  'debit-note': ['debitNote.js'],
  receipts: ['receiptForm.js'],
  payments: ['paymentForm.js'],
  expenses: ['expenseForm.js'],
  payroll: ['payrollForm.js'],
  inventory: ['inventory.js', 'inventoryScreen.js', 'inventoryForm.js', 'inventoryItems.js'],
  'fixed-assets': ['assetRegister.js'],
  forex: ['forexSettlement.js'],
  'trial-balance': ['trialBalance.js'],
  'income-statement': ['incomeStatement.js'],
  'balance-sheet': ['balanceSheet.js'],
  'ledger-card': ['ledgerCard.js'],
  closing: ['closing.js'],
};

const ROUTE_TITLES = {
  login: 'Sign in',
  dashboard: 'Dashboard',
  coa: 'Chart of Accounts',
  wizard: 'Discovery Wizard',
  journal: 'Journal Vouchers',
  'pos-sale': 'POS Sale',
  'sales-invoice': 'Sales Invoice',
  'credit-note': 'Credit Note',
  'purchase-bill': 'Purchase Bill',
  'debit-note': 'Debit Note',
  receipts: 'Receipts',
  payments: 'Payments',
  expenses: 'Expenses',
  payroll: 'Payroll',
  inventory: 'Inventory',
  'fixed-assets': 'Fixed Assets',
  forex: 'Forex Settlement',
  'trial-balance': 'Trial Balance',
  'income-statement': 'Income Statement',
  'balance-sheet': 'Balance Sheet',
  'ledger-card': 'Ledger Card',
  closing: 'Closing & Backup',
};

/** route → resolved render function (only successful resolutions cached). */
const screenCache = new Map();

/** Accept default export, named render(), or `{ default: { render } }` shapes. */
function normalizeScreen(mod) {
  if (typeof mod === 'function') return mod;
  if (!mod || typeof mod !== 'object') return null;
  if (typeof mod.default === 'function') return mod.default;
  if (typeof mod.render === 'function') return mod.render;
  if (mod.default && typeof mod.default.render === 'function') return mod.default.render;
  return null;
}

/** Placeholder used when another agent's module is not present yet. */
function placeholderScreen(route) {
  const files = REMOTE_SCREENS[route] || [];
  return (view) => {
    view.appendChild(
      el(
        'section',
        { class: 'screen' },
        el(
          'div',
          { class: 'placeholder-screen' },
          el('h2', {}, 'Screen not available yet'),
          el('p', { class: 'muted' }, `${ROUTE_TITLES[route] || route} is delivered by another module of the workspace.`),
          files.length
            ? el('p', { class: 'muted small mono' }, `expected: src/ui/${files.join('  |  src/ui/')}`)
            : null,
          el('p', { class: 'muted small' }, 'The rest of the shell keeps working — pick another section from the left rail.')
        )
      )
    );
  };
}

/** Resolve a route to a `(view, ctx)` render function (never throws). */
async function resolveScreen(route) {
  if (screenCache.has(route)) return screenCache.get(route);

  const local = normalizeScreen(LOCAL_SCREENS[route]);
  if (local) {
    screenCache.set(route, local);
    return local;
  }

  const candidates = REMOTE_SCREENS[route];
  if (candidates) {
    for (const file of candidates) {
      try {
        const mod = await import(/* @vite-ignore */ `./${file}`);
        const screen = normalizeScreen(mod);
        if (screen) {
          screenCache.set(route, screen);
          return screen;
        }
      } catch (_missing) {
        /* try the next candidate, then fall through to the placeholder */
      }
    }
  }
  return placeholderScreen(route);
}

/* --------------------------------------------------------- navigation */

/**
 * Navigation RBAC (Phase 1): which capability a route's screen needs.
 * Mirrors src/services/validationService.js CAPABILITIES — the kernel gate
 * is the real security boundary; this only keeps the rail honest.
 */
const ROUTE_CAPABILITY = {
  coa: 'manage_coa',
  wizard: 'manage_coa',
  closing: 'close_period',
  journal: 'post',
  'pos-sale': 'post',
  'sales-invoice': 'post',
  'credit-note': 'post',
  'purchase-bill': 'post',
  'debit-note': 'post',
  receipts: 'post',
  payments: 'post',
  expenses: 'post',
  payroll: 'post',
  inventory: 'post',
  'fixed-assets': 'post',
  forex: 'post',
};

/** Capabilities of the signed-in role (null/[] when anonymous). */
function currentPermissions() {
  const u = state.user;
  return (u && Array.isArray(u.permissions)) ? u.permissions : [];
}

/** True when the session role carries `capability`. */
export function can(capability) {
  if (!capability) return true;
  return currentPermissions().includes(capability);
}

/** Hide nav entries the current role may not use; re-run on login/logout. */
function applyNavPermissions(role) {
  const perms = role && Array.isArray(role.permissions) ? role.permissions : null;
  document.querySelectorAll('.nav-btn[data-route]').forEach((btn) => {
    const need = ROUTE_CAPABILITY[btn.dataset.route];
    if (!need) return;
    const allowed = perms ? perms.includes(need) : true; // anonymous -> login screen only
    btn.hidden = !allowed;
    btn.setAttribute('aria-hidden', allowed ? 'false' : 'true');
  });
}


/** Context handed to every screen render function as its 2nd argument. */
function makeCtx(route, params) {
  return {
    route,
    params,
    state,
    user: state.user,
    go,
    call,
    fmt,
    fmtNeg,
    el,
    modal,
    closeModal,
    confirm,
    toast,
    setUser,
    /** Phase 1 RBAC: does the session role carry `capability`? */
    can,
    permissions: currentPermissions(),
    /** Re-render the current screen. */
    refresh: () => go(route, params),
  };
}

function markActiveNav(route) {
  document.querySelectorAll('.nav-btn[data-route]').forEach((btn) => {
    const active = btn.dataset.route === route;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

/**
 * Navigate to a screen. Forces the login screen while `state.user` is null.
 * @param {string} route key of ROUTE_TITLES / screen registries
 * @param {object} [params] free-form params passed to the screen
 * @returns {Promise<void>}
 */
export async function go(route, params = {}) {
  if (!route) route = 'dashboard';
  if (route !== 'login' && !state.user) route = 'login';

  // Client-side RBAC: mirror the kernel gate so a restricted role lands on
  // the dashboard instead of a screen it cannot use. The kernel is still the
  // authority — every action inside the screen is re-checked server-side.
  const need = ROUTE_CAPABILITY[route];
  if (need && !can(need)) {
    if (route !== 'dashboard' && state.user) {
      toast(`Your role (${state.user.role || 'unknown'}) cannot open that section — “${need}” required.`, 'error');
    }
    route = 'dashboard';
  }

  state.route = route;
  markActiveNav(route);
  document.title = `${ROUTE_TITLES[route] || 'Apex ERP'} \u00b7 Apex ERP`;

  const view = document.getElementById('view');
  if (!view) return;
  view.innerHTML = '';
  view.appendChild(el('div', { class: 'screen-loading' }, el('span', { class: 'spinner' }), 'Loading\u2026'));

  try {
    const screen = await resolveScreen(route);
    if (state.route !== route) return; // superseded by a newer navigation
    view.innerHTML = '';
    await screen(view, makeCtx(route, params));
  } catch (err) {
    if (state.route !== route) return;
    const e = asError(err);
    view.innerHTML = '';
    view.appendChild(
      el(
        'section',
        { class: 'screen' },
        el(
          'div',
          { class: 'card error-card card-pad' },
          el('p', { class: 'card-title' }, 'This screen failed to load'),
          el('p', { class: 'muted mt-1' }, e.message || 'Unknown error')
        )
      )
    );
    if (!e.__toasted) {
      toast(e.message || 'Screen failed to load', 'error');
      e.__toasted = true;
    }
  }
}

/**
 * Store the signed-in user and refresh the app-bar chip.
 * @param {{userId?:number, username?:string, role?:string}|null} user
 */
export function setUser(user) {
  state.user = user || null;
  syncShell();
  applyNavPermissions(state.user);
}

/** Refresh the app-bar user chip / logout button from `state.user`. */
function syncShell() {
  const chip = document.getElementById('user-chip');
  const chipText = document.querySelector('#user-chip .user-chip-text');
  const chipAvatar = document.querySelector('#user-chip .user-chip-avatar');
  const logout = document.getElementById('btn-logout');
  const user = state.user;

  if (chip) chip.hidden = !user;
  if (logout) logout.hidden = !user;
  if (user && chipText) {
    const name = user.username || user.name || 'user';
    const role = user.role ? ` \u00b7 ${user.role}` : '';
    chipText.textContent = `${name}${role}`;
  }
  if (user && chipAvatar) chipAvatar.textContent = String((user.username || 'u')[0]).toUpperCase();
}

/* ---------------------------------------------------------------- boot */

function init() {
  document.querySelectorAll('.nav-btn[data-route]').forEach((btn) => {
    btn.addEventListener('click', () => go(btn.dataset.route));
  });

  const logout = document.getElementById('btn-logout');
  if (logout) {
    logout.addEventListener('click', async () => {
      try {
        // Drop the kernel-side session role too (Phase 1 RBAC) so a later
        // anonymous call fails closed instead of inheriting the old role.
        if (window.erp && typeof window.erp.invoke === 'function') {
          await window.erp.invoke('auth.logout', {});
        }
      } catch (_err) { /* logging out locally still succeeds */ }
      setUser(null);
      applyNavPermissions(null);
      go('login');
      toast('Signed out', 'info');
    });
  }

  syncShell();
  applyNavPermissions(state.user);
  // No session on load → login first (spec: route to login when user is null).
  go(state.user ? 'dashboard' : 'login');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
