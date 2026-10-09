'use strict';

/* ==========================================================================
 * Fixed assets (src/ui/assetRegister.js)
 *   Tab 1 "Register asset"     → assets.register    (capitalise on acquisition)
 *   Tab 2 "Asset register"     → assets.list        (cost / accum / NBV)
 *   Tab 3 "Run depreciation"   → assets.runDepreciation (monthly charge run)
 *
 * Money stays in integer cents end-to-end. Book value = Cost - AccumulatedDepreciation,
 * never stored, always derived (Invariant 3: no float rounding in the ledger).
 * Straight-line uses money.amortize() so residual cents land on the final month;
 * DDB charges 2/12 x 12/usefulLifeYears of the remaining book value.
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

const EQUIPMENT = '1.20.01.0001.0001';
const ACCUM_DEPR = '1.20.02.0001.0001';
const DEPRECIATION = '6.10.04.0001.0001';
const BANK_MAIN = '1.10.01.0002.0001';
const BANK_SECONDARY = '1.10.01.0002.0002';
const CASH_TILL = '1.10.01.0001.0001';
const AP = '2.10.01.0001.0001';

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

  let accounts = [];

  const field = (label, ...controls) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), ...controls);

  /* --------------------------- shared widgets ------------------------- */
  const mkDate = (value) => el('input', { class: 'input', type: 'date', value: value || today() });
  const moneyIn = (ph) => el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: ph || '0.00' });

  function acctSelect() {
    return el('select', { class: 'select' }, el('option', { value: '' }, 'Select account…'));
  }

  function fundingSelect() {
    return el('select', { class: 'select' },
      el('option', { value: BANK_MAIN }, 'Primary Operating Bank (1.10.01.0002.0001)'),
      el('option', { value: BANK_SECONDARY }, 'Secondary Savings / Tax A/C (1.10.01.0002.0002)'),
      el('option', { value: CASH_TILL }, 'Main Cash Till (1.10.01.0001.0001)'),
      el('option', { value: AP }, 'Trade Creditors (2.10.01.0001.0001) — on credit'));
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

  /* ----------------------- tab 1: register asset ---------------------- */
  const regDate = mkDate();
  const regCode = el('input', { class: 'input', type: 'text', placeholder: 'e.g. VEHICLE-001' });
  const regName = el('input', { class: 'input', type: 'text', placeholder: 'e.g. Delivery Van' });
  const regCost = moneyIn('0.00');
  const regSalvage = moneyIn('0.00');
  const regYears = el('input', { class: 'input', type: 'number', min: '1', step: '1', value: '5' });
  const regMethod = el('select', { class: 'select' },
    el('option', { value: 'Straight_Line' }, 'Straight line'),
    el('option', { value: 'DDB' }, 'Double-declining balance (DDB)'));
  const regFunding = fundingSelect();
  const regAssetAcct = acctSelect();
  const regAccumAcct = acctSelect();
  const regDeprAcct = acctSelect();
  const regMemo = el('input', { class: 'input', type: 'text', placeholder: 'Memo (optional)' });
  const regHint = el('p', { class: 'hint muted' },
    `DR the asset head · CR the funding account (${AP}). ` +
    'Choosing Trade Creditors posts a Purchase_Invoice instead of a Bank_Payment.');
  const regBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Capitalise asset');
  const regResult = el('div', { class: 'result-box' });
  regBtn.disabled = true;

  /* ----------------------- tab 2: asset register ---------------------- */
  const listSummary = el('p', { class: 'hint muted' }, 'Loading register…');
  const listBox = el('div', { class: 'result-box' });
  const refreshBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '↻ Refresh register');

  /* --------------------- tab 3: run depreciation ---------------------- */
  const runDate = mkDate();
  const runMemo = el('input', { class: 'input', type: 'text', placeholder: 'Memo (optional)' });
  const runHint = el('p', { class: 'hint muted' },
    'Posts ONE balanced voucher debiting each asset\u2019s depreciation expense head and crediting its ' +
    'accumulated-depreciation head. Fully depreciated assets are skipped automatically.');
  const runBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Run monthly depreciation');
  const runResult = el('div', { class: 'result-box' });

  /* ---------------------------- tab shell ----------------------------- */
  const TABS = [
    ['register', 'Register asset'],
    ['list', 'Asset register'],
    ['depreciation', 'Run depreciation'],
  ];
  const tabButtons = {};
  const panels = {
    register: el('div', { class: 'card card-pad tab-panel' },
      el('h3', { class: 'card-title section-title' }, 'Capitalise a fixed asset'),
      el('div', { class: 'grid grid-2' },
        field('Acquisition date', regDate),
        field('Asset code *', regCode),
        field('Asset name *', regName),
        field('Acquisition cost *', regCost),
        field('Salvage value', regSalvage),
        field('Useful life (years) *', regYears),
        field('Depreciation method', regMethod),
        field('Funded from', regFunding),
        field('Asset account', regAssetAcct),
        field('Accumulated depreciation a/c', regAccumAcct),
        field('Depreciation expense a/c', regDeprAcct),
        field('Memo', regMemo)),
      regHint,
      el('div', { class: 'toolbar row' }, regBtn),
      regResult),
    list: el('div', { class: 'card card-pad tab-panel' },
      el('h3', { class: 'card-title section-title' }, 'Asset register'),
      listSummary, listBox,
      el('div', { class: 'toolbar row' }, refreshBtn)),
    depreciation: el('div', { class: 'card card-pad tab-panel' },
      el('h3', { class: 'card-title section-title' }, 'Monthly depreciation run'),
      el('div', { class: 'grid grid-2' },
        field('Run date', runDate),
        field('Memo', runMemo)),
      runHint,
      el('div', { class: 'toolbar row' }, runBtn),
      runResult),
  };

  function activate(key) {
    for (const [k, btn] of Object.entries(tabButtons)) {
      const on = k === key;
      btn.className = 'tab-btn ' + (on ? 'btn btn-primary active' : 'btn btn-ghost');
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      panels[k].style.display = on ? '' : 'none';
    }
  }

  const tabBarRef = el('div', { class: 'tabs row' });
  const panelBoxRef = el('div', { class: 'tab-panels' });

  for (const [key, label] of TABS) {
    const btn = el('button', { class: 'tab-btn btn btn-ghost', type: 'button', role: 'tab' }, label);
    btn.addEventListener('click', () => activate(key));
    tabButtons[key] = btn;
    tabBarRef.append(btn);
    panelBoxRef.append(panels[key]);
  }

  const root = el('div', { class: 'screen screen-assets' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'Fixed assets'),
      tabBarRef),
    panelBoxRef);
  view.replaceChildren(root);
  activate('register');

  /* --------------------------- validation ----------------------------- */
  function refresh() {
    const cost = centsOf(regCost.value);
    const salv = centsOf(regSalvage.value);
    const years = parseInt(regYears.value, 10);
    const ok = Boolean(String(regCode.value).trim())
      && Boolean(String(regName.value).trim())
      && cost > 0
      && salv < cost
      && Number.isInteger(years) && years > 0
      && Boolean(regFunding.value)
      && Boolean(regAssetAcct.value);
    regBtn.disabled = !ok;
    return { cost, salv, years };
  }

  /* ---------------------------- register ------------------------------ */
  regBtn.addEventListener('click', async () => {
    const v = refresh();
    if (regBtn.disabled) return;
    regBtn.disabled = true;
    try {
      const res = await call('assets.register', {
        voucherDate: regDate.value || today(),
        assetCode: String(regCode.value).trim(),
        assetName: String(regName.value).trim(),
        costCents: v.cost,
        salvageCents: v.salv,
        usefulLifeYears: v.years,
        method: regMethod.value,
        assetAccountCode: regAssetAcct.value,
        accumulatedAccountCode: regAccumAcct.value,
        depreciationExpenseAccountCode: regDeprAcct.value,
        accountCode: regFunding.value,
        memo: String(regMemo.value || '').trim() || undefined,
        createdBy: uid(h),
      });
      const voucherNo = String(pick(res && res.voucher, 'voucherNo', 'VoucherNo') ?? '(no number)');
      toast(`Asset capitalised: ${voucherNo}`, 'success');
      regResult.replaceChildren(receiptBox('Asset capitalised', {
        voucherNo,
        lines: [
          ['Date', regDate.value || today()],
          ['Asset', `${String(regCode.value).trim()} — ${String(regName.value).trim()}`],
          ['Cost', fmt(v.cost)],
          ['Salvage', fmt(v.salv)],
          ['Life', `${v.years} yr · ${regMethod.value}`],
          ['Funded from', regFunding.options[regFunding.selectedIndex].text],
        ],
      }));
      regCode.value = ''; regName.value = ''; regCost.value = ''; regSalvage.value = '';
      regMemo.value = '';
      loadRegister();
    } catch (e) {
      fail(e);
    } finally {
      refresh();
    }
  });

  /* ---------------------------- register list -------------------------- */
  function table(cols, rows) {
    return el('table', { class: 'table' },
      el('thead', null, el('tr', null, ...cols.map((c) =>
        el('th', { class: c.num ? 'num' : null }, c.label)))),
      el('tbody', null, ...rows.map((r) =>
        el('tr', null, ...cols.map((c) => el('td', { class: c.num ? 'num' : null }, c.render(r)))))));
  }

  async function loadRegister() {
    try {
      const rows = (await call('assets.list')) || [];
      const totalCost = rows.reduce((s, a) => s + Number(pick(a, 'Cost', 'cost') || 0), 0);
      const totalAccum = rows.reduce((s, a) => s + Number(pick(a, 'AccumulatedDepreciation', 'accumulatedDepreciation') || 0), 0);
      const open = rows.filter((a) => !Number(pick(a, 'IsFullyDepreciated', 'isFullyDepreciated') || 0)).length;

      listSummary.textContent = rows.length
        ? `${rows.length} asset${rows.length === 1 ? '' : 's'} · ${open} still depreciable · `
          + `cost ${fmt(totalCost)} · accumulated ${fmt(totalAccum)} · NBV ${fmt(totalCost - totalAccum)}`
        : 'No fixed assets registered yet.';

      if (!rows.length) {
        listBox.replaceChildren(el('p', { class: 'muted' }, 'Nothing capitalised yet.'));
        return;
      }
      listBox.replaceChildren(table([
        { label: 'Code', render: (a) => String(pick(a, 'AssetCode', 'assetCode') ?? '') },
        { label: 'Asset', render: (a) => String(pick(a, 'AssetName', 'assetName') ?? '') },
        { label: 'Acquired', render: (a) => String(pick(a, 'AcquisitionDate', 'acquisitionDate') ?? '') },
        { label: 'Cost', num: true, render: (a) => fmt(pick(a, 'Cost', 'cost')) },
        { label: 'Salvage', num: true, render: (a) => fmt(pick(a, 'SalvageValue', 'salvageValue')) },
        { label: 'Life', num: true, render: (a) => `${pick(a, 'UsefulLifeYears', 'usefulLifeYears')} yr` },
        { label: 'Method', render: (a) => String(pick(a, 'Method', 'method') ?? '') },
        { label: 'Accum. depr.', num: true, render: (a) => fmt(pick(a, 'AccumulatedDepreciation', 'accumulatedDepreciation')) },
        {
          label: 'Book value',
          num: true,
          render: (a) => fmt(Number(pick(a, 'Cost', 'cost') || 0) - Number(pick(a, 'AccumulatedDepreciation', 'accumulatedDepreciation') || 0)),
        },
        {
          label: 'Status',
          render: (a) => (Number(pick(a, 'IsFullyDepreciated', 'isFullyDepreciated') || 0)
            ? 'Fully depreciated'
            : `Month ${pick(a, 'MonthsDepreciated', 'monthsDepreciated') ?? 0} of ${Number(pick(a, 'UsefulLifeYears', 'usefulLifeYears') || 0) * 12}`),
        },
      ], rows));
    } catch (e) {
      fail(e);
    }
  }
  refreshBtn.addEventListener('click', () => { loadRegister(); });

  /* -------------------------- run depreciation ------------------------- */
  runBtn.addEventListener('click', async () => {
    if (runBtn.disabled) return;
    runBtn.disabled = true;
    try {
      const res = await call('assets.runDepreciation', {
        voucherDate: runDate.value || today(),
        memo: String(runMemo.value || '').trim() || undefined,
        createdBy: uid(h),
      });
      const voucherNo = String(pick(res && res.voucher, 'voucherNo', 'VoucherNo') ?? '(no number)');
      const meta = (res && res.meta) || {};
      const entries = meta.entries || [];
      toast(`Depreciation posted: ${fmt(meta.totalCents)}`, 'success');
      runResult.replaceChildren(
        receiptBox('Depreciation run', {
          voucherNo,
          lines: [
            ['Date', runDate.value || today()],
            ['Assets charged', String(entries.length)],
            ['Total charge', fmt(meta.totalCents)],
          ],
        }),
        entries.length
          ? el('table', { class: 'table' },
              el('thead', null, el('tr', null,
                el('th', null, 'Asset'),
                el('th', null, 'Method'),
                el('th', { class: 'num' }, 'Charge'),
                el('th', { class: 'num' }, 'Accumulated after'))),
              el('tbody', null, ...entries.map((e) => el('tr', null,
                el('td', null, `${e.assetCode} — ${e.assetName}`),
                el('td', null, String(e.method || '')),
                el('td', { class: 'num' }, fmt(e.amountCents)),
                el('td', { class: 'num' }, fmt(e.accumulatedCents))))))
          : null,
      );
      runMemo.value = '';
      loadRegister();
    } catch (e) {
      fail(e);
    } finally {
      runBtn.disabled = false;
    }
  });

  [regCost, regSalvage, regYears, regCode, regName, regMemo,
    regFunding, regAssetAcct, regAccumAcct, regDeprAcct, regMethod].forEach((n) => {
    n.addEventListener('input', refresh);
    n.addEventListener('change', refresh);
  });

  /* ----------------------------- boot --------------------------------- */
  call('coa.list', { postingOnly: true }).then((rows) => {
    accounts = rows || [];
    const opts = (filter) => {
      const kept = accounts.filter(filter);
      return kept.length ? kept : accounts;
    };
    const codeOf = (a) => String(pick(a, 'AccountCode', 'accountCode', 'code') ?? '');
    const nameOf = (a) => String(pick(a, 'AccountName', 'accountName', 'name') ?? '');
    const optionFor = (a) => el('option', { value: codeOf(a) }, `${codeOf(a)} — ${nameOf(a)}`);

    const fill = (sel, list, fallback) => {
      sel.replaceChildren(...list.filter((a) => codeOf(a)).map(optionFor));
      sel.value = list.some((a) => codeOf(a) === fallback) ? fallback
        : (sel.options[1] ? sel.options[1].value : '');
    };

    fill(regAssetAcct, opts((a) => codeOf(a).startsWith('1.20')), EQUIPMENT);
    fill(regAccumAcct, opts((a) => codeOf(a).startsWith('1.20.02')), ACCUM_DEPR);
    fill(regDeprAcct, opts((a) => String(pick(a, 'RootType', 'rootType') ?? '') === 'Expense' || codeOf(a).startsWith('6.')), DEPRECIATION);
    refresh();
  }).catch((e) => fail(e));

  refresh();
  loadRegister();
  return root;
}

export default render;
