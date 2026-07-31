# Tally OCR MVP

This is a local working MVP for OCR-based invoice and bill intake for Tally. It supports camera capture, image upload, PDF upload, hybrid AI/OCR extraction, human review, validation, duplicate checks, original-file retention, audit trail, configurable ledger/party mappings, and approved exports to Tally XML, CSV, and JSON.

## Requirement source

Requirements are based on the supplied `AI_Automation_Assessment_Finance.pdf`.

Relevant assessment citations:

- Pages 5-6 describe the current state: Tally is the primary India accounting system, invoices and bills are manually scanned/processed/keyed, and manual processing causes slow AP, keying errors, and late payments.
- Pages 7-8 define OCR-based invoice and bill processing as the highest-priority quick win: capture invoices from scanner/email, extract header and line-item data, validate it, flag exceptions, and prepare reviewed data for Tally via import/ODBC/API.
- Page 8 requires retaining originals and an audit trail, duplicate/fraud checks, segregation of duties, and human review/authorization for every posting and payment.
- Pages 17-19 state the control principles used here: automate mechanical extraction/movement/formatting, keep qualified humans responsible for authorization, preserve audit trails, and do not allow autonomous ledger posting or money movement.

This MVP follows those controls. It does not post to Tally and does not move money. It only exports approved import proposals.

## Demo workspace

The current demo presents the invoice workflow as a finance operations control desk:

- Operational dashboard with invoice value, exception count, approval rate, GST captured, average OCR confidence, duplicate flags, and estimated time saved.
- Work queue with pending review, correction, rejected, and approved states.
- Structured control checks for required fields, GSTIN format/checksum, invoice totals, line-item totals, GST tax mode, invoice dates, and duplicates.
- Human decisions to approve, reject, or return an invoice for correction.
- Automatic approval reset when approved invoice data is edited.
- Tally readiness indicators, company and voucher setup, ledger mapping, and a local Tally connection test.
- Downloadable processing report covering every invoice in the queue.

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

## Hybrid AI extraction

When `OPENAI_API_KEY` is configured, uploads use a server-side OpenAI vision extraction pass with a strict JSON schema. The browser still runs local OCR first and sends the raw OCR text to the server as supporting evidence. The server then:

- Sends the image or PDF to OpenAI from the backend only.
- Requires structured invoice JSON with nullable fields rather than guessed values.
- Normalizes the AI result into the existing review fields and line-item table.
- Keeps OCR as fallback if OpenAI is not configured, times out, or returns an error.
- Cross-checks AI and OCR on invoice number, date, GSTIN, taxable value, taxes, and total amount.
- Labels each extraction as `high_confidence`, `review_required`, or `missing_unreadable`.
- Preserves the existing human approval gate before any Tally XML, CSV, or JSON export.

The OpenAI API key is never sent to the browser. The frontend only sees whether AI extraction is available and the configured model name.

## Validation and controls

- Flags missing supplier, invoice number, and total amount as errors.
- Checks whether taxable amount + CGST + SGST + IGST matches the total amount.
- Checks duplicates by supplier/GSTIN plus invoice number.
- Requires reviewer name before approval.
- Requires reviewer notes before rejection or return for correction.
- Blocks export until a human approves the invoice.
- Resets an approval if approved financial data is subsequently changed.
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

- `OPENAI_API_KEY`: enables the secure server-side AI extraction flow.
- `OPENAI_INVOICE_MODEL`: OpenAI vision model to use. Defaults to `gpt-5`.
- `OPENAI_TIMEOUT_MS`: AI extraction timeout in milliseconds. Defaults to `45000`.
- `PORT`: change the local port. Example: `$env:PORT=4180`
- `DATA_DIR`: store invoices in a custom writable directory.
- `PYTHON`: path to Python with `pdfplumber` installed for text PDFs.
- `PDFTOPPM`: path to `pdftoppm` for OCR of scanned PDFs.
- `NODE_MODULES_DIR`: folder containing `tesseract.js`.

PowerShell setup example:

```powershell
Copy-Item .env.example .env
# Edit .env and paste your key after OPENAI_API_KEY=
npm start
```

After restart, the upload button should say **Scan with AI**. If it still says
**Extract Document**, the server did not see `OPENAI_API_KEY`; stop the server,
check `.env`, and start it again.

## Vercel deployment

The included `vercel.json` routes the website and API through a Node.js
function. Vercel's application bundle is read-only, so the app automatically
uses `/tmp/tally-ocr-mvp` for uploaded originals, mappings, invoices, and audit
records.

Vercel temporary storage is suitable for a demonstration only. Records can be
lost when a function instance is replaced or restarted. Use persistent object
storage and a database before using the hosted app for real accounting work.

Vercel limits function request bodies to 4.5 MB. The browser automatically
resizes large invoice images before upload; PDFs must be under 4 MB. Text-based
PDFs are extracted directly in the browser, while scanned PDFs render up to
three pages and pass them through browser OCR. The bundled OCR worker, core,
and English language model avoid long-running serverless OCR jobs.

## Use

1. Start the app and open `http://localhost:4173`.
2. Upload an invoice image/PDF or start the camera and capture a bill.
3. Review the extracted data, confidence scores, validation warnings, and original document.
4. Correct fields and line items as needed.
5. Enter the reviewer name and notes.
6. Approve, reject, or return the invoice for correction.
7. Export approved data as Tally XML, CSV, or JSON.
8. Use **Overview > Download Report** for the queue-level processing report.

## Tally setup

Open **Tally Setup** to configure:

- Tally company name
- Purchase voucher type
- Local Tally HTTP address, normally `http://127.0.0.1:9000`
- Purchase and input-tax ledgers
- Supplier-specific party and purchase-ledger overrides

The dashboard connection test checks whether the local Tally service responds. It does not send invoice data or create a voucher.

## Tally XML note

The generated XML is a Tally voucher import proposal for a Purchase voucher. Ledger names come from the mapping screen:

- Party ledger: supplier-specific mapping, otherwise supplier name.
- Purchase ledger: supplier-specific mapping, otherwise default purchase ledger.
- Tax ledgers: default CGST/SGST/IGST ledgers.

Validate ledger names, voucher type, tax ledgers, and company-specific Tally configuration with your finance/Tally administrator before importing into production.

## Verification

Run the static checks and fixture tests:

```powershell
npm run check
npm test
```

The AI fixture in `test/sample-ai-invoice.json` mirrors the referenced uploaded sample bill values and verifies normalization, GST/math validation, and AI/OCR review-state behavior without calling OpenAI.

The MVP was also tested on desktop and mobile layouts and with two public GST invoice PDFs. See [TEST_RESULTS.md](TEST_RESULTS.md) for the source links, extracted values, and control checks. The two online samples are retained in the local review queue as pending review; they were not approved or exported.

## Limitations

- OCR accuracy depends on scan quality, language, and invoice layout.
- The parser uses deterministic invoice heuristics as fallback and as an AI cross-check. For production, add supplier-specific test fixtures and approval workflows before broad rollout.
- PDF support extracts embedded text first. Scanned PDFs are rendered to images with `pdftoppm` when available.
- The referenced `/mnt/data/test bill.webp` attachment is not stored in this repository; add the actual file to a private test fixture location if you want live image regression tests.
- No purchase-order matching or approval routing integration is included yet.
- User authentication and role-based segregation of duties are represented by the reviewer workflow but are not production authentication.
- The GSTIN checksum check is an offline structural check; it does not verify registration status with the GST portal.
- No autonomous posting, payment, credit, write-off, or ledger mutation is implemented.
