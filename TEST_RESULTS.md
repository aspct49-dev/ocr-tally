# MVP Test Results

Tested on 22 July 2026 against the local app at `http://localhost:4173`.

## Online documents

### Sleek Bill GST invoice

Source: [Model GST invoice PDF](https://sleekbill.in/images/articles/Model_GST_5_A4.pdf)

- Supplier: Sleek Bill
- Invoice number: IN-17
- Invoice date: 2025-01-24
- GSTIN: 27AAFCV2449G1Z7
- Taxable amount: 900.00
- IGST: 68.00
- Total amount: 968.00
- Line items: 6
- Validation: passed

### Handy Invoice template

Source: [GST invoice template PDF](https://www.handyinvoice.in/download_pdf?filename=template6)

- Supplier: Your Company Name
- Invoice number: HI/101/21-22
- Invoice date: 2021-03-08
- GSTIN: 27AVAFI1565S1Z8
- Taxable amount: 60,000.00
- CGST: 5,025.00
- SGST: 5,025.00
- Total amount: 70,050.00
- Line items: 3
- Validation: passed

## Control checks

- Duplicate detection: passed. A second upload of IN-17 was linked to the first record and flagged as a possible duplicate.
- Human approval gate: passed. Tally XML export before approval returned HTTP 409 and no export was produced.
- Audit retention: passed. Upload and extraction events were written to each invoice record, and original PDFs were retained locally.
- No autonomous posting: passed. No Tally connection, ledger posting, payment, or money movement was attempted.

## Interface checks

- Desktop viewport: no page-level horizontal overflow at 1279 px.
- Mobile viewport: no page-level horizontal overflow at 375 px.
- PDF preview: rendered successfully after load.
- Review and ledger-mapping navigation: passed.
- Browser console: no warnings or errors.

These are deterministic MVP checks, not a production OCR accuracy benchmark. Human review remains mandatory for every document.

## Hybrid AI extraction update

Tested on 31 July 2026 with the local fixture in `test/sample-ai-invoice.json`, based on the referenced uploaded sample bill values:

- Strict OpenAI invoice schema shape: passed.
- AI-to-review-field normalization: passed for supplier, invoice number, invoice date, GSTIN, taxable value, CGST, SGST, IGST, total, and line items.
- Mathematical validation: passed for taxable amount + CGST + SGST + IGST = total.
- Line-item validation: passed for line-item taxable totals matching invoice taxable value.
- GSTIN control: passed by flagging the fake sample GSTIN checksum for review.
- AI/OCR cross-check: passed by flagging deliberate invoice number and total mismatches as review-required.
- OpenAI network call: not run in automated tests; tests do not require or expose an API key.
- `.env` loading: added so local `OPENAI_API_KEY` setup is picked up when the Node server starts.

## Finance operations demo update

Tested on 29 July 2026 against the updated local app:

- Dashboard metrics: passed with the retained three-invoice sample queue.
- Extended controls: required fields, GSTIN structure/checksum, invoice total, line-item total, tax mode, invoice date, and duplicate checks rendered correctly.
- Review states: pending review, needs correction, rejected, and approved states passed.
- Approval integrity: editing an approved invoice reset it to pending review.
- Export gate: XML export succeeded while approved and returned HTTP 409 after approval was reset.
- Processing report: CSV download returned HTTP 200.
- Tally readiness: local connection test returned a clear not-connected result when Tally was not running and did not transmit invoice data.
- Desktop layout: no horizontal overflow at 1,440 x 900.
- Mobile layout: no horizontal overflow at 375 x 812; dashboard cards and review controls remained readable.
- Browser console: no warnings or errors.

## Vercel upload compatibility

Tested on 29 July 2026 through the exported Vercel request handler:

- Receipt image OCR: HTTP 201 in 1.1 seconds; invoice number and supplier extracted.
- Text PDF extraction: HTTP 201 in under one second.
- Scanned PDF OCR: HTTP 201 in 1.5 seconds after JavaScript page rendering.
- Oversized request: controlled HTTP 413 response; the server remained available.
- Pre-parsed JSON request: mapping update returned HTTP 200.
- Local OCR assets: English language data loaded from the deployment bundle without a runtime download.

After reproducing a 120-second serverless OCR timeout on the public Vercel
deployment, OCR was moved to the browser:

- Browser receipt image: completed with 94% OCR confidence.
- Browser text PDF: completed with 80% extraction confidence.
- Browser scanned PDF: completed with 93% OCR confidence.
- Saved records used `browser-image-ocr`, `browser-pdf-text`, and
  `browser-pdf-ocr` extraction modes.
- Browser console: no warnings or errors.
