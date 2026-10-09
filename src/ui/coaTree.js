/**
 * Apex ERP — Chart of Accounts viewer.
 *
 * Hierarchical, five-level account tree with search, expand/collapse,
 * per-node badges, right-aligned integer-cent balances, a detail modal
 * (backed by `coa.balance`) and an "Add Account" modal that previews the
 * sequential code from `coa.nextChildCode` before posting via `coa.add`.
 *
 * `renderTreeInto` is exported so other screens (e.g. the Discovery Wizard
 * result view) can reuse the same table renderer.
 */

import { el, call, modal, toast, fmt, go } from './app.js';

/* -------------------------------------------------- account-code helpers */

/** Level of a canonical code `X.XX.XX.XXXX.XXXX` (1..5), else null. */
function levelOfCode(code) {
  const parts = String(code || '').split('.');
  if (parts.length !== 5) return null;
  if (!/^\d$/.test(parts[0])) return null;
  if (parts[1].length !== 2 || parts[2].length !== 2 || parts[3].length !== 4 || parts[4].length !== 4) return null;
  if (parts[4] !== '0000') return 5;
  if (parts[3] !== '0000') return 4;
  if (parts[2] !== '00') return 3;
  if (parts[1] !== '00') return 2;
  return 1;
}

/** Parent code of a canonical account code (null for Level 1). */
function parentOfCode(code) {
  const level = levelOfCode(code);
  if (!level || level === 1) return null;
  const [l1, l2, l3, l4] = String(code).split('.');
  if (level === 5) return `${l1}.${l2}.${l3}.${l4}.0000`;
  if (level === 4) return `${l1}.${l2}.${l3}.0000.0000`;
  if (level === 3) return `${l1}.${l2}.00.0000.0000`;
  return `${l1}.00.00.0000.0000`;
}

/** Level of a tree node (kernel column first, code derivation as fallback). */
function levelOfNode(node) {
  return Number(node.AccountLevel || node.accountLevel) || levelOfCode(codeOf(node)) || 1;
}

const codeOf = (node) => String(node.AccountCode || node.accountCode || '');
const nameOf = (node) => String(node.AccountName || node.accountName || '');
const balanceOf = (node) => Number(node.balance || 0);

/**
 * Accept whatever `coa.tree` returned (array, `{ nodes }`, `{ roots }`,
 * `{ tree }`) and always hand back a plain node array.
 * @param {any} payload
 * @returns {Array<object>}
 */
export function normalizeTree(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['nodes', 'roots', 'tree', 'accounts']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}

/** Collect every account code in a tree (used for expand-all). */
export function collectCodes(nodes, out = new Set()) {
  for (const node of nodes || []) {
    const code = codeOf(node);
    if (code) out.add(code);
    if (node.children && node.children.length) collectCodes(node.children, out);
  }
  return out;
}

/* ----------------------------------------------------------- row builder */

function textMatches(node, q) {
  return (
    codeOf(node).toLowerCase().includes(q) ||
    nameOf(node).toLowerCase().includes(q) ||
    String(node.RootType || '').toLowerCase().includes(q)
  );
}

function subtreeMatches(node, q) {
  if (textMatches(node, q)) return true;
  return (node.children || []).some((kid) => subtreeMatches(kid, q));
}

/** Flatten the (visible) hierarchy into row descriptors. */
function buildRows(nodes, expanded, query, depth, out) {
  const q = query.trim().toLowerCase();
  for (const node of nodes || []) {
    if (q && !subtreeMatches(node, q)) continue;
    const kids = node.children || [];
    const code = codeOf(node);
    const open = q ? kids.length > 0 : expanded.has(code);
    out.push({ node, depth, hasKids: kids.length > 0, open, level: levelOfNode(node) });
    if (open && kids.length) buildRows(kids, expanded, q, depth + 1, out);
  }
  return out;
}

/** Badge cluster: level, root type, normal balance, posting, post-target. */
function badgeRow(node, level) {
  const root = String(node.RootType || node.rootType || '');
  const normal = String(node.NormalBalance || node.normalBalance || '');
  const isDebit = normal.toLowerCase().startsWith('d');
  const posting =
    node.IsPostingAllowed === true ||
    node.IsPostingAllowed === 1 ||
    node.isPostingAllowed === true ||
    node.isPostingAllowed === 1;

  return el(
    'div',
    { class: 'coa-attrs' },
    el('span', { class: 'badge badge-lvl' }, `L${level}`),
    root ? el('span', { class: `badge badge-root-${root.toLowerCase()}` }, root) : null,
    normal ? el('span', { class: isDebit ? 'badge badge-dr' : 'badge badge-cr' }, isDebit ? 'Dr' : 'Cr') : null,
    posting ? el('span', { class: 'badge badge-posting' }, 'Posting') : el('span', { class: 'badge badge-summary' }, 'Summary'),
    level === 5
      ? el('span', { class: 'badge badge-post', title: 'Voucher lines can only be posted to Level-5 accounts' }, 'Post to this account')
      : null
  );
}

/** code → node index of the *full* tree (for parent names / add modal). */
let nodeIndex = new Map();
/** Set by the screen so a successful `coa.add` can refresh the table. */
let screenReload = null;
/** Set by the screen so row toggles re-render without leaking DOM handlers. */
let rerenderHook = null;

function indexTree(nodes) {
  const map = new Map();
  const walk = (list) => {
    for (const node of list || []) {
      const code = codeOf(node);
      if (code && !map.has(code)) map.set(code, node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return map;
}

/**
 * Render the account hierarchy into `container` as a table with a sticky
 * header, indented rows, expand/collapse toggles and clickable detail rows.
 *
 * @param {HTMLElement} container
 * @param {Array<object>} nodes normalized `coa.tree` nodes
 * @param {{expanded?:Set<string>, query?:string, indexSource?:Array<object>,
 *          onOpen?:(node:object)=>void}} [opts]
 * @returns {{rows:number, total:number}}
 */
export function renderTreeInto(container, nodes, opts = {}) {
  const expanded = opts.expanded || new Set();
  const query = opts.query || '';
  const onOpen = opts.onOpen || ((node) => openAccountDetail(node));

  nodeIndex = indexTree(opts.indexSource || nodes);

  const visible = [];
  buildRows(nodes, expanded, query, 0, visible);
  const total = nodeIndex.size;

  if (!visible.length) {
    container.appendChild(
      el('div', { class: 'screen-empty' }, query ? `No accounts match \u201c${query}\u201d.` : 'No accounts defined yet.')
    );
    return { rows: 0, total };
  }

  const tbody = el('tbody', {});
  for (const row of visible) {
    const { node, depth, hasKids, open, level } = row;
    const code = codeOf(node);
    const name = nameOf(node);
    const balance = balanceOf(node);

    const toggle = el('button', {
      class: `coa-toggle${hasKids ? '' : ' leaf'}`,
      type: 'button',
      'aria-expanded': open ? 'true' : 'false',
      'aria-label': open ? 'Collapse' : 'Expand',
      text: open ? '\u25be' : '\u25b8',
    });
    if (hasKids) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (expanded.has(code)) expanded.delete(code);
        else expanded.add(code);
        if (opts.onToggle) opts.onToggle(code);
        else if (rerenderHook) rerenderHook();
      });
    }

    const tr = el(
      'tr',
      { class: `coa-row lvl-${level}`, 'data-code': code, tabindex: '0' },
      el(
        'td',
        {},
        el(
          'div',
          { class: 'coa-main', style: { paddingLeft: `${depth * 20}px` } },
          toggle,
          el('span', { class: 'coa-code' }, code),
          el('span', { class: 'coa-name', title: name }, name)
        )
      ),
      el('td', {}, badgeRow(node, level)),
      el(
        'td',
        { class: 'num' },
        el(
          'span',
          { class: `money${balance < 0 ? ' neg' : balance === 0 ? ' zero' : ''}` },
          fmt(balance)
        )
      )
    );

    tr.addEventListener('click', (e) => {
      if (e.target.closest('.coa-toggle')) return;
      onOpen(node);
    });
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen(node);
      }
    });
    tbody.appendChild(tr);
  }

  const table = el(
    'table',
    { class: 'table coa-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', {}, 'Account'),
        el('th', {}, 'Attributes'),
        el('th', { class: 'num' }, 'Balance')
      )
    ),
    tbody
  );

  const wrap = el('div', { class: 'table-wrap' }, table);
  container.appendChild(wrap);
  container.appendChild(el('p', { class: 'coa-count mt-1' }, `${visible.length} of ${total} accounts shown`));
  return { rows: visible.length, total };
}

/* ------------------------------------------------------- detail modal */

/** Fill the detail modal with `coa.balance` totals + description lookup. */
async function fillDetail(node, body) {
  const code = codeOf(node);

  const descEl = body.querySelector('.detail-desc');
  if (descEl) {
    let desc = node.Description || node.description || '';
    if (!desc) {
      try {
        const payload = await call('coa.list', { search: code });
        const rows = Array.isArray(payload) ? payload : (payload && (payload.rows || payload.accounts)) || [];
        const hit = rows.find((r) => String(r.AccountCode || r.accountCode) === code);
        desc = (hit && (hit.Description || hit.description)) || '';
      } catch (_err) {
        desc = '';
      }
    }
    descEl.textContent = desc || '\u2014';
  }

  try {
    const result = await call('coa.balance', { accountCode: code, includeChildren: true });
    const debit = body.querySelector('[data-bal="debit"]');
    const credit = body.querySelector('[data-bal="credit"]');
    const balance = body.querySelector('[data-bal="balance"]');
    if (debit) debit.textContent = fmt(result.totalDebit || 0);
    if (credit) credit.textContent = fmt(result.totalCredit || 0);
    if (balance) {
      const b = Number(result.balance || 0);
      balance.textContent = fmt(b);
      balance.classList.toggle('neg', b < 0);
    }
  } catch (_err) {
    /* error toast already raised by call() */
  }
}

/** Open the account detail modal (code, hierarchy, flags, live balance). */
function openAccountDetail(node) {
  const code = codeOf(node);
  const level = levelOfNode(node);
  const root = String(node.RootType || node.rootType || '\u2014');
  const normal = String(node.NormalBalance || node.normalBalance || '\u2014');
  const posting =
    node.IsPostingAllowed === true || node.IsPostingAllowed === 1 || node.isPostingAllowed === 1 ? 'Yes' : 'No';

  const parentCode = parentOfCode(code);
  const parentNode = parentCode ? nodeIndex.get(parentCode) : null;
  const parentLabel = parentCode
    ? `${parentCode} \u2014 ${parentNode ? nameOf(parentNode) : 'unknown parent'}`
    : '\u2014 (top level)';

  const tile = (label, key) =>
    el(
      'div',
      { class: 'balance-tile' },
      el('div', { class: 'bt-label' }, label),
      el('div', { class: 'bt-value money', dataset: { bal: key } }, '\u2026')
    );

  const detail = el(
    'dl',
    { class: 'detail-grid' },
    el('dt', {}, 'Code'),
    el('dd', {}, el('span', { class: 'mono' }, code)),
    el('dt', {}, 'Name'),
    el('dd', {}, nameOf(node)),
    el('dt', {}, 'Parent'),
    el('dd', {}, parentLabel),
    el('dt', {}, 'Level'),
    el('dd', {}, `L${level}${level === 5 ? ' \u2014 posting level' : ''}`),
    el('dt', {}, 'Root type'),
    el('dd', {}, root),
    el('dt', {}, 'Normal balance'),
    el('dd', {}, normal),
    el('dt', {}, 'Posting allowed'),
    el('dd', {}, posting),
    el('dt', {}, 'Description'),
    el('dd', {}, el('span', { class: 'detail-desc' }, '\u2026'))
  );

  const body = el(
    'div',
    {},
    detail,
    el(
      'div',
      { class: 'balance-box' },
      tile('Total debit', 'debit'),
      tile('Total credit', 'credit'),
      tile('Balance', 'balance')
    ),
    el('p', { class: 'hint mt-1' }, 'Balances computed by \u2018coa.balance\u2019 (integer cents, roll-up incl. children).')
  );

  modal({
    title: `${code} \u00b7 ${nameOf(node)}`,
    body,
    actions: [
      { label: 'Close', kind: 'btn btn-ghost' },
      {
        label: 'Add child account',
        kind: 'btn btn-primary',
        disabled: level >= 5,
        onClick: () => {
          openAddAccountModal(node);
          return false; // the add modal replaces this one
        },
      },
    ],
  });

  fillDetail(node, body);
}

/* -------------------------------------------------------- add account */

/** Options for the parent select: every non-Level-5 node, in tree order. */
function parentOptions() {
  return Array.from(nodeIndex.values())
    .map((node) => ({ node, level: levelOfNode(node) }))
    .filter((entry) => entry.level < 5 && codeOf(entry.node));
}

/** Open the "Add Account" modal; previews `coa.nextChildCode`, posts `coa.add`. */
function openAddAccountModal(presetParent) {
  const options = parentOptions();
  if (!options.length) {
    toast('No accounts available yet \u2014 run the Discovery Wizard first.', 'warn');
    return;
  }

  const select = el('select', { class: 'input', id: 'add-parent' });
  for (const { node, level } of options) {
    const indent = '\u00a0\u00a0'.repeat(level - 1);
    select.appendChild(
      el('option', { value: codeOf(node) }, `${indent}${codeOf(node)} \u2014 ${nameOf(node)}`)
    );
  }

  // Preselect: eligible parent → its parent → first option.
  let presetCode = presetParent ? codeOf(presetParent) : '';
  if (presetCode && (!nodeIndex.has(presetCode) || levelOfNode(nodeIndex.get(presetCode)) >= 5)) {
    presetCode = parentOfCode(presetCode) || '';
  }
  if (presetCode && options.some((o) => codeOf(o.node) === presetCode)) select.value = presetCode;
  else if (options.length) select.value = codeOf(options[0].node);

  const codePreview = el('output', { class: 'code-preview', for: 'add-parent' }, '\u2026');
  async function refreshNextCode() {
    codePreview.textContent = '\u2026';
    try {
      const nextCode = await call('coa.nextChildCode', { parentCode: select.value });
      codePreview.textContent = nextCode || '\u2014';
    } catch (_err) {
      codePreview.textContent = '\u2014';
    }
  }
  select.addEventListener('change', refreshNextCode);
  refreshNextCode();

  const nameInput = el('input', {
    class: 'input',
    id: 'add-name',
    type: 'text',
    placeholder: 'e.g. Website Maintenance Expense',
    maxlength: 140,
  });
  const descInput = el('textarea', {
    class: 'textarea',
    id: 'add-desc',
    placeholder: 'Optional description shown on the account detail card',
  });
  const contraInput = el('input', { type: 'checkbox', id: 'add-contra' });
  contraInput.addEventListener('change', () => contraRow.classList.toggle('checked', contraInput.checked));
  const contraRow = el(
    'label',
    { class: 'check-row', for: 'add-contra' },
    contraInput,
    el(
      'span',
      {},
      el('span', { class: 'cr-title' }, 'Contra account'),
      el('span', { class: 'cr-desc', style: { display: 'block' } }, 'Inverts the normal balance of its root (e.g. Accumulated Depreciation).')
    )
  );

  const body = el(
    'div',
    { class: 'form-grid cols-1' },
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'add-parent' }, 'Parent account'),
      select,
      el('p', { class: 'hint' }, 'Levels 1\u20134 may host children; Level 5 is the posting level.')
    ),
    el(
      'div',
      { class: 'field' },
      el('label', {}, 'Next sequential code'),
      codePreview
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'add-name' }, 'Account name', el('span', { class: 'req' }, ' *')),
      nameInput
    ),
    contraRow,
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'add-desc' }, 'Description'),
      descInput
    )
  );

  async function submit() {
    const name = nameInput.value.trim();
    if (!name) {
      toast('Enter a name for the new account.', 'warn');
      nameInput.focus();
      return false;
    }
    try {
      const row = await call('coa.add', {
        name,
        parentCode: select.value,
        isContra: contraInput.checked,
        description: descInput.value.trim() || undefined,
      });
      const newCode = (row && (row.AccountCode || row.accountCode)) || codePreview.textContent;
      toast(`Account created: ${newCode} \u2014 ${name}`, 'success');
      if (screenReload) {
        expanded.add(select.value); // reveal the new sibling
        await screenReload();
      }
      return true; // action wrapper closes the modal
    } catch (_err) {
      return false; // error toast already shown by call()
    }
  }

  modal({
    title: 'Add account',
    size: 'modal-lg',
    body,
    actions: [
      { label: 'Cancel', kind: 'btn btn-ghost' },
      { label: 'Add account', kind: 'btn btn-primary', onClick: submit },
    ],
  });
}

/* ----------------------------------------------------------- the screen */

/** Shared expand/collapse set (persists while the session lasts). */
const expanded = new Set();

/** @type {Array<object>} */
let currentTree = [];

/** Draw the current tree (filtered by `query`) into `host`. */
function drawInto(host, query) {
  host.innerHTML = '';
  renderTreeInto(host, currentTree, { expanded, query, indexSource: currentTree });
}

/**
 * Render the Chart of Accounts screen (module default export).
 * @param {HTMLElement} container
 */
export default async function render(container) {
  let query = '';
  let debounceTimer = 0;

  const host = el('div', { class: 'coa-host' });
  rerenderHook = () => drawInto(host, query);

  const searchInput = el('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search by code, name or root type\u2026',
    'aria-label': 'Search accounts',
    value: query,
  });
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      query = searchInput.value;
      drawInto(host, query);
    }, 180);
  });

  const addBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '+ Add Account' });
  addBtn.addEventListener('click', () => openAddAccountModal(null));

  const refreshBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '\u21bb Refresh' });
  refreshBtn.addEventListener('click', () => reload());

  const expandBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Expand all' });
  expandBtn.addEventListener('click', () => {
    collectCodes(currentTree).forEach((code) => {
      const node = nodeIndex.get(code);
      if (node && node.children && node.children.length) expanded.add(code);
    });
    drawInto(host, searchInput.value);
  });

  const collapseBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Collapse all' });
  collapseBtn.addEventListener('click', () => {
    expanded.clear();
    drawInto(host, searchInput.value);
  });

  async function reload() {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'screen-loading' }, el('span', { class: 'spinner' }), 'Loading chart of accounts\u2026'));
    try {
      currentTree = normalizeTree(await call('coa.tree', {}));
      if (!currentTree.length) {
        host.innerHTML = '';
        host.appendChild(
          el(
            'div',
            { class: 'screen-empty' },
            el('div', { class: 'center' },
              el('p', {}, 'The account tree is empty.'),
              el('p', { class: 'muted small mt-1' }, 'Run the 7-step Discovery Wizard to generate a chart of accounts.'),
              el('button', {
                class: 'btn btn-primary btn-sm mt-2',
                type: 'button',
                text: 'Open Discovery Wizard',
                onclick: () => go('wizard'),
              })
            )
          )
        );
        return;
      }
      // First load: expand the top two levels so the tree is readable.
      if (!expanded.size) {
        for (const node of currentTree) {
          expanded.add(codeOf(node));
          for (const kid of node.children || []) expanded.add(codeOf(kid));
        }
      }
      drawInto(host, searchInput.value);
    } catch (_err) {
      host.innerHTML = '';
      host.appendChild(
        el(
          'div',
          { class: 'screen-empty' },
          'Could not load the chart of accounts \u2014 see the error notification.'
        )
      );
    }
  }

  screenReload = reload;

  container.appendChild(
    el(
      'section',
      { class: 'screen coa-screen' },
      el(
        'div',
        { class: 'page-head' },
        el(
          'div',
          {},
          el('h1', {}, 'Chart of Accounts'),
          el('p', { class: 'subtitle' }, 'Five-level hierarchy \u00b7 root-type driven normal balances \u00b7 integer-cent amounts')
        ),
        el('div', { class: 'page-actions' }, addBtn, refreshBtn)
      ),
      el(
        'div',
        { class: 'card card-pad' },
        el(
          'div',
          { class: 'coa-toolbar' },
          el('div', { class: 'search-box' }, searchInput),
          expandBtn,
          collapseBtn,
          el(
            'div',
            { class: 'coa-legend', title: 'Legend' },
            el('span', {}, 'Badges:'),
            el('span', { class: 'badge badge-lvl' }, 'L1\u2026L5'),
            el('span', { class: 'badge badge-root-asset' }, 'RootType'),
            el('span', { class: 'badge badge-dr' }, 'Dr'),
            el('span', { class: 'badge badge-cr' }, 'Cr'),
            el('span', { class: 'badge badge-posting' }, 'Posting'),
            el('span', { class: 'badge badge-post' }, 'Post to this account = Level 5')
          )
        )
      ),
      host
    )
  );

  await reload();
}
