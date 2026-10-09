'use strict';

/* ==========================================================================
 * Credit sales invoice (src/ui/salesInvoice.js)
 * Customer invoice with the same cents-math panel as the POS terminal:
 *   exclusive: net = Q*P*(1-d), tax = net*r,   total = net + tax
 *   inclusive: total = Q*P*(1-d), net = total/(1+r), tax = total - net
 * Requires a customer (report.entities) and a due date → `sales.invoice`.
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
const plusDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
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
  const dateOf = () => dateInput.value || today();

  const dateInput = el('input', { class: 'input', type: 'date', value: today() });
  const dueInput = el('input', { class: 'input', type: 'date', value: plusDays(today(), 30) });
  const custSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select customer…'));
  const itemSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select item…'));
  const qtyInput = el('input', { class: 'input', type: 'number', min: '1', step: '1', value: '1' });
  const priceInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const taxInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', value: '0.10' });
  const discInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', value: '0.00' });
  const inclCheck = el('input', { type: 'checkbox' });

  const custBal = el('p', { class: 'hint muted' });
  const stockHint = el('p', { class: 'hint muted' });
  const netOut = el('span', { class: 'money' }, '$0.00');
  const taxOut = el('span', { class: 'money' }, '$0.00');
  const totalOut = el('span', { class: 'money strong' }, '$0.00');
  const modeBadge = el('span', { class: 'badge' }, 'tax exclusive');
  const identityBadge = el('span', { class: 'badge badge-success badge-green' }, 'R + T = A ✓');
  const calcHint = el('p', { class: 'hint muted' });

  const postBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Create invoice');
  postBtn.disabled = true;
  const resultBox = el('div', { class: 'result-box' });

  const root = el('div', { class: 'screen screen-invoice' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'Sales invoice (credit)'),
      el('div', { class: 'grid grid-2' },
        field('Invoice date', dateInput),
        field('Due date *', dueInput),
        field('Customer *', custSelect),
        field('Item', itemSelect),
        field('Quantity', qtyInput),
        field('Unit price', priceInput),
        field('Tax rate (0.10 = 10%)', taxInput),
        field('Discount rate (0.00 = none)', discInput),
        field('Pricing', el('label', { class: 'check-row' }, inclCheck, ' price includes tax'))),
      custBal,
      stockHint,
      el('div', { class: 'card card-pad calc-panel' },
        el('h3', { class: 'card-title section-title' }, 'Computation ', modeBadge),
        el('table', { class: 'table' },
          el('tbody', null,
            el('tr', null, el('td', null, el('strong', null, 'R — net amount (excl. tax)')), el('td', { class: 'num' }, netOut)),
            el('tr', null, el('td', null, el('strong', null, 'T — tax')), el('td', { class: 'num' }, taxOut)),
            el('tr', null, el('td', null, el('strong', null, 'A — total receivable')), el('td', { class: 'num' }, totalOut)))),
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
    const d = Math.min(1, Math.max(0, num(discInput.value)));
    const incl = inclCheck.checked;
    let netC; let taxC; let totalC;
    if (incl) {
      const totalF = q * p * (1 - d);
      totalC = Math.round(totalF);
      netC = Math.round(totalF / (1 + r));
      taxC = totalC - netC;
    } else {
      const netF = q * p * (1 - d);
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
    const stock = item ? Number(pick(item, 'CurrentStock', 'currentStock', 'stock') || 0) : null;
    const short = stock !== null && q > stock;
    stockHint.textContent = item
      ? (short ? `Requested ${q}, only ${stock} on hand — the kernel may reject with INSUFFICIENT_STOCK.` : `On hand: ${stock}`)
      : '';
    stockHint.classList.toggle('badge', short);
    stockHint.classList.toggle('badge-danger', short);
    stockHint.classList.toggle('badge-red', short);

    const dueOk = Boolean(dueInput.value) && dueInput.value >= dateOf();
    const ok = Boolean(itemSelect.value && custSelect.value) && q > 0 && p > 0 && dueOk;
    postBtn.disabled = !ok;
    calcHint.textContent = ok
      ? `Q×P = ${fmt(q * p)} · discount ${fmt(Math.round(q * p - q * p * (1 - d)))} (${(d * 100).toFixed(2)}%) · tax ${(r * 100).toFixed(2)}%`
      : (dueOk ? 'Select customer, item, quantity and price to continue.' : 'Due date must be on or after the invoice date.');
    return { q, p, r, d, incl, netC, taxC, totalC, ok };
  }

  function resetForm() {
    itemSelect.value = '';
    qtyInput.value = '1';
    priceInput.value = '';
    taxInput.value = '0.10';
    discInput.value = '0.00';
    inclCheck.checked = false;
    custSelect.value = '';
    dueInput.value = plusDays(dateOf(), 30);
    custBal.textContent = '';
    calc();
  }

  /* ----------------------------- submit ------------------------------ */
  async function submit() {
    const c = calc();
    if (!c.ok) return;
    postBtn.disabled = true;
    try {
      const res = await call('sales.invoice', {
        voucherDate: dateOf(),
        itemCode: itemSelect.value,
        qty: c.q,
        unitPriceCents: c.p,
        taxRate: c.r,
        discountRate: c.d,
        priceIncludesTax: c.incl,
        entityId: Number(custSelect.value),
        dueDate: dueInput.value,
        createdBy: uid(h),
      });
      const voucher = (res && res.voucher) || res || {};
      const voucherNo = voucher.voucherNo ?? res?.voucherNo ?? '(no number)';
      toast(`Invoice ${voucherNo} created`, 'success');
      const custName = custSelect.options[custSelect.selectedIndex]
        ? custSelect.options[custSelect.selectedIndex].text : '';
      resultBox.replaceChildren(
        el('div', { class: 'card card-pad receipt' },
          el('div', { class: 'receipt-head' },
            el('span', { class: 'card-title section-title' }, 'Invoice created'),
            el('span', { class: 'badge badge-success badge-green' }, String(voucherNo))),
          el('table', { class: 'table' },
            el('tbody', null,
              el('tr', null, el('td', null, 'Customer'), el('td', { class: 'num' }, custName)),
              el('tr', null, el('td', null, 'Invoice date'), el('td', { class: 'num' }, String(voucher.voucherDate ?? dateOf()))),
              el('tr', null, el('td', null, 'Due date'), el('td', { class: 'num' }, dueInput.value)),
              el('tr', null, el('td', null, 'R — net'), el('td', { class: 'num money' }, fmt(c.netC))),
              el('tr', null, el('td', null, 'T — tax'), el('td', { class: 'num money' }, fmt(c.taxC))),
              el('tr', null, el('td', null, 'A — total receivable'), el('td', { class: 'num money' }, fmt(c.totalC)))))));
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
  custSelect.addEventListener('change', () => {
    const e = entities.find((x) => String(pick(x, 'EntityId', 'entityId', 'id')) === custSelect.value);
    const bal = e ? pick(e, 'CurrentBalance', 'currentBalance', 'balance') : undefined;
    custBal.textContent = e
      ? `Outstanding balance: ${fmt(Number(bal || 0))} (debit positive)`
      : '';
    calc();
  });
  [dateInput, dueInput, qtyInput, priceInput, taxInput, discInput, inclCheck].forEach((n) => {
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
      const stock = pick(it, 'CurrentStock', 'currentStock', 'stock');
      if (!code) continue;
      itemSelect.append(el('option', { value: code }, `${code} — ${name}${stock !== undefined ? ` (stock ${stock})` : ''}`));
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
