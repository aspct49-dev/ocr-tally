const assert = require("node:assert/strict");
const test = require("node:test");
const router = require("../server");

const {
  AI_PROVIDER_DEFAULTS,
  chatRequestBody,
  detectAiProvider,
  invoicePromptText,
  parseAiJson,
  sanitizeApiKey,
  usableOcrEvidence
} = router._internals;

const PROVIDER_KEYS = [
  "AI_PROVIDER",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "OLLAMA_HOST"
];

function withEnv(values, run) {
  const previous = {};
  for (const key of PROVIDER_KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const key of PROVIDER_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function imageUpload() {
  return {
    filename: "bill.jpg",
    contentType: "image/jpeg",
    buffer: Buffer.from("fake-image-bytes")
  };
}

function pdfUpload() {
  return {
    filename: "bill.pdf",
    contentType: "application/pdf",
    buffer: Buffer.from("fake-pdf-bytes")
  };
}

test("every provider default exposes an endpoint and a model", () => {
  for (const [name, config] of Object.entries(AI_PROVIDER_DEFAULTS)) {
    assert.ok(config.url, `${name} is missing a url`);
    assert.ok(config.model, `${name} is missing a model`);
  }
  assert.match(AI_PROVIDER_DEFAULTS.openai.url, /\/responses$/);
  assert.match(AI_PROVIDER_DEFAULTS.gemini.url, /\/chat\/completions$/);
});

test("provider is detected from whichever key is present", () => {
  withEnv({ GEMINI_API_KEY: "k" }, () => assert.equal(detectAiProvider(), "gemini"));
  withEnv({ OPENROUTER_API_KEY: "k" }, () => assert.equal(detectAiProvider(), "openrouter"));
  withEnv({ GROQ_API_KEY: "k" }, () => assert.equal(detectAiProvider(), "groq"));
  withEnv({ OPENAI_API_KEY: "k" }, () => assert.equal(detectAiProvider(), "openai"));
});

test("an explicit AI_PROVIDER overrides key-based detection", () => {
  withEnv({ AI_PROVIDER: "ollama", OPENAI_API_KEY: "k" }, () => {
    assert.equal(detectAiProvider(), "ollama");
  });
  withEnv({ AI_PROVIDER: "not-a-provider", GEMINI_API_KEY: "k" }, () => {
    assert.equal(detectAiProvider(), "gemini");
  });
});

test("noisy OCR output is withheld from the model", () => {
  assert.equal(usableOcrEvidence(""), "");
  assert.equal(usableOcrEvidence("short"), "");
  // Failed Tesseract passes emit long runs of punctuation; passing that through
  // anchors the model on tokens that are not on the document.
  assert.equal(usableOcrEvidence("|| |~~ ### @@@ ||| ~~~ ### @@@ ||| ~~~ ### @@@ |||"), "");
});

test("legible OCR output is passed through as supporting evidence", () => {
  const text = "Invoice Number IN-17 Date 2025-01-24 Total 968.00 Supplier Sleek Bill";
  assert.equal(usableOcrEvidence(text), text);
  assert.match(invoicePromptText(text), /supporting evidence/i);
});

test("the prompt omits the OCR section entirely when evidence is unusable", () => {
  assert.doesNotMatch(invoicePromptText("###"), /supporting evidence/i);
  assert.match(invoicePromptText("###"), /unreadable_fields/);
});

test("a BOM or stray whitespace in the key is stripped before it reaches a header", () => {
  // Piping a secret through PowerShell 5.1 prepends U+FEFF, which otherwise
  // fails deep inside fetch() as "Cannot convert argument to a ByteString".
  assert.equal(sanitizeApiKey("﻿AIzaSyTest"), "AIzaSyTest");
  assert.equal(sanitizeApiKey("  AIzaSyTest\n"), "AIzaSyTest");
  assert.equal(sanitizeApiKey("AIza\r\nSyTest"), "AIzaSyTest");
  assert.equal(sanitizeApiKey(undefined), "");
  assert.doesNotThrow(() => new Headers({ authorization: `Bearer ${sanitizeApiKey("﻿k")}` }));
});

test("model JSON is parsed through prose and code fences", () => {
  assert.deepEqual(parseAiJson('{"total":10}'), { total: 10 });
  assert.deepEqual(parseAiJson('```json\n{"total":10}\n```'), { total: 10 });
  assert.deepEqual(parseAiJson('Here you go:\n{"total":10}\nHope that helps.'), { total: 10 });
  assert.throws(() => parseAiJson(""), /empty response/i);
  assert.throws(() => parseAiJson("no json here"), /parsable invoice JSON/i);
});

test("image uploads are sent as a vision part", () => {
  const body = chatRequestBody(imageUpload(), "", true);
  const image = body.messages[0].content.find(part => part.type === "image_url");
  assert.ok(image);
  assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(body.temperature, 0);
});

test("strict schema mode is requested first and JSON mode is the fallback shape", () => {
  const strict = chatRequestBody(imageUpload(), "", true);
  assert.equal(strict.response_format.type, "json_schema");
  assert.equal(strict.response_format.json_schema.strict, true);

  const loose = chatRequestBody(imageUpload(), "", false);
  assert.equal(loose.response_format.type, "json_object");
  // The schema has to travel in the prompt when the provider cannot enforce it.
  assert.match(loose.messages[0].content[0].text, /JSON Schema/);
});

test("PDFs fall back to extracted text because chat providers reject file parts", () => {
  const text = "Invoice Number IN-17 Date 2025-01-24 Total 968.00 Supplier Sleek Bill";
  const body = chatRequestBody(pdfUpload(), text, true);
  assert.equal(body.messages[0].content.some(part => part.type === "image_url"), false);
  assert.match(body.messages[0].content[0].text, /IN-17/);
});

test("a PDF with no extractable text fails loudly instead of sending nothing", () => {
  assert.throws(() => chatRequestBody(pdfUpload(), "", true), /cannot be sent as an image/i);
});
