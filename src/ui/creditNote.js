'use strict';

/* ==========================================================================
 * Sales return / credit note (src/ui/creditNote.js)
 * Customer return of goods → `sales.creditNote`. The confirmation surfaces
 * the FIFO cost of the inventory the kernel restored to the shelf.
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

/* Inventory value restored by a credit note (kernel meta, defensive). */
function restoredCostFrom(res) {
  const meta = (res && res.meta) || {};
  const direct = pick(meta, 'restoredValueCents', 'restockValueCents', 'restoredCents', 'valueCents',
    'inventoryValueCents', 'cogsCents', 'cogs', 'costCents', 'fifoValueCents');
  if (direct !== undefined && direct !== null && typeof direct !== 'object') {
    const n = Number(direct);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

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
  const custSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select customer…'));
  const itemSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select item…'));
  const qtyInput = el('input', { class: 'input', type: 'number', min: '1', step: '1', value: '1' });
  const priceInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const taxInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', value: '0.10' });
  const inclCheck = el('input', { type: 'checkbox' });
  const reasonInput = el('input', { class: 'input', type: 'text', placeholder: 'e.g. Damaged goods' });

  const stockHint = el('p', { class: 'hint muted' });
  const netOut = el('span', { class: 'money' }, '$0.00');
  const taxOut = el('span', { class: 'money' }, '$0.00');
  const totalOut = el('span', { class: 'money strong' }, '$0.00');
  const modeBadge = el('span', { class: 'badge' }, 'tax exclusive');
  const identityBadge = el('span', { class: 'badge badge-success badge-green' }, 'R + T = A ✓');
  const calcHint = el('p', { class: 'hint muted' });

  const postBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Post credit note');
  postBtn.disabled = true;
  const resultBox = el('div', { class: 'result-box' });

  const root = el('div', { class: 'screen screen-creditnote' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'Sales return (credit note)'),
      el('div', { class: 'grid grid-2' },
        field('Return date', dateInput),
        field('Customer *', custSelect),
        field('Item *', itemSelect),
        field('Quantity returned', qtyInput),
        field('Unit price', priceInput),
        field('Tax rate (0.10 = 10%)', taxInput),
        field('Reason', reasonInput),
        field('Pricing', el('label', { class: 'check-row' }, inclCheck, ' price includes tax'))),
      stockHint,
      el('div', { class: 'card card-pad calc-panel' },
        el('h3', { class: 'card-title section-title' }, 'Refund computation ', modeBadge),
        el('table', { class: 'table' },
          el('tbody', null,
            el('tr', null, el('td', null, el('strong', null, 'R — net amount (excl. tax)')), el('td', { class: 'num' }, netOut)),
            el('tr', null, el('td', null, el('strong', null, 'T — tax')), el('td', { class: 'num' }, taxOut)),
            el('tr', null, el('td', null, el('strong', null, 'A — total refund')), el('td', { class: 'num' }, totalOut)))),
        identityBadge,
        calcHint),
      el('div', { class: 'toolbar row' }, postBtn),
      resultBox));

  view.replaceChildren(root);

  /* --------------------------- computation --------------------------- */
  function calc() {
    const q = Math.max(0, Math.round(num(qtyInput.value)));
    const p = centsOf(priceInput.value);
    const r = Math.max(0, num(taxInput.value));
    const incl = inclCheck.checked;
    let netC; let taxC; let totalC;
    if (incl) {
      const totalF = q * p;
      totalC = Math.round(totalF);
      netC = Math.round(totalF / (1 + r));
      taxC = totalC - netC;
    } else {
      const netF = q * p;
      netC = Math.round(netF);
      taxC = Math.round(netF * r);
      totalC = netC + taxC;
    }
    netOut.textContent = fmt(netC);
    taxOut.textContent = fmt(taxC);
    totalOut.textContent = fmt(totalC);
    modeBadge.textContent = incl ? 'tax inclusive' : 'tax exclusive';
    const identity = netC + taxC === totalC;
    identityBadge.textContent = identity ? 'R + T = A ✓' : `R + T − A = ${fmt(netC + taxC - totalC)}`;
    identityBadge.className = 'badge ' + (identity ? 'badge badge-success badge-green' : 'badge badge-danger badge-red');

    const item = items.find((it) => String(pick(it, 'ItemCode', 'itemCode', 'code')) === itemSelect.value);
    stockHint.textContent = item
      ? `On hand: ${Number(pick(item, 'CurrentStock', 'currentStock', 'stock') || 0)} · cost ${fmt(Number(pick(item, 'CostPrice', 'costPrice') || 0))}`
      : '';

    const ok = Boolean(itemSelect.value && custSelect.value) && q > 0 && p > 0;
    postBtn.disabled = !ok;
    calcHint.textContent = ok
      ? `Q×P = ${fmt(q * p)} · tax ${(r * 100).toFixed(2)}%`
      : 'Select customer, item, quantity and price to continue.';
    return { q, p, r, incl, netC, taxC, totalC, ok };
  }

  function resetForm() {
    itemSelect.value = '';
    qtyInput.value = '1';
    priceInput.value = '';
    taxInput.value = '0.10';
    inclCheck.checked = false;
    custSelect.value = '';
    reasonInput.value = '';
    calc();
  }

  /* ----------------------------- submit ------------------------------ */
  async function submit() {
    const c = calc();
    if (!c.ok) return;
    postBtn.disabled = true;
    try {
      const res = await call('sales.creditNote', {
        voucherDate: dateInput.value || today(),
        itemCode: itemSelect.value,
        qty: c.q,
        unitPriceCents: c.p,
        taxRate: c.r,
        priceIncludesTax: c.incl,
        entityId: Number(custSelect.value),
        reason: String(reasonInput.value || '').trim() || undefined,
        createdBy: uid(h),
      });
      const voucher = (res && res.voucher) || res || {};
      const voucherNo = voucher.voucherNo ?? res?.voucherNo ?? '(no number)';
      const restored = restoredCostFrom(res);
      toast(`Credit note ${voucherNo} posted`, 'success');
      resultBox.replaceChildren(
        el('div', { class: 'card card-pad receipt' },
          el('div', { class: 'receipt-head' },
            el('span', { class: 'card-title section-title' }, 'Credit note posted'),
            el('span', { class: 'badge badge-success badge-green' }, String(voucherNo))),
          el('table', { class: 'table' },
            el('tbody', null,
              el('tr', null, el('td', null, 'Date'), el('td', { class: 'num' }, String(voucher.voucherDate ?? dateInput.value))),
              el('tr', null, el('td', null, 'Item returned'), el('td', { class: 'num' }, `${itemSelect.value} × ${c.q}`)),
              el('tr', null, el('td', null, 'R — net'), el('td', { class: 'num money' }, fmt(c.netC))),
              el('tr', null, el('td', null, 'T — tax'), el('td', { class: 'num money' }, fmt(c.taxC))),
              el('tr', null, el('td', null, 'A — total refund'), el('td', { class: 'num money' }, fmt(c.totalC))),
              el('tr', null,
                el('td', null, 'Inventory cost restored'),
                el('td', { class: 'num money' },
                  restored === null ? '—' : fmt(restored)))))));
      resetForm();
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
      const sp = Number(pick(item, 'SellingPrice', 'sellingPrice') || 0);
      priceInput.value = sp ? (sp / 100).toFixed(2) : '';
    }
    calc();
  });
  [dateInput, qtyInput, priceInput, taxInput, inclCheck, custSelect, reasonInput].forEach((n) => {
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
    for (const c of entities) {
      const type = String(pick(c, 'EntityType', 'entityType') ?? '').toLowerCase();
      const id = pick(c, 'EntityId', 'entityId', 'id');
      if (id === undefined || (type && type !== 'customer')) continue;
      const name = String(pick(c, 'FullName', 'fullName', 'name') ?? `Entity ${id}`);
      custSelect.append(el('option', { value: String(id) }, name));
    }
    calc();
  }).catch((e) => fail(e));

  calc();
  return root;
}

export default render;
