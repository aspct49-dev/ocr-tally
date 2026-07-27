const state = {
  invoices: [],
  selectedId: null,
  filter: "all",
  mappings: null,
  stream: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload.error || response.statusText;
    } catch (_) {
      detail = response.statusText;
    }
    throw new Error(detail);
  }
  return response.json();
}

function selectedInvoice() {
  return state.invoices.find(invoice => invoice.id === state.selectedId) || null;
}

function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusLabel(status) {
  return status === "approved" ? "Approved" : "Pending review";
}

function setServiceStatus(message, stateName = "ready") {
  const node = $("#serviceStatus");
  node.innerHTML = '<span class="statusDot"></span>';
  node.append(document.createTextNode(message));
  node.dataset.state = stateName;
}

async function loadAll() {
  const [health, invoices, mappings] = await Promise.all([
    api("/api/health"),
    api("/api/invoices"),
    api("/api/mappings")
  ]);
  setServiceStatus(health.ok ? "Local service ready" : "Service unavailable", health.ok ? "ready" : "error");
  state.invoices = invoices;
  state.mappings = mappings;
  if (!state.selectedId && invoices[0]) state.selectedId = invoices[0].id;
  renderInvoices();
  renderReview();
  renderMappings();
}

function renderInvoices() {
  const list = $("#invoiceList");
  const invoices = state.invoices.filter(invoice => state.filter === "all" || invoice.status === state.filter);
  const pendingCount = state.invoices.filter(invoice => invoice.status === "pending_review").length;
  const approvedCount = state.invoices.filter(invoice => invoice.status === "approved").length;
  $("#queueCount").textContent = state.invoices.length;
  $("#allCount").textContent = state.invoices.length;
  $("#reviewCount").textContent = pendingCount;
  $("#approvedCount").textContent = approvedCount;
  list.innerHTML = invoices.length
    ? ""
    : '<div class="message">No invoices in this view.</div>';
  for (const invoice of invoices) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `invoiceCard ${invoice.id === state.selectedId ? "active" : ""}`;
    const f = invoice.fields || {};
    const issueCount = (invoice.validation?.errors?.length || 0) + (invoice.validation?.warnings?.length || 0);
    card.innerHTML = `
      <strong>${escapeHtml(f.supplier || "Unknown supplier")}</strong>
      <span class="invoiceNumber">${escapeHtml(f.invoiceNumber || "No invoice number")}</span>
      <span class="invoiceAmount">Rs ${money(f.totalAmount)}</span>
      <span class="invoiceMetaLine">${issueCount ? `${issueCount} issue${issueCount === 1 ? "" : "s"}` : "Checks passed"}</span>
      <span class="queueStatus ${invoice.status === "approved" ? "approved" : ""}">${statusLabel(invoice.status)}</span>
    `;
    card.addEventListener("click", () => {
      state.selectedId = invoice.id;
      renderInvoices();
      renderReview();
      renderAudit();
    });
    list.appendChild(card);
  }
}

function setInput(name, value) {
  const input = document.querySelector(`[name="${name}"]`);
  if (input) input.value = value ?? "";
}

function getReviewPayload() {
  const form = $("#reviewForm");
  const lineItems = $$("#lineItems .lineItem").map(row => ({
    description: row.querySelector('[data-line="description"]').value,
    quantity: Number(row.querySelector('[data-line="quantity"]').value || 0),
    rate: Number(row.querySelector('[data-line="rate"]').value || 0),
    amount: Number(row.querySelector('[data-line="amount"]').value || 0),
    confidence: 100
  })).filter(item => item.description || item.amount);
  return {
    reviewer: form.elements.reviewer.value.trim(),
    notes: form.elements.notes.value.trim(),
    fields: {
      supplier: form.elements.supplier.value.trim(),
      invoiceNumber: form.elements.invoiceNumber.value.trim(),
      invoiceDate: form.elements.invoiceDate.value,
      gstin: form.elements.gstin.value.trim().toUpperCase(),
      taxableAmount: Number(form.elements.taxableAmount.value || 0),
      cgst: Number(form.elements.cgst.value || 0),
      sgst: Number(form.elements.sgst.value || 0),
      igst: Number(form.elements.igst.value || 0),
      totalAmount: Number(form.elements.totalAmount.value || 0),
      lineItems
    }
  };
}

function renderValidation(invoice) {
  const box = $("#validationBox");
  const errors = invoice.validation?.errors || [];
  const warnings = invoice.validation?.warnings || [];
  box.innerHTML = "";
  if (!errors.length && !warnings.length) {
    box.innerHTML = '<div class="message ok">Validation passed. Review is still required before export.</div>';
    return;
  }
  for (const error of errors) {
    const node = document.createElement("div");
    node.className = "message error";
    node.textContent = error;
    box.appendChild(node);
  }
  for (const warning of warnings) {
    const node = document.createElement("div");
    node.className = "message warn";
    node.textContent = warning;
    box.appendChild(node);
  }
}

function renderLineItems(items = []) {
  const container = $("#lineItems");
  container.innerHTML = "";
  const rows = items.length ? items : [{ description: "", quantity: "", rate: "", amount: "" }];
  for (const item of rows) addLineItem(item);
}

function addLineItem(item = {}) {
  const row = document.createElement("div");
  row.className = "lineItem";
  row.innerHTML = `
    <label>Description<input data-line="description" value="${escapeHtml(item.description || "")}"></label>
    <label>Qty<input data-line="quantity" type="number" step="0.01" value="${item.quantity || ""}"></label>
    <label>Rate<input data-line="rate" type="number" step="0.01" value="${item.rate || ""}"></label>
    <label>Amount<input data-line="amount" type="number" step="0.01" value="${item.amount || ""}"></label>
    <button class="removeButton" type="button" title="Remove line" aria-label="Remove line">&times;</button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#lineItems").appendChild(row);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function renderReview() {
  const invoice = selectedInvoice();
  $("#emptyState").hidden = Boolean(invoice);
  $("#reviewPane").hidden = !invoice;
  if (!invoice) {
    renderAudit();
    return;
  }

  const f = invoice.fields || {};
  setInput("supplier", f.supplier);
  setInput("invoiceNumber", f.invoiceNumber);
  setInput("invoiceDate", f.invoiceDate);
  setInput("gstin", f.gstin);
  setInput("taxableAmount", f.taxableAmount);
  setInput("cgst", f.cgst);
  setInput("sgst", f.sgst);
  setInput("igst", f.igst);
  setInput("totalAmount", f.totalAmount);
  setInput("reviewer", invoice.review?.reviewer);
  setInput("notes", invoice.review?.notes);

  $("#invoiceMeta").textContent = `${invoice.originalName} | ${invoice.extractionMode} | OCR ${invoice.confidence?.ocrOverall ?? 0}%`;
  $("#statusPill").textContent = statusLabel(invoice.status);
  $("#statusPill").classList.toggle("approved", invoice.status === "approved");
  $("#originalLink").href = `/api/invoices/${invoice.id}/original`;
  $("#originalFrame").src = `/api/invoices/${invoice.id}/original`;
  $("#rawText").textContent = invoice.rawText || "";

  $$("[data-confidence]").forEach(node => {
    const key = node.getAttribute("data-confidence");
    const score = invoice.confidence?.[key] ?? 0;
    node.textContent = `Confidence ${score}%`;
    node.classList.toggle("highConfidence", score >= 80);
    node.classList.toggle("lowConfidence", score < 60);
  });

  renderValidation(invoice);
  renderLineItems(f.lineItems || []);
  renderExports(invoice);
  renderAudit();
}

function renderExports(invoice) {
  const approved = invoice.status === "approved";
  for (const [id, format] of [["exportXml", "xml"], ["exportCsv", "csv"], ["exportJson", "json"]]) {
    const link = $(`#${id}`);
    link.href = approved ? `/api/invoices/${invoice.id}/${format}` : "#";
    link.classList.toggle("disabled", !approved);
  }
}

function renderMappings() {
  const m = state.mappings || {};
  $("#defaultPurchaseLedger").value = m.defaultPurchaseLedger || "";
  $("#defaultCgstLedger").value = m.defaultTaxLedgers?.cgst || "";
  $("#defaultSgstLedger").value = m.defaultTaxLedgers?.sgst || "";
  $("#defaultIgstLedger").value = m.defaultTaxLedgers?.igst || "";
  const container = $("#supplierMappings");
  container.innerHTML = "";
  const suppliers = m.suppliers || {};
  const entries = Object.entries(suppliers);
  if (!entries.length) addMappingRow();
  for (const [key, value] of entries) addMappingRow({ key, ...value });
}

function addMappingRow(mapping = {}) {
  const row = document.createElement("div");
  row.className = "mappingRow";
  row.innerHTML = `
    <label>Supplier or GSTIN<input data-map="key" value="${escapeHtml(mapping.key || "")}" placeholder="GSTIN or supplier name"></label>
    <label>Party ledger<input data-map="partyLedger" value="${escapeHtml(mapping.partyLedger || "")}"></label>
    <label>Purchase ledger<input data-map="purchaseLedger" value="${escapeHtml(mapping.purchaseLedger || "")}"></label>
    <button class="removeButton" type="button" title="Remove mapping" aria-label="Remove mapping">&times;</button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#supplierMappings").appendChild(row);
}

function collectMappings() {
  const suppliers = {};
  $$("#supplierMappings .mappingRow").forEach(row => {
    const key = row.querySelector('[data-map="key"]').value.trim();
    if (!key) return;
    suppliers[key] = {
      partyLedger: row.querySelector('[data-map="partyLedger"]').value.trim(),
      purchaseLedger: row.querySelector('[data-map="purchaseLedger"]').value.trim()
    };
  });
  return {
    defaultPurchaseLedger: $("#defaultPurchaseLedger").value.trim() || "Purchase Accounts",
    defaultTaxLedgers: {
      cgst: $("#defaultCgstLedger").value.trim() || "Input CGST",
      sgst: $("#defaultSgstLedger").value.trim() || "Input SGST",
      igst: $("#defaultIgstLedger").value.trim() || "Input IGST"
    },
    defaultPaymentMode: "On Account",
    suppliers
  };
}

function renderAudit() {
  const invoice = selectedInvoice();
  const container = $("#auditTrail");
  if (!invoice) {
    container.innerHTML = '<div class="message">Select an invoice to inspect its audit trail.</div>';
    return;
  }
  container.innerHTML = "";
  for (const event of invoice.auditTrail || []) {
    const item = document.createElement("div");
    item.className = "auditItem";
    item.innerHTML = `<strong>${escapeHtml(event.action)}</strong><time>${escapeHtml(event.at)}</time><pre>${escapeHtml(JSON.stringify(event.details || {}, null, 2))}</pre>`;
    container.appendChild(item);
  }
}

async function saveReview() {
  const invoice = selectedInvoice();
  if (!invoice) return;
  const updated = await api(`/api/invoices/${invoice.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(getReviewPayload())
  });
  state.invoices = state.invoices.map(item => item.id === updated.id ? updated : item);
  renderInvoices();
  renderReview();
  toast("Review saved");
}

async function approveInvoice() {
  const invoice = selectedInvoice();
  if (!invoice) return;
  const updated = await api(`/api/invoices/${invoice.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(getReviewPayload())
  });
  state.invoices = state.invoices.map(item => item.id === updated.id ? updated : item);
  renderInvoices();
  renderReview();
  toast("Approved for export only");
}

async function uploadForm(formData) {
  setServiceStatus("Extracting invoice", "working");
  const invoice = await api("/api/invoices", { method: "POST", body: formData });
  state.invoices.unshift(invoice);
  state.selectedId = invoice.id;
  renderInvoices();
  renderReview();
  setServiceStatus("Local service ready");
  $("#fileInput").value = "";
  $("#fileSelection").hidden = true;
  toast("OCR extraction complete");
}

async function startCamera() {
  state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  $("#cameraVideo").srcObject = state.stream;
  await $("#cameraVideo").play();
  $("#videoWrap").hidden = false;
  $("#startCamera").hidden = true;
  $("#capturePhoto").hidden = false;
  $("#capturePhoto").disabled = false;
}

async function capturePhoto() {
  const video = $("#cameraVideo");
  const canvas = $("#captureCanvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png", 0.95));
  const formData = new FormData();
  formData.append("document", blob, `camera-${Date.now()}.png`);
  await uploadForm(formData);
}

function bindEvents() {
  $("#fileInput").addEventListener("change", event => {
    const file = event.target.files[0];
    const selection = $("#fileSelection");
    selection.hidden = !file;
    selection.textContent = file ? `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)` : "";
  });

  $("#uploadForm").addEventListener("submit", async event => {
    event.preventDefault();
    const file = $("#fileInput").files[0];
    if (!file) return toast("Choose an invoice image or PDF");
    const formData = new FormData();
    formData.append("document", file, file.name);
    try {
      await uploadForm(formData);
    } catch (error) {
      setServiceStatus("Local service ready");
      toast(error.message);
    }
  });

  $("#startCamera").addEventListener("click", () => startCamera().catch(error => toast(error.message)));
  $("#capturePhoto").addEventListener("click", () => capturePhoto().catch(error => toast(error.message)));
  $("#refreshInvoices").addEventListener("click", () => loadAll().catch(error => toast(error.message)));
  $("#saveReview").addEventListener("click", () => saveReview().catch(error => toast(error.message)));
  $("#approveInvoice").addEventListener("click", () => approveInvoice().catch(error => toast(error.message)));
  $("#addLineItem").addEventListener("click", () => addLineItem());
  $("#toggleRaw").addEventListener("click", event => {
    const raw = $("#rawText");
    raw.hidden = !raw.hidden;
    event.target.textContent = raw.hidden ? "Show" : "Hide";
  });

  $$(".filters button").forEach(button => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      $$(".filters button").forEach(item => item.classList.toggle("active", item === button));
      renderInvoices();
    });
  });

  $$(".tabs button").forEach(button => {
    button.addEventListener("click", () => {
      $$(".tabs button").forEach(item => item.classList.toggle("active", item === button));
      $$(".tabView").forEach(view => view.classList.remove("active"));
      $(`#${button.dataset.tab}Tab`).classList.add("active");
      if (button.dataset.tab === "audit") renderAudit();
    });
  });

  $("#addMapping").addEventListener("click", () => addMappingRow());
  $("#saveMappings").addEventListener("click", async () => {
    state.mappings = await api("/api/mappings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectMappings())
    });
    toast("Mappings saved");
  });
}

bindEvents();
loadAll().catch(error => {
  setServiceStatus("Service error", "error");
  toast(error.message);
});
