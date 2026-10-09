'use strict';

/* ==========================================================================
 * Dashboard (src/ui/dashboard.js)
 * Landing screen: KPI tiles from report.dashboard, the consolidated
 * equilibrium proof (report.proof), recent vouchers, quick actions.
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

const errMsg = (e) => (e && e.message) || (typeof e === 'string' ? e : 'Kernel call failed');

/** KPI tile. */
function kpi(el, label, value, sub) {
  return el('div', { class: 'kpi' },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, value),
    sub ? el('div', { class: 'kpi-sub' }, sub) : null);
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
  const fmtNeg = (v) => h.fmtNeg(v);
  const go = (route) => { if (ctx && typeof ctx.go === 'function') ctx.go(route); };

  const today = new Date().toISOString().slice(0, 10);

  const kpiGrid = el('div', { class: 'grid grid-4' },
    kpi(el, 'Cash & bank', '—', 'till + operating accounts'),
    kpi(el, 'Receivables', '—', 'trade debtors'),
    kpi(el, 'Payables', '—', 'trade creditors'),
    kpi(el, 'Inventory', '—', 'perpetual FIFO value'));

  const resultGrid = el('div', { class: 'grid grid-4' },
    kpi(el, 'Net revenue', '—', 'since last close'),
    kpi(el, 'Gross profit', '—', 'margin —'),
    kpi(el, 'Net profit / (loss)', '—', 'result since last close'),
    kpi(el, 'Stock on hand', '—', 'units in the FIFO queue'));

  const proofTile = (label, sub) => el('div', { class: 'kpi' },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value', text: '—' }),
    el('div', { class: 'kpi-sub', text: sub }));

  const tbTile = proofTile('Trial balance Δ', 'ΣDR − ΣCR (Equation 10)');
  const bsTile = proofTile('Balance sheet Δ', 'A − (L + E)');
  const invTile = proofTile('Zero tolerance', '|Δ| must equal 0.00');
  const resultProofTile = proofTile('Period result', 'flushed on closing');

  const proofGrid = el('div', { class: 'grid grid-4' }, tbTile, bsTile, invTile, resultProofTile);

  const recentBody = el('tbody', null,
    el('tr', null,
      el('td', { class: 'muted small', colspan: '5' }, 'Loading recent activity…')));

  const quickActions = el('div', { class: 'row page-actions' },
    el('button', { class: 'btn btn-primary', type: 'button', onclick: () => go('pos-sale') }, 'POS sale'),
    el('button', { class: 'btn', type: 'button', onclick: () => go('journal') }, 'Journal voucher'),
    el('button', { class: 'btn', type: 'button', onclick: () => go('trial-balance') }, 'Trial balance'),
    el('button', { class: 'btn', type: 'button', onclick: () => go('balance-sheet') }, 'Balance sheet'),
    el('button', { class: 'btn', type: 'button', onclick: () => go('coa') }, 'Chart of accounts'));

  const statusLine = el('p', { class: 'hint muted' }, 'Loading engine state…');

  const root = el('div', { class: 'screen screen-dashboard' },
    el('div', { class: 'card card-pad' },
      el('h2', { class: 'card-title' }, 'Dashboard'),
      el('p', { class: 'hint muted' }, `As of ${today} · all amounts are exact integer cents (Invariant 3)`),
      quickActions),
    el('div', { class: 'card card-pad' },
      el('p', { class: 'card-title' }, 'Position'),
      kpiGrid,
      el('div', { class: 'mt-2' }, resultGrid)),
    el('div', { class: 'card card-pad' },
      el('p', { class: 'card-title' }, 'Equilibrium proof'),
      proofGrid,
      statusLine),
    el('div', { class: 'card card-pad' },
      el('p', { class: 'card-title' }, 'Recent vouchers'),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' },
          el('thead', null,
            el('tr', null,
              el('th', null, 'No.'),
              el('th', null, 'Date'),
              el('th', null, 'Type'),
              el('th', null, 'Narration'),
              el('th', { class: 'num' }, 'Amount'))),
          recentBody))));

  view.replaceChildren(root);

  const setTile = (tile, text, tone) => {
    const value = tile.querySelector('.kpi-value');
    if (!value) return;
    value.textContent = text;
    value.classList.remove('badge', 'badge-success', 'badge-danger', 'badge-warn');
    // `tone` arrives as a class STRING ('badge badge-success'): split it, or
    // DOMTokenList rejects the space and the whole tile update dies.
    if (tone) value.classList.add(...tone.split(/\s+/).filter(Boolean));
  };

  const fail = (e) => {
    if (e && e.__toasted) return;
    LOCAL.toast(errMsg(e), 'error');
  };

  /* ------------------------------------------------------------ data load */
  Promise.all([
    call('report.dashboard', { asOfDate: today }),
    call('report.proof', { asOfDate: today }),
    call('ledger.list', { limit: 12 }),
  ]).then(([dash, proof, vouchers]) => {
    const tiles = kpiGrid.querySelectorAll('.kpi');
    if (dash) {
      setTile(tiles[0], fmt(dash.cash), null);
      setTile(tiles[1], fmt(dash.receivables), null);
      setTile(tiles[2], fmtNeg(dash.payables), null);
      setTile(tiles[3], fmt(dash.inventoryValueCents), null);

      const rtiles = resultGrid.querySelectorAll('.kpi');
      setTile(rtiles[0], fmt(dash.netRevenue), null);
      const margin = dash.netRevenue ? Math.round((dash.grossProfit / dash.netRevenue) * 10000) / 100 : 0;
      setTile(rtiles[1], fmt(dash.grossProfit), null);
      const gpSub = rtiles[1].querySelector('.kpi-sub');
      if (gpSub) gpSub.textContent = `margin ${margin.toFixed(2)}%`;
      setTile(rtiles[2], fmtNeg(dash.netProfit), dash.netProfit < 0 ? 'badge badge-danger' : 'badge badge-success');
      setTile(rtiles[3], String(dash.inventoryQty), null);
    }

    if (proof) {
      const tb = proof.trialBalance || {};
      const bs = proof.balanceSheet || {};
      setTile(tbTile, fmt(tb.delta ?? 0), (tb.delta ?? 0) === 0 ? 'badge badge-success' : 'badge badge-danger');
      setTile(bsTile, fmt(bs.delta ?? 0), (bs.delta ?? 0) === 0 ? 'badge badge-success' : 'badge badge-danger');

      const balanced = (tb.delta ?? 1) === 0 && (bs.delta ?? 1) === 0;
      setTile(invTile, balanced ? 'BALANCED' : 'OUT OF BALANCE',
        balanced ? 'badge badge-success' : 'badge badge-danger');
      const invSub = invTile.querySelector('.kpi-sub');
      if (invSub) {
        invSub.textContent = balanced
          ? `ΣDR ${fmt(tb.debits ?? tb.totalDebit ?? 0)} = ΣCR ${fmt(tb.credits ?? tb.totalCredit ?? 0)}`
          : 'investigate before posting further';
      }

      const np = (proof.incomeStatement && proof.incomeStatement.netProfit) || 0;
      setTile(resultProofTile, fmtNeg(np), np < 0 ? 'badge badge-warn' : 'badge badge-success');
      statusLine.textContent = balanced
        ? `Both proofs hold to the cent: trial balance Δ ${fmt(tb.delta ?? 0)} · balance sheet Δ ${fmt(bs.delta ?? 0)}.`
        : 'Warning: an equilibrium proof is out. Open the Trial Balance before posting further.';
    }

    const rows = Array.isArray(vouchers) ? vouchers : [];
    if (rows.length === 0) {
      recentBody.replaceChildren(el('tr', null,
        el('td', { class: 'muted', colspan: '5' }, 'No vouchers posted yet — run the seeder or post a journal.')));
      return;
    }
    recentBody.replaceChildren(...rows.map((v) => el('tr', null,
      el('td', { class: 'mono small' }, String(v.VoucherNo ?? v.voucherNo ?? '—')),
      el('td', { class: 'small' }, String(v.VoucherDate ?? v.voucherDate ?? '')),
      el('td', { class: 'small' }, String(v.VoucherType ?? v.voucherType ?? '')),
      el('td', { class: 'small' }, String(v.Narration ?? v.narration ?? '').slice(0, 90)),
      el('td', { class: 'num money' }, fmt(v.TotalDebit ?? v.totalDebit ?? 0)))));
  }).catch((e) => {
    fail(e);
    statusLine.textContent = `Could not read the ledger: ${errMsg(e)}`;
  });

  return root;
}

export default render;
