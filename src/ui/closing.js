'use strict';

/* ==========================================================================
 * Closing & Backup (src/ui/closing.js)
 *   • fiscal periods table      → closing.status / closing.closePeriod
 *                                  closing.reopenPeriod (Admin/Accountant)
 *   • backup snapshot + JSON    → backup.snapshot / backup.dumpJson
 *   • backup catalogue + restore→ backup.list / backup.restore
 *   • System Proof card         → report.proof { from, to }
 *     (trial-balance delta, balance-sheet delta, net profit)
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

const HELPER_KEYS = ['fmt', 'fmtNeg', 'el', 'call', 'toast', 'modal', 'closeModal', 'confirm'];


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
const yearStart = () => `${new Date().getFullYear()}-01-01`;
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

  /**
   * Confirmation dialog. Electron disables the synchronous `window.confirm`
   * (it always returns false), so the shell's Promise-based modal is used
   * whenever it is available; the native dialog is only trusted when it
   * answers "true", and a standalone browser with no dialog at all proceeds.
   * @param {string} message
   * @param {string} [title]
   * @returns {Promise<boolean>}
   */
  const ask = async (message, title = 'Please confirm') => {
    if (typeof h.confirm === 'function') return (await h.confirm(message, { title })) === true;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return window.confirm(message) === true;
    }
    return true;
  };

  const field = (label, ...controls) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), ...controls);

  /* ----------------------------- widgets ----------------------------- */
  const periodBody = el('tbody', null, el('tr', null, el('td', { colspan: '5', class: 'muted' }, 'Loading…')));
  const snapshotBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Backup snapshot (.db)');
  const dumpBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Export JSON dump');
  const refreshBackupBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '↻ Refresh list');
  const backupOut = el('p', { class: 'hint muted' }, 'Snapshots copy the live SQLite database; JSON dumps serialise every table.');
  const backupBody = el('tbody', null, el('tr', null, el('td', { colspan: '4', class: 'muted' }, 'Loading…')));

  const fromInput = el('input', { class: 'input', type: 'date', value: yearStart() });
  const toInput = el('input', { class: 'input', type: 'date', value: today() });
  const proofBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Run proof');
  const tbTile = el('div', { class: 'kpi' },
    el('div', { class: 'kpi-label' }, 'Trial balance Δ'),
    el('div', { class: 'kpi-value' }, '—'),
    el('div', { class: 'kpi-sub' }, 'ΣDR − ΣCR'));
  const bsTile = el('div', { class: 'kpi' },
    el('div', { class: 'kpi-label' }, 'Balance sheet Δ'),
    el('div', { class: 'kpi-value' }, '—'),
    el('div', { class: 'kpi-sub' }, 'A − (L + E)'));
  const npTile = el('div', { class: 'kpi' },
    el('div', { class: 'kpi-label' }, 'Net profit'),
    el('div', { class: 'kpi-value' }, '—'),
    el('div', { class: 'kpi-sub' }, 'income statement result'));

  const root = el('div', { class: 'screen screen-closing' },
    el('div', { class: 'page-head' },
      el('div', null,
        el('h2', { class: 'card-title section-title' }, 'Closing & Backup'),
        el('p', { class: 'subtitle' }, 'Lock fiscal periods, snapshot the books and verify the accounting proof.'))),

    el('div', { class: 'card card-pad' },
      el('h3', { class: 'card-title section-title' }, 'Fiscal periods'),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' },
          el('thead', null, el('tr', null,
            el('th', null, 'Period'),
            el('th', null, 'Start'),
            el('th', null, 'End'),
            el('th', null, 'Status'),
            el('th', null, ''))),
          periodBody))),

    el('div', { class: 'grid grid-2' },
      el('div', { class: 'card card-pad' },
        el('h3', { class: 'card-title section-title' }, 'Backup'),
        el('p', { class: 'hint' },
          'A snapshot is a consistent copy of the ledger database; the JSON dump is a portable export of every table.'),
        el('div', { class: 'toolbar row mt-1' }, snapshotBtn, dumpBtn, refreshBackupBtn),
        backupOut,
        el('div', { class: 'table-wrap mt-1' },
          el('table', { class: 'table' },
            el('thead', null, el('tr', null,
              el('th', null, 'Snapshot'),
              el('th', null, 'Size'),
              el('th', null, 'Created'),
              el('th', null, ''))),
            backupBody))),
      el('div', { class: 'card card-pad' },
        el('h3', { class: 'card-title section-title' }, 'System Proof'),
        el('div', { class: 'row' },
          field('From', fromInput),
          field('To', toInput),
          proofBtn),
        el('div', { class: 'grid grid-3 mt-1' }, tbTile, bsTile, npTile))));

  view.replaceChildren(root);

  /* --------------------------- periods ------------------------------- */
  function setTile(tile, valueCents, kind) {
    const [ , valueEl, subEl ] = tile.children;
    valueEl.textContent = kind === 'pct' ? String(valueCents) : fmt(valueCents);
    if (kind === 'delta') {
      const ok = Number(valueCents) === 0;
      subEl.textContent = ok ? 'balanced — zero tolerance ✓' : 'MISMATCH — investigate';
      valueEl.className = 'kpi-value ' + (ok ? 'money' : 'money neg');
      valueEl.style.color = ok ? '' : 'var(--red)';
    } else {
      const ok = Number(valueCents) >= 0;
      valueEl.style.color = ok ? '' : 'var(--red)';
    }
  }

  async function loadPeriods() {
    try {
      const rows = (await call('closing.status')) || [];
      periodBody.replaceChildren();
      if (!rows.length) {
        periodBody.append(el('tr', null, el('td', { colspan: '5', class: 'muted' }, 'No fiscal periods defined yet.')));
        return;
      }
      for (const p of rows) {
        const id = pick(p, 'PeriodId', 'periodId', 'id');
        const name = String(pick(p, 'PeriodName', 'periodName', 'name') ?? `Period ${id}`);
        const start = String(pick(p, 'StartDate', 'startDate', 'start') ?? '');
        const end = String(pick(p, 'EndDate', 'endDate', 'end') ?? '');
        const closed = Boolean(pick(p, 'IsClosed', 'isClosed') ?? false);
        const closedAt = pick(p, 'ClosedAt', 'closedAt');

        let action;
        if (closed) {
          const reopenBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Reopen period');
          reopenBtn.addEventListener('click', async () => {
            const sure = await ask(
              `Reopen “${name}”? Postings into this period become possible again. `
              + 'Use this only to correct closed books.',
              'Reopen fiscal period');
            if (!sure) return;
            reopenBtn.disabled = true;
            try {
              await call('closing.reopenPeriod', { periodId: id, createdBy: uid(h) });
              toast(`${name} reopened — postings are unlocked`, 'success');
              loadPeriods();
            } catch (e) {
              fail(e);
              reopenBtn.disabled = false;
            }
          });
          action = el('div', { class: 'row' },
            el('span', { class: 'badge badge-success badge-green' },
              closedAt ? `closed ${String(closedAt).slice(0, 10)}` : 'closed'),
            reopenBtn);
        } else {
          const btn = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Close period');
          btn.addEventListener('click', async () => {
            const sure = await ask(
              `Close “${name}”? Postings into this period will be locked and `
              + 'nominal accounts flushed to Retained Earnings.',
              'Close fiscal period');
            if (!sure) return;
            btn.disabled = true;
            try {
              const res = await call('closing.closePeriod', { periodId: id, createdBy: uid(h) });
              const voucher = (res && res.voucher) || {};
              toast(`${name} closed${voucher.voucherNo ? ` (closing voucher ${voucher.voucherNo})` : ''}`, 'success');
              loadPeriods();
            } catch (e) {
              fail(e);
              btn.disabled = false;
            }
          });
          action = btn;
        }

        periodBody.append(el('tr', null,
          el('td', null, name),
          el('td', null, start),
          el('td', null, end),
          el('td', null, closed
            ? el('span', { class: 'badge badge-danger badge-red' }, 'IsClosed = 1')
            : el('span', { class: 'badge badge-success badge-green' }, 'open')),
          el('td', null, action)));
      }
    } catch (e) {
      fail(e);
      periodBody.replaceChildren(el('tr', null, el('td', { colspan: '5', class: 'muted' }, errMsg(e))));
    }
  }

  /* ---------------------------- backup -------------------------------- */
  async function snapshot() {
    snapshotBtn.disabled = true;
    try {
      const res = await call('backup.snapshot', {});
      const path = (res && (res.path || res.file)) || 'saved';
      const bytes = res && (res.bytes ?? res.size);
      backupOut.textContent = `Snapshot written: ${path}${bytes !== undefined && bytes !== null ? ` (${Number(bytes).toLocaleString('en-US')} bytes)` : ''}`;
      toast('Backup snapshot created', 'success');
      loadBackups();
    } catch (e) { fail(e); } finally { snapshotBtn.disabled = false; }
  }

  async function dumpJson() {
    dumpBtn.disabled = true;
    try {
      const res = await call('backup.dumpJson', {});
      const path = (res && (res.path || res.file)) || 'saved';
      const records = res && res.records;
      backupOut.textContent = `JSON dump written: ${path}${records !== undefined && records !== null ? ` (${Number(records).toLocaleString('en-US')} records)` : ''}`;
      toast('JSON dump exported', 'success');
      loadBackups();
    } catch (e) { fail(e); } finally { dumpBtn.disabled = false; }
  }

  /* ------------------------ backup catalogue / restore ---------------- */
  const kb = (bytes) => {
    const n = Number(bytes) || 0;
    return n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
  };

  async function loadBackups() {
    try {
      const rows = (await call('backup.list')) || [];
      backupBody.replaceChildren();
      if (!rows.length) {
        backupBody.append(el('tr', null, el('td', { colspan: '4', class: 'muted' },
          'No snapshots yet — press “Backup snapshot (.db)” to create one.')));
        return;
      }
      for (const b of rows) {
        const p = String(pick(b, 'path', 'name', 'file') ?? '');
        const name = String(pick(b, 'name', 'path') ?? p);
        const size = Number(pick(b, 'bytes', 'size') ?? 0);
        const created = String(pick(b, 'createdAt', 'created', 'mtime') ?? '').slice(0, 19).replace('T', ' ');

        const restoreBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Restore');
        restoreBtn.addEventListener('click', async () => {
          const sure = await ask(
            `Restore “${name}” over the live database?\n\n`
            + 'Every change made since this snapshot will be lost. The current database '
            + 'is copied aside first (…replaced_<stamp>).',
            'Restore backup');
          if (!sure) return;
          restoreBtn.disabled = true;
          try {
            const res = await call('backup.restore', { sourcePath: p });
            toast(`Restored ${name}${res && res.previous ? ` — previous db kept at ${res.previous}` : ''}`, 'success');
            backupOut.textContent = `Restored from ${name}. The database handle was reopened; reload the app to refresh every screen.`;
            loadBackups();
            loadPeriods();
          } catch (e) {
            fail(e);
            restoreBtn.disabled = false;
          }
        });

        backupBody.append(el('tr', null,
          el('td', { class: 'mono small' }, name),
          el('td', { class: 'num' }, kb(size)),
          el('td', null, created),
          el('td', { class: 'right' }, restoreBtn)));
      }
    } catch (e) {
      backupBody.replaceChildren(el('tr', null, el('td', { colspan: '4', class: 'muted' }, errMsg(e))));
    }
  }

  /* ---------------------------- proof --------------------------------- */
  async function runProof() {
    proofBtn.disabled = true;
    const params = { from: fromInput.value || yearStart(), to: toInput.value || today() };
    try {
      const res = (await call('report.proof', params)) || {};
      const tb = res.trialBalance || {};
      const bs = res.balanceSheet || {};
      const is = res.incomeStatement || {};
      const tbDelta = Number(pick(tb, 'delta') ?? (Number(pick(tb, 'debits') || 0) - Number(pick(tb, 'credits') || 0)));
      const bsDelta = Number(pick(bs, 'delta') ?? (Number(pick(bs, 'assets') || 0) - Number(pick(bs, 'liabilities') || 0) - Number(pick(bs, 'equity') || 0)));
      const netProfit = Number(pick(is, 'netProfit', 'net') ?? 0);
      setTile(tbTile, tbDelta, 'delta');
      setTile(bsTile, bsDelta, 'delta');
      setTile(npTile, netProfit, 'value');
      const ok = tbDelta === 0 && bsDelta === 0;
      toast(ok ? 'Proof verified — both deltas are $0.00' : 'Proof FAILED — deltas are non-zero', ok ? 'success' : 'error');
    } catch (e) {
      fail(e);
    } finally {
      proofBtn.disabled = false;
    }
  }

  /* ----------------------------- wiring ------------------------------- */
  snapshotBtn.addEventListener('click', snapshot);
  dumpBtn.addEventListener('click', dumpJson);
  refreshBackupBtn.addEventListener('click', loadBackups);
  proofBtn.addEventListener('click', runProof);

  loadPeriods();
  loadBackups();
  return root;
}

export default render;
