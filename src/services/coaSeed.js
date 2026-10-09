'use strict';

/**
 * Master Canonical Chart of Accounts (Section 2.3) - deterministic seed data.
 *
 * Coding standard:  X.XX.XX.XXXX.XXXX   (Level 1..5, 15 characters)
 *
 * The SRS table lists every leaf plus several summary heads; where the table
 * skips an intermediate level (e.g. jumps from 1.20.00.0000.0000 straight to
 * 1.20.01.0001.0001) the missing Level 3/4 node is materialised here so the
 * hierarchy is a strict, FK-valid 5-level tree with no orphaned codes.
 *
 * Tuple: [AccountCode, AccountName, RootType, IsContra, Description]
 * Level and NormalBalance are derived deterministically from the code/root type.
 */

const ROOT_TYPES = {
  1: { root: 'Asset', normal: 'Debit' },
  2: { root: 'Liability', normal: 'Credit' },
  3: { root: 'Equity', normal: 'Credit' },
  4: { root: 'Revenue', normal: 'Credit' },
  5: { root: 'CostOfSales', normal: 'Debit' },
  6: { root: 'Expense', normal: 'Debit' },
};

/** Explicit normal-balance overrides for contra accounts (Section 2.2). */
const CONTRA_NORMAL = {
  '1.20.02.0001.0001': 'Credit', // Accumulated Depreciation (contra-asset)
  '3.10.01.0002.0001': 'Debit',  // Owner Drawings (contra-equity)
  '4.10.02.0001.0001': 'Debit',  // Sales Returns & Allowances (contra-revenue)
  '4.10.02.0002.0001': 'Debit',  // Sales Discounts Allowed (contra-revenue)
  '4.10.02.0003.0001': 'Debit',  // Rounding Adjustment (contra-revenue)
};

// [code, name, isContra, description]
const CANONICAL_COA = [
  // ---------------------------------------------------------------- ASSETS
  ['1.00.00.0000.0000', 'ASSETS', false, 'Root Level 1 Summary Head'],
  ['1.10.00.0000.0000', 'Current Assets', false, 'Short-term economic resources'],
  ['1.10.01.0000.0000', 'Cash and Cash Equivalents', false, 'Liquid cash & banking summary'],
  ['1.10.01.0001.0000', 'Cash on Hand', false, 'Physical currency till group'],
  ['1.10.01.0001.0001', 'Main Cash Till / Petty Cash', false, 'POS Cash drawer posting leaf'],
  ['1.10.01.0002.0000', 'Bank Accounts', false, 'Commercial banking sub-ledger'],
  ['1.10.01.0002.0001', 'Primary Operating Bank A/C', false, 'Main business checking account (Chase Operating)'],
  ['1.10.01.0002.0002', 'Secondary Savings / Tax A/C', false, 'Tax reserve or secondary account'],
  ['1.10.02.0000.0000', 'Trade & Other Receivables', false, 'Receivables control group'],
  ['1.10.02.0001.0000', 'Accounts Receivable Control', false, 'Sub-ledger debtor group'],
  ['1.10.02.0001.0001', 'Trade Debtors (AR Sub-Ledger)', false, 'Customer credit receivables'],
  ['1.10.03.0000.0000', 'Inventories', false, 'Inventory control group'],
  ['1.10.03.0001.0000', 'Merchandise Inventory', false, 'Stock valuation summary'],
  ['1.10.03.0001.0001', 'Finished Resale Stock', false, 'Perpetual inventory FIFO asset'],
  ['1.10.04.0000.0000', 'Tax Assets & Recoverables', false, 'Recoverable tax group'],
  ['1.10.04.0001.0000', 'Recoverable Tax Control', false, 'Input/output tax control sub-ledger'],
  ['1.10.04.0001.0001', 'Input Tax / VAT Recoverable', false, 'Tax paid on purchases (Asset)'],
  ['1.20.00.0000.0000', 'Non-Current / Fixed Assets', false, 'Long-term capital assets'],
  ['1.20.01.0000.0000', 'Tangible Fixed Assets', false, 'Depreciable property group'],
  ['1.20.01.0001.0000', 'Plant, Equipment & Fixtures', false, 'Equipment control sub-ledger'],
  ['1.20.01.0001.0001', 'Office & Store Equipment', false, 'Tangible depreciable assets (POS hardware)'],
  ['1.20.02.0000.0000', 'Depreciation & Impairment Reserves', false, 'Contra-asset reserve group'],
  ['1.20.02.0001.0000', 'Accumulated Depreciation Control', false, 'Accumulated depreciation sub-ledger'],
  ['1.20.02.0001.0001', 'Accumulated Depreciation', true, 'Contra Asset account'],

  // ------------------------------------------------------------ LIABILITIES
  ['2.00.00.0000.0000', 'LIABILITIES', false, 'Root Level 2 Summary Head'],
  ['2.10.00.0000.0000', 'Current Liabilities', false, 'Short-term debt obligations'],
  ['2.10.01.0000.0000', 'Trade Payables', false, 'Vendor payable control group'],
  ['2.10.01.0001.0000', 'Accounts Payable Control', false, 'Sub-ledger creditor group'],
  ['2.10.01.0001.0001', 'Trade Creditors (AP Sub-Ledger)', false, 'Vendor payables control'],
  ['2.10.02.0000.0000', 'Tax Liabilities', false, 'Collected & withheld taxes group'],
  ['2.10.02.0001.0000', 'Output Tax Control', false, 'Sales tax payable sub-ledger'],
  ['2.10.02.0001.0001', 'Sales Tax / Output VAT Payable', false, 'Tax collected on sales (Owed)'],
  ['2.10.02.0002.0000', 'Payroll Tax Control', false, 'Statutory payroll withholding sub-ledger'],
  ['2.10.02.0002.0001', 'Employee Payroll Tax Withheld', false, 'Statutory payroll deductions'],
  ['2.10.03.0000.0000', 'Accrued Expenses', false, 'Accrued obligations group'],
  ['2.10.03.0001.0000', 'Accrued Personnel Costs', false, 'Accrued payroll sub-ledger'],
  ['2.10.03.0001.0001', 'Accrued Salaries Payable', false, 'Earned wages awaiting payout'],

  // ----------------------------------------------------------------- EQUITY
  ['3.00.00.0000.0000', 'EQUITY', false, 'Root Level 3 Summary Head'],
  ['3.10.00.0000.0000', 'Contributed Equity', false, 'Owner invested capital group'],
  ['3.10.01.0000.0000', 'Owner Capital', false, 'Owner capital sub-ledger'],
  ['3.10.01.0001.0000', 'Owner Contributions Control', false, 'Contributions control head'],
  ['3.10.01.0001.0001', "Owner's Contributed Capital", false, 'Owner initial/ongoing investments'],
  ['3.10.01.0002.0000', 'Owner Distributions Control', false, 'Drawings control head'],
  ['3.10.01.0002.0001', 'Owner Drawings / Dividends', true, 'Contra Equity: Personal withdrawals'],
  ['3.20.00.0000.0000', 'Accumulated Reserves', false, 'Retained result group'],
  ['3.20.01.0000.0000', 'Retained Earnings', false, 'Retained earnings sub-ledger'],
  ['3.20.01.0001.0000', 'Retained Earnings Control', false, 'RE control head'],
  ['3.20.01.0001.0001', 'Retained Earnings (P&L Rollup)', false, 'Cumulative retained profit/loss'],

  // --------------------------------------------------------------- REVENUE
  ['4.00.00.0000.0000', 'REVENUE', false, 'Root Level 4 Summary Head'],
  ['4.10.00.0000.0000', 'Operating Revenue', false, 'Revenue from primary operations'],
  ['4.10.01.0000.0000', 'Trading Revenue', false, 'Goods & services revenue group'],
  ['4.10.01.0001.0000', 'Merchandise Trading', false, 'Product sales sub-ledger'],
  ['4.10.01.0001.0001', 'Merchandise Sales Revenue', false, 'Gross physical goods sales'],
  ['4.10.01.0002.0000', 'Service Revenue', false, 'Service billing sub-ledger'],
  ['4.10.01.0002.0001', 'Service & Consulting Revenue', false, 'Direct service fees billed'],
  ['4.10.02.0000.0000', 'Sales Deductions', false, 'Contra-revenue group'],
  ['4.10.02.0001.0000', 'Sales Returns Control', false, 'Returns sub-ledger'],
  ['4.10.02.0001.0001', 'Sales Returns & Allowances', true, 'Contra Revenue: Customer refunds'],
  ['4.10.02.0002.0000', 'Sales Discounts Control', false, 'Discounts sub-ledger'],
  ['4.10.02.0002.0001', 'Sales Discounts Allowed', true, 'Contra Revenue: Early pay discount'],
  ['4.10.02.0003.0000', 'Rounding Control', false, 'Rounding sub-ledger'],
  ['4.10.02.0003.0001', 'Rounding Adjustment', true, 'Contra Revenue: deterministic penny allocation'],
  ['4.20.00.0000.0000', 'Other Operating Revenue', false, 'Non-trade revenue group'],
  ['4.20.01.0000.0000', 'Foreign Exchange Results', false, 'Forex results sub-ledger'],
  ['4.20.01.0001.0000', 'Forex Gains Control', false, 'Realized gain head'],
  ['4.20.01.0001.0001', 'Realized Forex Gain', false, 'IAS 21 realized exchange gain (Revenue head)'],

  // ------------------------------------------------------- COST OF GOODS SOLD
  ['5.00.00.0000.0000', 'COST OF GOODS SOLD', false, 'Root Level 5 Summary Head'],
  ['5.10.00.0000.0000', 'Cost of Sales', false, 'Direct cost group'],
  ['5.10.01.0000.0000', 'Direct Product Costs', false, 'Product cost sub-group'],
  ['5.10.01.0001.0000', 'Merchandise COGS Control', false, 'COGS sub-ledger'],
  ['5.10.01.0001.0001', 'Cost of Goods Sold - Merch', false, 'Direct inventory cost of sales'],
  ['5.10.02.0000.0000', 'Procurement Costs', false, 'Inbound cost sub-group'],
  ['5.10.02.0001.0000', 'Inbound Freight Control', false, 'Freight sub-ledger'],
  ['5.10.02.0001.0001', 'Inbound Freight & Shipping', false, 'Direct procurement shipping'],

  // -------------------------------------------------------- OPERATING EXPENSES
  ['6.00.00.0000.0000', 'OPERATING EXPENSES', false, 'Root Level 6 Summary Head'],
  ['6.10.00.0000.0000', 'Operating Expenses', false, 'Period operating cost group'],
  ['6.10.01.0000.0000', 'Premises & Utilities', false, 'Facility cost sub-group'],
  ['6.10.01.0001.0000', 'Occupancy Control', false, 'Rent sub-ledger'],
  ['6.10.01.0001.0001', 'Commercial Facility Rent', false, 'Store / warehouse lease'],
  ['6.10.01.0002.0000', 'Utilities Control', false, 'Utilities sub-ledger'],
  ['6.10.01.0002.0001', 'Utilities (Electricity, Water)', false, 'Monthly utility bills'],
  ['6.10.02.0000.0000', 'Personnel Costs', false, 'Employee cost sub-group'],
  ['6.10.02.0001.0000', 'Salaries & Wages Control', false, 'Payroll sub-ledger'],
  ['6.10.02.0001.0001', 'Staff Salaries & Wages', false, 'Gross employee compensation'],
  ['6.10.03.0000.0000', 'Sales & Marketing', false, 'Promotion sub-group'],
  ['6.10.03.0001.0000', 'Advertising Control', false, 'Advertising sub-ledger'],
  ['6.10.03.0001.0001', 'Advertising & Marketing', false, 'Promotions and ad campaigns'],
  ['6.10.04.0000.0000', 'Financial & Other Costs', false, 'Finance cost sub-group'],
  ['6.10.04.0001.0000', 'Bank & Depreciation Control', false, 'Bank/depreciation sub-ledger'],
  ['6.10.04.0001.0001', 'Office Equipment Depreciation', false, 'Monthly straight-line depreciation of store/POS equipment'],
  ['6.10.04.0002.0000', 'Bank Charges Control', false, 'Bank charges sub-ledger'],
  ['6.10.04.0002.0001', 'Bank Fees & Merchant Charges', false, 'Payment processor commissions'],
  ['6.10.05.0000.0000', 'Inventory Adjustments', false, 'Stock adjustment sub-group'],
  ['6.10.05.0001.0000', 'Shrinkage Control', false, 'Shrinkage sub-ledger'],
  ['6.10.05.0001.0001', 'Inventory Shrinkage & Write-Off', false, 'Physical count shrinkage / write-off loss (Equation 4)'],
  ['6.20.00.0000.0000', 'Non-Operating Expenses', false, 'Non-operating cost group'],
  ['6.20.01.0000.0000', 'Foreign Exchange Results', false, 'Forex loss sub-group'],
  ['6.20.01.0001.0000', 'Forex Losses Control', false, 'Realized loss head'],
  ['6.20.01.0001.0001', 'Realized Forex Loss', false, 'IAS 21 realized exchange loss (Expense head)'],
];

/** Well-known system account codes used by the posting matrix (Section 5). */
const COA = {
  CASH_TILL: '1.10.01.0001.0001',
  BANK_MAIN: '1.10.01.0002.0001',
  BANK_SECONDARY: '1.10.01.0002.0002',
  AR: '1.10.02.0001.0001',
  INVENTORY: '1.10.03.0001.0001',
  INPUT_TAX: '1.10.04.0001.0001',
  EQUIPMENT: '1.20.01.0001.0001',
  ACCUM_DEPR: '1.20.02.0001.0001',
  AP: '2.10.01.0001.0001',
  OUTPUT_TAX: '2.10.02.0001.0001',
  PAYROLL_TAX: '2.10.02.0002.0001',
  ACCRUED_SALARIES: '2.10.03.0001.0001',
  CAPITAL: '3.10.01.0001.0001',
  DRAWINGS: '3.10.01.0002.0001',
  RETAINED_EARNINGS: '3.20.01.0001.0001',
  SALES_REVENUE: '4.10.01.0001.0001',
  SERVICE_REVENUE: '4.10.01.0002.0001',
  SALES_RETURNS: '4.10.02.0001.0001',
  SALES_DISCOUNTS: '4.10.02.0002.0001',
  ROUNDING: '4.10.02.0003.0001',
  FOREX_GAIN: '4.20.01.0001.0001',
  COGS: '5.10.01.0001.0001',
  INBOUND_FREIGHT: '5.10.02.0001.0001',
  RENT: '6.10.01.0001.0001',
  UTILITIES: '6.10.01.0002.0001',
  SALARIES: '6.10.02.0001.0001',
  ADVERTISING: '6.10.03.0001.0001',
  DEPRECIATION: '6.10.04.0001.0001',
  BANK_FEES: '6.10.04.0002.0001',
  SHRINKAGE: '6.10.05.0001.0001',
  FOREX_LOSS: '6.20.01.0001.0001',
};

/** Level of an account derived from its code: X . XX . XX . XXXX . XXXX */
function levelOfCode(code) {
  const parts = String(code).split('.');
  if (parts.length !== 5) return null;
  if (parts[0] !== '0' && !/^\d$/.test(parts[0])) return null;
  const lengthsOk = parts[1].length === 2 && parts[2].length === 2 && parts[3].length === 4 && parts[4].length === 4;
  if (!lengthsOk) return null;
  if (!/^\d+$/.test(parts[1] + parts[2] + parts[3] + parts[4])) return null;
  if (parts[4] !== '0000') return 5;
  if (parts[3] !== '0000') return 4;
  if (parts[2] !== '00') return 3;
  if (parts[1] !== '00') return 2;
  return 1;
}

function parentOfCode(code) {
  const level = levelOfCode(code);
  if (!level || level === 1) return null;
  const [l1, l2, l3, l4, l5] = String(code).split('.');
  if (level === 5) return `${l1}.${l2}.${l3}.${l4}.0000`;
  if (level === 4) return `${l1}.${l2}.${l3}.0000.0000`;
  if (level === 3) return `${l1}.${l2}.00.0000.0000`;
  return `${l1}.00.00.0000.0000`;
}

module.exports = { CANONICAL_COA, COA, ROOT_TYPES, CONTRA_NORMAL, levelOfCode, parentOfCode };
