'use strict';

/* ==========================================================================
 * Multi-currency settlement (src/ui/forexSettlement.js)
 *   Tab 1 "Settle receivable" → forex.preview (dry run) + forex.settle
 *   Tab 2 "Settlement history"→ forex.history
 *
 * Equation 9 / IAS 21 (Section 3.8):
 *   V_orig   = F_curr x E_orig     receivable as originally booked
 *   V_settle = F_curr x E_settle    cash actually realised
 *   Delta    = V_settle - V_orig    >0 gain (revenue) | <0 loss (expense)
 *
 * The preview calls `forex.preview`, which shares `convert()` with the real
 * posting, so the gain/loss shown beforehand IS the gain/loss booked.
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

const BANK_MAIN = '1.10.01.0002.0001';
const BANK_SECONDARY = '1.10.01.0002.0002';
const CASH_TILL = '1.10.01.0001.0001';

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
  const fail = (e) => { if (e && e.__toasted) return; toast(errMsg(e), 'error'); };

  const field = (label, ...controls) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), ...controls);
  const mkDate = () => el('input', { class: 'input', type: 'date', value: today() });
  const moneyIn = (ph) => el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: ph || '0.00' });
  const rateIn = (ph) => el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: ph || '0.000000' });

  function receiptBox(title, rows) {
    return el('div', { class: 'card card-pad receipt' },
      el('div', { class: 'receipt-head' },
        el('span', { class: 'card-title section-title' }, title),
        el('span', { class: 'badge badge-success badge-green' }, String(rows.voucherNo))),
      el('table', { class: 'table' },
        el('tbody', null, ...rows.lines.map(([k, v]) =>
          el('tr', null, el('td', null, k), el('td', { class: 'num' }, v))))));
  }

  function table(cols, rows) {
    return el('table', { class: 'table' },
      el('thead', null, el('tr', null, ...cols.map((c) => el('th', { class: c.num ? 'num' : null }, c.label)))),
      el('tbody', null, ...rows.map((r) => el('tr', null,
        ...cols.map((c) => el('td', { class: c.num ? 'num' : null }, c.render(r)))))));
  }

  /* --------------------- tab 1: settle receivable --------------------- */
  const setDate = mkDate();
  const setInvoice = el('select', { class: 'select' }, el('option', { value: '' }, 'Select sales invoice…'));
  const setCurrency = el('input', { class: 'input', type: 'text', maxlength: '3', value: 'EUR' });
  const setForeign = moneyIn('0.00');
  const setOrigRate = rateIn('0.000000');
  const setSettleRate = rateIn('0.000000');
  const setInto = el('select', { class: 'select' },
    el('option', { value: BANK_MAIN }, 'Primary Operating Bank (1.10.01.0002.0001)'),
    el('option', { value: BANK_SECONDARY }, 'Secondary Savings / Tax A/C (1.10.01.0002.0002)'),
    el('option', { value: CASH_TILL }, 'Main Cash Till (1.10.01.0001.0001)'));
  const setCustomer = el('select', { class: 'select' }, el('option', { value: '' }, 'Unallocated'));
  const setMemo = el('input', { class: 'input', type: 'text', placeholder: 'Memo (optional)' });
  const setHint = el('p', { class: 'hint muted' },
    'Rates are units of base currency per 1 foreign unit, 6 decimal places. ' +
    'A rate change on an already-booked receivable is a realised gain or loss, never an FX revaluation of the balance itself.');
  const setPreview = el('div', { class: 'result-box' });
  const setBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Settle receivable');
  const setResult = el('div', { class: 'result-box' });
  setBtn.disabled = true;

  /* ---------------------- tab 2: settlement history ------------------- */
  const histSummary = el('p', { class: 'hint muted' }, 'Loading settlement history…');
  const histBox = el('div', { class: 'result-box' });
  const histRefresh = el('button', { class: 'btn btn-ghost', type: 'button' }, '↻ Refresh history');

  /* ----------------------------- tab shell ---------------------------- */
  const TABS = [
    ['settle', 'Settle receivable'],
    ['history', 'Settlement history'],
  ];
  const tabButtons = {};
  const panels = {
    settle: el('div', { class: 'card card-pad tab-panel' },
      el('h3', { class: 'card-title section-title' }, 'Settle a foreign-currency receivable'),
      el('div', { class: 'grid grid-2' },
        field('Settlement date', setDate),
        field('Sales invoice *', setInvoice),
        field('Currency *', setCurrency),
        field('Foreign amount *', setForeign),
        field('Original rate *', setOrigRate),
        field('Settlement rate *', setSettleRate),
        field('Received into', setInto),
        field('Customer', setCustomer),
        field('Memo', setMemo)),
      setHint,
      setPreview,
      el('div', { class: 'toolbar row' }, setBtn),
      setResult),
    history: el('div', { class: 'card card-pad tab-panel' },
      el('h3', { class: 'card-title section-title' }, 'Settlement history (IAS 21 audit)'),
      histSummary, histBox,
      el('div', { class: 'toolbar row' }, histRefresh)),
  };

  function activate(key) {
    for (const [k, btn] of Object.entries(tabButtons)) {
      const on = k === key;
      btn.className = 'tab-btn ' + (on ? 'btn btn-primary active' : 'btn btn-ghost');
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      panels[k].style.display = on ? '' : 'none';
    }
  }

  const tabBar = el('div', { class: 'tabs row' });
  const panelBox = el('div', { class: 'tab-panels' });
  for (const [key, label] of TABS) {
    const btn = el('button', { class: 'tab-btn btn btn-ghost', type: 'button', role: 'tab' }, label);
    btn.addEventListener('click', () => activate(key));
    tabButtons[key] = btn;
    tabBar.append(btn);
    panelBox.append(panels[key]);
  }

  const root = el('div', { class: 'screen screen-forex' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'Multi-currency settlement'),
      tabBar),
    panelBox);
  view.replaceChildren(root);
  activate('settle');

  /* --------------------------- validation ----------------------------- */
  function formState() {
    return {
      invoiceVoucherId: Number(setInvoice.value) || null,
      currency: String(setCurrency.value || '').trim().toUpperCase(),
      foreign: centsOf(setForeign.value),
      origRate: String(setOrigRate.value || '').trim(),
      settleRate: String(setSettleRate.value || '').trim(),
      memo: String(setMemo.value || '').trim() || undefined,
    };
  }

  function refresh() {
    const s = formState();
    const ok = Boolean(s.invoiceVoucherId)
      && /^[A-Z]{3}$/.test(s.currency)
      && s.foreign > 0
      && num(s.origRate) > 0
      && num(s.settleRate) > 0
      && Boolean(setInto.value);
    setBtn.disabled = !ok;
    if (!ok) {
      setPreview.replaceChildren(el('p', { class: 'hint muted' },
        'Fill the invoice, currency, amount and both rates to see the realised gain/loss.'));
      return;
    }
    schedulePreview(s);
  }

  /* Debounced: one IPC round-trip per settled keystroke burst. */
  let previewTimer = null;
  function schedulePreview(s) {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => runPreview(s), 260);
  }

  async function runPreview(s) {
    try {
      const p = await call('forex.preview', {
        foreignAmountCents: s.foreign,
        originalRate: s.origRate,
        settlementRate: s.settleRate,
      });
      const dir = String(p.direction || 'NEUTRAL');
      const badge = dir === 'GAIN' ? 'badge badge-green badge-success'
        : (dir === 'LOSS' ? 'badge badge-red badge-error' : 'badge');
      setPreview.replaceChildren(el('table', { class: 'table fx-preview' },
        el('tbody', null,
          el('tr', null, el('td', null, `Foreign amount (${s.currency})`),
            el('td', { class: 'num' }, `${(p.foreignAmountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)),
          el('tr', null, el('td', null, `V_orig = F x E_orig  @ ${s.origRate}`),
            el('td', { class: 'num' }, fmt(p.origValueCents))),
          el('tr', null, el('td', null, `V_settle = F x E_settle  @ ${s.settleRate}`),
            el('td', { class: 'num' }, fmt(p.settleValueCents))),
          el('tr', null,
            el('td', null, el('span', { class: badge }, `Delta ${dir}`)),
            el('td', { class: 'num' }, fmt(p.deltaCents))))));
    } catch (e) {
      setPreview.replaceChildren(el('p', { class: 'hint muted' }, `Preview unavailable: ${errMsg(e)}`));
    }
  }

  /* ------------------------------ post -------------------------------- */
  setBtn.addEventListener('click', async () => {
    const s = formState();
    refresh();
    if (setBtn.disabled) return;
    setBtn.disabled = true;
    try {
      const res = await call('forex.settle', {
        voucherDate: setDate.value || today(),
        invoiceVoucherId: s.invoiceVoucherId,
        foreignAmountCents: s.foreign,
        currencyCode: s.currency,
        originalRate: s.origRate,
        settlementRate: s.settleRate,
        accountCode: setInto.value,
        entityId: Number(setCustomer.value) || null,
        memo: s.memo,
        createdBy: uid(h),
      });
      const voucherNo = String(pick(res && res.voucher, 'voucherNo', 'VoucherNo') ?? '(no number)');
      const meta = (res && res.meta) || {};
      toast(`Settled: ${meta.direction || ''} ${fmt(meta.deltaCents)}`, 'success');
      setResult.replaceChildren(receiptBox('Forex settlement', {
        voucherNo,
        lines: [
          ['Date', setDate.value || today()],
          ['Currency', `${s.currency} ${(s.foreign / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`],
          ['Rates', `${s.origRate} → ${s.settleRate}`],
          ['V_orig', fmt(meta.origValueCents)],
          ['V_settle', fmt(meta.settleValueCents)],
          ['Delta', `${meta.direction || ''} ${fmt(meta.deltaCents)}`],
        ],
      }));
      setForeign.value = ''; setMemo.value = '';
      loadHistory();
    } catch (e) {
      fail(e);
    } finally {
      refresh();
    }
  });

  /* ----------------------------- history ------------------------------ */
  async function loadHistory() {
    try {
      const rows = (await call('forex.history')) || [];
      const net = rows.reduce((s, r) => s + Number(pick(r, 'ForexDelta', 'forexDelta') || 0), 0);
      histSummary.textContent = rows.length
        ? `${rows.length} settlement${rows.length === 1 ? '' : 's'} · net realised ${fmt(net)}`
        : 'No settlements recorded yet.';
      if (!rows.length) {
        histBox.replaceChildren(el('p', { class: 'muted' }, 'Nothing settled yet.'));
        return;
      }
      histBox.replaceChildren(table([
        { label: 'Voucher', render: (r) => String(pick(r, 'VoucherNo', 'voucherNo') ?? '') },
        { label: 'Currency', render: (r) => String(pick(r, 'CurrencyCode', 'currencyCode') ?? '') },
        { label: 'Foreign', num: true, render: (r) => (Number(pick(r, 'ForeignAmount', 'foreignAmount') || 0) / 100).toFixed(2) },
        { label: 'E_orig', num: true, render: (r) => String(pick(r, 'OriginalRate', 'originalRate') ?? '') },
        { label: 'E_settle', num: true, render: (r) => String(pick(r, 'SettlementRate', 'settlementRate') ?? '') },
        { label: 'V_orig', num: true, render: (r) => fmt(pick(r, 'OrigValueBase', 'origValueBase')) },
        { label: 'V_settle', num: true, render: (r) => fmt(pick(r, 'SettleValueBase', 'settleValueBase')) },
        {
          label: 'Delta',
          num: true,
          render: (r) => fmt(pick(r, 'ForexDelta', 'forexDelta')),
        },
      ], rows));
    } catch (e) {
      fail(e);
    }
  }
  histRefresh.addEventListener('click', () => { loadHistory(); });

  [setInvoice, setCurrency, setForeign, setOrigRate, setSettleRate,
    setInto, setCustomer, setDate, setMemo].forEach((n) => {
    n.addEventListener('input', refresh);
    n.addEventListener('change', refresh);
  });

  /* ------------------------------ boot -------------------------------- */
  Promise.all([
    call('ledger.list', { voucherType: 'Sales_Invoice', limit: 200 })
      .then((rows) => { return rows || []; }),
    call('report.entities', { type: 'customer' }).then((rows) => { return rows || []; }),
  ]).then(([vouchers, entities]) => {
    for (const v of vouchers) {
      const id = pick(v, 'VoucherId', 'voucherId');
      const no = String(pick(v, 'VoucherNo', 'voucherNo') ?? `#${id}`);
      const date = String(pick(v, 'VoucherDate', 'voucherDate') ?? '');
      if (id === undefined) continue;
      setInvoice.append(el('option', { value: String(id) }, `${no} · ${date}`));
    }
    for (const c of entities) {
      const id = pick(c, 'EntityId', 'entityId', 'id');
      const name = String(pick(c, 'FullName', 'fullName', 'name') ?? `Customer ${id}`);
      if (id === undefined) continue;
      setCustomer.append(el('option', { value: String(id) }, name));
    }
    if (setInvoice.options.length > 1) setInvoice.selectedIndex = 1;
    refresh();
  }).catch((e) => fail(e));

  refresh();
  loadHistory();
  return root;
}

export default render;
