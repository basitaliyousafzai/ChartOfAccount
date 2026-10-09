'use strict';

/* ==========================================================================
 * Manual Journal Voucher (src/ui/journalVoucher.js)
 * Editable double-entry grid with a zero-tolerance live footer:
 *   |Σ Debit − Σ Credit| must be exactly $0.00 before the voucher can post.
 * All money crossing the kernel boundary is INTEGER CENTS.
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * Standalone fallback helpers. The shell (./app.js) supplies the canonical
 * versions through `ctx`, or through the lazy dynamic import below. If both
 * are unavailable the screen still works with these local copies.
 * ------------------------------------------------------------------------ */
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
    t.style.position = 'fixed';
    t.style.top = '16px';
    t.style.right = '16px';
    t.style.zIndex = '9999';
    t.style.padding = '10px 14px';
    t.style.maxWidth = '420px';
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
  closeModal() {
    document.querySelectorAll('.modal-overlay, .modal-backdrop').forEach((n) => n.remove());
  },
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

const VOUCHER_TYPES = [
  ['General_JV', 'General journal (JV)'],
  ['Cash_Receipt', 'Cash receipt (CR)'],
  ['Cash_Payment', 'Cash payment (CP)'],
  ['Bank_Receipt', 'Bank receipt (BR)'],
  ['Bank_Payment', 'Bank payment (BP)'],
];

/* ========================================================================== */

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
  const field = (label, ...controls) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), ...controls);

  /* ---------------------------- state ------------------------------ */
  let accounts = [];
  let rowSeq = 0;

  /* ---------------------------- DOM -------------------------------- */
  const dateInput = el('input', { class: 'input', type: 'date', value: today() });
  const typeSelect = el('select', { class: 'select' },
    ...VOUCHER_TYPES.map(([v, label]) => el('option', { value: v }, label)));
  const narrationInput = el('input', { class: 'input', type: 'text', placeholder: 'Narration (required)', value: '' });
  const refInput = el('input', { class: 'input', type: 'text', placeholder: 'e.g. INV-0042 (optional)', value: '' });

  const tbody = el('tbody');
  const drOut = el('span', { class: 'money' }, '$0.00');
  const crOut = el('span', { class: 'money' }, '$0.00');
  const deltaBadge = el('span', { class: 'badge badge-success badge-green' }, 'Δ = $0.00');
  const hint = el('p', { class: 'hint muted' });
  const resultBox = el('div', { class: 'result-box' });
  const addBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '+ Add line');
  const postBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Post voucher');
  postBtn.disabled = true;

  const linesTable = el('table', { class: 'table jv-grid' },
    el('thead', null,
      el('tr', null,
        el('th', null, '#'),
        el('th', null, 'Account'),
        el('th', { class: 'num' }, 'Debit'),
        el('th', { class: 'num' }, 'Credit'),
        el('th', null, 'Line memo'),
        el('th', null, ''))),
    tbody,
    el('tfoot', null,
      el('tr', null,
        el('td', { colspan: '2' }, el('strong', null, 'Totals')),
        el('td', { class: 'num' }, drOut),
        el('td', { class: 'num' }, crOut),
        el('td', { colspan: '2', class: 'num' }, deltaBadge))));

  const recentBody = el('tbody', null, el('tr', null, el('td', { colspan: '7', class: 'muted' }, 'Loading…')));

  const root = el('div', { class: 'screen screen-journal' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'Manual journal voucher'),
      el('div', { class: 'grid grid-2' },
        field('Voucher date', dateInput),
        field('Voucher type', typeSelect),
        field('Narration', narrationInput),
        field('Reference', refInput)),
      el('div', { class: 'table-wrap' }, linesTable),
      el('div', { class: 'toolbar row' }, addBtn, postBtn, hint),
      resultBox),
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'Recent vouchers'),
      el('table', { class: 'table' },
        el('thead', null,
          el('tr', null,
            el('th', null, 'Voucher'),
            el('th', null, 'Date'),
            el('th', null, 'Type'),
            el('th', null, 'Narration'),
            el('th', { class: 'num' }, 'DR'),
            el('th', { class: 'num' }, 'CR'),
            el('th', null, ''))),
        recentBody)));

  view.replaceChildren(root);

  /* --------------------------- grid rows ---------------------------- */
  function accountSelect() {
    const sel = el('select', { class: 'select account-select' },
      el('option', { value: '' }, 'Select account…'));
    for (const a of accounts) {
      const code = a.AccountCode ?? a.accountCode ?? a.code;
      const name = a.AccountName ?? a.accountName ?? a.name ?? '';
      if (!code) continue;
      sel.append(el('option', { value: code }, `${code} — ${name}`));
    }
    return sel;
  }

  function addRow() {
    rowSeq += 1;
    const sel = accountSelect();
    const debit = el('input', { class: 'input num', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
    const credit = el('input', { class: 'input num', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
    const memo = el('input', { class: 'input', type: 'text', placeholder: 'Line memo (optional)' });
    const del = el('button', { class: 'btn btn-ghost row-del', type: 'button', title: 'Remove row' }, '✕');

    const tr = el('tr', { 'data-row': String(rowSeq) },
      el('td', { class: 'muted row-no' }, String(rowSeq)),
      el('td', null, sel),
      el('td', { class: 'num' }, debit),
      el('td', { class: 'num' }, credit),
      el('td', null, memo),
      el('td', null, del));

    // Typing a debit clears the credit side (one side per line only) and vice versa.
    debit.addEventListener('input', () => { if (num(debit.value) > 0) credit.value = ''; recalc(); });
    credit.addEventListener('input', () => { if (num(credit.value) > 0) debit.value = ''; recalc(); });
    debit.addEventListener('change', recalc);
    credit.addEventListener('change', recalc);
    sel.addEventListener('change', recalc);
    del.addEventListener('click', () => {
      if (tbody.children.length <= 2) { toast('A voucher needs at least two lines', 'error'); return; }
      tr.remove();
      recalc();
    });

    tbody.append(tr);
    recalc();
    return tr;
  }

  function rowState() {
    const rows = [];
    for (const tr of tbody.children) {
      const sel = tr.querySelector('select');
      const inputs = tr.querySelectorAll('input');
      const d = centsOf(inputs[0] ? inputs[0].value : 0);
      const c = centsOf(inputs[1] ? inputs[1].value : 0);
      const memo = inputs[2] ? String(inputs[2].value || '').trim() : '';
      rows.push({ tr, account: sel ? sel.value : '', debit: d, credit: c, memo });
    }
    return rows;
  }

  function recalc() {
    let dr = 0; let cr = 0;
    let rowsOk = tbody.children.length >= 2;
    for (const r of rowState()) {
      dr += r.debit;
      cr += r.credit;
      const sides = (r.debit > 0 ? 1 : 0) + (r.credit > 0 ? 1 : 0);
      if (!r.account || sides !== 1) rowsOk = false;
      r.tr.classList.toggle('row-invalid', !r.account || sides !== 1);
    }
    const delta = Math.abs(dr - cr);
    drOut.textContent = fmt(dr);
    crOut.textContent = fmt(cr);
    deltaBadge.textContent = `Δ = ${fmt(delta)}`;
    deltaBadge.className = 'badge ' + (delta === 0 ? 'badge badge-success badge-green' : 'badge badge-danger badge-red');
    const ready = rowsOk && delta === 0;
    postBtn.disabled = !ready;
    hint.textContent = ready
      ? 'Balanced — ready to post.'
      : 'Every line needs an account and exactly one of Debit / Credit; Σ Debit − Σ Credit must equal $0.00.';
    hint.classList.toggle('badge', !ready);
    hint.classList.toggle('badge-danger', !ready);
    hint.classList.toggle('badge-red', !ready);
    return { dr, cr, delta, ready };
  }

  function resetForm() {
    narrationInput.value = '';
    refInput.value = '';
    typeSelect.value = 'General_JV';
    resultBox.replaceChildren();
    tbody.replaceChildren();
    addRow();
    addRow();
    recalc();
  }

  /* --------------------------- submit ------------------------------- */
  async function submit() {
    const totals = recalc();
    if (!totals.ready) return;
    const lines = rowState()
      .filter((r) => r.account && (r.debit > 0 || r.credit > 0))
      .map((r) => ({
        accountCode: r.account,
        debit: r.debit,
        credit: r.credit,
        lineMemo: r.memo || undefined,
      }));
    const narration = String(narrationInput.value || '').trim();
    if (!narration) { toast('Narration is required', 'error'); narrationInput.focus(); return; }

    postBtn.disabled = true;
    try {
      const payload = {
        voucherDate: dateInput.value || today(),
        voucherType: typeSelect.value,
        narration,
        referenceNo: String(refInput.value || '').trim() || undefined,
        createdBy: uid(h),
        sourceModule: 'Journal',
        lines,
      };
      const res = await call('ledger.record', payload);
      const voucherNo = (res && (res.voucherNo ?? (res.voucher && res.voucher.voucherNo))) || '(no number)';
      toast(`Posted ${voucherNo}`, 'success');
      // Clear the grid FIRST: resetForm() empties the result box.
      resetForm();
      resultBox.replaceChildren(
        el('div', { class: 'card card-pad receipt' },
          el('div', { class: 'card-title section-title' }, 'Voucher posted'),
          el('p', null, 'Assigned voucher number: ',
            el('span', { class: 'badge badge-success badge-green' }, String(voucherNo))),
          el('p', null, `Σ Debit ${fmt(res.totalDebit ?? totals.dr)} · Σ Credit ${fmt(res.totalCredit ?? totals.cr)} · Δ ${fmt(res.delta ?? 0)}`)));
      loadRecent();
    } catch (e) {
      fail(e);
    } finally {
      postBtn.disabled = false;
      recalc();
    }
  }

  /* ------------------------ recent vouchers -------------------------- */
  async function loadRecent() {
    try {
      const rows = (await call('ledger.list', { limit: 12 })) || [];
      recentBody.replaceChildren();
      if (!rows.length) {
        recentBody.append(el('tr', null, el('td', { colspan: '7', class: 'muted' }, 'No vouchers posted yet.')));
        return;
      }
      for (const v of rows) {
        const id = v.VoucherId ?? v.voucherId;
        const no = v.VoucherNo ?? v.voucherNo ?? '?';
        const isReversal = Boolean(v.IsReversal ?? v.isReversal);
        const reverseBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Reverse');
        reverseBtn.addEventListener('click', async () => {
          reverseBtn.disabled = true;
          try {
            const res = await call('ledger.reverse', {
              voucherId: id,
              reason: 'Manual reversal from journal screen',
              createdBy: uid(h),
            });
            const revNo = res && (res.voucherNo ?? (res.voucher && res.voucher.voucherNo));
            toast(`Reversal ${revNo || ''} created`, 'success');
            loadRecent();
          } catch (e) {
            fail(e);
            reverseBtn.disabled = false;
          }
        });
        recentBody.append(el('tr', null,
          el('td', null, el('span', { class: 'badge' }, String(no)), isReversal ? ' ⇄' : ''),
          el('td', null, String(v.VoucherDate ?? v.voucherDate ?? '')),
          el('td', null, String(v.VoucherType ?? v.voucherType ?? '')),
          el('td', null, String(v.Narration ?? v.narration ?? '')),
          el('td', { class: 'num money' }, fmt(v.TotalDebit ?? v.totalDebit ?? 0)),
          el('td', { class: 'num money' }, fmt(v.TotalCredit ?? v.totalCredit ?? 0)),
          el('td', null, (id === undefined || isReversal) ? el('span', { class: 'muted' }, '—') : reverseBtn)));
      }
    } catch (e) {
      recentBody.replaceChildren(
        el('tr', null, el('td', { colspan: '7', class: 'muted' }, errMsg(e))));
    }
  }

  /* ---------------------------- boot --------------------------------- */
  addBtn.addEventListener('click', () => addRow());
  postBtn.addEventListener('click', submit);
  [dateInput, typeSelect, narrationInput, refInput].forEach((n) => n.addEventListener('input', recalc));

  addRow();
  addRow();

  call('coa.list', { postingOnly: true })
    .then((rows) => { accounts = rows || []; resetForm(); })
    .catch((e) => { fail(e); recalc(); });
  loadRecent();

  return root;
}

export default render;
