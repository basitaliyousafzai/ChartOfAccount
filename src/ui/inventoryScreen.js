'use strict';

/* ==========================================================================
 * Inventory catalogue (src/ui/inventoryScreen.js)
 *   • item table          → inventory.items
 *   • create-item modal   → inventory.createItem
 *   • FIFO lot queue view → inventory.lots + inventory.valuation
 *   • physical count      → inventory.shrinkage
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
            Promise.resolve(ret).then((r) => { if (r !== false) LOCAL.closeModal(); }).catch((e) => {
              if (e && e.__toasted) return;
              LOCAL.toast(e && e.message ? e.message : String(e), 'error');
            });
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

const SHRINKAGE_ACCOUNT = '6.10.05.0001.0001'; // Inventory Shrinkage & Write-Off

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
  const modal = (o) => h.modal(o);
  const closeModal = () => h.closeModal();
  // Kernel errors already toasted by shell `call` (marked __toasted) — avoid dupes.
  const fail = (e) => { if (e && e.__toasted) return; toast(errMsg(e), 'error'); };
  const field = (label, ...controls) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), ...controls);

  let items = [];
  let filterText = '';

  const tbody = el('tbody', null, el('tr', null, el('td', { colspan: '8', class: 'muted' }, 'Loading…')));
  const searchInput = el('input', { class: 'input', type: 'search', placeholder: 'Filter by code or name…' });
  const countBadge = el('span', { class: 'badge' }, '0 items');
  const newItemBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '+ New item');

  const root = el('div', { class: 'screen screen-inventory' },
    el('div', { class: 'card card-pad' },
      el('div', { class: 'row between' },
        el('h2', { class: 'card-title section-title' }, 'Item catalogue ', countBadge),
        el('div', { class: 'row' },
          el('span', { class: 'search-box' }, searchInput),
          newItemBtn)),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' },
          el('thead', null,
            el('tr', null,
              el('th', null, 'Code'),
              el('th', null, 'Name'),
              el('th', { class: 'num' }, 'Stock'),
              el('th', { class: 'num' }, 'Reorder'),
              el('th', { class: 'num' }, 'Cost'),
              el('th', { class: 'num' }, 'Sell'),
              el('th', null, 'Valuation'),
              el('th', null, ''))),
          tbody))));

  view.replaceChildren(root);

  /* --------------------------- rendering ----------------------------- */
  function matches(it) {
    if (!filterText) return true;
    const code = String(pick(it, 'ItemCode', 'itemCode', 'code') ?? '').toLowerCase();
    const name = String(pick(it, 'ItemName', 'itemName', 'name') ?? '').toLowerCase();
    return code.includes(filterText) || name.includes(filterText);
  }

  function renderTable() {
    const rows = items.filter(matches);
    countBadge.textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
    tbody.replaceChildren();
    if (!rows.length) {
      tbody.append(el('tr', null, el('td', { colspan: '8', class: 'muted' },
        items.length ? 'No item matches the filter.' : 'No items yet — create the first one.')));
      return;
    }
    for (const it of rows) {
      const code = String(pick(it, 'ItemCode', 'itemCode', 'code') ?? '');
      const name = String(pick(it, 'ItemName', 'itemName', 'name') ?? '');
      const stock = Number(pick(it, 'CurrentStock', 'currentStock', 'stock') ?? 0);
      const reorder = Number(pick(it, 'ReorderLevel', 'reorderLevel') ?? 0);
      const cost = Number(pick(it, 'CostPrice', 'costPrice') ?? 0);
      const sell = Number(pick(it, 'SellingPrice', 'sellingPrice') ?? 0);
      const low = reorder > 0 && stock <= reorder;

      const lotsBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'FIFO lots');
      lotsBtn.addEventListener('click', () => openLots(code));
      const countBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Physical count');
      countBtn.addEventListener('click', () => openShrinkage(code, stock));

      tbody.append(el('tr', null,
        el('td', { class: 'mono' }, code),
        el('td', null, name),
        el('td', { class: 'num' },
          el('span', { class: 'badge ' + (low ? 'badge badge-danger badge-red' : 'badge badge-success badge-green') }, String(stock))),
        el('td', { class: 'num muted' }, String(reorder)),
        el('td', { class: 'num money' }, fmt(cost)),
        el('td', { class: 'num money' }, fmt(sell)),
        el('td', null, el('span', { class: 'muted small' }, 'open lots for value')),
        el('td', null, el('span', { class: 'row' }, lotsBtn, countBtn))));
    }
  }

  async function load() {
    try {
      items = (await call('inventory.items')) || [];
      renderTable();
    } catch (e) {
      fail(e);
      tbody.replaceChildren(el('tr', null, el('td', { colspan: '8', class: 'muted' }, errMsg(e))));
    }
  }

  /* ------------------------- create item modal ----------------------- */
  function openCreateItem() {
    const codeIn = el('input', { class: 'input', type: 'text', placeholder: 'e.g. SKU-0001' });
    const nameIn = el('input', { class: 'input', type: 'text', placeholder: 'Item name' });
    const sellIn = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
    const costIn = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
    const stockIn = el('input', { class: 'input', type: 'number', min: '0', step: '1', value: '0' });
    const reorderIn = el('input', { class: 'input', type: 'number', min: '0', step: '1', value: '0' });

    modal({
      title: 'Create inventory item',
      body: el('div', { class: 'grid grid-2' },
        field('Item code *', codeIn),
        field('Item name *', nameIn),
        field('Selling price *', sellIn),
        field('Cost price', costIn),
        field('Opening stock', stockIn),
        field('Reorder level', reorderIn)),
      actions: [
        { label: 'Cancel', kind: 'btn btn-ghost' },
        {
          label: 'Create item',
          kind: 'btn btn-primary',
          onClick: async () => {
            const itemCode = String(codeIn.value || '').trim();
            const itemName = String(nameIn.value || '').trim();
            if (!itemCode || !itemName) { toast('Item code and name are required', 'error'); return false; }
            const created = await call('inventory.createItem', {
              itemCode,
              itemName,
              sellingPrice: centsOf(sellIn.value),
              costPrice: centsOf(costIn.value),
              currentStock: Math.max(0, Math.round(num(stockIn.value))),
              reorderLevel: Math.max(0, Math.round(num(reorderIn.value))),
            });
            const newCode = String(pick(created, 'ItemCode', 'itemCode', 'code') ?? itemCode);
            toast(`Item ${newCode} created`, 'success');
            load();
            return undefined; // close
          },
        },
      ],
    });
  }

  /* --------------------------- FIFO lots modal ----------------------- */
  function openLots(itemCode) {
    const body = el('div', null, el('p', { class: 'hint' }, 'Loading FIFO queue…'));
    modal({
      title: `FIFO lot queue — ${itemCode}`,
      body,
      actions: [{ label: 'Close', kind: 'btn btn-ghost' }],
    });

    Promise.all([
      call('inventory.lots', { itemCode }),
      call('inventory.valuation', { itemCode }),
    ]).then(([lots, val]) => {
      const v = val || {};
      const qty = Number(pick(v, 'qty', 'Qty', 'currentStock') ?? 0);
      const value = Number(pick(v, 'valueCents', 'ValueCents', 'value') ?? 0);
      const avg = Number(pick(v, 'avgCostCents', 'AvgCostCents', 'avgCost') ?? 0);
      const list = lots || [];

      const valGrid = el('div', { class: 'grid grid-3' },
        el('div', { class: 'card card-pad' },
          el('div', { class: 'hint' }, 'Quantity on hand'),
          el('div', { class: 'money strong' }, String(qty))),
        el('div', { class: 'card card-pad' },
          el('div', { class: 'hint' }, 'Stock value'),
          el('div', { class: 'money strong' }, fmt(value))),
        el('div', { class: 'card card-pad' },
          el('div', { class: 'hint' }, 'Average cost'),
          el('div', { class: 'money strong' }, fmt(avg))));

      const lotRows = list.map((l) => {
        const lotQty = Number(pick(l, 'QtyRemaining', 'qtyRemaining') ?? 0);
        const unit = Number(pick(l, 'UnitCost', 'unitCost') ?? 0);
        const lotValue = pick(l, 'ValueCents', 'valueCents');
        return el('tr', null,
          el('td', null, String(pick(l, 'LotId', 'lotId') ?? '')),
          el('td', null, String(pick(l, 'ReceiptDate', 'receiptDate') ?? '')),
          el('td', { class: 'num' }, String(lotQty)),
          el('td', { class: 'num money' }, fmt(unit)),
          el('td', { class: 'num money' }, fmt(lotValue !== undefined ? Number(lotValue) : lotQty * unit)));
      });

      body.replaceChildren(
        valGrid,
        el('div', { class: 'table-wrap mt-1' },
          el('table', { class: 'table' },
            el('thead', null,
              el('tr', null,
                el('th', null, 'Lot'),
                el('th', null, 'Received'),
                el('th', { class: 'num' }, 'Qty left'),
                el('th', { class: 'num' }, 'Unit cost'),
                el('th', { class: 'num' }, 'Value'))),
            el('tbody', null,
              lotRows.length
                ? lotRows
                : el('tr', null, el('td', { colspan: '5', class: 'muted' }, 'No open lots — stock is empty.'))))),
        el('p', { class: 'hint mt-1' },
          'Lots are consumed strictly front-to-back (FIFO); value = Σ QtyRemaining × UnitCost.'));
    }).catch((e) => {
      body.replaceChildren(el('p', { class: 'error-text' }, errMsg(e)));
    });
  }

  /* ------------------------- shrinkage modal ------------------------- */
  function openShrinkage(itemCode, counted) {
    const dateIn = el('input', { class: 'input', type: 'date', value: today() });
    const countIn = el('input', { class: 'input', type: 'number', min: '0', step: '1', value: String(counted) });
    const expenseIn = el('input', { class: 'input', type: 'text', value: SHRINKAGE_ACCOUNT });
    const bookQty = Math.max(0, Math.round(num(counted)));
    /* Dry run BEFORE the count is committed. `inventory.previewFifoCost` is the
     * same call `inventory.shrinkage` makes internally, so the value shown here
     * is exactly what the write-off voucher will book — no second opinion. */
    const previewBox = el('p', { class: 'hint muted' }, 'FIFO write-off preview…');

    let previewTimer = null;
    const refreshPreview = () => {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        const entered = Math.max(0, Math.round(num(countIn.value)));
        const shortfall = bookQty - entered;
        if (shortfall <= 0) {
          previewBox.className = 'hint ' + (shortfall < 0 ? 'error-text' : 'muted');
          previewBox.textContent = shortfall < 0
            ? `Counted (${entered}) exceeds book (${bookQty}) — count-up gains need a separate voucher, so this will be rejected.`
            : 'Counted equals book quantity — nothing to write off.';
          return;
        }
        try {
          const p = await call('inventory.previewFifoCost', { itemCode, qty: shortfall });
          const layers = (p.layers || []).filter((l) => Number(l.qty) > 0);
          previewBox.className = 'hint';
          previewBox.textContent =
            `FIFO write-off ${shortfall} unit${shortfall === 1 ? '' : 's'} = ${fmt(p.costCents)}`
            + (layers.length
              ? ` across ${layers.length} lot${layers.length === 1 ? '' : 's'} (`
                + layers.map((l) => `${l.qty} @ ${fmt(Number(l.valueCents) / Number(l.qty))}`).join(' · ') + ')'
              : '');
        } catch (e) {
          previewBox.className = 'hint error-text';
          previewBox.textContent = `Preview unavailable: ${errMsg(e)}`;
        }
      }, 220);
    };
    countIn.addEventListener('input', refreshPreview);
    countIn.addEventListener('change', refreshPreview);
    refreshPreview();

    modal({
      title: `Physical count / shrinkage — ${itemCode}`,
      body: el('div', null,
        el('div', { class: 'grid grid-2' },
          field('Count date', dateIn),
          field('Counted quantity *', countIn),
          field('Expense account', expenseIn)),
        previewBox,
        el('p', { class: 'hint muted' }, `Book quantity on hand: ${bookQty}`)),
      actions: [
        { label: 'Cancel', kind: 'btn btn-ghost' },
        {
          label: 'Post adjustment',
          kind: 'btn btn-primary',
          onClick: async () => {
            const countedQty = Math.max(0, Math.round(num(countIn.value)));
            const res = await call('inventory.shrinkage', {
              voucherDate: dateIn.value || today(),
              itemCode,
              countedQty,
              expenseAccountCode: String(expenseIn.value || '').trim() || SHRINKAGE_ACCOUNT,
              createdBy: uid(h),
            });
            const voucher = (res && res.voucher) || res || {};
            const voucherNo = voucher.voucherNo ?? res?.voucherNo ?? '(no number)';
            const meta = (res && res.meta) || {};
            toast(`Shrinkage posted (${voucherNo}) — ${fmt(meta.valueCents)} written off`, 'success');
            load();
            return undefined; // close
          },
        },
      ],
    });
  }

  /* ----------------------------- wiring ------------------------------ */
  newItemBtn.addEventListener('click', openCreateItem);
  searchInput.addEventListener('input', () => {
    filterText = String(searchInput.value || '').trim().toLowerCase();
    renderTable();
  });

  load();
  return root;
}

export default render;
