const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const router = require("../server");

const {
  INVOICE_SCHEMA,
  addExtractionValidation,
  aiToParsedFields,
  compareExtractionFields,
  extractionReviewState,
  validateInvoice,
  validGstinChecksum
} = router._internals;

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "sample-ai-invoice.json"), "utf8"));

test("strict invoice schema requires the fields used by the OpenAI endpoint", () => {
  assert.equal(INVOICE_SCHEMA.additionalProperties, false);
  for (const key of ["supplier", "customer", "invoice_number", "line_items", "taxable_amount", "total", "unreadable_fields"]) {
    assert.ok(INVOICE_SCHEMA.required.includes(key));
  }
  assert.equal(INVOICE_SCHEMA.properties.line_items.items.additionalProperties, false);
});

test("AI invoice output normalizes into the review and Tally export fields", () => {
  const parsed = aiToParsedFields(sample, 76);
  assert.equal(parsed.fields.supplier, "Foobar Labs");
  assert.equal(parsed.fields.invoiceNumber, "004");
  assert.equal(parsed.fields.invoiceDate, "2019-06-19");
  assert.equal(parsed.fields.gstin, "29ABCDE1234F2Z5");
  assert.equal(parsed.fields.taxableAmount, 36000);
  assert.equal(parsed.fields.cgst, 3240);
  assert.equal(parsed.fields.sgst, 3240);
  assert.equal(parsed.fields.igst, 0);
  assert.equal(parsed.fields.totalAmount, 42480);
  assert.equal(parsed.fields.lineItems.length, 4);
});

test("math checks pass while fake sample GSTINs are still flagged for review", () => {
  const parsed = aiToParsedFields(sample, 76);
  const validation = validateInvoice(parsed.fields, [], "sample");
  assert.equal(validation.errors.length, 0);
  assert.ok(validation.checks.find(check => check.id === "invoice-total" && check.status === "pass"));
  assert.ok(validation.checks.find(check => check.id === "line-items" && check.status === "pass"));
  assert.equal(validGstinChecksum("29ABCDE1234F2Z5"), false);
  assert.ok(validation.warnings.some(message => /GSTIN checksum/i.test(message)));
});

test("AI and OCR disagreements are carried into review state", () => {
  const parsed = aiToParsedFields(sample, 76);
  const ocrFields = { ...parsed.fields, totalAmount: 42000, invoiceNumber: "OO4" };
  const disagreements = compareExtractionFields(parsed.fields, ocrFields);
  assert.deepEqual(disagreements.sort(), ["invoiceNumber", "totalAmount"].sort());

  const validation = addExtractionValidation(validateInvoice(parsed.fields, [], "sample"), {
    aiAttempted: true,
    aiModel: "test-model",
    aiError: "",
    disagreements,
    unreadableFields: []
  });
  assert.equal(extractionReviewState(parsed.fields, validation, {
    disagreements,
    aiError: "",
    unreadableFields: []
  }), "review_required");
  assert.ok(validation.warnings.some(message => /AI\/OCR cross-check/i.test(message)));
});
