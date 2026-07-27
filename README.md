# Tally OCR MVP

This is a local working MVP for OCR-based invoice and bill intake for Tally. It supports camera capture, image upload, PDF upload, OCR/text extraction, human review, validation, duplicate checks, original-file retention, audit trail, configurable ledger/party mappings, and approved exports to Tally XML, CSV, and JSON.

## Requirement source

Requirements are based on the supplied `AI_Automation_Assessment_Finance.pdf`.

Relevant assessment citations:

- Pages 5-6 describe the current state: Tally is the primary India accounting system, invoices and bills are manually scanned/processed/keyed, and manual processing causes slow AP, keying errors, and late payments.
- Pages 7-8 define OCR-based invoice and bill processing as the highest-priority quick win: capture invoices from scanner/email, extract header and line-item data, validate it, flag exceptions, and prepare reviewed data for Tally via import/ODBC/API.
- Page 8 requires retaining originals and an audit trail, duplicate/fraud checks, segregation of duties, and human review/authorization for every posting and payment.
- Pages 17-19 state the control principles used here: automate mechanical extraction/movement/formatting, keep qualified humans responsible for authorization, preserve audit trails, and do not allow autonomous ledger posting or money movement.

This MVP follows those controls. It does not post to Tally and does not move money. It only exports approved import proposals.

## What the MVP extracts

- Supplier
- Invoice number
- Invoice date
- GSTIN
- Taxable amount
- CGST, SGST, IGST
- Total amount
- Line items where the OCR text follows a recognizable item/qty/rate/amount pattern
- Field confidence scores and overall OCR confidence

## Validation and controls

- Flags missing supplier, invoice number, and total amount as errors.
- Checks whether taxable amount + CGST + SGST + IGST matches the total amount.
- Checks duplicates by supplier/GSTIN plus invoice number.
- Requires reviewer name before approval.
- Blocks export until a human approves the invoice.
- Stores originals in `data/originals`.
- Stores invoice state, corrections, approvals, and export events in `data/invoices.json`.
- Stores ledger mappings in `data/mappings.json`.

## Run

From this folder:

```powershell
npm install
npm start
```

Then open:

```text
http://localhost:4173
```

Optional environment variables:

- `PORT`: change the local port. Example: `$env:PORT=4180`
- `PYTHON`: path to Python with `pdfplumber` installed for text PDFs.
- `PDFTOPPM`: path to `pdftoppm` for OCR of scanned PDFs.
- `NODE_MODULES_DIR`: folder containing `tesseract.js`.

## Use

1. Start the app and open `http://localhost:4173`.
2. Upload an invoice image/PDF or start the camera and capture a bill.
3. Review the extracted data, confidence scores, validation warnings, and original document.
4. Correct fields and line items as needed.
5. Enter the reviewer name and notes.
6. Select **Approve for export**.
7. Export Tally XML, CSV, or JSON.

## Tally XML note

The generated XML is a Tally voucher import proposal for a Purchase voucher. Ledger names come from the mapping screen:

- Party ledger: supplier-specific mapping, otherwise supplier name.
- Purchase ledger: supplier-specific mapping, otherwise default purchase ledger.
- Tax ledgers: default CGST/SGST/IGST ledgers.

Validate ledger names, voucher type, tax ledgers, and company-specific Tally configuration with your finance/Tally administrator before importing into production.

## Verification

The MVP was tested on desktop and mobile layouts and with two public GST invoice PDFs. See [TEST_RESULTS.md](TEST_RESULTS.md) for the source links, extracted values, and control checks. The two online samples are retained in the local review queue as pending review; they were not approved or exported.

## Limitations

- OCR accuracy depends on scan quality, language, and invoice layout.
- The parser uses deterministic invoice heuristics. For production, train supplier-specific templates or use a managed IDP engine.
- PDF support extracts embedded text first. Scanned PDFs are rendered to images with `pdftoppm` when available.
- No purchase-order matching or approval routing integration is included yet.
- No autonomous posting, payment, credit, write-off, or ledger mutation is implemented.
