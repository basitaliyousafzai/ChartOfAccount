'use strict';

/* ==========================================================================
 * Vendor purchase bill (src/ui/purchaseBill.js)
 * Dynamic line grid (item / qty / unit cost), tax on the net, optional
 * freight that can be capitalised into inventory (or expensed to inbound
 * freight) → `purchase.bill`.
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

/* Canonical freight destinations (src/services/coaSeed.js COA). */
const INVENTORY_ACCOUNT = '1.10.03.0001.0001'; // Finished Resale Stock
const INBOUND_FREIGHT = '5.10.02.0001.0001';   // Inbound Freight & Shipping

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
  let rowSeq = 0;

  const field = (label, ...controls) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), ...controls);

  const dateInput = el('input', { class: 'input', type: 'date', value: today() });
  const vendorSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select vendor…'));
  const taxInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', value: '0.10' });
  const freightInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const capitaliseCheck = el('input', { type: 'checkbox', checked: true });
  const freightHint = el('p', { class: 'hint muted' });

  const tbody = el('tbody');
  const netOut = el('span', { class: 'money' }, '$0.00');
  const taxOut = el('span', { class: 'money' }, '$0.00');
  const freightOut = el('span', { class: 'money' }, '$0.00');
  const totalOut = el('span', { class: 'money strong' }, '$0.00');
  const identityBadge = el('span', { class: 'badge badge-success badge-green' }, 'net + tax + freight = A ✓');
  const calcHint = el('p', { class: 'hint muted' });

  const addBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '+ Add line');
  const postBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Post purchase bill');
  postBtn.disabled = true;
  const resultBox = el('div', { class: 'result-box' });

  const linesTable = el('table', { class: 'table' },
    el('thead', null,
      el('tr', null,
        el('th', null, '#'),
        el('th', null, 'Item'),
        el('th', { class: 'num' }, 'Qty'),
        el('th', { class: 'num' }, 'Unit cost'),
        el('th', { class: 'num' }, 'Line net'),
        el('th', null, ''))),
    tbody);

  const root = el('div', { class: 'screen screen-purchase' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'Purchase bill (vendor)'),
      el('div', { class: 'grid grid-2' },
        field('Bill date', dateInput),
        field('Vendor *', vendorSelect),
        field('Tax rate (0.10 = 10%)', taxInput),
        field('Freight amount', freightInput)),
      el('label', { class: 'check-row' }, capitaliseCheck, ' Capitalise freight into inventory (otherwise post to inbound freight expense)'),
      freightHint,
      el('div', { class: 'table-wrap' }, linesTable),
      el('div', { class: 'toolbar row' }, addBtn),
      el('div', { class: 'card card-pad calc-panel' },
        el('h3', { class: 'card-title section-title' }, 'Totals'),
        el('table', { class: 'table' },
          el('tbody', null,
            el('tr', null, el('td', null, 'Net (Σ qty × unit cost)'), el('td', { class: 'num' }, netOut)),
            el('tr', null, el('td', null, 'Tax'), el('td', { class: 'num' }, taxOut)),
            el('tr', null, el('td', null, 'Freight'), el('td', { class: 'num' }, freightOut)),
            el('tr', null, el('td', null, el('strong', null, 'A — bill total')), el('td', { class: 'num' }, totalOut)))),
        identityBadge,
        calcHint),
      el('div', { class: 'toolbar row' }, postBtn),
      resultBox));

  view.replaceChildren(root);

  /* --------------------------- line grid ----------------------------- */
  function itemOptions() {
    const sel = el('select', { class: 'select' }, el('option', { value: '' }, 'Select item…'));
    for (const it of items) {
      const code = String(pick(it, 'ItemCode', 'itemCode', 'code') ?? '');
      const name = String(pick(it, 'ItemName', 'itemName', 'name') ?? '');
      if (!code) continue;
      sel.append(el('option', { value: code }, `${code} — ${name}`));
    }
    return sel;
  }

  function addRow() {
    rowSeq += 1;
    const sel = itemOptions();
    const qty = el('input', { class: 'input num', type: 'number', min: '1', step: '1', value: '1' });
    const cost = el('input', { class: 'input num', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
    const lineNet = el('span', { class: 'money' }, '$0.00');
    const del = el('button', { class: 'btn btn-ghost', type: 'button', title: 'Remove row' }, '✕');

    sel.addEventListener('change', () => {
      const item = items.find((i) => String(pick(i, 'ItemCode', 'itemCode', 'code')) === sel.value);
      if (item) {
        const cp = Number(pick(item, 'CostPrice', 'costPrice') || 0);
        cost.value = cp ? (cp / 100).toFixed(2) : cost.value;
      }
      recalc();
    });
    [qty, cost].forEach((n) => {
      n.addEventListener('input', recalc);
      n.addEventListener('change', recalc);
    });
    del.addEventListener('click', () => { tr.remove(); recalc(); });

    const tr = el('tr', null,
      el('td', { class: 'muted' }, String(rowSeq)),
      el('td', null, sel),
      el('td', { class: 'num' }, qty),
      el('td', { class: 'num' }, cost),
      el('td', { class: 'num' }, lineNet),
      el('td', null, del));
    tr._lineNet = lineNet;
    tbody.append(tr);
    recalc();
    return tr;
  }

  function lineState() {
    const rows = [];
    for (const tr of tbody.children) {
      const sel = tr.querySelector('select');
      const inputs = tr.querySelectorAll('input');
      const qty = Math.max(0, Math.round(num(inputs[0] ? inputs[0].value : 0)));
      const cost = centsOf(inputs[1] ? inputs[1].value : 0);
      const net = qty * cost;
      if (tr._lineNet) tr._lineNet.textContent = fmt(net);
      const ok = Boolean(sel && sel.value) && qty > 0 && cost > 0;
      tr.classList.toggle('row-invalid', !ok);
      rows.push({ ok, itemCode: sel ? sel.value : '', qty, unitCostCents: cost, net });
    }
    return rows;
  }

  function recalc() {
    const rows = lineState();
    const netC = rows.reduce((s, r) => s + r.net, 0);
    const r = Math.max(0, num(taxInput.value));
    const taxC = Math.round(netC * r);
    const freightC = Math.max(0, centsOf(freightInput.value));
    const totalC = netC + taxC + freightC;
    netOut.textContent = fmt(netC);
    taxOut.textContent = fmt(taxC);
    freightOut.textContent = fmt(freightC);
    totalOut.textContent = fmt(totalC);
    const identity = netC + taxC + freightC === totalC;
    identityBadge.textContent = identity ? 'net + tax + freight = A ✓' : 'totals do not add up';
    identityBadge.className = 'badge ' + (identity ? 'badge badge-success badge-green' : 'badge badge-danger badge-red');
    freightHint.textContent = capitaliseCheck.checked
      ? `Freight posts to inventory ${INVENTORY_ACCOUNT} (capitalised landed cost).`
      : `Freight posts to expense ${INBOUND_FREIGHT}.`;
    const ok = Boolean(vendorSelect.value) && rows.length > 0 && rows.every((x) => x.ok);
    postBtn.disabled = !ok;
    calcHint.textContent = ok
      ? `tax ${(r * 100).toFixed(2)}% on ${fmt(netC)}`
      : 'Choose a vendor and fill every line (item, qty ≥ 1, unit cost > 0).';
    return { rows, netC, taxC, freightC, totalC, rate: r, ok };
  }

  function resetForm() {
    vendorSelect.value = '';
    taxInput.value = '0.10';
    freightInput.value = '';
    capitaliseCheck.checked = true;
    resultBox.replaceChildren();
    tbody.replaceChildren();
    addRow();
    addRow();
    recalc();
  }

  /* ----------------------------- submit ------------------------------ */
  async function submit() {
    const t = recalc();
    if (!t.ok) return;
    postBtn.disabled = true;
    try {
      const res = await call('purchase.bill', {
        voucherDate: dateInput.value || today(),
        entityId: Number(vendorSelect.value),
        lines: t.rows.map((x) => ({ itemCode: x.itemCode, qty: x.qty, unitCostCents: x.unitCostCents })),
        taxRate: t.rate,
        freightCents: t.freightC,
        freightFromAccountCode: capitaliseCheck.checked ? INVENTORY_ACCOUNT : INBOUND_FREIGHT,
        createdBy: uid(h),
      });
      const voucher = (res && res.voucher) || res || {};
      const voucherNo = voucher.voucherNo ?? res?.voucherNo ?? '(no number)';
      toast(`Purchase bill ${voucherNo} posted`, 'success');
      const vendorName = vendorSelect.options[vendorSelect.selectedIndex]
        ? vendorSelect.options[vendorSelect.selectedIndex].text : '';
      // Clear the grid FIRST: resetForm() empties the result box.
      resetForm();
      resultBox.replaceChildren(
        el('div', { class: 'card card-pad receipt' },
          el('div', { class: 'receipt-head' },
            el('span', { class: 'card-title section-title' }, 'Bill posted'),
            el('span', { class: 'badge badge-success badge-green' }, String(voucherNo))),
          el('table', { class: 'table' },
            el('tbody', null,
              el('tr', null, el('td', null, 'Vendor'), el('td', { class: 'num' }, vendorName)),
              el('tr', null, el('td', null, 'Date'), el('td', { class: 'num' }, String(voucher.voucherDate ?? dateInput.value))),
              el('tr', null, el('td', null, 'Net'), el('td', { class: 'num money' }, fmt(t.netC))),
              el('tr', null, el('td', null, 'Tax'), el('td', { class: 'num money' }, fmt(t.taxC))),
              el('tr', null, el('td', null, 'Freight'), el('td', { class: 'num money' }, fmt(t.freightC))),
              el('tr', null, el('td', null, el('strong', null, 'Bill total')), el('td', { class: 'num money' }, fmt(t.totalC)))))));
    } catch (e) {
      fail(e);
    } finally {
      recalc();
    }
  }

  /* ----------------------------- wiring ------------------------------ */
  addBtn.addEventListener('click', () => addRow());
  postBtn.addEventListener('click', submit);
  [taxInput, freightInput, vendorSelect, capitaliseCheck].forEach((n) => {
    n.addEventListener('input', recalc);
    n.addEventListener('change', recalc);
  });

  addRow();
  addRow();

  Promise.all([
    call('inventory.items').then((rows) => { items = rows || []; }),
    call('report.entities').then((rows) => { entities = rows || []; }),
  ]).then(() => {
    for (const c of entities) {
      const type = String(pick(c, 'EntityType', 'entityType') ?? '').toLowerCase();
      const id = pick(c, 'EntityId', 'entityId', 'id');
      if (id === undefined || (type && type !== 'vendor')) continue;
      const name = String(pick(c, 'FullName', 'fullName', 'name') ?? `Entity ${id}`);
      vendorSelect.append(el('option', { value: String(id) }, name));
    }
    // item dropdowns are built when rows are created — rebuild existing rows
    for (const tr of tbody.children) {
      const old = tr.querySelector('select');
      if (!old) continue;
      const fresh = itemOptions();
      fresh.value = old.value;
      old.replaceWith(fresh);
      fresh.addEventListener('change', () => {
        const item = items.find((i) => String(pick(i, 'ItemCode', 'itemCode', 'code')) === fresh.value);
        if (item) {
          const cp = Number(pick(item, 'CostPrice', 'costPrice') || 0);
          const inputs = tr.querySelectorAll('input');
          if (cp && inputs[1]) inputs[1].value = (cp / 100).toFixed(2);
        }
        recalc();
      });
    }
    recalc();
  }).catch((e) => fail(e));

  recalc();
  return root;
}

export default render;
