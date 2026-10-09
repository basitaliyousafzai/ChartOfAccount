'use strict';

/* ==========================================================================
 * Payments hub (src/ui/paymentForm.js)
 *   Tab 1 "Vendor Payment"   → ap.payment
 *   Tab 2 "Expense Payment"  → expense.pay
 *   Tab 3 "Capital Deposit"  → capital.deposit
 *   Tab 4 "Till → Bank"      → transfer.tillToBank
 *   Tab 5 "Owner Drawings"   → owner.drawings
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
const BANK_SECONDARY = '1.10.01.0002.0002';
const CAPITAL = '3.10.01.0001.0001';
const DRAWINGS = '3.10.01.0002.0001';
const RENT = '6.10.01.0001.0001';

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

  let entities = [];
  let accounts = [];

  const field = (label, ...controls) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), ...controls);

  /* ------------------------- shared widgets -------------------------- */
  // NOTE: one <input> can only live in one panel, so every tab gets its own.
  const mkDate = () => el('input', { class: 'input', type: 'date', value: today() });

  function accountSelect() {
    return el('select', { class: 'select' }, el('option', { value: '' }, 'Select account…'));
  }

  function bankSelect() {
    return el('select', { class: 'select' },
      el('option', { value: BANK_MAIN }, 'Primary Operating Bank (1.10.01.0002.0001)'),
      el('option', { value: BANK_SECONDARY }, 'Secondary Savings / Tax A/C (1.10.01.0002.0002)'),
      el('option', { value: CASH_TILL }, 'Main Cash Till (1.10.01.0001.0001)'));
  }

  /* ------------------------- tab 1: vendor --------------------------- */
  const vendorDate = mkDate();
  const vendorSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select vendor…'));
  const vendorBal = el('p', { class: 'hint muted' }, 'Select a vendor to see the outstanding balance.');
  const vendorAmount = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const vendorAccount = bankSelect();
  const vendorMemo = el('input', { class: 'input', type: 'text', placeholder: 'Memo (optional)' });
  const vendorBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Pay vendor');
  const vendorResult = el('div', { class: 'result-box' });
  vendorBtn.disabled = true;

  /* ------------------------- tab 2: expense -------------------------- */
  const expenseDate = mkDate();
  const expenseAccount = accountSelect();
  const expenseAmount = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const expenseFrom = bankSelect();
  const expenseMemo = el('input', { class: 'input', type: 'text', placeholder: 'What was this expense for?' });
  const expenseBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Pay expense');
  const expenseResult = el('div', { class: 'result-box' });
  expenseBtn.disabled = true;

  /* ------------------------- tab 3: capital -------------------------- */
  const capitalDate = mkDate();
  const capitalAccount = el('select', { class: 'select' },
    el('option', { value: BANK_MAIN }, 'Primary Operating Bank (1.10.01.0002.0001)'),
    el('option', { value: BANK_SECONDARY }, 'Secondary Savings / Tax A/C (1.10.01.0002.0002)'),
    el('option', { value: CASH_TILL }, 'Main Cash Till (1.10.01.0001.0001)'));
  const capitalHint = el('p', { class: 'hint muted' },
    `Debits the selected asset account and credits owner capital ${CAPITAL}.`);
  const capitalAmount = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const capitalMemo = el('input', { class: 'input', type: 'text', placeholder: 'Memo (optional)' });
  const capitalBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Record deposit');
  const capitalResult = el('div', { class: 'result-box' });
  capitalBtn.disabled = true;

  /* ------------------------ tab 4: till → bank ----------------------- */
  const transferDate = mkDate();
  const transferTo = el('select', { class: 'select' },
    el('option', { value: BANK_MAIN }, 'Primary Operating Bank (1.10.01.0002.0001)'),
    el('option', { value: BANK_SECONDARY }, 'Secondary Savings / Tax A/C (1.10.01.0002.0002)'));
  const transferHint = el('p', { class: 'hint muted' },
    `Moves cash out of the till (${CASH_TILL}) into the selected bank account.`);
  const transferAmount = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const transferBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Transfer');
  const transferResult = el('div', { class: 'result-box' });
  transferBtn.disabled = true;

  /* ----------------------- tab 5: owner drawings --------------------- */
  const drawDate = mkDate();
  const drawAccount = bankSelect();
  const drawHint = el('p', { class: 'hint muted' },
    `Contra-equity: debits Owner's Drawings ${DRAWINGS} and credits the account you take the money out of. ` +
    'Drawings reduce equity — they are never an expense.');
  const drawAmount = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const drawMemo = el('input', { class: 'input', type: 'text', placeholder: 'Memo (optional)' });
  const drawBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Record drawing');
  const drawResult = el('div', { class: 'result-box' });
  drawBtn.disabled = true;

  /* ---------------------------- tab shell ---------------------------- */
  const TABS = [
    ['vendor', 'Vendor payment'],
    ['expense', 'Expense payment'],
    ['capital', 'Capital deposit'],
    ['transfer', 'Till → Bank transfer'],
    ['drawings', 'Owner drawings'],
  ];
  const tabButtons = {};
  const tabPanels = {};
  const tabBar = el('div', { class: 'tabs row' });
  const panelBox = el('div', { class: 'tab-panels' });

  const panels = {
    vendor: el('div', { class: 'card card-pad tab-panel' },
      el('h3', { class: 'card-title section-title' }, 'Vendor payment (AP)'),
      el('div', { class: 'grid grid-2' },
        field('Payment date', vendorDate),
        field('Vendor *', vendorSelect),
        field('Amount *', vendorAmount),
        field('Paid from account', vendorAccount),
        field('Memo', vendorMemo)),
      vendorBal,
      el('div', { class: 'toolbar row' }, vendorBtn),
      vendorResult),
    expense: el('div', { class: 'card card-pad tab-panel' },
      el('h3', { class: 'card-title section-title' }, 'Expense payment'),
      el('div', { class: 'grid grid-2' },
        field('Payment date', expenseDate),
        field('Expense account *', expenseAccount),
        field('Amount *', expenseAmount),
        field('Paid from account', expenseFrom),
        field('Memo', expenseMemo)),
      el('div', { class: 'toolbar row' }, expenseBtn),
      expenseResult),
    capital: el('div', { class: 'card card-pad tab-panel' },
      el('h3', { class: 'card-title section-title' }, 'Capital deposit (owner investment)'),
      el('div', { class: 'grid grid-2' },
        field('Deposit date', capitalDate),
        field('Deposit into account', capitalAccount),
        field('Amount *', capitalAmount),
        field('Memo', capitalMemo)),
      capitalHint,
      el('div', { class: 'toolbar row' }, capitalBtn),
      capitalResult),
    transfer: el('div', { class: 'card card-pad tab-panel' },
      el('h3', { class: 'card-title section-title' }, 'Till → Bank transfer'),
      el('div', { class: 'grid grid-2' },
        field('Transfer date', transferDate),
        field('Transfer to bank', transferTo),
        field('Amount *', transferAmount)),
      transferHint,
      el('div', { class: 'toolbar row' }, transferBtn),
      transferResult),
    drawings: el('div', { class: 'card card-pad tab-panel' },
      el('h3', { class: 'card-title section-title' }, 'Owner drawings (personal withdrawal)'),
      el('div', { class: 'grid grid-2' },
        field('Drawing date', drawDate),
        field('Withdrawn from', drawAccount),
        field('Amount *', drawAmount),
        field('Memo', drawMemo)),
      drawHint,
      el('div', { class: 'toolbar row' }, drawBtn),
      drawResult),
  };

  function activate(key) {
    for (const [k, btn] of Object.entries(tabButtons)) {
      const on = k === key;
      btn.className = 'tab-btn ' + (on ? 'btn btn-primary active' : 'btn btn-ghost');
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      panels[k].style.display = on ? '' : 'none';
    }
  }
  for (const [key, label] of TABS) {
    const btn = el('button', { class: 'tab-btn btn btn-ghost', type: 'button', role: 'tab' }, label);
    btn.addEventListener('click', () => activate(key));
    tabButtons[key] = btn;
    tabBar.append(btn);
    panelBox.append(panels[key]);
  }

  const root = el('div', { class: 'screen screen-payments' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'Payments'),
      tabBar),
    panelBox);
  view.replaceChildren(root);
  activate('vendor');

  /* --------------------------- validation ---------------------------- */
  function refresh() {
    const vAmt = centsOf(vendorAmount.value);
    const vend = entities.find((e) => String(pick(e, 'EntityId', 'entityId', 'id')) === vendorSelect.value);
    const vBal = vend ? Number(pick(vend, 'CurrentBalance', 'currentBalance', 'balance') || 0) : 0;
    vendorBal.textContent = vend
      ? `Outstanding balance: ${fmt(vBal)} · payment ${fmt(vAmt)} → after: ${fmt(vBal - vAmt)}`
      : 'Select a vendor to see the outstanding balance.';
    vendorBtn.disabled = !(vendorSelect.value && vAmt > 0);

    const eAmt = centsOf(expenseAmount.value);
    expenseBtn.disabled = !(expenseAccount.value && eAmt > 0 && expenseFrom.value);

    const cAmt = centsOf(capitalAmount.value);
    capitalBtn.disabled = !(cAmt > 0 && capitalAccount.value);

    const tAmt = centsOf(transferAmount.value);
    transferBtn.disabled = !(tAmt > 0 && transferTo.value);

    const wAmt = centsOf(drawAmount.value);
    drawBtn.disabled = !(wAmt > 0 && drawAccount.value);
    return { vAmt, eAmt, cAmt, tAmt, wAmt };
  }

  function receiptBox(title, rows) {
    return el('div', { class: 'card card-pad receipt' },
      el('div', { class: 'receipt-head' },
        el('span', { class: 'card-title section-title' }, title),
        el('span', { class: 'badge badge-success badge-green' }, String(rows.voucherNo))),
      el('table', { class: 'table' },
        el('tbody', null, ...rows.lines.map(([k, v]) =>
          el('tr', null, el('td', null, k), el('td', { class: 'num' }, v))))));
  }

  /* ----------------------------- posts ------------------------------- */
  async function post(method, args, box, title, lines) {
    try {
      const res = await call(method, args);
      const voucher = (res && res.voucher) || res || {};
      const voucherNo = voucher.voucherNo ?? res?.voucherNo ?? '(no number)';
      toast(`${title}: ${voucherNo}`, 'success');
      box.replaceChildren(receiptBox(title, {
        voucherNo,
        lines: [['Date', String(voucher.voucherDate ?? args.voucherDate)], ...lines],
      }));
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  vendorBtn.addEventListener('click', async () => {
    const a = refresh();
    if (vendorBtn.disabled) return;
    vendorBtn.disabled = true;
    const name = vendorSelect.options[vendorSelect.selectedIndex]
      ? vendorSelect.options[vendorSelect.selectedIndex].text : '';
    const done = await post('ap.payment', {
      voucherDate: vendorDate.value || today(),
      entityId: Number(vendorSelect.value),
      amountCents: a.vAmt,
      accountCode: vendorAccount.value,
      memo: String(vendorMemo.value || '').trim() || undefined,
      createdBy: uid(h),
    }, vendorResult, 'Vendor payment', [
      ['Vendor', name],
      ['Amount', fmt(a.vAmt)],
      ['Paid from', vendorAccount.options[vendorAccount.selectedIndex].text],
    ]);
    if (done) { vendorAmount.value = ''; vendorMemo.value = ''; call('report.entities').then((r) => { entities = r || []; }).catch(() => {}); }
    refresh();
  });

  expenseBtn.addEventListener('click', async () => {
    const a = refresh();
    if (expenseBtn.disabled) return;
    expenseBtn.disabled = true;
    const acct = expenseAccount.options[expenseAccount.selectedIndex]
      ? expenseAccount.options[expenseAccount.selectedIndex].text : '';
    const done = await post('expense.pay', {
      voucherDate: expenseDate.value || today(),
      accountCode: expenseAccount.value,
      amountCents: a.eAmt,
      paidFromAccountCode: expenseFrom.value,
      memo: String(expenseMemo.value || '').trim() || undefined,
      createdBy: uid(h),
    }, expenseResult, 'Expense payment', [
      ['Expense account', acct],
      ['Amount', fmt(a.eAmt)],
      ['Paid from', expenseFrom.options[expenseFrom.selectedIndex].text],
    ]);
    if (done) { expenseAmount.value = ''; expenseMemo.value = ''; }
    refresh();
  });

  capitalBtn.addEventListener('click', async () => {
    const a = refresh();
    if (capitalBtn.disabled) return;
    capitalBtn.disabled = true;
    const done = await post('capital.deposit', {
      voucherDate: capitalDate.value || today(),
      amountCents: a.cAmt,
      accountCode: capitalAccount.value,
      memo: String(capitalMemo.value || '').trim() || undefined,
      createdBy: uid(h),
    }, capitalResult, 'Capital deposit', [
      ['Amount', fmt(a.cAmt)],
      ['Into', capitalAccount.options[capitalAccount.selectedIndex].text],
      ['Equity credit', CAPITAL],
    ]);
    if (done) { capitalAmount.value = ''; capitalMemo.value = ''; }
    refresh();
  });

  transferBtn.addEventListener('click', async () => {
    const a = refresh();
    if (transferBtn.disabled) return;
    transferBtn.disabled = true;
    const done = await post('transfer.tillToBank', {
      voucherDate: transferDate.value || today(),
      amountCents: a.tAmt,
      accountCode: transferTo.value,
      createdBy: uid(h),
    }, transferResult, 'Till → Bank transfer', [
      ['Amount', fmt(a.tAmt)],
      ['To', transferTo.options[transferTo.selectedIndex].text],
      ['From', `Main Cash Till (${CASH_TILL})`],
    ]);
    if (done) transferAmount.value = '';
    refresh();
  });

  drawBtn.addEventListener('click', async () => {
    const a = refresh();
    if (drawBtn.disabled) return;
    drawBtn.disabled = true;
    const done = await post('owner.drawings', {
      voucherDate: drawDate.value || today(),
      amountCents: a.wAmt,
      accountCode: drawAccount.value,
      memo: String(drawMemo.value || '').trim() || undefined,
      createdBy: uid(h),
    }, drawResult, 'Owner drawing', [
      ['Amount', fmt(a.wAmt)],
      ['From', drawAccount.options[drawAccount.selectedIndex].text],
      ['Equity debit', DRAWINGS],
    ]);
    if (done) { drawAmount.value = ''; drawMemo.value = ''; }
    refresh();
  });

  [vendorAmount, vendorSelect, vendorAccount, vendorMemo,
    expenseAmount, expenseAccount, expenseFrom, expenseMemo,
    capitalAmount, capitalAccount, capitalMemo,
    transferAmount, transferTo, vendorDate, expenseDate, capitalDate, transferDate,
    drawAmount, drawAccount, drawMemo, drawDate].forEach((n) => {
    n.addEventListener('input', refresh);
    n.addEventListener('change', refresh);
  });

  /* ----------------------------- boot -------------------------------- */
  Promise.all([
    call('report.entities').then((rows) => { entities = rows || []; }),
    call('coa.list', { postingOnly: true }).then((rows) => { accounts = rows || []; }),
  ]).then(() => {
    for (const c of entities) {
      const type = String(pick(c, 'EntityType', 'entityType') ?? '').toLowerCase();
      const id = pick(c, 'EntityId', 'entityId', 'id');
      if (id === undefined || (type && type !== 'vendor')) continue;
      const name = String(pick(c, 'FullName', 'fullName', 'name') ?? `Entity ${id}`);
      const bal = Number(pick(c, 'CurrentBalance', 'currentBalance', 'balance') || 0);
      vendorSelect.append(el('option', { value: String(id) }, `${name} — due ${fmt(bal)}`));
    }
    // expense accounts: RootType 'Expense' (or canonical level-1 code 6.*)
    const expenseRows = accounts.filter((a) => {
      const rootType = String(pick(a, 'RootType', 'rootType') ?? '');
      const code = String(pick(a, 'AccountCode', 'accountCode', 'code') ?? '');
      return rootType === 'Expense' || code.startsWith('6.');
    });
    const usable = expenseRows.length ? expenseRows : accounts;
    for (const a of usable) {
      const code = String(pick(a, 'AccountCode', 'accountCode', 'code') ?? '');
      const name = String(pick(a, 'AccountName', 'accountName', 'name') ?? '');
      if (!code) continue;
      expenseAccount.append(el('option', { value: code }, `${code} — ${name}`));
    }
    expenseAccount.value = usable.some((a) => String(pick(a, 'AccountCode', 'accountCode', 'code')) === RENT)
      ? RENT
      : (expenseAccount.options[1] ? expenseAccount.options[1].value : '');
    refresh();
  }).catch((e) => fail(e));

  refresh();
  return root;
}

export default render;
