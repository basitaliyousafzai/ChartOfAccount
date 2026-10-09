'use strict';

/* ==========================================================================
 * Expense payment (src/ui/expenseForm.js)
 * Picks an expense head, an amount and the account it is paid from, then
 * posts `expense.pay` → DR <expense> / CR <bank|till> (Section 5 matrix).
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
};

const HELPER_KEYS = ['fmt', 'fmtNeg', 'el', 'call', 'toast'];

function resolveHelpers(ctx) {
  const h = { state: (ctx && ctx.state) || {}, ...LOCAL };
  for (const k of HELPER_KEYS) if (ctx && typeof ctx[k] === 'function') h[k] = ctx[k];
  return h;
}

const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => {
  const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
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

  const field = (label, ...controls) => el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label), ...controls);

  const dateInput = el('input', { class: 'input', type: 'date', value: today() });
  const expenseSelect = el('select', { class: 'select' },
    el('option', { value: '' }, 'Select an expense head…'));
  const sourceSelect = el('select', { class: 'select' },
    el('option', { value: BANK_MAIN }, 'Primary Operating Bank (1.10.01.0002.0001)'),
    el('option', { value: BANK_SECONDARY }, 'Secondary Savings / Tax A/C (1.10.01.0002.0002)'),
    el('option', { value: CASH_TILL }, 'Main Cash Till (1.10.01.0001.0001)'));
  const amountInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const memoInput = el('input', {
    class: 'input', type: 'text',
    placeholder: 'Narration, e.g. “Pays store electricity & water bill” (required)',
  });

  const preview = el('p', { class: 'hint muted' }, 'Choose an expense head and enter an amount.');
  const resultBox = el('div', { class: 'result-box' });

  const postBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Pay expense');
  postBtn.disabled = true;

  const root = el('div', { class: 'screen screen-expense' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'Expense payment'),
      el('div', { class: 'grid grid-2' },
        field('Payment date', dateInput),
        field('Expense head *', expenseSelect),
        field('Amount *', amountInput),
        field('Paid from', sourceSelect),
        field('Narration *', memoInput)),
      preview,
      el('div', { class: 'toolbar row' }, postBtn),
      resultBox));

  view.replaceChildren(root);

  function currentExpense() {
    const code = expenseSelect.value;
    return code ? expenseSelect.selectedOptions[0] : null;
  }

  function calc() {
    const amount = centsOf(amountInput.value);
    const memo = String(memoInput.value || '').trim();
    const label = currentExpense() ? currentExpense().text : 'expense head';
    if (amount > 0 && expenseSelect.value) {
      preview.textContent = `DR ${label} ${fmt(amount)}  ·  CR ${sourceSelect.selectedOptions[0].text} ${fmt(amount)}`
        + (memo ? '' : '  · narration required');
      preview.classList.remove('badge', 'badge-danger');
    } else {
      preview.textContent = 'Choose an expense head and enter an amount.';
    }
    const ok = Boolean(expenseSelect.value) && amount > 0 && memo.length > 0;
    postBtn.disabled = !ok;
    return { amount, memo, ok };
  }

  async function submit() {
    const s = calc();
    if (!s.ok) return;
    postBtn.disabled = true;
    try {
      const res = await call('expense.pay', {
        voucherDate: dateInput.value || today(),
        accountCode: expenseSelect.value,
        amountCents: s.amount,
        paidFromAccountCode: sourceSelect.value,
        memo: s.memo,
        createdBy: uid(h),
      });
      const voucher = (res && res.voucher) || res || {};
      const voucherNo = voucher.voucherNo ?? res?.voucherNo ?? '(no number)';
      toast(`Expense ${voucherNo} posted`, 'success');
      resultBox.replaceChildren(
        el('div', { class: 'card card-pad receipt' },
          el('div', { class: 'receipt-head' },
            el('span', { class: 'card-title section-title' }, 'Expense posted'),
            el('span', { class: 'badge badge-success' }, String(voucherNo))),
          el('table', { class: 'table' },
            el('tbody', null,
              el('tr', null, el('td', null, 'Date'), el('td', { class: 'num' }, String(voucher.voucherDate ?? dateInput.value))),
              el('tr', null, el('td', null, 'Expense head'), el('td', { class: 'num' }, expenseSelect.selectedOptions[0].text)),
              el('tr', null, el('td', null, 'Paid from'), el('td', { class: 'num' }, sourceSelect.selectedOptions[0].text)),
              el('tr', null, el('td', null, 'Amount'), el('td', { class: 'num money' }, fmt(s.amount))),
              el('tr', null, el('td', null, 'Narration'), el('td', { class: 'num' }, s.memo))))));
      amountInput.value = '';
      memoInput.value = '';
      calc();
    } catch (e) {
      fail(e);
    } finally {
      postBtn.disabled = false;
      calc();
    }
  }

  expenseSelect.addEventListener('change', calc);
  sourceSelect.addEventListener('change', calc);
  amountInput.addEventListener('input', calc);
  amountInput.addEventListener('change', calc);
  memoInput.addEventListener('input', calc);
  postBtn.addEventListener('click', submit);

  call('coa.list', { postingOnly: true, rootType: 'Expense', activeOnly: true })
    .then((rows) => {
      const list = Array.isArray(rows) ? rows : [];
      for (const a of list) {
        const code = pick(a, 'AccountCode', 'accountCode');
        const name = pick(a, 'AccountName', 'accountName');
        if (!code) continue;
        expenseSelect.append(el('option', { value: String(code) }, `${name} (${code})`));
      }
      if (list.length === 0) {
        preview.textContent = 'No expense accounts found — seed the chart of accounts first.';
      }
      calc();
    })
    .catch((e) => fail(e));

  calc();
  return root;
}

export default render;
