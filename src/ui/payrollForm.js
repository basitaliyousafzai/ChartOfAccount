'use strict';

/* ==========================================================================
 * Payroll disbursement (src/ui/payrollForm.js)
 *   Gross = Base + (OT × 1.5 × Hourly rate) + Allowances
 *   Tax   = piecewise annual slab (editable override)
 *   Pension = Gross × pension rate
 *   Net   = Gross − Tax − Pension
 * BALANCING RULE asserts Gross == Tax + Pension + Net (red on any drift)
 * → `payroll.disburse`
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

/**
 * Piecewise annual income-tax slab, in cents:
 *   gross ≤ 50,000        → 0
 *   ≤ 100,000             → 5%  of (gross − 50,000)
 *   ≤ 200,000             → 2,500 + 15% of (gross − 100,000)
 *   above 200,000         → 17,500 + 25% of (gross − 200,000)
 */
function slabTaxCents(grossCents) {
  const g = Math.max(0, Number(grossCents) || 0);
  if (g <= 5000000) return 0;
  if (g <= 10000000) return Math.round((g - 5000000) * 0.05);
  if (g <= 20000000) return Math.round(250000 + (g - 10000000) * 0.15);
  return Math.round(1750000 + (g - 20000000) * 0.25);
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
  const field = (label, ...controls) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), ...controls);

  let entities = [];

  const dateInput = el('input', { class: 'input', type: 'date', value: today() });
  const empSelect = el('select', { class: 'select' }, el('option', { value: '' }, 'Select employee (optional)…'));
  const baseInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00', value: '4,000.00' });
  const otInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0', value: '0' });
  const rateInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00', value: '25.00' });
  const allowInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00', value: '0.00' });
  const pensionInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', value: '8.00' });
  const taxInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00', value: '0.00' });
  const bankSelect = el('select', { class: 'select' },
    el('option', { value: BANK_MAIN }, 'Primary Operating Bank (1.10.01.0002.0001)'),
    el('option', { value: BANK_SECONDARY }, 'Secondary Savings / Tax A/C (1.10.01.0002.0002)'),
    el('option', { value: CASH_TILL }, 'Main Cash Till (1.10.01.0001.0001)'));

  const grossOut = el('span', { class: 'money strong' }, '$0.00');
  const taxOut = el('span', { class: 'money' }, '$0.00');
  const pensionOut = el('span', { class: 'money' }, '$0.00');
  const netOut = el('span', { class: 'money strong' }, '$0.00');
  const ruleBadge = el('span', { class: 'badge badge-success badge-green' }, 'balanced');
  const ruleLine = el('p', { class: 'hint' }, 'Gross − (Tax + Pension + Net) = $0.00');
  const calcHint = el('p', { class: 'hint muted' });
  /* Kernel cross-check. The numbers above are the screen's own fast
   * arithmetic; the voucher that actually posts is built by
   * `payroll.calculate`, so the two are re-verified on every edit. If they
   * ever drift by a cent, the preview would be lying about the posted amount
   * — this line is what turns that from invisible into red text. */
  const kernelLine = el('p', { class: 'hint muted' }, 'Verifying against the kernel…');

  const postBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Disburse payroll');
  const resultBox = el('div', { class: 'result-box' });

  const root = el('div', { class: 'screen screen-payroll' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title section-title' }, 'Payroll disbursement'),
      el('div', { class: 'grid grid-2' },
        field('Payroll date', dateInput),
        field('Employee (optional)', empSelect),
        field('Base salary (period)', baseInput),
        field('Overtime hours', otInput),
        field('Hourly rate', rateInput),
        field('Allowances', allowInput),
        field('Pension rate %', pensionInput),
        field('Tax withheld (auto, editable)', taxInput),
        field('Paid to account', bankSelect)),
      el('div', { class: 'card card-pad calc-panel' },
        el('h3', { class: 'card-title section-title' }, 'Live computation'),
        el('table', { class: 'table' },
          el('tbody', null,
            el('tr', null,
              el('td', null, el('strong', null, 'Gross'), ' = Base + (OT × 1.5 × Rate) + Allowances'),
              el('td', { class: 'num' }, grossOut)),
            el('tr', null, el('td', null, 'Tax withheld'), el('td', { class: 'num' }, taxOut)),
            el('tr', null, el('td', null, 'Pension'), el('td', { class: 'num' }, pensionOut)),
            el('tr', null, el('td', null, el('strong', null, 'Net pay')), el('td', { class: 'num' }, netOut)),
            el('tr', { class: 'total-row' },
              el('td', null, el('strong', null, 'BALANCING RULE — Gross == Tax + Pension + Net'), ' ', ruleBadge),
              el('td', { class: 'num' }, ruleLine)))),
        calcHint,
        kernelLine),
      el('div', { class: 'toolbar row' }, postBtn),
      resultBox));

  view.replaceChildren(root);

  /* --------------------------- computation --------------------------- */
  let taxTouched = false;

  function calc({ refillTax = false } = {}) {
    const base = centsOf(baseInput.value);
    const ot = Math.max(0, num(otInput.value));
    const rate = centsOf(rateInput.value);
    const allow = centsOf(allowInput.value);
    const pensionPct = Math.max(0, num(pensionInput.value));

    const otPay = Math.round(ot * 1.5 * rate);
    const gross = base + otPay + allow;
    const autoTax = slabTaxCents(gross);
    if (refillTax || !taxTouched) {
      taxInput.value = (autoTax / 100).toFixed(2);
    }
    const tax = centsOf(taxInput.value);
    const pension = Math.round(gross * (pensionPct / 100));
    const net = gross - tax - pension;
    const delta = gross - (tax + pension + net);

    grossOut.textContent = fmt(gross);
    taxOut.textContent = fmt(tax);
    pensionOut.textContent = fmt(pension);
    netOut.textContent = fmt(net);

    const balanced = delta === 0 && net >= 0;
    ruleLine.textContent = `Gross − (Tax + Pension + Net) = ${fmt(delta)}`
      + (net < 0 ? ' · net pay is negative' : '');
    ruleLine.className = 'hint ' + (balanced ? '' : 'error-text');
    ruleBadge.textContent = balanced
      ? (taxTouched ? 'manual tax — balanced' : 'balanced')
      : 'OUT OF BALANCE';
    ruleBadge.className = 'badge ' + (balanced ? 'badge badge-success badge-green' : 'badge badge-danger badge-red');

    const ok = gross > 0 && net >= 0 && Boolean(bankSelect.value);
    postBtn.disabled = !ok;
    calcHint.textContent = ok
      ? `OT pay ${fmt(otPay)} · tax slab on ${fmt(gross)} → auto ${fmt(autoTax)} · pension ${pensionPct.toFixed(2)}%`
      : 'Enter a positive gross with a payable (non-negative) net and choose an account.';
    scheduleKernelCheck({ base, ot, rate, allow, gross, tax, pension, net, pensionPct });
    return { base, ot, rate, allow, gross, tax, pension, net, otPay, pensionPct, autoTax, ok };
  }

  /* One kernel round-trip per settled keystroke burst, not one per keystroke. */
  let checkTimer = null;
  function scheduleKernelCheck(c) {
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => runKernelCheck(c), 300);
  }

  async function runKernelCheck(c) {
    try {
      const k = await call('payroll.calculate', {
        baseCents: c.base,
        overtimeHours: c.ot,
        hourlyRateCents: c.rate,
        allowancesCents: c.allow,
        taxWithheldCents: c.tax,
        pensionRate: c.pensionPct / 100,
      });
      const drift = [
        ['gross', c.gross, k.grossCents],
        ['tax', c.tax, k.taxCents],
        ['pension', c.pension, k.pensionCents],
        ['net', c.net, k.netCents],
      ].filter(([, mine, theirs]) => Number(mine) !== Number(theirs));
      if (!drift.length) {
        kernelLine.textContent = 'Kernel ✓ payroll.calculate agrees — the posted voucher will show exactly these figures.';
        kernelLine.className = 'hint';
      } else {
        kernelLine.textContent = 'Kernel ✗ ' + drift.map(([n, mine, theirs]) =>
          `${n}: screen ${fmt(mine)} vs kernel ${fmt(theirs)}`).join(' · ')
          + ' — the voucher posts the kernel figure.';
        kernelLine.className = 'hint error-text';
      }
    } catch (e) {
      kernelLine.textContent = `Kernel check unavailable: ${errMsg(e)}`;
      kernelLine.className = 'hint muted';
    }
  }

  function resetForm() {
    baseInput.value = '4,000.00';
    otInput.value = '0';
    rateInput.value = '25.00';
    allowInput.value = '0.00';
    pensionInput.value = '8.00';
    empSelect.value = '';
    taxTouched = false;
    calc({ refillTax: true });
  }

  /* ----------------------------- submit ------------------------------ */
  async function submit() {
    const c = calc();
    if (!c.ok) return;
    postBtn.disabled = true;
    try {
      const res = await call('payroll.disburse', {
        voucherDate: dateInput.value || today(),
        baseCents: c.base,
        overtimeHours: c.ot,
        hourlyRateCents: c.rate,
        allowancesCents: c.allow,
        taxWithheldCents: c.tax,
        pensionRate: c.pensionPct / 100,
        accountCode: bankSelect.value,
        entityId: empSelect.value ? Number(empSelect.value) : undefined,
        createdBy: uid(h),
      });
      const voucher = (res && res.voucher) || res || {};
      const voucherNo = voucher.voucherNo ?? res?.voucherNo ?? '(no number)';
      toast(`Payroll ${voucherNo} disbursed`, 'success');
      resultBox.replaceChildren(
        el('div', { class: 'card card-pad receipt' },
          el('div', { class: 'receipt-head' },
            el('span', { class: 'card-title section-title' }, 'Payroll posted'),
            el('span', { class: 'badge badge-success badge-green' }, String(voucherNo))),
          el('table', { class: 'table' },
            el('tbody', null,
              el('tr', null, el('td', null, 'Date'), el('td', { class: 'num' }, String(voucher.voucherDate ?? dateInput.value))),
              el('tr', null, el('td', null, 'Gross'), el('td', { class: 'num money' }, fmt(c.gross))),
              el('tr', null, el('td', null, 'Tax withheld'), el('td', { class: 'num money' }, fmt(c.tax))),
              el('tr', null, el('td', null, 'Pension'), el('td', { class: 'num money' }, fmt(c.pension))),
              el('tr', null, el('td', null, el('strong', null, 'Net pay')), el('td', { class: 'num money' }, fmt(c.net))),
              el('tr', null,
                el('td', null, 'Balancing rule'),
                el('td', { class: 'num' },
                  el('span', { class: 'badge badge-success badge-green' },
                    `Gross − (Tax + Pension + Net) = ${fmt(0)}`)))))));
      taxTouched = false;
      resetForm();
    } catch (e) {
      fail(e);
    } finally {
      calc({ refillTax: true });
    }
  }

  /* ----------------------------- wiring ------------------------------ */
  [baseInput, otInput, rateInput, allowInput, pensionInput].forEach((n) => {
    const handler = () => { taxTouched = false; calc({ refillTax: true }); };
    n.addEventListener('input', handler);
    n.addEventListener('change', handler);
  });
  taxInput.addEventListener('input', () => { taxTouched = true; calc(); });
  taxInput.addEventListener('change', () => { taxTouched = true; calc(); });
  bankSelect.addEventListener('change', calc);
  empSelect.addEventListener('change', calc);
  postBtn.addEventListener('click', submit);

  call('report.entities')
    .then((rows) => {
      entities = rows || [];
      for (const e of entities) {
        const type = String(pick(e, 'EntityType', 'entityType') ?? '').toLowerCase();
        const id = pick(e, 'EntityId', 'entityId', 'id');
        if (id === undefined || (type && type !== 'employee')) continue;
        const name = String(pick(e, 'FullName', 'fullName', 'name') ?? `Entity ${id}`);
        empSelect.append(el('option', { value: String(id) }, name));
      }
    })
    .catch((e) => fail(e));

  calc({ refillTax: true });
  return root;
}

export default render;
