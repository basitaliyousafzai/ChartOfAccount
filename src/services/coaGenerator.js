'use strict';

/**
 * COA Discovery Generator (Phase 2: Wizard & COA Engine)
 * ----------------------------------------------------------------------------
 * Deterministically compiles the 7-step discovery questionnaire into a fully
 * materialised 5-level Chart of Accounts: the canonical taxonomy (Section 2.3)
 * is always seeded first, then industry/operational answers add the extra
 * posting leaves the business actually needs.  Same answers -> same COA.
 */

const { AccountService } = require('./accountService');
const { ValidationError } = require('../core/errors');

const INDUSTRY_TEMPLATES = {
  retail: [
    { parent: '6.10.03.0000.0000', name: 'Delivery & Courier Expense', description: 'Last-mile delivery and courier costs' },
    { parent: '6.10.01.0000.0000', name: 'Store Consumables & Packaging', description: 'Packaging, bags and consumables' },
    { parent: '6.10.05.0000.0000', name: 'Warranty Claims & Returns Loss', description: 'Customer returns and warranty write-offs' },
    { parent: '4.10.00.0000.0000', name: 'Sundry / Other Trading Income', description: 'Occasional non-core trading income' },
  ],
  services: [
    { parent: '6.10.02.0000.0000', name: 'Professional Fees & Subcontractors', description: 'External specialists and subcontractors' },
    { parent: '6.10.03.0000.0000', name: 'Software Subscriptions & Hosting', description: 'Recurring tooling and hosting fees' },
    { parent: '6.10.01.0000.0000', name: 'Travel & Accommodation', description: 'Client-site travel costs' },
    { parent: '4.10.00.0000.0000', name: 'Installation & Support Revenue', description: 'Implementation and support fees' },
  ],
  manufacturing: [
    { parent: '6.10.02.0000.0000', name: 'Direct Labour - Production', description: 'Production wages' },
    { parent: '6.10.01.0000.0000', name: 'Factory Utilities & Power', description: 'Plant electricity and water' },
    { parent: '5.10.00.0000.0000', name: 'Raw Materials Consumed', description: 'Direct material cost of production' },
    { parent: '5.10.00.0000.0000', name: 'Factory Overheads', description: 'Indirect production costs' },
  ],
  general: [
    { parent: '6.10.01.0000.0000', name: 'Office Supplies & Stationery', description: 'General office consumables' },
    { parent: '6.10.04.0000.0000', name: 'Repairs & Maintenance', description: 'Premises and equipment upkeep' },
    { parent: '6.10.04.0000.0000', name: 'Insurance Expense', description: 'Business insurance premiums' },
    { parent: '4.10.00.0000.0000', name: 'Bank Interest Income', description: 'Interest earned on bank balances' },
  ],
};

function normaliseAnswers(answers = {}) {
  if (typeof answers !== 'object' || answers === null) {
    throw new ValidationError('Wizard answers must be an object');
  }
  return {
    businessName: answers.businessName || 'My Business',
    industry: INDUSTRY_TEMPLATES[answers.industry] ? answers.industry : 'general',
    fiscalYearStart: answers.fiscalYearStart || '01-01',
    currency: (answers.currency || 'USD').toUpperCase().slice(0, 3),
    channels: {
      pos: Boolean(answers.pos),
      invoicing: Boolean(answers.invoicing),
      services: Boolean(answers.services),
    },
    inventoryModel: answers.inventoryModel === 'MAC' ? 'MAC' : 'FIFO',
    taxRegistered: answers.taxRegistered !== false,
    usesPayroll: Boolean(answers.usesPayroll),
    usesFixedAssets: Boolean(answers.usesFixedAssets),
  };
}

class CoaGenerator {
  constructor(db) {
    this.db = db;
    this.accounts = new AccountService(db);
  }

  /** Returns the questionnaire definition rendered by the wizard UI. */
  steps() {
    return [
      { id: 1, title: 'Business identity', fields: [
        { key: 'businessName', label: 'Registered business name', type: 'text', placeholder: 'Apex Tech Store', required: true },
        { key: 'industry', label: 'Industry', type: 'select', options: [
          { value: 'retail', label: 'Retail / Reseller' },
          { value: 'services', label: 'Professional services' },
          { value: 'manufacturing', label: 'Manufacturing' },
          { value: 'general', label: 'General trading' },
        ] },
      ] },
      { id: 2, title: 'Fiscal calendar', fields: [
        { key: 'fiscalYearStart', label: 'Fiscal year start (MM-DD)', type: 'select', options: [
          { value: '01-01', label: 'January 1' },
          { value: '04-01', label: 'April 1' },
          { value: '07-01', label: 'July 1' },
          { value: '10-01', label: 'October 1' },
        ] },
      ] },
      { id: 3, title: 'Currency', fields: [
        { key: 'currency', label: 'Base reporting currency', type: 'select', options: [
          { value: 'USD', label: 'USD - US Dollar' },
          { value: 'EUR', label: 'EUR - Euro' },
          { value: 'GBP', label: 'GBP - Pound Sterling' },
          { value: 'NGN', label: 'NGN - Naira' },
          { value: 'ZAR', label: 'ZAR - Rand' },
        ] },
      ] },
      { id: 4, title: 'Sales channels', fields: [
        { key: 'pos', label: 'Point-of-sale counter (cash sales)', type: 'check' },
        { key: 'invoicing', label: 'Credit invoicing / accounts receivable', type: 'check' },
        { key: 'services', label: 'Services / consulting revenue', type: 'check' },
      ] },
      { id: 5, title: 'Inventory & tax', fields: [
        { key: 'inventoryModel', label: 'Inventory valuation method', type: 'select', options: [
          { value: 'FIFO', label: 'Perpetual FIFO' },
          { value: 'MAC', label: 'Moving average cost' },
        ] },
        { key: 'taxRegistered', label: 'Registered for sales tax / VAT', type: 'check' },
      ] },
      { id: 6, title: 'Payroll & assets', fields: [
        { key: 'usesPayroll', label: 'The business runs monthly payroll', type: 'check' },
        { key: 'usesFixedAssets', label: 'The business owns depreciable fixed assets', type: 'check' },
      ] },
      { id: 7, title: 'Review & generate', fields: [] },
    ];
  }

  /**
   * Compile the questionnaire into a chart of accounts.
   * Idempotent: an answer already reflected in the COA is skipped.
   */
  generate(rawAnswers = {}) {
    const answers = normaliseAnswers(rawAnswers);
    const seeded = this.accounts.seedChartOfAccounts();
    const added = [];

    const ensure = ({ parent, name, description }) => {
      if (this.accounts.findByName(name)) return;
      const account = this.accounts.addAccount({ name, parentCode: parent, description });
      added.push({ code: account.AccountCode, name: account.AccountName, parent });
    };

    for (const entry of INDUSTRY_TEMPLATES[answers.industry] || []) ensure(entry);

    // Channel-specific leaves --------------------------------------------------
    if (answers.channels.pos) {
      ensure({ parent: '1.10.01.0001.0000', name: 'POS Card Settlement Clearing', description: 'Card tender awaiting bank settlement' });
    }
    if (answers.channels.services) {
      ensure({ parent: '4.10.01.0000.0000', name: 'Retainer & Contract Revenue', description: 'Recurring contract income' });
    }
    if (!answers.taxRegistered) {
      ensure({ parent: '4.10.00.0000.0000', name: 'Tax-Inclusive Sales (No Recovery)', description: 'Sales recorded gross where no input tax is recovered' });
    }
    if (answers.usesPayroll) {
      ensure({ parent: '6.10.02.0000.0000', name: 'Employee Benefits & Allowances', description: 'Non-cash benefits and staff allowances' });
      ensure({ parent: '2.10.03.0000.0000', name: 'Payroll Deductions Payable', description: 'Pension and statutory deductions awaiting remittance' });
    }
    if (answers.usesFixedAssets) {
      ensure({ parent: '6.10.04.0000.0000', name: 'Loss on Disposal of Fixed Assets', description: 'Balancing loss on asset disposal' });
      ensure({ parent: '4.20.00.0000.0000', name: 'Gain on Disposal of Fixed Assets', description: 'Balancing gain on asset disposal' });
    }

    return {
      answers,
      seededCanonical: seeded,
      added,
      settings: {
        BaseCurrency: answers.currency,
        InventoryValuationMethod: answers.inventoryModel,
        DefaultSalesTaxRate: answers.taxRegistered ? '0.10' : '0',
        BusinessName: answers.businessName,
        FiscalYearStart: answers.fiscalYearStart,
      },
      tree: this.accounts.buildTree(),
    };
  }
}

module.exports = { CoaGenerator, INDUSTRY_TEMPLATES };
