/**
 * Apex ERP — Discovery Wizard (Section 2 of the SRS).
 *
 * Seven-step interactive questionnaire that gathers how the business runs and
 * then posts the answers to `wizard.generate({ answers })`, rendering the
 * resulting chart-of-accounts tree. Progress bar + back/next controls; the
 * final step is a review summary with the "Generate Chart of Accounts" action.
 */

import { el, call, toast, go } from './app.js';
import { renderTreeInto, normalizeTree, collectCodes } from './coaTree.js';

const INDUSTRIES = [
  'Retail',
  'Wholesale / Trading',
  'Services / Consulting',
  'Manufacturing',
  'Restaurant / Hospitality',
  'Construction',
  'Technology / Software',
  'Transport & Logistics',
  'Healthcare',
  'Education',
  'Other',
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'AUD', 'CAD', 'CHF', 'INR', 'PKR',
  'AED', 'SAR', 'TRY', 'NGN', 'ZAR', 'BRL',
];

const CHANNELS = [
  { key: 'POS', title: 'Point of Sale (counter & till)', desc: 'Cash/credit tenders posting straight to the cash till' },
  { key: 'Invoicing', title: 'Sales invoicing (credit customers)', desc: 'AR invoices, receipts, credit notes and due dates' },
  { key: 'Services', title: 'Services / billing without stock', desc: 'Service and consulting revenue, no inventory lines' },
];

const INVENTORY_MODELS = [
  { v: 'FIFO', title: 'FIFO', desc: 'First-in first-out valuation lots (engine default, §3.3)' },
  { v: 'MovingAverage', title: 'Moving average', desc: 'Weighted-average cost per item' },
];

/** Fresh answer set (defaults are safe, reviewable on step 7). */
function defaultAnswers() {
  const month = new Date().getMonth() + 1;
  return {
    legalName: '',
    industry: '',
    fiscalYearStartMonth: month,
    fiscalYearStart: `${String(month).padStart(2, '0')}-01`,
    baseCurrency: 'USD',
    salesChannels: [],
    inventoryModel: 'FIFO',
    taxRegistered: false,
    payrollInUse: false,
    fixedAssetsInUse: false,
  };
}

/** Persistent answers/step while the shell session lasts. */
let answers = defaultAnswers();
let step = 0;

/* ------------------------------------------------------------ UI helpers */

/** Labeled field wrapper. */
function field(labelText, control, hint) {
  return el(
    'div',
    { class: 'field' },
    el('label', {}, labelText),
    control,
    hint ? el('p', { class: 'hint' }, hint) : null
  );
}

/**
 * Radio cards (visually large selectable options).
 * @returns {HTMLElement} the group container
 */
function radioCards(name, options, current, onChange) {
  const inputs = [];
  const group = el('div', { class: 'radio-group' });

  for (const opt of options) {
    const input = el('input', { type: 'radio', name, value: opt.v });
    input.checked = opt.v === current;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      inputs.forEach((i, idx) => {
        const label = group.children[idx];
        if (label) label.classList.toggle('checked', i.checked);
      });
      onChange(opt.v);
    });
    inputs.push(input);
    group.appendChild(
      el(
        'label',
        { class: `radio-card${input.checked ? ' checked' : ''}` },
        input,
        el(
          'span',
          {},
          el('span', { class: 'cr-title' }, opt.title),
          el('span', { class: 'cr-desc', style: { display: 'block' } }, opt.desc)
        )
      )
    );
  }
  return group;
}

/* ----------------------------------------------------------- step bodies */

function buildIdentity(host, a, ui) {
  const nameInput = el('input', {
    class: 'input',
    type: 'text',
    value: a.legalName,
    placeholder: 'e.g. Apex Retail LLC',
    maxlength: 160,
    oninput: (e) => {
      a.legalName = e.target.value;
      ui.sync();
    },
  });
  const industrySelect = el(
    'select',
    {
      class: 'input',
      onchange: (e) => {
        a.industry = e.target.value;
        ui.sync();
      },
    },
    el('option', { value: '' }, 'Select industry\u2026'),
    INDUSTRIES.map((name) => el('option', { value: name, selected: name === a.industry }, name))
  );

  host.append(
    el('p', { class: 'wizard-q' }, '1. Business legal name & industry', el('span', { class: 'req' }, ' *')),
    el('p', { class: 'hint' }, 'The legal identity feeds report letterheads, closing narrations and backup stamps.'),
    el('div', { class: 'form-grid' }, field('Legal name', nameInput), field('Industry', industrySelect))
  );
}

function buildFiscal(host, a, ui) {
  const select = el(
    'select',
    {
      class: 'input',
      onchange: (e) => {
        a.fiscalYearStartMonth = Number(e.target.value);
        a.fiscalYearStart = `${String(a.fiscalYearStartMonth).padStart(2, '0')}-01`;
        ui.sync();
        meta.textContent = `Fiscal periods will run ${MONTHS[a.fiscalYearStartMonth - 1]} \u2192 ${MONTHS[(a.fiscalYearStartMonth + 10) % 12]}.`;
      },
    },
    MONTHS.map((name, idx) => el('option', { value: String(idx + 1), selected: idx + 1 === a.fiscalYearStartMonth }, name))
  );
  const meta = el('p', { class: 'hint' }, `Fiscal periods will run ${MONTHS[a.fiscalYearStartMonth - 1]} \u2192 ${MONTHS[(a.fiscalYearStartMonth + 10) % 12]}.`);

  host.append(
    el('p', { class: 'wizard-q' }, '2. Fiscal year start', el('span', { class: 'req' }, ' *')),
    el('p', { class: 'hint' }, 'Determines the fiscal periods generated for posting and period closing.'),
    el('div', { class: 'form-grid' }, field('Start month', select, `Recorded as \u201c${a.fiscalYearStart}\u201d.`)),
    meta
  );
}

function buildCurrency(host, a, ui) {
  const select = el(
    'select',
    {
      class: 'input',
      onchange: (e) => {
        a.baseCurrency = e.target.value;
        ui.sync();
      },
    },
    CURRENCIES.map((code) => el('option', { value: code, selected: code === a.baseCurrency }, code))
  );

  host.append(
    el('p', { class: 'wizard-q' }, '3. Base currency', el('span', { class: 'req' }, ' *')),
    el('p', { class: 'hint' }, 'Every amount is stored as integer cents of this currency \u2014 never as floats.'),
    el('div', { class: 'form-grid' }, field('Currency code', select, 'ISO 4217 code used on all reports and vouchers.'))
  );
}

function buildChannels(host, a, ui) {
  const rows = CHANNELS.map((channel) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = a.salesChannels.includes(channel.key);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!a.salesChannels.includes(channel.key)) a.salesChannels.push(channel.key);
      } else {
        a.salesChannels = a.salesChannels.filter((k) => k !== channel.key);
      }
      row.classList.toggle('checked', cb.checked);
      ui.sync();
    });
    const row = el(
      'label',
      { class: `check-row${cb.checked ? ' checked' : ''}` },
      cb,
      el(
        'span',
        {},
        el('span', { class: 'cr-title' }, channel.title),
        el('span', { class: 'cr-desc', style: { display: 'block' } }, channel.desc)
      )
    );
    return row;
  });

  host.append(
    el('p', { class: 'wizard-q' }, '4. Sales channels in use', el('span', { class: 'req' }, ' *')),
    el('p', { class: 'hint' }, 'Pick every channel the business uses \u2014 it decides which operational screens and posting rules apply.'),
    el('div', { class: 'check-list' }, rows)
  );
}

function buildInventory(host, a, ui) {
  host.append(
    el('p', { class: 'wizard-q' }, '5. Inventory model & tax registration', el('span', { class: 'req' }, ' *')),
    field(
      'Inventory valuation',
      radioCards('wiz-inventory', INVENTORY_MODELS, a.inventoryModel, (v) => {
        a.inventoryModel = v;
        ui.sync();
      }),
      'Applies to stock lots, COGS and shrinkage postings.'
    ),
    field(
      'Tax status',
      radioCards(
        'wiz-tax',
        [
          { v: 'yes', title: 'Tax registered', desc: 'Maintains output VAT payable and input VAT recoverable accounts' },
          { v: 'no', title: 'Not tax registered', desc: 'No tax control accounts in the generated COA' },
        ],
        a.taxRegistered ? 'yes' : 'no',
        (v) => {
          a.taxRegistered = v === 'yes';
          ui.sync();
        }
      ),
      'Tax registration adds input/output tax control accounts to the chart.'
    )
  );
}

function buildPayroll(host, a, ui) {
  const yesNo = (name, current, onChange) =>
    radioCards(
      name,
      [
        { v: 'yes', title: 'Yes, in use', desc: 'Included in the questionnaire answer set' },
        { v: 'no', title: 'No', desc: 'Module stays out of the generated configuration' },
      ],
      current ? 'yes' : 'no',
      (v) => {
        onChange(v === 'yes');
        ui.sync();
      }
    );

  host.append(
    el('p', { class: 'wizard-q' }, '6. Payroll & fixed assets in use?', el('span', { class: 'req' }, ' *')),
    el('p', { class: 'hint' }, 'Enables the matching operational screens and account groups in the generated chart.'),
    el(
      'div',
      { class: 'form-grid' },
      field('Payroll', yesNo('wiz-payroll', a.payrollInUse, (v) => (a.payrollInUse = v)),
        'Employees, salaries, withholdings and pension contributions.'),
      field('Fixed assets', yesNo('wiz-assets', a.fixedAssetsInUse, (v) => (a.fixedAssetsInUse = v)),
        'Depreciable assets and accumulated depreciation reserves.')
    )
  );
}

function buildReview(host, a) {
  const list = el('dl', { class: 'review-list' });
  const add = (label, value) => {
    list.appendChild(el('dt', {}, label));
    list.appendChild(el('dd', {}, value));
  };

  add('Legal name', a.legalName || '\u2014');
  add('Industry', a.industry || '\u2014');
  add('Fiscal year start', `${MONTHS[a.fiscalYearStartMonth - 1]} (${a.fiscalYearStart})`);
  add('Base currency', a.baseCurrency);
  add('Sales channels', a.salesChannels.length ? a.salesChannels.join(' \u00b7 ') : '\u2014');
  add('Inventory model', a.inventoryModel);
  add('Tax registered', a.taxRegistered ? 'Yes' : 'No');
  add('Payroll in use', a.payrollInUse ? 'Yes' : 'No');
  add('Fixed assets in use', a.fixedAssetsInUse ? 'Yes' : 'No');

  const generateBtn = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: 'Generate Chart of Accounts',
  });
  generateBtn.addEventListener('click', () => generate(generateBtn));

  host.append(
    el('p', { class: 'wizard-q' }, '7. Review & generate'),
    el('p', { class: 'hint' }, 'Confirm the answers below, then generate the chart of accounts deterministically.'),
    list,
    el(
      'div',
      { class: 'row mt-1' },
      generateBtn,
      el('span', { class: 'hint' }, 'Calls \u201cwizard.generate\u201d and renders the resulting tree.')
    )
  );
}

/** Ask the kernel to generate the COA, then show the resulting tree. */
async function generate(btn) {
  btn.disabled = true;
  btn.textContent = 'Generating\u2026';
  try {
    const payload = await call('wizard.generate', {
      answers: { ...answers, salesChannels: [...answers.salesChannels] },
    });
    await showResult(payload);
  } catch (_err) {
    // error toast already raised by call(); let the user retry
    btn.disabled = false;
    btn.textContent = 'Generate Chart of Accounts';
  }
}

/* ------------------------------------------------------- step definition */

const STEPS = [
  {
    title: 'Business',
    empty: 'Enter the legal name and pick an industry.',
    build: buildIdentity,
    validate: (a) => Boolean(a.legalName.trim()) && Boolean(a.industry),
  },
  { title: 'Fiscal year', empty: 'Pick the fiscal year start month.', build: buildFiscal, validate: (a) => Boolean(a.fiscalYearStartMonth) },
  { title: 'Currency', empty: 'Pick the base currency.', build: buildCurrency, validate: (a) => Boolean(a.baseCurrency) },
  { title: 'Channels', empty: 'Select at least one sales channel.', build: buildChannels, validate: (a) => a.salesChannels.length > 0 },
  { title: 'Inventory & tax', empty: 'Choose an inventory model and tax status.', build: buildInventory, validate: () => true },
  { title: 'Payroll & assets', empty: 'Answer both questions.', build: buildPayroll, validate: () => true },
  { title: 'Review', empty: '', build: buildReview, validate: () => true },
];

/* ---------------------------------------------------------- result view */

/** Render the post-generation success screen with the fresh account tree. */
async function showResult(payload) {
  const view = document.getElementById('view');
  if (!view) return;

  let tree = normalizeTree(payload && payload.tree);
  if (!tree.length) {
    try {
      tree = normalizeTree(await call('coa.tree', {}));
    } catch (_err) {
      tree = [];
    }
  }
  const added = payload && Array.isArray(payload.added) ? payload.added : [];

  view.innerHTML = '';
  const treeHost = el('div', {});
  const expandedSet = collectCodes(tree);
  const draw = () => {
    treeHost.innerHTML = '';
    renderTreeInto(treeHost, tree, { expanded: expandedSet, indexSource: tree, onToggle: draw });
  };

  const restartBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Start over' });
  restartBtn.addEventListener('click', () => {
    answers = defaultAnswers();
    step = 0;
    render(view);
  });

  view.appendChild(
    el(
      'section',
      { class: 'screen wizard-screen' },
      el(
        'div',
        { class: 'card card-pad' },
        el(
          'div',
          { class: 'gen-success' },
          el('span', { class: 'big-check', 'aria-hidden': 'true' }, '\u2713'),
          el('h1', {}, 'Chart of Accounts generated'),
          el(
            'p',
            { class: 'muted' },
            added.length
              ? `${added.length} account${added.length === 1 ? '' : 's'} added deterministically from your answers.`
              : 'The wizard returned a chart of accounts.'
          ),
          added.length
            ? el('div', { class: 'code-chips' }, added.map((code) => el('span', { class: 'code-chip' }, String(code))))
            : null,
          el(
            'div',
            { class: 'row mt-1' },
            el('button', {
              class: 'btn btn-primary',
              type: 'button',
              text: 'Open Chart of Accounts',
              onclick: () => go('coa'),
            }),
            restartBtn
          )
        )
      ),
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('span', { class: 'card-title' }, 'Generated chart of accounts')),
        el('div', { class: 'card-body' }, treeHost)
      )
    )
  );

  draw();
}

/* --------------------------------------------------------------- screen */

/**
 * Render the Discovery Wizard (module default export).
 * @param {HTMLElement} container
 */
export default function render(container) {
  const screen = el('section', { class: 'screen wizard-screen' });

  screen.appendChild(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Discovery Wizard'),
        el('p', { class: 'subtitle' }, 'Seven questions about the business \u2014 then one deterministic chart of accounts.')
      )
    )
  );

  /* progress */
  const fill = el('div', { class: 'progress-fill', style: { width: '14%' } });
  const stepItems = STEPS.map((s, i) =>
    el('li', {}, el('span', { class: 'step-dot' }, String(i + 1)), el('span', {}, s.title))
  );
  const meta = el('p', { class: 'wizard-step-meta' });
  screen.appendChild(
    el(
      'div',
      { class: 'card card-pad wizard-progress' },
      el('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(STEPS.length) }, fill),
      el('ol', { class: 'wizard-steps' }, stepItems),
      meta
    )
  );

  /* body + footer */
  const body = el('div', { class: 'card-body wizard-body' });
  const backBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: '\u2190 Back' });
  const nextBtn = el('button', { class: 'btn btn-primary', type: 'button', text: 'Next \u2192' });
  const stepCard = el('div', { class: 'card' }, body, el('div', { class: 'wizard-foot' }, backBtn, el('span', { class: 'spacer' }), nextBtn));
  screen.appendChild(stepCard);
  container.appendChild(screen);

  const ui = {
    sync: () => {
      const current = STEPS[step];
      nextBtn.disabled = !current.validate(answers);
    },
    rerender: () => renderStep(),
  };

  function renderStep() {
    const current = STEPS[step];
    body.innerHTML = '';
    current.build(body, answers, ui);

    stepItems.forEach((item, i) => {
      item.classList.toggle('current', i === step);
      item.classList.toggle('done', i < step);
    });
    fill.style.width = `${Math.round(((step + 1) / STEPS.length) * 100)}%`;
    meta.textContent = `Step ${step + 1} of ${STEPS.length} \u00b7 ${current.title}`;

    backBtn.disabled = step === 0;
    nextBtn.classList.toggle('hidden', step === STEPS.length - 1);
    ui.sync();
  }

  backBtn.addEventListener('click', () => {
    if (step > 0) {
      step -= 1;
      renderStep();
    }
  });

  nextBtn.addEventListener('click', () => {
    const current = STEPS[step];
    if (!current.validate(answers)) {
      toast(current.empty || 'Complete this step before continuing.', 'warn');
      return;
    }
    if (step < STEPS.length - 1) {
      step += 1;
      renderStep();
    }
  });

  renderStep();
}
