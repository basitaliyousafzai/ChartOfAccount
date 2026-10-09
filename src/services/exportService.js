'use strict';

/**
 * Export Service (Invariant 5) - styled Excel (.xlsx) and PDF statement output.
 * Both libraries are local npm packages: the export path works with zero
 * network connectivity.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { jsPDF } = require('jspdf');

const money = require('../core/money');
const { ReportService } = require('./reportService');
const { LedgerService } = require('./ledgerService');
const { ValidationError } = require('../core/errors');

class ExportService {
  constructor(db, { appDataDir }) {
    this.db = db;
    this.appDataDir = appDataDir;
    this.reports = new ReportService(db);
    this.ledger = new LedgerService(db);
  }

  defaultDir() {
    const dir = path.join(this.appDataDir, 'exports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  stamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  /** Build { title, subtitle, headers, rows, footer } for a report kind. */
  build(kind, params = {}) {
    switch (kind) {
      case 'trialBalance': {
        const report = this.reports.trialBalance({ asOfDate: params.asOfDate || null, includeZero: false });
        return {
          title: 'TRIAL BALANCE',
          subtitle: params.asOfDate ? `As at ${params.asOfDate}` : 'As at today',
          headers: ['Account Code', 'Account Name', 'Type', 'Normal', 'Debit ($)', 'Credit ($)', 'Balance ($)'],
          rows: report.rows.map((r) => [
            r.AccountCode, r.AccountName, r.RootType, r.NormalBalance,
            money.fromCents(r.TotalDebit), money.fromCents(r.TotalCredit), money.fromCents(r.NetBalance),
          ]),
          footer: ['', 'TOTALS', '', '', money.fromCents(report.totalDebit), money.fromCents(report.totalCredit),
            `Delta ${money.fromCents(report.delta)}`],
          numericFrom: 4,
        };
      }
      case 'incomeStatement': {
        const r = this.reports.incomeStatement({ from: params.from, to: params.to });
        const rows = [
          ['Gross Sales Revenue', money.fromCents(r.grossSales)],
          ['Less: Sales Returns', money.fromCents(-r.returns)],
          ['Less: Discounts Allowed', money.fromCents(-r.discounts)],
          ['NET SALES REVENUE', money.fromCents(r.netRevenue)],
          ['Less: Cost of Goods Sold', money.fromCents(-r.cogs)],
          ['GROSS PROFIT', money.fromCents(r.grossProfit)],
          [`Operating Expenses (${r.opexLines.length} heads)`, money.fromCents(-r.operatingExpenses)],
          ['OPERATING INCOME (EBIT)', money.fromCents(r.operatingIncome)],
          ['Less: Finance Costs', money.fromCents(-r.financeCosts)],
          ['Add: Other Income', money.fromCents(r.otherIncome)],
          ['Less: Tax Expense', money.fromCents(-r.tax)],
          ['NET PROFIT / (LOSS)', money.fromCents(r.netProfit)],
        ];
        return {
          title: 'INCOME STATEMENT',
          subtitle: `${params.from} to ${params.to}`,
          headers: ['Line Item', 'Amount ($)'],
          rows,
          footer: ['', money.fromCents(r.netProfit)],
          numericFrom: 1,
        };
      }
      case 'balanceSheet': {
        const b = this.reports.balanceSheet({ asOfDate: params.asOfDate, from: params.from });
        const rows = [
          ['CURRENT ASSETS', ''],
          ...b.currentAssets.map((x) => [`  ${x.AccountName}`, money.fromCents(x.amount)]),
          ['TOTAL CURRENT ASSETS', money.fromCents(b.totalCurrentAssets)],
          ['NON-CURRENT ASSETS', ''],
          ...b.nonCurrentAssets.map((x) => [`  ${x.AccountName}`, money.fromCents(x.amount)]),
          ['TOTAL ASSETS', money.fromCents(b.totalAssets)],
          ['CURRENT LIABILITIES', ''],
          ...b.currentLiabilities.map((x) => [`  ${x.AccountName}`, money.fromCents(x.amount)]),
          ['TOTAL CURRENT LIABILITIES', money.fromCents(b.totalCurrentLiabilities)],
          ['TOTAL LIABILITIES', money.fromCents(b.totalLiabilities)],
          ['OWNER EQUITY', ''],
          ...b.equity.map((x) => [`  ${x.label}`, money.fromCents(x.amount)]),
          ['TOTAL OWNER EQUITY', money.fromCents(b.totalEquity)],
          ['TOTAL LIABILITIES + EQUITY', money.fromCents(b.totalLiabilities + b.totalEquity)],
          ['EQUILIBRIUM DELTA', money.fromCents(b.delta)],
        ];
        return {
          title: 'CLASSIFIED BALANCE SHEET',
          subtitle: `As at ${params.asOfDate}`,
          headers: ['Classification & Item', 'Amount ($)'],
          rows,
          footer: [`Assets - (Liabilities + Equity) = ${money.fromCents(b.delta)}`, money.fromCents(b.delta)],
          numericFrom: 1,
        };
      }
      case 'ledgerCard': {
        const card = this.ledger.ledgerCard(params.accountCode, { from: params.from, to: params.to });
        return {
          title: `GENERAL LEDGER - ${card.account.AccountCode} ${card.account.AccountName}`,
          subtitle: `${params.from || 'inception'} to ${params.to || 'today'} | Normal balance: ${card.account.NormalBalance}`,
          headers: ['Date', 'Voucher No', 'Type', 'Narration', 'Debit ($)', 'Credit ($)', 'Running Balance ($)'],
          rows: card.entries.map((e) => [
            e.VoucherDate, e.VoucherNo, e.VoucherType, (e.Narration || '').slice(0, 60),
            money.fromCents(e.Debit), money.fromCents(e.Credit), money.fromCents(e.RunningBalance),
          ]),
          footer: ['', 'TOTALS', '', '', money.fromCents(card.totalDebit), money.fromCents(card.totalCredit),
            money.fromCents(card.closingBalance)],
          numericFrom: 4,
        };
      }
      case 'journal': {
        const voucher = params.voucherId
          ? this.ledger.getVoucher(params.voucherId)
          : this.ledger.findByVoucherNo(params.voucherNo);
        return {
          title: `JOURNAL VOUCHER ${voucher.VoucherNo}`,
          subtitle: `${voucher.VoucherDate} | ${voucher.VoucherType} | ${voucher.Narration}`,
          headers: ['Account Code', 'Account Head', 'Memo', 'Debit ($)', 'Credit ($)'],
          rows: voucher.lines.map((l) => [
            l.AccountCode, l.AccountName, l.LineMemo || '',
            money.fromCents(l.Debit), money.fromCents(l.Credit),
          ]),
          footer: ['', 'TOTALS', '', money.fromCents(voucher.TotalDebit), money.fromCents(voucher.TotalCredit)],
          numericFrom: 3,
        };
      }
      default:
        throw new ValidationError(`Unknown export kind "${kind}"`, {
          allowed: ['trialBalance', 'incomeStatement', 'balanceSheet', 'ledgerCard', 'journal'],
        });
    }
  }

  workbook({ kind, params = {}, targetPath = null }) {
    const model = this.build(kind, params);
    const aoa = [
      ['APEX ERP - AUTONOMOUS COA & GENERAL LEDGER ENGINE'],
      [model.title],
      [model.subtitle],
      [`Generated ${new Date().toISOString()} | Precision: exact integer cents (DECIMAL(18,2))`],
      [],
      model.headers,
      ...model.rows,
      model.footer,
    ];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet['!cols'] = model.headers.map((h, i) => ({ wch: i === 0 ? 34 : (i >= model.numericFrom ? 16 : 26) }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, model.title.slice(0, 31).replace(/[^A-Za-z0-9 ]/g, ''));
    const destination = targetPath || path.join(this.defaultDir(), `${kind}_${this.stamp()}.xlsx`);
    const dir = path.dirname(destination);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    XLSX.writeFile(workbook, destination);
    return { path: destination, bytes: fs.statSync(destination).size, kind };
  }

  pdf({ kind, params = {}, targetPath = null }) {
    const model = this.build(kind, params);
    const doc = new jsPDF({ orientation: model.headers.length > 5 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 32;
    let y = margin;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text('APEX ERP - AUTONOMOUS COA & GENERAL LEDGER ENGINE', margin, y);
    y += 18;
    doc.setFontSize(11);
    doc.text(model.title, margin, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(model.subtitle, margin, y);
    y += 12;
    doc.text(`Generated ${new Date().toISOString()} | Exact integer-cent precision`, margin, y);
    y += 16;

    const usable = pageWidth - margin * 2;
    const colCount = model.headers.length;
    const numericStart = model.numericFrom;
    const weights = model.headers.map((h, i) => (i >= numericStart ? 1.1 : (i === 1 ? 2.2 : 1.6)));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (usable * w) / weightSum);
    const xs = [];
    let cursor = margin;
    for (const w of widths) { xs.push(cursor); cursor += w; }

    const drawHeader = () => {
      doc.setFillColor(30, 41, 59);
      doc.rect(margin, y - 10, usable, 18, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      model.headers.forEach((header, i) => {
        const align = i >= numericStart ? 'right' : 'left';
        const xPos = align === 'right' ? xs[i] + widths[i] - 4 : xs[i] + 4;
        doc.text(String(header), xPos, y + 2, { align });
      });
      doc.setTextColor(0, 0, 0);
      y += 16;
    };

    drawHeader();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);

    model.rows.forEach((row, index) => {
      if (y > doc.internal.pageSize.getHeight() - margin) {
        doc.addPage();
        y = margin;
        drawHeader();
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
      }
      if (index % 2 === 1) {
        doc.setFillColor(241, 245, 249);
        doc.rect(margin, y - 9, usable, 14, 'F');
      }
      row.forEach((cell, i) => {
        const align = i >= numericStart ? 'right' : 'left';
        const xPos = align === 'right' ? xs[i] + widths[i] - 4 : xs[i] + 4;
        const text = String(cell ?? '');
        const clipped = doc.splitTextToSize(text, widths[i] - 8)[0] || '';
        doc.text(clipped, xPos, y, { align });
      });
      y += 14;
    });

    y += 4;
    doc.setDrawColor(148, 163, 184);
    doc.line(margin, y, pageWidth - margin, y);
    y += 14;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    model.footer.forEach((cell, i) => {
      const align = i >= numericStart ? 'right' : 'left';
      const xPos = align === 'right' ? xs[i] + widths[i] - 4 : xs[i] + 4;
      doc.text(String(cell ?? ''), xPos, y, { align });
      y += 12;
    });

    const destination = targetPath || path.join(this.defaultDir(), `${kind}_${this.stamp()}.pdf`);
    const dir = path.dirname(destination);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    doc.save(destination);
    return { path: destination, bytes: fs.statSync(destination).size, kind };
  }
}

module.exports = { ExportService };
