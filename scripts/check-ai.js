#!/usr/bin/env node
// End-to-end check of the configured AI provider.
//
// Renders a synthetic GST invoice with known values, sends it through the same
// extraction path the upload route uses, and reports which fields came back
// correct. This is the only check in the repo that makes a real network call.
//
//   npm run check:ai

const { createCanvas } = require("@napi-rs/canvas");
const router = require("../server");

const { extractInvoiceWithAi } = router._internals;

const EXPECTED = {
  supplier: "Northwind Traders",
  invoice_number: "NW-2291",
  invoice_date: "2026-03-14",
  gstin: "29AABCU9603R1ZM",
  taxable_amount: 24000,
  cgst: 2160,
  sgst: 2160,
  total: 28320
};

function renderInvoice() {
  const canvas = createCanvas(900, 1120);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 900, 1120);
  ctx.fillStyle = "#000000";

  ctx.font = "bold 30px sans-serif";
  ctx.fillText("TAX INVOICE", 330, 60);

  ctx.font = "bold 22px sans-serif";
  ctx.fillText(EXPECTED.supplier, 60, 130);

  ctx.font = "17px sans-serif";
  ctx.fillText("14 Industrial Layout, Bengaluru, Karnataka 560068", 60, 158);
  ctx.fillText(`GSTIN: ${EXPECTED.gstin}`, 60, 184);

  ctx.fillText(`Invoice No: ${EXPECTED.invoice_number}`, 60, 240);
  ctx.fillText("Invoice Date: 14-03-2026", 60, 266);
  ctx.fillText("Place of Supply: Karnataka (29)", 60, 292);

  ctx.fillText("Bill To: Contoso Manufacturing Pvt Ltd", 60, 340);
  ctx.fillText("GSTIN: 29AAGCC7896P1Z4", 60, 366);

  // line item table
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("Description", 60, 440);
  ctx.fillText("HSN", 380, 440);
  ctx.fillText("Qty", 470, 440);
  ctx.fillText("Rate", 560, 440);
  ctx.fillText("Amount", 700, 440);
  ctx.beginPath();
  ctx.moveTo(60, 452);
  ctx.lineTo(840, 452);
  ctx.stroke();

  ctx.font = "16px sans-serif";
  const rows = [
    ["Steel bracket assembly", "7326", "40", "300.00", "12,000.00"],
    ["Powder coating service", "9988", "40", "150.00", "6,000.00"],
    ["Freight and handling", "9965", "1", "6,000.00", "6,000.00"]
  ];
  rows.forEach(([desc, hsn, qty, rate, amount], index) => {
    const y = 486 + index * 34;
    ctx.fillText(desc, 60, y);
    ctx.fillText(hsn, 380, y);
    ctx.fillText(qty, 470, y);
    ctx.fillText(rate, 560, y);
    ctx.fillText(amount, 700, y);
  });

  ctx.beginPath();
  ctx.moveTo(60, 610);
  ctx.lineTo(840, 610);
  ctx.stroke();

  const totals = [
    ["Taxable Value", "24,000.00"],
    ["CGST @ 9%", "2,160.00"],
    ["SGST @ 9%", "2,160.00"],
    ["IGST", "0.00"]
  ];
  totals.forEach(([label, value], index) => {
    const y = 650 + index * 30;
    ctx.fillText(label, 520, y);
    ctx.fillText(value, 720, y);
  });

  ctx.font = "bold 19px sans-serif";
  ctx.fillText("Total Amount", 520, 790);
  ctx.fillText("28,320.00", 720, 790);

  ctx.font = "16px sans-serif";
  ctx.fillText("Amount in words: Twenty Eight Thousand Three Hundred Twenty Only", 60, 850);

  return canvas.toBuffer("image/png");
}

function num(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function compare(invoice) {
  const supplier = invoice.supplier || {};
  return [
    ["supplier", EXPECTED.supplier, supplier.name],
    ["gstin", EXPECTED.gstin, supplier.gstin],
    ["invoice_number", EXPECTED.invoice_number, invoice.invoice_number],
    ["invoice_date", EXPECTED.invoice_date, invoice.invoice_date],
    ["taxable_amount", EXPECTED.taxable_amount, num(invoice.taxable_amount)],
    ["cgst", EXPECTED.cgst, num(invoice.cgst)],
    ["sgst", EXPECTED.sgst, num(invoice.sgst)],
    ["total", EXPECTED.total, num(invoice.total)]
  ].map(([field, expected, actual]) => {
    const normalise = value =>
      typeof value === "string" ? value.trim().toLowerCase() : value;
    return { field, expected, actual, ok: normalise(expected) === normalise(actual) };
  });
}

async function main() {
  const upload = {
    filename: "synthetic-invoice.png",
    contentType: "image/png",
    buffer: renderInvoice()
  };

  console.log("Sending a synthetic GST invoice to the configured provider...\n");

  let result;
  try {
    result = await extractInvoiceWithAi(upload, "");
  } catch (error) {
    console.error(`FAILED: ${error.message}`);
    if (error.code === "AI_NOT_CONFIGURED") {
      console.error("\nSet a provider key in .env first. See README > Choosing a provider.");
    }
    process.exitCode = 1;
    return;
  }

  const rows = compare(result.invoice);
  const width = Math.max(...rows.map(row => row.field.length));
  for (const row of rows) {
    const mark = row.ok ? "PASS" : "FAIL";
    console.log(
      `${mark}  ${row.field.padEnd(width)}  expected=${String(row.expected).padEnd(20)} got=${String(row.actual)}`
    );
  }

  const passed = rows.filter(row => row.ok).length;
  const lineItems = Array.isArray(result.invoice.line_items) ? result.invoice.line_items.length : 0;

  console.log(`\nmodel:       ${result.model}`);
  console.log(`fields:      ${passed}/${rows.length} matched`);
  console.log(`line items:  ${lineItems} extracted (expected 3)`);

  if (passed !== rows.length || lineItems !== 3) {
    console.log(
      "\nThis is a clean synthetic invoice, so anything less than a full match means\n" +
        "the provider or model is a poor fit. Try a stronger model before testing real bills."
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { EXPECTED, renderInvoice, compare };
