'use strict';

/* ==========================================================================
 * Accounts-receivable receipt (src/ui/receiptForm.js)
 * Customer select with its outstanding balance, amount, destination
 * bank/cash account → `ar.receipt`.
 * ========================================================================== */

const LOCAL = {
  fmt(cents) {
    const n = (Number(cents) || 0) / 100;
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  },
  fmtNeg(cents) {
    const v = Number(cents) || 0;
    return v < 0 ? '(' + LOCAL.fmt(-v) + ')' : LOCAL.fmt(v);
  },
  el(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props && typeof props === 'object') {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(4)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  },
  call(method, args) {
    if (typeof window === 'undefined' || !window.erp || typeof window.erp.invoke !== 'function') {
      return Promise.reject({ code: 'NO_KERNEL', message: 'Kernel bridge window.erp.invoke is unavailable.' });
    }
    return window.erp.invoke(method, args);
  },
  toast(message, type) {
    const t = document.createElement('div');
    t.className = 'toast ' + (type === 'error' ? 'toast-error badge badge-red' : 'toast-ok badge badge-green');
    t.textContent = String(message);
    Object.assign(t.style, { position: 'fixed', top: '16px', right: '16px', zIndex: '9999', padding: '10px 14px', maxWidth: '420px' });
    document.body.append(t);
    setTimeout(() => t.remove(), 4200);
  },
  /* Shell-compatible signature: modal({ title, body, actions }) or a raw node. */
  modal(opts) {
    LOCAL.closeModal();
    const o = opts || {};
    let body;
    if (o.nodeType) {
      body = LOCAL.el('div', { class: 'modal-body' }, o);
    } else if (Array.isArray(o.body)) {
      body = LOCAL.el('div', { class: 'modal-body' }, ...o.body.filter((p) => p !== null && p !== undefined));
    } else if (typeof o.body === 'string' || typeof o.body === 'number') {
      body = LOCAL.el('div', { class: 'modal-body' }, String(o.body));
    } else {
      body = LOCAL.el('div', { class: 'modal-body' }, o.body || null);
    }
    const closeBtn = LOCAL.el('button', { class: 'btn btn-ghost modal-close', type: 'button', 'aria-label': 'Close' }, '✕');
    const head = LOCAL.el('div', { class: 'modal-head' },
      LOCAL.el('span', { class: 'modal-title' }, o.title || ''), closeBtn);
    const actions = Array.isArray(o.actions) ? o.actions : [];
    const foot = actions.length
      ? LOCAL.el('div', { class: 'modal-foot' }, ...actions.map((a) => {
          const b = LOCAL.el('button', { class: 'btn ' + (a.kind === 'primary' ? 'btn-primary' : 'btn-ghost'), type: 'button' }, a.label || 'OK');
          b.addEventListener('click', () => {
            let ret;
            if (typeof a.onClick === 'function') ret = a.onClick();
            Promise.resolve(ret).then((r) => { if (r !== false) LOCAL.closeModal(); }).catch(() => {});
          });
          return b;
        }))
      : null;
    const box = LOCAL.el('div', { class: 'modal-box card' }, head, body, foot);
    const overlay = LOCAL.el('div', { class: 'modal-overlay' }, box);
    closeBtn.addEventListener('click', () => LOCAL.closeModal());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) LOCAL.closeModal(); });
    document.body.append(overlay);
    return overlay;
  },
  closeModal() { document.querySelectorAll('.modal-overlay, .modal-backdrop').forEach((n) => n.remove()); },
};

const HELPER_KEYS = ['fmt', 'fmtNeg', 'el', 'call', 'toast', 'modal', 'closeModal'];


/* The shell's formatter must SCALE integer cents (100 -> "1.00"). If the
 * resolved fmt/fmtNeg is missing or does not divide by 100, keep the local
 * cents scaler so amounts never render 100x too large. */
function guardFmt(h) {
  const ok = (fn, probe, expect) => {
    try { return typeof fn === 'function' && String(fn(probe)).includes(expect); } catch (_e) { return false; }
  };
  if (!ok(h.fmt, 100, '1.00')) h.fmt = LOCAL.fmt;
  if (!ok(h.fmtNeg, -100, '(1.00)')) h.fmtNeg = LOCAL.fmtNeg;
  return h;
}

function resolveHelpers(ctx) {
  const h = { state: (ctx && ctx.state) || {}, ...LOCAL };
  for (const k of HELPER_KEYS) if (ctx && typeof ctx[k] === 'function') h[k] = ctx[k];
  const wantsShell = !ctx || HELPER_KEYS.some((k) => typeof ctx[k] !== 'function');
  if (wantsShell && typeof document !== 'undefined') {
    import('./app.js').then((m) => {
      const src = { ...(m || {}), ...((m && m.default && typeof m.default === 'object') ? m.default : {}) };
      for (const k of HELPER_KEYS) {
        if ((!ctx || typeof ctx[k] !== 'function') && typeof src[k] === 'function') h[k] = src[k];
      }
      if ((!ctx || !ctx.state) && src.state) h.state = src.state;
      guardFmt(h);
    }).catch(() => { /* app.js not present: local fallbacks stay in place */ });
  }
  guardFmt(h);
  return h;
}

/* ------------------------------ utilities ------------------------------- */
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => { const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const centsOf = (v) => Math.round(num(v) * 100);
const errMsg = (e) => (e && e.message) || (typeof e === 'string' ? e : 'Kernel call failed');
const uid = (h) => {
  const s = h.state || {};
  const u = s.user || s.auth || s;
  const v = u.userId ?? u.UserId ?? s.userId ?? s.UserId ?? 1;
  return Number(v) || 1;
};
const pick = (row, ...names) => {
  if (!row) return undefined;
  for (const n of names) if (row[n] !== undefined && row[n] !== null) return row[n];
  return undefined;
};

const CASH_TILL = '1.10.01.0001.0001';
const BANK_MAIN = '1.10.01.0002.0001';
const BANK_SECONDARY = '1.10.01.0002.0002';

export function render(container, ctx) {
  const view = container
    || (typeof document !== 'undefined' && document.getElementById('view'))
    || (typeof document !== 'undefined' ? document.body : null);
  if (!view) return null;

  const h = resolveHelpers(ctx);
  const el = (...a) => h.el(...a);
  const call = (m, a) => h.call(m, a);
  const fmt = (v) => h.fmt(v);
  const toast = (...a) => h.toast(...a);
  // Kernel errors already toasted by shell `call` (marked __toasted) — avoid dupes.
  const fail = (e) => { if (e && e.__toasted) return; toast(errMsg(e), 'error'); };

  let entities = [];

  const field = (label, ...controls) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), ...controls);

  const dateInput = el('input', { class: 'input', type: 'date', value: today() });
  const custSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select customer…'));
  const amountInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const accountSelect = el('select', { class: 'select' },
    el('option', { value: BANK_MAIN }, 'Primary Operating Bank (1.10.01.0002.0001)'),
    el('option', { value: BANK_SECONDARY }, 'Secondary Savings / Tax A/C (1.10.01.0002.0002)'),
    el('option', { value: CASH_TILL }, 'Main Cash Till (1.10.01.0001.0001)'));
  const memoInput = el('input', { class: 'input', type: 'text', placeholder: 'Memo (optional)' });

  const balanceOut = el('p', { class: 'hint muted' }, 'Select a customer to see the outstanding balance.');
  const liveOut = el('p', { class: 'hint muted' });

  const postBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Record receipt');
  postBtn.disabled = true;
  const resultBox = el('div', { class: 'result-box' });

  const root = el('div', { class: 'screen screen-receipt' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'AR receipt (customer payment)'),
      el('div', { class: 'grid grid-2' },
        field('Receipt date', dateInput),
        field('Customer *', custSelect),
        field('Amount received *', amountInput),
        field('Deposit into account', accountSelect),
        field('Memo', memoInput)),
      balanceOut,
      liveOut,
      el('div', { class: 'toolbar row' }, postBtn),
      resultBox));

  view.replaceChildren(root);

  function currentCustomer() {
    return entities.find((e) => String(pick(e, 'EntityId', 'entityId', 'id')) === custSelect.value);
  }

  function calc() {
    const c = currentCustomer();
    const outstanding = c ? Number(pick(c, 'CurrentBalance', 'currentBalance', 'balance') || 0) : 0;
    const amount = centsOf(amountInput.value);
    balanceOut.textContent = c
      ? `Outstanding balance: ${fmt(outstanding)} (debit positive) · account ${String(pick(c, 'LinkedAccountId', 'linkedAccountId') ?? '—')}`
      : 'Select a customer to see the outstanding balance.';
    if (c && amount > 0) {
      const after = outstanding - amount;
      liveOut.textContent = `Receipt ${fmt(amount)} → balance after: ${fmt(after)}`
        + (amount > outstanding ? ' · ⚠ exceeds the outstanding balance' : '');
      liveOut.classList.toggle('badge', amount > outstanding);
      liveOut.classList.toggle('badge-danger', amount > outstanding);
      liveOut.classList.toggle('badge-red', amount > outstanding);
    } else {
      liveOut.textContent = '';
    }
    const ok = Boolean(custSelect.value) && amount > 0;
    postBtn.disabled = !ok;
    return { amount, ok, outstanding };
  }

  function resetForm() {
    custSelect.value = '';
    amountInput.value = '';
    memoInput.value = '';
    calc();
  }

  async function submit() {
    const s = calc();
    if (!s.ok) return;
    postBtn.disabled = true;
    try {
      const res = await call('ar.receipt', {
        voucherDate: dateInput.value || today(),
        entityId: Number(custSelect.value),
        amountCents: s.amount,
        accountCode: accountSelect.value,
        memo: String(memoInput.value || '').trim() || undefined,
        createdBy: uid(h),
      });
      const voucher = (res && res.voucher) || res || {};
      const voucherNo = voucher.voucherNo ?? res?.voucherNo ?? '(no number)';
      const custName = custSelect.options[custSelect.selectedIndex]
        ? custSelect.options[custSelect.selectedIndex].text : '';
      toast(`Receipt ${voucherNo} recorded`, 'success');
      resultBox.replaceChildren(
        el('div', { class: 'card card-pad receipt' },
          el('div', { class: 'receipt-head' },
            el('span', { class: 'card-title section-title' }, 'Receipt recorded'),
            el('span', { class: 'badge badge-success badge-green' }, String(voucherNo))),
          el('table', { class: 'table' },
            el('tbody', null,
              el('tr', null, el('td', null, 'Customer'), el('td', { class: 'num' }, custName)),
              el('tr', null, el('td', null, 'Date'), el('td', { class: 'num' }, String(voucher.voucherDate ?? dateInput.value))),
              el('tr', null, el('td', null, 'Amount'), el('td', { class: 'num money' }, fmt(s.amount))),
              el('tr', null, el('td', null, 'Deposited into'), el('td', { class: 'num' }, accountSelect.options[accountSelect.selectedIndex].text))))));
      resetForm();
      // refresh balances so the readout is accurate after the receipt
      call('report.entities').then((rows) => { entities = rows || []; }).catch(() => {});
    } catch (e) {
      fail(e);
    } finally {
      postBtn.disabled = false;
      calc();
    }
  }

  custSelect.addEventListener('change', calc);
  amountInput.addEventListener('input', calc);
  amountInput.addEventListener('change', calc);
  postBtn.addEventListener('click', submit);

  call('report.entities')
    .then((rows) => {
      entities = rows || [];
      for (const c of entities) {
        const type = String(pick(c, 'EntityType', 'entityType') ?? '').toLowerCase();
        const id = pick(c, 'EntityId', 'entityId', 'id');
        if (id === undefined || (type && type !== 'customer')) continue;
        const name = String(pick(c, 'FullName', 'fullName', 'name') ?? `Entity ${id}`);
        const bal = Number(pick(c, 'CurrentBalance', 'currentBalance', 'balance') || 0);
        custSelect.append(el('option', { value: String(id) }, `${name} — due ${fmt(bal)}`));
      }
      calc();
    })
    .catch((e) => fail(e));

  calc();
  return root;
}

export default render;
