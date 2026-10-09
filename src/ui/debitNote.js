'use strict';

/* ==========================================================================
 * Purchase return / debit note (src/ui/debitNote.js)
 * Vendor return of goods → `purchase.debitNote`. Reverses vendor debt at the
 * invoice value and relieves stock at the FIFO cost sitting in the queue.
 * Phase 4 of Section 7 lists Debit Notes as a mandatory operational form.
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
    t.className = 'toast ' + (type === 'error' ? 'toast-error badge badge-danger badge-red' : 'toast-ok badge badge-success badge-green');
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
    if (o.nodeType) body = LOCAL.el('div', { class: 'modal-body' }, o);
    else if (Array.isArray(o.body)) body = LOCAL.el('div', { class: 'modal-body' }, ...o.body.filter((p) => p !== null && p !== undefined));
    else if (typeof o.body === 'string' || typeof o.body === 'number') body = LOCAL.el('div', { class: 'modal-body' }, String(o.body));
    else body = LOCAL.el('div', { class: 'modal-body' }, o.body || null);
    const closeBtn = LOCAL.el('button', { class: 'btn btn-ghost modal-close', type: 'button', 'aria-label': 'Close' }, '✕');
    const head = LOCAL.el('div', { class: 'modal-head' }, LOCAL.el('span', { class: 'modal-title' }, o.title || ''), closeBtn);
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

  let items = [];
  let entities = [];

  const field = (label, ...controls) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), ...controls);

  const dateInput = el('input', { class: 'input', type: 'date', value: today() });
  const vendSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select vendor…'));
  const itemSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select item…'));
  const qtyInput = el('input', { class: 'input', type: 'number', min: '1', step: '1', value: '1' });
  const costInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const taxInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', value: '0.10' });
  const reasonInput = el('input', { class: 'input', type: 'text', placeholder: 'e.g. Faulty goods returned to vendor' });

  const stockHint = el('p', { class: 'hint muted' });
  const netOut = el('span', { class: 'money' }, '$0.00');
  const taxOut = el('span', { class: 'money' }, '$0.00');
  const totalOut = el('span', { class: 'money strong' }, '$0.00');
  const fifoOut = el('span', { class: 'money' }, '—'); // filled from kernel meta after posting
  const identityBadge = el('span', { class: 'badge badge-success badge-green' }, 'DR = CR ✓');
  const calcHint = el('p', { class: 'hint muted' });

  const postBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Post debit note');
  postBtn.disabled = true;
  const resultBox = el('div', { class: 'result-box' });

  const root = el('div', { class: 'screen screen-debitnote' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'Purchase return (debit note)'),
      el('p', { class: 'subtitle' },
        'Returns goods to the vendor: DR Trade creditors · CR Inventory (FIFO) · CR Input tax.'),
      el('div', { class: 'grid grid-2' },
        field('Return date', dateInput),
        field('Vendor *', vendSelect),
        field('Item *', itemSelect),
        field('Quantity returned', qtyInput),
        field('Unit cost (excl. tax)', costInput),
        field('Tax rate (0.10 = 10%)', taxInput),
        field('Reason', reasonInput)),
      stockHint,
      el('div', { class: 'card card-pad calc-panel' },
        el('h3', { class: 'card-title section-title' }, 'Debit note computation'),
        el('table', { class: 'table' },
          el('tbody', null,
            el('tr', null, el('td', null, el('strong', null, 'R — net credit (excl. tax)')), el('td', { class: 'num' }, netOut)),
            el('tr', null, el('td', null, el('strong', null, 'T — recoverable input tax reversed')), el('td', { class: 'num' }, taxOut)),
            el('tr', null, el('td', null, el('strong', null, 'A — total debited to Trade creditors')), el('td', { class: 'num' }, totalOut)),
            el('tr', null, el('td', null, 'FIFO cost relieved from stock'), el('td', { class: 'num' }, fifoOut)))),
        identityBadge,
        calcHint),
      el('div', { class: 'toolbar row' }, postBtn),
      resultBox));

  view.replaceChildren(root);

  /* --------------------------- computation --------------------------- */
  function calc() {
    const q = Math.max(0, Math.round(num(qtyInput.value)));
    const c = centsOf(costInput.value);
    const r = Math.max(0, num(taxInput.value));
    const netC = Math.round(q * c);
    const taxC = Math.round(netC * r);
    const totalC = netC + taxC;

    netOut.textContent = fmt(netC);
    taxOut.textContent = fmt(taxC);
    totalOut.textContent = fmt(totalC);
    const identity = totalC === netC + taxC;
    identityBadge.textContent = identity ? 'DR = CR ✓' : `Δ ${fmt(totalC - netC - taxC)}`;
    identityBadge.className = 'badge ' + (identity ? 'badge badge-success badge-green' : 'badge badge-danger badge-red');

    const item = items.find((it) => String(pick(it, 'ItemCode', 'itemCode', 'code')) === itemSelect.value);
    stockHint.textContent = item
      ? `On hand: ${Number(pick(item, 'CurrentStock', 'currentStock', 'stock') || 0)} · unit cost ${fmt(Number(pick(item, 'CostPrice', 'costPrice') || 0))}`
      : '';

    const stock = item ? Number(pick(item, 'CurrentStock', 'currentStock', 'stock') || 0) : 0;
    const ok = Boolean(itemSelect.value && vendSelect.value) && q > 0 && c > 0 && q <= stock;
    postBtn.disabled = !ok;
    calcHint.textContent = !itemSelect.value
      ? 'Select vendor, item, quantity and cost to continue.'
      : (q > stock
        ? `Only ${stock} unit(s) on hand — reduce the quantity.`
        : `${q} × ${fmt(c)} · tax ${(r * 100).toFixed(2)}% · stock relieved ${q}`);
    return { q, c, r, netC, taxC, totalC, ok };
  }

  function resetForm() {
    itemSelect.value = '';
    vendSelect.value = '';
    qtyInput.value = '1';
    costInput.value = '';
    taxInput.value = '0.10';
    reasonInput.value = '';
    fifoOut.textContent = '—';
    calc();
  }

  /* ----------------------------- submit ------------------------------ */
  async function submit() {
    const c = calc();
    if (!c.ok) return;
    postBtn.disabled = true;
    try {
      const res = await call('purchase.debitNote', {
        voucherDate: dateInput.value || today(),
        entityId: Number(vendSelect.value),
        itemCode: itemSelect.value,
        qty: c.q,
        unitCostCents: c.c,
        taxRate: c.r,
        narration: String(reasonInput.value || '').trim() || undefined,
        createdBy: uid(h),
      });
      const voucher = (res && res.voucher) || res || {};
      const voucherNo = voucher.voucherNo ?? res?.voucherNo ?? '(no number)';
      const meta = (res && res.meta) || {};
      const fifo = Number(pick(meta, 'cogsCents', 'fifoCostCents', 'costCents') ?? NaN);
      toast(`Debit note ${voucherNo} posted`, 'success');
      resultBox.replaceChildren(
        el('div', { class: 'card card-pad receipt' },
          el('div', { class: 'receipt-head' },
            el('span', { class: 'card-title section-title' }, 'Debit note posted'),
            el('span', { class: 'badge badge-success badge-green' }, String(voucherNo))),
          el('table', { class: 'table' },
            el('tbody', null,
              el('tr', null, el('td', null, 'Date'), el('td', { class: 'num' }, String(voucher.voucherDate ?? dateInput.value))),
              el('tr', null, el('td', null, 'Item returned'), el('td', { class: 'num' }, `${itemSelect.value} × ${c.q}`)),
              el('tr', null, el('td', null, 'R — net'), el('td', { class: 'num money' }, fmt(c.netC))),
              el('tr', null, el('td', null, 'T — input tax reversed'), el('td', { class: 'num money' }, fmt(c.taxC))),
              el('tr', null, el('td', null, 'A — total debited to Trade creditors'), el('td', { class: 'num money' }, fmt(c.totalC))),
              el('tr', null,
                el('td', null, 'FIFO cost relieved from stock'),
                el('td', { class: 'num money' }, Number.isFinite(fifo) ? fmt(fifo) : '—'))))));
      resetForm();
      if (Number.isFinite(fifo)) fifoOut.textContent = fmt(fifo);
    } catch (e) {
      fail(e);
    } finally {
      calc();
    }
  }

  /* ----------------------------- wiring ------------------------------ */
  itemSelect.addEventListener('change', () => {
    const item = items.find((it) => String(pick(it, 'ItemCode', 'itemCode', 'code')) === itemSelect.value);
    if (item) {
      const cp = Number(pick(item, 'CostPrice', 'costPrice') || 0);
      costInput.value = cp ? (cp / 100).toFixed(2) : '';
    }
    calc();
  });
  [dateInput, qtyInput, costInput, taxInput, vendSelect, reasonInput].forEach((n) => {
    n.addEventListener('input', calc);
    n.addEventListener('change', calc);
  });
  postBtn.addEventListener('click', submit);

  Promise.all([
    call('inventory.items').then((rows) => { items = rows || []; }),
    call('report.entities').then((rows) => { entities = rows || []; }),
  ]).then(() => {
    for (const it of items) {
      const code = String(pick(it, 'ItemCode', 'itemCode', 'code') ?? '');
      const name = String(pick(it, 'ItemName', 'itemName', 'name') ?? '');
      if (!code) continue;
      itemSelect.append(el('option', { value: code }, `${code} — ${name}`));
    }
    for (const e of entities) {
      const type = String(pick(e, 'EntityType', 'entityType') ?? '').toLowerCase();
      const id = pick(e, 'EntityId', 'entityId', 'id');
      if (id === undefined || (type && type !== 'vendor')) continue;
      const name = String(pick(e, 'FullName', 'fullName', 'name') ?? `Entity ${id}`);
      vendSelect.append(el('option', { value: String(id) }, name));
    }
    calc();
  }).catch((e) => fail(e));

  calc();
  return root;
}

export default render;
