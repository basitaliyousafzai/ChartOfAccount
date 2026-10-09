'use strict';

/* ==========================================================================
 * Classified Balance Sheet (src/ui/balanceSheet.js)
 *   report.balanceSheet { asOfDate } →
 *   Current / Non-Current assets, Current / LT liabilities, Owner equity
 *   with subtotals and the equilibrium footer  A − (L + E) = $0.00.
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
  modal(opts) {
    LOCAL.closeModal();
    const o = opts || {};
    const body = o.nodeType ? LOCAL.el('div', { class: 'modal-body' }, o)
      : LOCAL.el('div', { class: 'modal-body' }, typeof o.body === 'string' ? o.body : (o.body || null));
    const closeBtn = LOCAL.el('button', { class: 'btn btn-ghost modal-close', type: 'button', 'aria-label': 'Close' }, '✕');
    const box = LOCAL.el('div', { class: 'modal-box card' },
      LOCAL.el('div', { class: 'modal-head' }, LOCAL.el('span', { class: 'modal-title' }, o.title || ''), closeBtn),
      body);
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
const errMsg = (e) => (e && e.message) || (typeof e === 'string' ? e : 'Kernel call failed');
const pick = (row, ...names) => {
  if (!row) return undefined;
  for (const n of names) if (row[n] !== undefined && row[n] !== null) return row[n];
  return undefined;
};
const amountOf = (row) => Number(pick(row, 'amount', 'Amount', 'amountCents', 'balance', 'Balance',
  'totalDebit', 'totalCredit', 'Debit', 'Credit', 'value', 'valueCents') || 0);

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

  let lastParams = { asOfDate: today() };

  const dateInput = el('input', { class: 'input', type: 'date', value: today() });
  const runBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Run');
  const printBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Print');
  const xlsxBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Export XLSX');
  const pdfBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Export PDF');

  const bodyBox = el('div', { class: 'card card-pad' }, el('p', { class: 'hint' }, 'Loading…'));

  const root = el('div', { class: 'screen screen-balance-sheet' },
    el('div', { class: 'page-head' },
      el('div', null,
        el('h2', { class: 'card-title section-title' }, 'Balance Sheet'),
        el('p', { class: 'subtitle' }, 'Classified statement of financial position.')),
      el('div', { class: 'page-actions' },
        field('As of date', dateInput),
        runBtn, printBtn, xlsxBtn, pdfBtn)),
    bodyBox);

  view.replaceChildren(root);

  /* ----------------------------- helpers ----------------------------- */
  const sectionTable = (title, list, subtotalLabel, subtotalValue) => {
    const rows = (Array.isArray(list) ? list : []).map((item) => el('tr', null,
      el('td', { class: 'mono small' }, String(pick(item, 'AccountCode', 'accountCode', 'code') ?? '')),
      el('td', null, String(pick(item, 'AccountName', 'accountName', 'name') ?? '')),
      el('td', { class: 'num money' }, fmt(amountOf(item)))));
    return el('div', { class: 'card card-pad mb-2' },
      el('h3', { class: 'card-title section-title' }, title),
      el('table', { class: 'table' },
        el('thead', null, el('tr', null,
          el('th', null, 'Code'), el('th', null, 'Account'), el('th', { class: 'num' }, 'Amount'))),
        el('tbody', null,
          rows.length ? rows : el('tr', null, el('td', { colspan: '3', class: 'muted' }, '— none —'))),
        el('tfoot', null, el('tr', { class: 'total-row' },
          el('td', { colspan: '2' }, el('strong', null, subtotalLabel)),
          el('td', { class: 'num money strong' }, fmt(subtotalValue))))));
  };

  /* ----------------------------- render ------------------------------ */
  function renderSheet(r) {
    const currentAssets = Array.isArray(r.currentAssets) ? r.currentAssets : [];
    const nonCurrent = Array.isArray(r.nonCurrentAssets) ? r.nonCurrentAssets : [];
    const currentLiab = Array.isArray(r.currentLiabilities) ? r.currentLiabilities : [];
    const longTerm = Array.isArray(r.longTermLiabilities) ? r.longTermLiabilities : [];
    const equity = Array.isArray(r.equity) ? r.equity : [];

    const caTotal = Number(pick(r, 'totalCurrentAssets') ?? currentAssets.reduce((s, x) => s + amountOf(x), 0));
    const ncaTotal = Number(pick(r, 'totalNonCurrentAssets') ?? nonCurrent.reduce((s, x) => s + amountOf(x), 0));
    const totalAssets = Number(pick(r, 'totalAssets') ?? (caTotal + ncaTotal));
    const clTotal = Number(pick(r, 'totalCurrentLiabilities') ?? currentLiab.reduce((s, x) => s + amountOf(x), 0));
    const ltTotal = Number(pick(r, 'totalLongTermLiabilities') ?? longTerm.reduce((s, x) => s + amountOf(x), 0));
    const totalLiabilities = Number(pick(r, 'totalLiabilities') ?? (clTotal + ltTotal));
    const equityTotal = Number(pick(r, 'totalEquity') ?? equity.reduce((s, x) => s + amountOf(x), 0));
    const leTotal = totalLiabilities + equityTotal;
    const delta = Number(pick(r, 'delta') ?? (totalAssets - leTotal));
    const balanced = delta === 0;

    const equityTable = el('div', { class: 'card card-pad mb-2' },
      el('h3', { class: 'card-title section-title' }, 'Owner Equity'),
      el('table', { class: 'table' },
        el('thead', null, el('tr', null,
          el('th', null, 'Code'), el('th', null, 'Account'), el('th', { class: 'num' }, 'Amount'))),
        el('tbody', null,
          equity.length
            ? equity.map((item) => el('tr', null,
                el('td', { class: 'mono small' }, String(pick(item, 'AccountCode', 'accountCode', 'code') ?? '')),
                el('td', null, String(pick(item, 'AccountName', 'accountName', 'name') ?? '')),
                el('td', { class: 'num money' }, fmt(amountOf(item)))))
            : el('tr', null, el('td', { colspan: '3', class: 'muted' }, '— none —'))),
        el('tfoot', null, el('tr', { class: 'total-row' },
          el('td', { colspan: '2' }, el('strong', null, 'Total Equity')),
          el('td', { class: 'num money strong' }, fmt(equityTotal))))));

    const summary = el('div', { class: 'card card-pad' },
      el('h3', { class: 'card-title section-title' }, 'Statement totals'),
      el('table', { class: 'table' },
        el('tbody', null,
          el('tr', null, el('td', null, 'Total Current Assets'), el('td', { class: 'num money' }, fmt(caTotal))),
          el('tr', null, el('td', null, 'Total Non-Current Assets'), el('td', { class: 'num money' }, fmt(ncaTotal))),
          el('tr', { class: 'total-row' }, el('td', null, el('strong', null, 'TOTAL ASSETS')),
            el('td', { class: 'num money strong' }, fmt(totalAssets))),
          el('tr', null, el('td', null, 'Total Current Liabilities'), el('td', { class: 'num money' }, fmt(clTotal))),
          el('tr', null, el('td', null, 'Total Long-Term Liabilities'), el('td', { class: 'num money' }, fmt(ltTotal))),
          el('tr', { class: 'total-row' }, el('td', null, el('strong', null, 'TOTAL LIABILITIES')),
            el('td', { class: 'num money strong' }, fmt(totalLiabilities))),
          el('tr', { class: 'total-row' }, el('td', null, el('strong', null, 'TOTAL EQUITY')),
            el('td', { class: 'num money strong' }, fmt(equityTotal))),
          el('tr', null, el('td', null, 'Liabilities + Equity'), el('td', { class: 'num money' }, fmt(leTotal))),
          el('tr', { class: 'total-row' },
            el('td', null, el('strong', null, 'A − (L + E)'), ' ',
              el('span', { class: 'hint' }, `assets ${fmt(totalAssets)} − obligations ${fmt(leTotal)}`)),
            el('td', { class: 'num' },
              el('span', {
                class: 'badge ' + (balanced ? 'badge badge-success badge-green' : 'badge badge-danger badge-red'),
              }, `A − (L + E) = ${fmt(delta)}`))))));

    bodyBox.replaceChildren(
      el('div', { class: 'grid grid-2' },
        el('div', null,
          sectionTable('Current Assets', currentAssets, 'Subtotal — Current Assets', caTotal),
          sectionTable('Non-Current Assets', nonCurrent, 'Subtotal — Non-Current Assets', ncaTotal)),
        el('div', null,
          sectionTable('Current Liabilities', currentLiab, 'Subtotal — Current Liabilities', clTotal),
          sectionTable('Long-Term Liabilities', longTerm, 'Subtotal — LT Liabilities', ltTotal))),
      equityTable,
      summary);
  }

  async function load() {
    lastParams = { asOfDate: dateInput.value || today() };
    bodyBox.replaceChildren(el('div', { class: 'card card-pad' }, el('p', { class: 'hint' }, 'Computing…')));
    try {
      const res = await call('report.balanceSheet', lastParams);
      renderSheet(res || {});
    } catch (e) {
      fail(e);
      bodyBox.replaceChildren(el('div', { class: 'card card-pad' }, el('p', { class: 'error-text' }, errMsg(e))));
    }
  }

  /* ----------------------------- actions ----------------------------- */
  runBtn.addEventListener('click', load);
  dateInput.addEventListener('change', load);
  printBtn.addEventListener('click', () => { try { window.print(); } catch (e) { fail(e); } });
  xlsxBtn.addEventListener('click', async () => {
    xlsxBtn.disabled = true;
    try {
      const res = await call('export.workbook', { kind: 'balanceSheet', params: lastParams });
      toast(`XLSX written: ${(res && res.path) || 'done'}`, 'success');
    } catch (e) { fail(e); } finally { xlsxBtn.disabled = false; }
  });
  pdfBtn.addEventListener('click', async () => {
    pdfBtn.disabled = true;
    try {
      const res = await call('export.pdf', { kind: 'balanceSheet', params: lastParams });
      toast(`PDF written: ${(res && res.path) || 'done'}`, 'success');
    } catch (e) { fail(e); } finally { pdfBtn.disabled = false; }
  });

  load();
  return root;
}

export default render;
