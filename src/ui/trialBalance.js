'use strict';

/* ==========================================================================
 * Trial Balance report (src/ui/trialBalance.js)
 *   report.trialBalance → code / name / normal / DR / CR table
 *   footer ΣDR · ΣCR · Δ badge (zero tolerance), print + XLSX/PDF export.
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

  const tbody = el('tbody', null, el('tr', null, el('td', { colspan: '5', class: 'muted' }, 'Loading…')));
  const drTotal = el('span', { class: 'money strong' }, '$0.00');
  const crTotal = el('span', { class: 'money strong' }, '$0.00');
  const deltaBadge = el('span', { class: 'badge badge-success badge-green' }, 'Δ = $0.00');
  const metaLine = el('span', { class: 'hint muted' }, '');

  const root = el('div', { class: 'screen screen-trial-balance' },
    el('div', { class: 'page-head' },
      el('div', null,
        el('h2', { class: 'card-title section-title' }, 'Trial Balance'),
        el('p', { class: 'subtitle' }, 'All posted balances as of a date — Σ Debits must equal Σ Credits.')),
      el('div', { class: 'page-actions' },
        field('As of date', dateInput),
        runBtn, printBtn, xlsxBtn, pdfBtn)),
    el('div', { class: 'card card-pad' },
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' },
          el('thead', null,
            el('tr', null,
              el('th', null, 'Code'),
              el('th', null, 'Account'),
              el('th', null, 'Normal'),
              el('th', { class: 'num' }, 'DR'),
              el('th', { class: 'num' }, 'CR'))),
          tbody,
          el('tfoot', null,
            el('tr', { class: 'total-row' },
              el('td', { colspan: '3' }, el('strong', null, 'Σ Totals'), ' ', metaLine),
              el('td', { class: 'num' }, drTotal),
              el('td', { class: 'num' }, crTotal)),
            el('tr', null,
              el('td', { colspan: '3' }, el('strong', null, 'Zero-tolerance check')),
              el('td', { colspan: '2', class: 'num' }, deltaBadge)))))));

  view.replaceChildren(root);

  /* ---------------------------- loading ------------------------------ */
  async function load() {
    const params = { asOfDate: dateInput.value || today() };
    lastParams = params;
    tbody.replaceChildren(el('tr', null, el('td', { colspan: '5', class: 'muted' }, 'Computing trial balance…')));
    try {
      const res = await call('report.trialBalance', params) || {};
      const rows = Array.isArray(res) ? res
        : (Array.isArray(res.rows) ? res.rows
          : (Array.isArray(res.data) ? res.data : []));
      const list = rows;
      // Columns come from the signed net (DebitColumn / CreditColumn) so a
      // contra account lands on the correct side - Equation 10 then holds.
      const totalDr = Number(pick(res, 'tbDebit', 'totalDebit', 'debits')
        ?? list.reduce((s, r) => s + Number(pick(r, 'DebitColumn', 'Debit', 'debit', 'totalDebit') || 0), 0));
      const totalCr = Number(pick(res, 'tbCredit', 'totalCredit', 'credits')
        ?? list.reduce((s, r) => s + Number(pick(r, 'CreditColumn', 'Credit', 'credit', 'totalCredit') || 0), 0));
      const delta = Number(pick(res, 'tbDelta', 'delta') ?? Math.abs(totalDr - totalCr));

      tbody.replaceChildren();
      if (!list.length) {
        tbody.append(el('tr', null, el('td', { colspan: '5', class: 'muted' },
          'No posted activity yet — post a journal voucher first.')));
      }
      for (const r of list) {
        const dr = Number(pick(r, 'DebitColumn', 'Debit', 'debit', 'totalDebit') || 0);
        const cr = Number(pick(r, 'CreditColumn', 'Credit', 'credit', 'totalCredit') || 0);
        const normal = String(pick(r, 'NormalBalance', 'normalBalance', 'normal') ?? '');
        tbody.append(el('tr', null,
          el('td', { class: 'mono' }, String(pick(r, 'AccountCode', 'accountCode', 'code') ?? '')),
          el('td', null, String(pick(r, 'AccountName', 'accountName', 'name') ?? '')),
          el('td', null, normal
            ? el('span', { class: 'badge ' + (normal === 'Debit' ? 'badge-dr' : 'badge-cr') }, normal)
            : '—'),
          el('td', { class: 'num money' }, dr ? fmt(dr) : '—'),
          el('td', { class: 'num money' }, cr ? fmt(cr) : '—')));
      }

      drTotal.textContent = fmt(totalDr);
      crTotal.textContent = fmt(totalCr);
      deltaBadge.textContent = `Δ = ${fmt(delta)}`;
      deltaBadge.className = 'badge ' + (delta === 0 ? 'badge badge-success badge-green' : 'badge badge-danger badge-red');
      const gross = pick(res, 'totalDebit');
      metaLine.textContent = `as of ${params.asOfDate} · ${list.length} account${list.length === 1 ? '' : 's'}`
        + (gross !== undefined ? ` · gross ledger Σ ${fmt(Number(gross))}` : '');
    } catch (e) {
      fail(e);
      tbody.replaceChildren(el('tr', null, el('td', { colspan: '5', class: 'muted' }, errMsg(e))));
    }
  }

  /* ----------------------------- actions ----------------------------- */
  runBtn.addEventListener('click', load);
  dateInput.addEventListener('change', load);
  printBtn.addEventListener('click', () => {
    try { window.print(); } catch (e) { fail(e); }
  });
  xlsxBtn.addEventListener('click', async () => {
    xlsxBtn.disabled = true;
    try {
      const res = await call('export.workbook', { kind: 'trialBalance', params: lastParams });
      toast(`XLSX written: ${(res && res.path) || 'done'}`, 'success');
    } catch (e) { fail(e); } finally { xlsxBtn.disabled = false; }
  });
  pdfBtn.addEventListener('click', async () => {
    pdfBtn.disabled = true;
    try {
      const res = await call('export.pdf', { kind: 'trialBalance', params: lastParams });
      toast(`PDF written: ${(res && res.path) || 'done'}`, 'success');
    } catch (e) { fail(e); } finally { pdfBtn.disabled = false; }
  });

  load();
  return root;
}

export default render;
