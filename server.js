const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");
const Module = require("module");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : IS_SERVERLESS
    ? path.join(os.tmpdir(), "tally-ocr-mvp")
    : path.join(ROOT, "data");
const ORIGINALS_DIR = path.join(DATA_DIR, "originals");
const TMP_DIR = path.join(DATA_DIR, "tmp");
const INVOICES_FILE = path.join(DATA_DIR, "invoices.json");
const MAPPINGS_FILE = path.join(DATA_DIR, "mappings.json");
const PORT = Number(process.env.PORT || 4173);
const MAX_UPLOAD_BYTES = IS_SERVERLESS ? Math.floor(4.25 * 1024 * 1024) : 25 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gz": "application/gzip",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf"
};

function bundledPath(...segments) {
  const runtimeRoot = process.env.CODEX_RUNTIME_ROOT || path.join(
    os.homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies"
  );
  return path.join(runtimeRoot, ...segments);
}

function loadTesseract() {
  const bundledNodeModules = bundledPath("node", "node_modules");
  const bundledPnpmModules = path.join(bundledNodeModules, ".pnpm", "node_modules");
  const nodePathParts = [process.env.NODE_PATH || "", bundledPnpmModules, bundledNodeModules].filter(Boolean);
  process.env.NODE_PATH = nodePathParts.join(path.delimiter);
  Module._initPaths();
  const candidates = [
    () => require("tesseract.js"),
    () => require(path.join(process.env.NODE_MODULES_DIR || "", "tesseract.js")),
    () => require(path.join(bundledNodeModules, "tesseract.js")),
    () => require(path.join(bundledNodeModules, ".pnpm", "tesseract.js@7.0.0", "node_modules", "tesseract.js"))
  ];
  for (const candidate of candidates) {
    try {
      return candidate();
    } catch (_) {
      // Try the next configured module location.
    }
  }
  throw new Error("tesseract.js is not installed. Run npm install, or set NODE_MODULES_DIR to a folder containing tesseract.js.");
}

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8", cacheControl = "no-store") {
  res.writeHead(status, { "content-type": contentType, "cache-control": cacheControl });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

async function ensureData() {
  await fsp.mkdir(ORIGINALS_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await ensureJson(INVOICES_FILE, []);
  await ensureJson(MAPPINGS_FILE, {
    companyName: "",
    voucherType: "Purchase",
    tallyUrl: "http://127.0.0.1:9000",
    defaultPurchaseLedger: "Purchase Accounts",
    defaultTaxLedgers: {
      cgst: "Input CGST",
      sgst: "Input SGST",
      igst: "Input IGST"
    },
    defaultPaymentMode: "On Account",
    suppliers: {}
  });
}

async function ensureJson(filePath, fallback) {
  try {
    await fsp.access(filePath);
  } catch (_) {
    await fsp.writeFile(filePath, JSON.stringify(fallback, null, 2));
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function audit(invoice, action, details = {}) {
  invoice.auditTrail = invoice.auditTrail || [];
  invoice.auditTrail.push({ at: nowIso(), action, details });
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (req.body instanceof Uint8Array) return Buffer.from(req.body);
    if (typeof req.body === "string") return Buffer.from(req.body);
    return Buffer.from(JSON.stringify(req.body));
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      const limit = IS_SERVERLESS ? "4 MB" : "25 MB";
      const error = new Error(`Upload is larger than ${limit}.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(req, body) {
  const contentType = req.headers["content-type"] || "";
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error("Missing multipart boundary.");
  const boundary = `--${match[1] || match[2]}`;
  const raw = body.toString("latin1");
  const parts = raw.split(boundary).slice(1, -1);
  const fields = {};
  const files = {};

  for (let part of parts) {
    if (part.startsWith("\r\n")) part = part.slice(2);
    const sep = part.indexOf("\r\n\r\n");
    if (sep === -1) continue;
    const headerText = part.slice(0, sep);
    let content = part.slice(sep + 4);
    if (content.endsWith("\r\n")) content = content.slice(0, -2);
    const disposition = headerText.match(/content-disposition:\s*form-data;\s*([^\r\n]+)/i);
    if (!disposition) continue;
    const name = (disposition[1].match(/name="([^"]+)"/) || [])[1];
    const filename = (disposition[1].match(/filename="([^"]*)"/) || [])[1];
    const type = (headerText.match(/content-type:\s*([^\r\n]+)/i) || [])[1] || "application/octet-stream";
    if (!name) continue;
    if (filename) {
      files[name] = { filename, contentType: type, buffer: Buffer.from(content, "latin1") };
    } else {
      fields[name] = Buffer.from(content, "latin1").toString("utf8");
    }
  }
  return { fields, files };
}

function extensionForUpload(upload) {
  const fromName = path.extname(upload.filename || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".pdf", ".tif", ".tiff", ".webp"].includes(fromName)) return fromName;
  if (upload.contentType === "application/pdf") return ".pdf";
  if (upload.contentType === "image/png") return ".png";
  if (upload.contentType === "image/jpeg") return ".jpg";
  return ".bin";
}

async function ocrImage(filePath) {
  const Tesseract = loadTesseract();
  const options = {
    logger: () => {},
    cachePath: TMP_DIR
  };
  const localLanguage = path.join(ROOT, "eng.traineddata");
  if (fs.existsSync(localLanguage)) {
    options.langPath = ROOT;
    options.gzip = false;
  }
  try {
    options.workerPath = require.resolve("tesseract.js/src/worker-script/node/index.js");
  } catch (_) {
    // Tesseract can resolve its own worker in local development.
  }
  const result = await Tesseract.recognize(filePath, "eng", options);
  return {
    text: result.data.text || "",
    confidence: Math.round(result.data.confidence || 0)
  };
}

function findExecutable(envName, fallbackSegments, binaryName) {
  if (process.env[envName]) return process.env[envName];
  const fallback = bundledPath(...fallbackSegments);
  if (fs.existsSync(fallback)) return fallback;
  return binaryName;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      shell: process.platform === "win32" && /\.cmd$/i.test(command),
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
}

async function extractPdfTextWithJs(filePath) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await fsp.readFile(filePath));
  const document = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    useWorkerFetch: false
  }).promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 10); pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str || "").join(" "));
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  return pages.join("\n");
}

async function renderPdfPagesWithJs(filePath) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = require("@napi-rs/canvas");
  const data = new Uint8Array(await fsp.readFile(filePath));
  const document = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    useWorkerFetch: false
  }).promise;
  const files = [];
  try {
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 3); pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const canvasContext = canvas.getContext("2d");
      await page.render({ canvasContext, viewport }).promise;
      const outputPath = path.join(TMP_DIR, `${crypto.randomUUID()}-${pageNumber}.png`);
      await fsp.writeFile(outputPath, canvas.toBuffer("image/png"));
      files.push(outputPath);
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  return files;
}

async function extractPdf(filePath) {
  let extracted = "";
  let pdfJsError = null;
  try {
    extracted = await extractPdfTextWithJs(filePath);
  } catch (error) {
    pdfJsError = error;
  }
  if (extracted.trim().length >= 30) {
    return { text: extracted, confidence: 80, mode: "pdf-text" };
  }
  if (IS_SERVERLESS) {
    const error = new Error("This scanned PDF requires browser OCR. Refresh the page and upload it again.");
    error.statusCode = 422;
    throw error;
  }

  let renderedFiles = [];
  try {
    renderedFiles = await renderPdfPagesWithJs(filePath);
    const pageResults = [];
    for (const pageFile of renderedFiles) {
      pageResults.push(await ocrImage(pageFile));
    }
    const textValue = pageResults.map(item => item.text).join("\n");
    if (textValue.trim()) {
      return {
        text: textValue,
        confidence: Math.round(pageResults.reduce((sum, item) => sum + item.confidence, 0) / pageResults.length),
        mode: "pdf-ocr"
      };
    }
  } catch (error) {
    pdfJsError = error;
  } finally {
    await Promise.all(renderedFiles.map(file => fsp.unlink(file).catch(() => {})));
  }
  const python = findExecutable("PYTHON", ["python", "python.exe"], "python");
  const code = [
    "import json, pathlib, pdfplumber, sys",
    "p=pathlib.Path(sys.argv[1])",
    "texts=[]",
    "with pdfplumber.open(p) as pdf:",
    "    for page in pdf.pages:",
    "        texts.append(page.extract_text() or '')",
    "print(json.dumps({'text':'\\n'.join(texts)}))"
  ].join("\n");
  try {
    const output = await run(python, ["-c", code, filePath]);
    extracted = JSON.parse(output).text || "";
  } catch (error) {
    throw new Error(`PDF text extraction failed: ${error.message}`);
  }
  if (extracted.trim().length >= 30) {
    return { text: extracted, confidence: 80, mode: "pdf-text" };
  }

  const prefix = path.join(TMP_DIR, crypto.randomUUID());
  const pdftoppm = findExecutable("PDFTOPPM", ["bin", "override", "pdftoppm.cmd"], "pdftoppm");
  try {
    await run(pdftoppm, ["-png", "-r", "200", "-f", "1", "-l", "3", filePath, prefix]);
    const dir = await fsp.readdir(TMP_DIR);
    const pageFiles = dir
      .filter(name => name.startsWith(path.basename(prefix)) && name.endsWith(".png"))
      .map(name => path.join(TMP_DIR, name))
      .sort();
    if (!pageFiles.length) throw new Error("PDF renderer produced no page images.");
    const pageResults = [];
    for (const pageFile of pageFiles) {
      pageResults.push(await ocrImage(pageFile));
    }
    await Promise.all(pageFiles.map(file => fsp.unlink(file).catch(() => {})));
    return {
      text: pageResults.map(item => item.text).join("\n"),
      confidence: Math.round(pageResults.reduce((sum, item) => sum + item.confidence, 0) / pageResults.length),
      mode: "pdf-ocr"
    };
  } catch (error) {
    throw new Error(`Scanned PDF OCR failed. Install Poppler/pdftoppm or upload an image. Details: ${error.message}`);
  }
}

function normalizeText(textValue) {
  return (textValue || "")
    .replace(/\u20b9/g, "Rs ")
    .replace(/[|]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "\n");
}

function linesOf(textValue) {
  return normalizeText(textValue)
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
}

function amountToNumber(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  if (!cleaned || cleaned === "." || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function firstMatch(textValue, patterns) {
  for (const pattern of patterns) {
    const match = textValue.match(pattern);
    if (match) return (match[1] || match[0] || "").trim();
  }
  return "";
}

function firstAmount(textValue, labels) {
  const label = labels.join("|");
  return amountToNumber(firstMatch(textValue, [
    new RegExp(`(?:${label})\\s*[:\\-]?\\s*(?:rs\\.?|inr)?\\s*([0-9][0-9,]*(?:\\.\\d{1,2})?)`, "i"),
    new RegExp(`(?:rs\\.?|inr)?\\s*([0-9][0-9,]*(?:\\.\\d{1,2})?)\\s*(?:${label})`, "i")
  ]));
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labeledAmount(lines, labels, pick = "first") {
  for (const label of labels) {
    const pattern = new RegExp(escapePattern(label), "i");
    for (const line of lines) {
      const match = line.match(pattern);
      if (!match) continue;
      const remainder = line.slice((match.index || 0) + match[0].length);
      const values = remainder.match(/[0-9][0-9,]*(?:\.\d{1,2})?/g) || [];
      if (!values.length) continue;
      return amountToNumber(pick === "last" ? values[values.length - 1] : values[0]);
    }
  }
  return null;
}

function fieldConfidence(value, base) {
  if (value === null || value === undefined || value === "") return 0;
  return base;
}

function parseDate(value) {
  if (!value) return "";
  const monthNames = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
  };
  const named = value.trim().match(/^(\d{1,2})\s*[-/.]\s*([A-Za-z]{3,9})\s*[-/.]\s*(\d{2,4})$/);
  if (named) {
    const month = monthNames[named[2].slice(0, 3).toLowerCase()];
    if (!month) return "";
    const year = named[3].length === 2 ? `20${named[3]}` : named[3];
    return `${year}-${month}-${named[1].padStart(2, "0")}`;
  }
  const cleaned = value.replace(/[.]/g, "/").replace(/-/g, "/").replace(/\s+/g, "").trim();
  const parts = cleaned.split("/");
  if (parts.length !== 3) return value.trim();
  let [a, b, c] = parts.map(part => part.trim());
  if (c.length === 2) c = `20${c}`;
  if (a.length === 4) return `${a}-${b.padStart(2, "0")}-${c.padStart(2, "0")}`;
  return `${c.padStart(4, "20")}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`;
}

function extractSupplier(lines, gstin) {
  if (!lines.length) return "";
  const forLine = lines.find(line => /\bfor\s*[,.:]\s*.+/i.test(line));
  if (forLine) return forLine.replace(/^.*?\bfor\s*[,.:]\s*/i, "").slice(0, 80);
  if (gstin) {
    const gstIndex = lines.findIndex(line => line.includes(gstin));
    const candidates = lines
      .slice(Math.max(0, gstIndex - 6), gstIndex)
      .filter(candidate => candidate && !/tax invoice|invoice\s*(?:no|number)|gstin|\bdate\b|^pin\b|^country\b/i.test(candidate));
    const nameLike = candidates.find(candidate => !/[0-9,]/.test(candidate) && candidate.split(/\s+/).length <= 7);
    if (nameLike) return nameLike.slice(0, 80);
    if (candidates.length) return candidates[0].slice(0, 80);
  }
  return (lines.find(line => !/invoice|tax invoice|original|duplicate|gstin|date|bill/i.test(line)) || lines[0] || "").slice(0, 80);
}

function extractInvoiceNumber(textValue, lines) {
  const direct = firstMatch(textValue, [
    /\b(?:invoice|inv|bill|voucher)\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]*\d[A-Z0-9\/\-]*)\b/i,
    /\b(?:invoice|inv|bill|voucher)\s*[:\-]\s*([A-Z0-9][A-Z0-9\/\-]*\d[A-Z0-9\/\-]*)\b/i
  ]);
  if (direct && !/^(no|not|number)$/i.test(direct)) return direct;
  const line = lines.find(item => /invoice|inv|bill|voucher/i.test(item) && /\d/.test(item));
  if (!line) return "";
  const tokens = line.match(/[A-Z0-9][A-Z0-9\/\-]*\d[A-Z0-9\/\-]*/gi) || [];
  const filtered = tokens.filter(token => !/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(token));
  return filtered[filtered.length - 1] || "";
}

function extractLineItems(lines) {
  const items = [];
  let previousLine = "";
  for (const line of lines) {
    if (/total|taxable|cgst|sgst|igst|invoice|gstin|amount in words|hsn\/sac/i.test(line)) continue;
    if (/^\d{3,8}\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%/.test(line)) continue;
    const compact = line.match(/^\d+\s+(\d{3,8})\s+(\d+(?:\.\d+)?)\s+[A-Z]{1,5}\s+(.+)$/i);
    const detailed = line.match(/^\d+\s+(.+?)\s+(\d{3,8})\s+(\d+(?:\.\d+)?)\s+[A-Z]{1,5}\s+([0-9,]+(?:\.\d{1,2})?)\s+([0-9,]+(?:\.\d{1,2})?)/i);
    if (detailed) {
      items.push({
        description: detailed[1].trim(),
        quantity: Number(detailed[3]),
        rate: amountToNumber(detailed[4]),
        amount: amountToNumber(detailed[5]),
        confidence: 72
      });
      previousLine = "";
      continue;
    }
    if (compact) {
      const amounts = compact[3].match(/[0-9][0-9,]*(?:\.\d{1,2})?/g) || [];
      if (amounts.length < 2) continue;
      items.push({
        description: previousLine || `HSN/SAC ${compact[1]}`,
        quantity: Number(compact[2]),
        rate: amountToNumber(amounts[0]),
        amount: amountToNumber(amounts[amounts.length - 1]),
        confidence: previousLine ? 68 : 58
      });
      previousLine = "";
      continue;
    }
    const match = line.match(/^(.{3,}?)\s+(\d+(?:\.\d+)?)\s+([0-9,]+(?:\.\d{1,2})?)\s+([0-9,]+(?:\.\d{1,2})?)$/);
    if (match) {
      items.push({
        description: match[1].trim(),
        quantity: Number(match[2]),
        rate: amountToNumber(match[3]),
        amount: amountToNumber(match[4]),
        confidence: 65
      });
      previousLine = "";
      continue;
    }
    if (/[A-Za-z]{3}/.test(line) && line.length <= 100) previousLine = line;
  }
  return items.slice(0, 30);
}

function extractInvoiceFields(rawText, ocrConfidence) {
  const textValue = normalizeText(rawText);
  const lines = linesOf(textValue);
  const gstin = firstMatch(textValue, [/\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/i]).toUpperCase();
  const invoiceNumber = extractInvoiceNumber(textValue, lines);
  const dateRaw = firstMatch(textValue, [
    /\b(?:invoice|inv|bill)?\s*date\s*[:\-]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/i,
    /\b(?:invoice|inv|bill)?\s*date\s*[:\-]?\s*(\d{1,2}\s*[-\/.]\s*[A-Za-z]{3,9}\s*[-\/.]\s*\d{2,4})\b/i,
    /\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/
  ]);
  let taxableAmount = labeledAmount(lines, ["total taxable amount", "taxable amount", "taxable value", "sub total", "subtotal", "total amount"]);
  if (!taxableAmount) {
    const totalQtyLine = lines.find(line => /^total qty\b/i.test(line));
    if (totalQtyLine) taxableAmount = amountToNumber((totalQtyLine.match(/[0-9][0-9,]*(?:\.\d{1,2})?/g) || []).pop());
  }
  taxableAmount = taxableAmount || 0;
  let cgst = labeledAmount(lines, ["total cgst amount", "total cgst", "cgst amount"]) || 0;
  let sgst = labeledAmount(lines, ["total sgst amount", "total sgst", "sgst amount"]) || 0;
  let igst = labeledAmount(lines, ["total igst amount", "total igst", "igst amount"]) || 0;
  const totalAmount = labeledAmount(lines, ["net invoice amount", "total invoice amount", "amount including gst", "invoice value (word)", "grand total", "invoice total", "net amount", "total amount"]) || 0;
  const taxDifference = Math.round((totalAmount - taxableAmount - cgst - sgst - igst) * 100) / 100;
  const placeOfSupplyCode = firstMatch(textValue, [/place of supply[^\n]*?\(([0-9]{2})\)/i]);
  if (taxDifference > 0 && !cgst && !sgst && !igst && placeOfSupplyCode && gstin) {
    if (placeOfSupplyCode === gstin.slice(0, 2)) {
      cgst = Math.round((taxDifference / 2) * 100) / 100;
      sgst = Math.round((taxDifference - cgst) * 100) / 100;
    } else {
      igst = taxDifference;
    }
  }
  const supplier = extractSupplier(lines, gstin);
  const lineItems = extractLineItems(lines);

  const fields = {
    supplier,
    invoiceNumber,
    invoiceDate: parseDate(dateRaw),
    gstin,
    taxableAmount,
    cgst,
    sgst,
    igst,
    totalAmount,
    lineItems
  };
  const confidence = {
    supplier: fieldConfidence(supplier, 55),
    invoiceNumber: fieldConfidence(invoiceNumber, 82),
    invoiceDate: fieldConfidence(dateRaw, 80),
    gstin: fieldConfidence(gstin, 90),
    taxableAmount: taxableAmount ? 72 : 0,
    cgst: cgst ? 78 : 45,
    sgst: sgst ? 78 : 45,
    igst: igst ? 78 : 45,
    totalAmount: totalAmount ? 82 : 0,
    lineItems: lineItems.length ? 60 : 25,
    ocrOverall: ocrConfidence
  };
  return { fields, confidence, rawText: textValue };
}

function validateInvoice(fields, invoices, currentId) {
  const errors = [];
  const warnings = [];
  const checks = [];
  if (!fields.supplier) errors.push("Supplier is missing.");
  if (!fields.invoiceNumber) errors.push("Invoice number is missing.");
  if (!fields.invoiceDate) warnings.push("Invoice date was not confidently extracted.");
  if (!fields.gstin) warnings.push("Supplier GSTIN was not found.");
  if (!fields.totalAmount) errors.push("Total amount is missing.");

  const requiredFieldsPresent = Boolean(fields.supplier && fields.invoiceNumber && fields.totalAmount);
  checks.push({
    id: "required-fields",
    label: "Required fields",
    status: requiredFieldsPresent ? "pass" : "fail",
    detail: requiredFieldsPresent ? "Supplier, invoice number and total are present." : "Complete the missing required fields."
  });

  const gstin = String(fields.gstin || "").toUpperCase();
  if (gstin) {
    const formatValid = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin);
    const checksumValid = formatValid && validGstinChecksum(gstin);
    if (!formatValid) warnings.push("GSTIN format appears invalid.");
    else if (!checksumValid) warnings.push("GSTIN checksum could not be verified.");
    checks.push({
      id: "gstin",
      label: "GSTIN",
      status: checksumValid ? "pass" : "warn",
      detail: checksumValid ? "Format and checksum verified." : "Review the GSTIN against the original."
    });
  } else {
    checks.push({ id: "gstin", label: "GSTIN", status: "warn", detail: "GSTIN was not detected." });
  }

  const expected = Math.round(((fields.taxableAmount || 0) + (fields.cgst || 0) + (fields.sgst || 0) + (fields.igst || 0)) * 100) / 100;
  const totalsMatch = !fields.totalAmount || !expected || Math.abs(expected - fields.totalAmount) <= 1;
  if (!totalsMatch) {
    warnings.push(`Total check failed: taxable + taxes is ${expected.toFixed(2)}, total is ${fields.totalAmount.toFixed(2)}.`);
  }
  checks.push({
    id: "invoice-total",
    label: "Invoice total",
    status: totalsMatch ? "pass" : "warn",
    detail: totalsMatch ? "Taxable value and taxes reconcile to the total." : `Expected ${expected.toFixed(2)}.`
  });

  const items = Array.isArray(fields.lineItems) ? fields.lineItems : [];
  const lineTotal = Math.round(items.reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100;
  const linesMatch = !items.length || !fields.taxableAmount || Math.abs(lineTotal - fields.taxableAmount) <= 1;
  if (!linesMatch) warnings.push(`Line-item check failed: items total ${lineTotal.toFixed(2)}, taxable amount is ${Number(fields.taxableAmount).toFixed(2)}.`);
  checks.push({
    id: "line-items",
    label: "Line items",
    status: !items.length ? "warn" : linesMatch ? "pass" : "warn",
    detail: !items.length ? "No line items were detected." : linesMatch ? `${items.length} line item${items.length === 1 ? "" : "s"} reconcile.` : `Items total ${lineTotal.toFixed(2)}.`
  });

  const hasLocalTax = Number(fields.cgst || 0) > 0 || Number(fields.sgst || 0) > 0;
  const hasIgst = Number(fields.igst || 0) > 0;
  const taxModeValid = !(hasLocalTax && hasIgst) && (!hasLocalTax || Math.abs(Number(fields.cgst || 0) - Number(fields.sgst || 0)) <= 1);
  if (!taxModeValid) warnings.push("Tax-mode check failed: review the CGST, SGST and IGST combination.");
  checks.push({
    id: "tax-mode",
    label: "GST tax mode",
    status: taxModeValid ? "pass" : "warn",
    detail: taxModeValid ? (hasIgst ? "IGST treatment detected." : hasLocalTax ? "CGST and SGST treatment detected." : "No GST amount detected.") : "Use either balanced CGST/SGST or IGST."
  });

  const invoiceDate = fields.invoiceDate ? new Date(`${fields.invoiceDate}T00:00:00Z`) : null;
  const futureDate = invoiceDate && Number.isFinite(invoiceDate.getTime()) && invoiceDate.getTime() > Date.now() + 86400000;
  if (futureDate) warnings.push("Invoice date is in the future.");
  checks.push({
    id: "invoice-date",
    label: "Invoice date",
    status: !fields.invoiceDate || futureDate ? "warn" : "pass",
    detail: !fields.invoiceDate ? "Date needs review." : futureDate ? "Future date detected." : "Date is present and not in the future."
  });

  const duplicate = invoices.find(invoice => {
    if (invoice.id === currentId) return false;
    const a = invoice.fields || {};
    if (!a.invoiceNumber || !fields.invoiceNumber) return false;
    const sameInvoice = a.invoiceNumber.toLowerCase() === fields.invoiceNumber.toLowerCase();
    const sameSupplier = (a.gstin && fields.gstin && a.gstin === fields.gstin) || (a.supplier && fields.supplier && a.supplier.toLowerCase() === fields.supplier.toLowerCase());
    return sameInvoice && sameSupplier;
  });
  if (duplicate) warnings.push(`Possible duplicate of invoice ${duplicate.id}.`);
  checks.push({
    id: "duplicate",
    label: "Duplicate check",
    status: duplicate ? "warn" : "pass",
    detail: duplicate ? "A matching supplier and invoice number already exists." : "No exact duplicate found."
  });
  return { errors, warnings, checks, duplicateId: duplicate ? duplicate.id : null };
}

function validGstinChecksum(gstin) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let factor = 2;
  let sum = 0;
  for (let index = gstin.length - 2; index >= 0; index -= 1) {
    const codePoint = chars.indexOf(gstin[index]);
    if (codePoint < 0) return false;
    const product = factor * codePoint;
    sum += Math.floor(product / 36) + (product % 36);
    factor = factor === 2 ? 1 : 2;
  }
  const checkCodePoint = (36 - (sum % 36)) % 36;
  return chars[checkCodePoint] === gstin[gstin.length - 1];
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tallyDate(dateValue) {
  if (!dateValue) return "";
  const match = String(dateValue).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(dateValue).replace(/[^0-9]/g, "");
  return `${match[1]}${match[2]}${match[3]}`;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function mappingFor(invoice, mappings) {
  const fields = invoice.fields || {};
  const key = fields.gstin || fields.supplier || "";
  return {
    partyLedger: (mappings.suppliers[key] && mappings.suppliers[key].partyLedger) || fields.supplier || "Unknown Supplier",
    purchaseLedger: (mappings.suppliers[key] && mappings.suppliers[key].purchaseLedger) || mappings.defaultPurchaseLedger || "Purchase Accounts",
    taxLedgers: mappings.defaultTaxLedgers || {}
  };
}

function processingReportCsv(invoices, mappings) {
  const headers = [
    "id", "status", "supplier", "invoiceNumber", "invoiceDate", "gstin",
    "taxableAmount", "cgst", "sgst", "igst", "totalAmount", "issues",
    "reviewer", "partyLedger", "createdAt", "updatedAt"
  ];
  const rows = invoices.map(invoice => {
    const fields = invoice.fields || {};
    const map = mappingFor(invoice, mappings);
    const issues = (invoice.validation?.errors?.length || 0) + (invoice.validation?.warnings?.length || 0);
    return [
      invoice.id, invoice.status, fields.supplier, fields.invoiceNumber, fields.invoiceDate,
      fields.gstin, fields.taxableAmount, fields.cgst, fields.sgst, fields.igst,
      fields.totalAmount, issues, invoice.review?.reviewer || "", map.partyLedger,
      invoice.createdAt, invoice.updatedAt
    ].map(csvEscape).join(",");
  });
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

function createTallyXml(invoice, mappings) {
  const fields = invoice.fields;
  const map = mappingFor(invoice, mappings);
  const voucherType = mappings.voucherType || "Purchase";
  const taxes = [
    ["cgst", fields.cgst || 0],
    ["sgst", fields.sgst || 0],
    ["igst", fields.igst || 0]
  ].filter(([, amount]) => amount > 0);
  const ledgerEntries = [
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${escapeXml(map.partyLedger)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${fields.totalAmount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`,
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${escapeXml(map.purchaseLedger)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${(fields.taxableAmount || 0).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
  ];
  for (const [tax, amount] of taxes) {
    const ledgerName = map.taxLedgers[tax] || `Input ${tax.toUpperCase()}`;
    ledgerEntries.push(`<ALLLEDGERENTRIES.LIST><LEDGERNAME>${escapeXml(ledgerName)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        ${mappings.companyName ? `<STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(mappings.companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>` : ""}
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${escapeXml(voucherType)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>${escapeXml(tallyDate(fields.invoiceDate))}</DATE>
            <VOUCHERTYPENAME>${escapeXml(voucherType)}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${escapeXml(fields.invoiceNumber)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${escapeXml(map.partyLedger)}</PARTYLEDGERNAME>
            <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
            <NARRATION>${escapeXml(`OCR reviewed import proposal ${invoice.id}. Original retained: ${invoice.originalName}`)}</NARRATION>
            <REFERENCE>${escapeXml(fields.invoiceNumber)}</REFERENCE>
            <REFERENCEDATE>${escapeXml(tallyDate(fields.invoiceDate))}</REFERENCEDATE>
            ${ledgerEntries.join("\n            ")}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

async function readValidatedInvoices() {
  const invoices = await readJson(INVOICES_FILE, []);
  for (const invoice of invoices) {
    invoice.validation = validateInvoice(invoice.fields || {}, invoices, invoice.id);
  }
  await writeJson(INVOICES_FILE, invoices);
  return invoices;
}

function createCsv(invoice, mappings) {
  const fields = invoice.fields;
  const map = mappingFor(invoice, mappings);
  const headers = ["id", "status", "supplier", "partyLedger", "invoiceNumber", "invoiceDate", "gstin", "taxableAmount", "cgst", "sgst", "igst", "totalAmount", "originalName"];
  const row = [
    invoice.id,
    invoice.status,
    fields.supplier,
    map.partyLedger,
    fields.invoiceNumber,
    fields.invoiceDate,
    fields.gstin,
    fields.taxableAmount,
    fields.cgst,
    fields.sgst,
    fields.igst,
    fields.totalAmount,
    invoice.originalName
  ];
  return `${headers.join(",")}\n${row.map(csvEscape).join(",")}\n`;
}

async function handleUpload(req, res) {
  const body = await readBody(req);
  const { fields, files } = parseMultipart(req, body);
  const upload = files.document;
  if (!upload || !upload.buffer.length) {
    return json(res, 400, { error: "Upload an invoice image or PDF." });
  }

  const ext = extensionForUpload(upload);
  if (ext === ".bin") return json(res, 400, { error: "Unsupported file type. Use PNG, JPG, JPEG, TIFF, WEBP, or PDF." });
  const id = crypto.randomUUID();
  const storedName = `${id}${ext}`;
  const filePath = path.join(ORIGINALS_DIR, storedName);
  await fsp.writeFile(filePath, upload.buffer);

  let extraction;
  try {
    if (fields.clientOcr === "true") {
      extraction = {
        text: fields.extractedText || "",
        confidence: Math.max(0, Math.min(100, Number(fields.ocrConfidence) || 0)),
        mode: fields.extractionMode || "browser-ocr"
      };
    } else if (ext === ".pdf") {
      extraction = await extractPdf(filePath);
    } else if (IS_SERVERLESS) {
      const error = new Error("Browser OCR data was not received. Refresh the page and try again.");
      error.statusCode = 422;
      throw error;
    } else {
      extraction = await ocrImage(filePath);
      extraction.mode = "image-ocr";
    }
  } catch (error) {
    await fsp.unlink(filePath).catch(() => {});
    throw error;
  }

  const parsed = extractInvoiceFields(extraction.text, extraction.confidence);
  const invoices = await readJson(INVOICES_FILE, []);
  const validation = validateInvoice(parsed.fields, invoices, id);
  const invoice = {
    id,
    status: "pending_review",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    originalName: upload.filename || storedName,
    storedName,
    contentType: upload.contentType,
    extractionMode: extraction.mode || "ocr",
    rawText: parsed.rawText,
    fields: parsed.fields,
    confidence: parsed.confidence,
    validation,
    review: {
      reviewer: "",
      notes: ""
    },
    auditTrail: []
  };
  audit(invoice, "uploaded", { originalName: invoice.originalName, extractionMode: invoice.extractionMode });
  audit(invoice, "extracted", { ocrOverall: invoice.confidence.ocrOverall, warnings: validation.warnings.length, errors: validation.errors.length });
  invoices.unshift(invoice);
  await writeJson(INVOICES_FILE, invoices);
  return json(res, 201, invoice);
}

function mergeInvoiceFields(existing, incoming) {
  const current = existing.fields || {};
  const next = { ...current, ...incoming };
  next.taxableAmount = amountToNumber(next.taxableAmount) || 0;
  next.cgst = amountToNumber(next.cgst) || 0;
  next.sgst = amountToNumber(next.sgst) || 0;
  next.igst = amountToNumber(next.igst) || 0;
  next.totalAmount = amountToNumber(next.totalAmount) || 0;
  next.lineItems = Array.isArray(incoming.lineItems) ? incoming.lineItems : current.lineItems || [];
  return next;
}

async function updateInvoice(req, res, id, action = "save") {
  const payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const invoices = await readJson(INVOICES_FILE, []);
  const invoice = invoices.find(item => item.id === id);
  if (!invoice) return notFound(res);
  const previousFields = JSON.stringify(invoice.fields || {});
  invoice.fields = mergeInvoiceFields(invoice, payload.fields || {});
  invoice.review = {
    reviewer: payload.reviewer || invoice.review.reviewer || "",
    notes: payload.notes || invoice.review.notes || ""
  };
  invoice.updatedAt = nowIso();
  invoice.validation = validateInvoice(invoice.fields, invoices, id);
  audit(invoice, "review_updated", { reviewer: invoice.review.reviewer || "unassigned" });

  if (action === "save" && invoice.status === "approved" && previousFields !== JSON.stringify(invoice.fields)) {
    invoice.status = "pending_review";
    delete invoice.approvedAt;
    audit(invoice, "approval_revoked", { reason: "Approved invoice data was edited and must be reviewed again." });
  }

  if (action === "approve") {
    if (!invoice.review.reviewer) return json(res, 400, { error: "Reviewer name is required before approval." });
    if (invoice.validation.errors.length) return json(res, 400, { error: "Fix validation errors before approval.", validation: invoice.validation });
    if (invoice.validation.duplicateId && !invoice.review.notes) {
      return json(res, 400, { error: "Add a review note explaining why this possible duplicate should be approved." });
    }
    invoice.status = "approved";
    invoice.approvedAt = nowIso();
    audit(invoice, "approved", { reviewer: invoice.review.reviewer, note: "Approved for export only. No posting was performed." });
  }

  if (action === "needs-correction" || action === "reject") {
    if (!invoice.review.reviewer) return json(res, 400, { error: "Reviewer name is required for this decision." });
    if (!invoice.review.notes) return json(res, 400, { error: "Add a review note explaining this decision." });
    invoice.status = action === "reject" ? "rejected" : "needs_correction";
    delete invoice.approvedAt;
    audit(invoice, action === "reject" ? "rejected" : "returned_for_correction", {
      reviewer: invoice.review.reviewer,
      note: invoice.review.notes
    });
  }

  await writeJson(INVOICES_FILE, invoices);
  return json(res, 200, invoice);
}

async function tallyConnectionStatus(res) {
  const mappings = await readJson(MAPPINGS_FILE, {});
  const target = new URL(process.env.TALLY_URL || mappings.tallyUrl || "http://127.0.0.1:9000");
  if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname)) {
    return json(res, 400, { connected: false, message: "For this local MVP, the Tally address must point to this computer." });
  }

  const request = http.get(target, { timeout: 1800 }, response => {
    response.resume();
    json(res, 200, {
      connected: true,
      address: target.origin,
      message: `Tally responded with HTTP ${response.statusCode}.`
    });
  });
  request.on("timeout", () => request.destroy(new Error("Connection timed out.")));
  request.on("error", error => {
    json(res, 200, {
      connected: false,
      address: target.origin,
      message: `Tally was not detected at ${target.origin}. Start TallyPrime and enable its HTTP server.`
    });
  });
}

async function deleteInvoice(res, id) {
  const invoices = await readJson(INVOICES_FILE, []);
  const next = invoices.filter(item => item.id !== id);
  if (next.length === invoices.length) return notFound(res);
  await writeJson(INVOICES_FILE, next);
  return json(res, 200, { ok: true });
}

async function exportInvoice(res, id, format) {
  const invoices = await readJson(INVOICES_FILE, []);
  const invoice = invoices.find(item => item.id === id);
  if (!invoice) return notFound(res);
  if (invoice.status !== "approved") {
    return json(res, 409, { error: "Human approval is required before export." });
  }
  const mappings = await readJson(MAPPINGS_FILE, {});
  audit(invoice, `exported_${format}`, { noPosting: true });
  invoice.updatedAt = nowIso();
  await writeJson(INVOICES_FILE, invoices);

  if (format === "xml") {
    res.writeHead(200, {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="${invoice.id}-tally.xml"`
    });
    return res.end(createTallyXml(invoice, mappings));
  }
  if (format === "csv") {
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${invoice.id}.csv"`
    });
    return res.end(createCsv(invoice, mappings));
  }
  if (format === "json") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${invoice.id}.json"`
    });
    return res.end(JSON.stringify({ invoice, mappings: mappingFor(invoice, mappings) }, null, 2));
  }
  return notFound(res);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  try {
    const data = await fsp.readFile(filePath);
    const cacheControl = pathname.startsWith("/vendor/")
      ? "public, max-age=31536000, immutable"
      : "no-store";
    text(res, 200, data, MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream", cacheControl);
  } catch (_) {
    notFound(res);
  }
}

async function router(req, res) {
  try {
    await ensureData();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = url.pathname;

    if (route === "/api/health") return json(res, 200, { ok: true, app: "tally-ocr-mvp" });
    if (route === "/api/invoices" && req.method === "GET") return json(res, 200, await readValidatedInvoices());
    if (route === "/api/invoices" && req.method === "POST") return await handleUpload(req, res);
    if (route === "/api/tally/status" && req.method === "GET") return await tallyConnectionStatus(res);
    if (route === "/api/reports/processing.csv" && req.method === "GET") {
      const invoices = await readJson(INVOICES_FILE, []);
      const mappings = await readJson(MAPPINGS_FILE, {});
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="invoice-processing-report.csv"'
      });
      return res.end(processingReportCsv(invoices, mappings));
    }
    if (route === "/api/mappings" && req.method === "GET") return json(res, 200, await readJson(MAPPINGS_FILE, {}));
    if (route === "/api/mappings" && req.method === "PUT") {
      const payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      await writeJson(MAPPINGS_FILE, payload);
      return json(res, 200, payload);
    }

    const invoiceMatch = route.match(/^\/api\/invoices\/([^/]+)(?:\/([^/]+))?$/);
    if (invoiceMatch) {
      const [, id, action] = invoiceMatch;
      if (req.method === "PUT" && !action) return await updateInvoice(req, res, id, "save");
      if (req.method === "POST" && ["approve", "needs-correction", "reject"].includes(action)) return await updateInvoice(req, res, id, action);
      if (req.method === "DELETE" && !action) return await deleteInvoice(res, id);
      if (req.method === "GET" && ["xml", "csv", "json"].includes(action)) return await exportInvoice(res, id, action);
      if (req.method === "GET" && action === "original") {
        const invoices = await readJson(INVOICES_FILE, []);
        const invoice = invoices.find(item => item.id === id);
        if (!invoice) return notFound(res);
        const filePath = path.join(ORIGINALS_DIR, invoice.storedName);
        res.writeHead(200, { "content-type": invoice.contentType || "application/octet-stream" });
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    if (req.method === "GET") return await serveStatic(req, res);
    notFound(res);
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) console.error(error);
    json(res, error.statusCode || 500, { error: error.message || "Unexpected server error." });
  }
}

if (require.main === module) {
  http.createServer(router).listen(PORT, () => {
    console.log(`Tally OCR MVP running at http://localhost:${PORT}`);
    console.log("No data is posted to Tally automatically. Approved invoices are export proposals only.");
  });
}

module.exports = router;
