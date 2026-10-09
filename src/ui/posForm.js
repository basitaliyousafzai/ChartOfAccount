'use strict';

/* ==========================================================================
 * POS terminal (src/ui/posForm.js)
 * Single-line till sale with a live cents-math computation panel:
 *   exclusive: net = Q*P*(1-d), tax = net*r,   total = net + tax
 *   inclusive: total = Q*P*(1-d), net = total/(1+r), tax = total - net
 * Posts `pos.sale`, then renders a receipt-style confirmation carrying the
 * FIFO COGS reported by the kernel.
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
const AR = '1.10.02.0001.0001';

/* Pull FIFO COGS out of the `{ voucher, meta }` document response. */
function cogsFrom(res) {
  const meta = (res && res.meta) || {};
  const direct = pick(meta, 'cogsCents', 'cogs', 'fifoCogsCents', 'fifoCogs', 'cogsValueCents', 'costCents', 'FifoCogsCents');
  if (direct !== undefined && typeof direct !== 'object') {
    const n = Number(direct);
    if (Number.isFinite(n)) return n;
  }
  const lots = pick(meta, 'lots', 'fifoLots', 'consumedLots', 'layers', 'lotQueue');
  if (Array.isArray(lots)) {
    let sum = 0; let seen = false;
    for (const l of lots) {
      const q = Number(pick(l, 'qty', 'Qty', 'qtyConsumed', 'QtyConsumed', 'qtySold') || 0);
      const c = Number(pick(l, 'unitCost', 'UnitCost', 'unitCostCents', 'UnitCostCents') || 0);
      const v = pick(l, 'valueCents', 'ValueCents', 'costCents');
      if (q > 0 && c > 0) { sum += q * c; seen = true; }
      else if (v !== undefined) { sum += Number(v); seen = true; }
    }
    if (seen) return sum;
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
  const itemSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select item…'));
  const qtyInput = el('input', { class: 'input', type: 'number', min: '1', step: '1', value: '1' });
  const priceInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const taxInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', value: '0.10' });
  const discInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', value: '0.00' });
  const inclCheck = el('input', { type: 'checkbox' });
  const tenderSelect = el('select', { class: 'select' },
    el('option', { value: 'Cash' }, 'Cash'),
    el('option', { value: 'Credit' }, 'Credit (on account)'));
  const accountSelect = el('select', { class: 'select' },
    el('option', { value: CASH_TILL }, 'Main Cash Till (1.10.01.0001.0001)'),
    el('option', { value: BANK_MAIN }, 'Primary Operating Bank (1.10.01.0002.0001)'),
    el('option', { value: AR }, 'Trade Debtors / AR (1.10.02.0001.0001)'));
  const customerSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select customer…'));

  const netOut = el('span', { class: 'money' }, '$0.00');
  const taxOut = el('span', { class: 'money' }, '$0.00');
  const totalOut = el('span', { class: 'money strong' }, '$0.00');
  const modeBadge = el('span', { class: 'badge' }, 'tax exclusive');
  const identityBadge = el('span', { class: 'badge badge-success badge-green' }, 'R + T = A ✓');
  const stockHint = el('p', { class: 'hint muted' });
  const calcHint = el('p', { class: 'hint muted' });

  const sellBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Take payment');
  sellBtn.disabled = true;
  const receiptBox = el('div', { class: 'result-box' });

  const panel = el('div', { class: 'card card-pad calc-panel' },
    el('h3', { class: 'card-title section-title' }, 'Computation ', modeBadge),
    el('table', { class: 'table' },
      el('tbody', null,
        el('tr', null, el('td', null, el('strong', null, 'R — net amount (excl. tax)')), el('td', { class: 'num' }, netOut)),
        el('tr', null, el('td', null, el('strong', null, 'T — tax')), el('td', { class: 'num' }, taxOut)),
        el('tr', null, el('td', null, el('strong', null, 'A — total payable')), el('td', { class: 'num' }, totalOut)))),
    identityBadge,
    calcHint);

  const root = el('div', { class: 'screen screen-pos' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'POS terminal'),
      el('div', { class: 'grid grid-2' },
        field('Sale date', dateInput),
        field('Item', itemSelect),
        field('Quantity', qtyInput),
        field('Unit price', priceInput),
        field('Tax rate (0.10 = 10%)', taxInput),
        field('Discount rate (0.00 = none)', discInput),
        field('Tender', tenderSelect),
        field('Cash account', accountSelect),
        field('Customer (required for Credit)', customerSelect),
        field('Price includes tax', el('label', { class: 'check-row' }, inclCheck, ' unit price is tax-inclusive'))),
      stockHint,
      panel,
      el('div', { class: 'toolbar row' }, sellBtn),
      receiptBox));

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
    modeBadge.className = 'badge ' + (incl ? 'badge-green' : '');
    const identity = netC + taxC === totalC;
    identityBadge.textContent = identity ? 'R + T = A ✓' : `R + T − A = ${fmt(netC + taxC - totalC)}`;
    identityBadge.className = 'badge ' + (identity ? 'badge badge-success badge-green' : 'badge badge-danger badge-red');

    const item = items.find((it) => String(pick(it, 'ItemCode', 'itemCode', 'code')) === itemSelect.value);
    const stock = item ? Number(pick(item, 'CurrentStock', 'currentStock', 'stock') || 0) : null;
    const outOfStock = stock !== null && q > stock;
    stockHint.textContent = item
      ? (outOfStock
        ? `Requested ${q} but only ${stock} in stock — the kernel will reject with INSUFFICIENT_STOCK.`
        : `On hand: ${stock} · selling price ${fmt(Number(pick(item, 'SellingPrice', 'sellingPrice') || 0))}`)
      : '';
    stockHint.classList.toggle('badge', outOfStock);
    stockHint.classList.toggle('badge-danger', outOfStock);
    stockHint.classList.toggle('badge-red', outOfStock);

    const credit = tenderSelect.value === 'Credit';
    const needCustomer = credit && !customerSelect.value;
    const ok = Boolean(itemSelect.value) && q > 0 && p > 0 && !needCustomer;
    sellBtn.disabled = !ok;
    calcHint.textContent = ok
      ? `Q×P = ${fmt(q * p)} · discount ${fmt(Math.round(q * p - q * p * (1 - d)))} (${(d * 100).toFixed(2)}%) · rate ${(r * 100).toFixed(2)}%`
      : 'Select an item, quantity and price to continue.';
    return { q, p, r, d, incl, netC, taxC, totalC, ok, credit };
  }

  function resetForm() {
    itemSelect.value = '';
    qtyInput.value = '1';
    priceInput.value = '';
    discInput.value = '0.00';
    taxInput.value = '0.10';
    inclCheck.checked = false;
    tenderSelect.value = 'Cash';
    customerSelect.value = '';
    accountSelect.value = CASH_TILL;
    calc();
  }

  /* ----------------------------- submit ------------------------------ */
  async function takePayment() {
    const c = calc();
    if (!c.ok) return;
    sellBtn.disabled = true;
    try {
      const res = await call('pos.sale', {
        voucherDate: dateInput.value || today(),
        itemCode: itemSelect.value,
        qty: c.q,
        unitPriceCents: c.p,
        taxRate: c.r,
        discountRate: c.d,
        priceIncludesTax: c.incl,
        tender: tenderSelect.value,
        entityId: c.credit && customerSelect.value ? Number(customerSelect.value) : undefined,
        accountCode: accountSelect.value,
        createdBy: uid(h),
      });
      const voucher = (res && res.voucher) || res || {};
      const voucherNo = voucher.voucherNo ?? res?.voucherNo ?? '(no number)';
      const cogs = cogsFrom(res);
      toast(`Sale posted — ${voucherNo}`, 'success');
      receiptBox.replaceChildren(
        el('div', { class: 'card card-pad receipt' },
          el('div', { class: 'receipt-head' },
            el('span', { class: 'card-title section-title' }, 'Sale confirmation'),
            el('span', { class: 'badge badge-success badge-green' }, String(voucherNo))),
          el('table', { class: 'table' },
            el('tbody', null,
              el('tr', null, el('td', null, 'Date'), el('td', { class: 'num' }, String(voucher.voucherDate ?? dateInput.value))),
              el('tr', null, el('td', null, 'Item'), el('td', { class: 'num' }, `${itemSelect.value} × ${c.q}`)),
              el('tr', null, el('td', null, 'Tender'), el('td', { class: 'num' }, tenderSelect.value)),
              el('tr', null, el('td', null, 'R — net'), el('td', { class: 'num money' }, fmt(c.netC))),
              el('tr', null, el('td', null, 'T — tax'), el('td', { class: 'num money' }, fmt(c.taxC))),
              el('tr', null, el('td', null, 'A — total'), el('td', { class: 'num money' }, fmt(c.totalC))),
              cogs === null ? null : el('tr', null,
                el('td', null, 'FIFO cost of goods sold'),
                el('td', { class: 'num money' }, fmt(cogs)))))));
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
  tenderSelect.addEventListener('change', () => {
    accountSelect.value = tenderSelect.value === 'Credit' ? AR : CASH_TILL;
    calc();
  });
  [qtyInput, priceInput, taxInput, discInput, inclCheck, customerSelect].forEach((n) => {
    n.addEventListener('input', calc);
    n.addEventListener('change', calc);
  });
  sellBtn.addEventListener('click', takePayment);

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
    const customers = entities.filter((e) => !pick(e, 'EntityType', 'entityType') || String(pick(e, 'EntityType', 'entityType')).toLowerCase() === 'customer');
    for (const c of customers) {
      const id = pick(c, 'EntityId', 'entityId', 'id');
      const name = String(pick(c, 'FullName', 'fullName', 'name') ?? `Entity ${id}`);
      if (id === undefined) continue;
      customerSelect.append(el('option', { value: String(id) }, name));
    }
    calc();
  }).catch((e) => fail(e));

  calc();
  return root;
}

export default render;
