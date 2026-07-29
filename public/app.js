const state = {
  invoices: [],
  selectedId: null,
  filter: "all",
  mappings: null,
  stream: null,
  activeTab: new URLSearchParams(window.location.search).get("view") || "dashboard"
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric"
});

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  window.clearTimeout(toast.timeout);
  toast.timeout = window.setTimeout(() => node.classList.remove("show"), 3200);
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
  return currencyFormatter.format(Number(value || 0));
}

function formattedDate(value) {
  if (!value) return "Date not found";
  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : value;
}

function statusLabel(status) {
  return {
    approved: "Approved",
    pending_review: "Pending Review",
    needs_correction: "Needs Correction",
    rejected: "Rejected"
  }[status] || "Pending Review";
}

function statusClass(status) {
  return {
    approved: "approved",
    needs_correction: "correction",
    rejected: "rejected"
  }[status] || "review";
}

function setServiceStatus(message, stateName = "ready") {
  const node = $("#serviceStatus");
  node.innerHTML = '<span class="statusDot"></span>';
  node.append(document.createTextNode(message));
  node.dataset.state = stateName;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function switchTab(tabName, updateUrl = true) {
  const nextTab = $(`#${tabName}Tab`) ? tabName : "dashboard";
  state.activeTab = nextTab;
  $$(".tabs button").forEach(button => button.classList.toggle("active", button.dataset.tab === nextTab));
  $$(".tabView").forEach(view => view.classList.toggle("active", view.id === `${nextTab}Tab`));

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextTab);
    if (state.selectedId) url.searchParams.set("invoice", state.selectedId);
    window.history.replaceState({}, "", url);
  }

  if (nextTab === "audit") renderAudit();
  if (nextTab === "dashboard") renderDashboard();
  refreshIcons();
}

function focusWorkspaceOnMobile() {
  if (window.matchMedia("(max-width: 780px)").matches) {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    $(".workspace").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }
}

async function loadAll() {
  const [health, invoices, mappings] = await Promise.all([
    api("/api/health"),
    api("/api/invoices"),
    api("/api/mappings")
  ]);
  setServiceStatus(health.ok ? "Local Service Ready" : "Service Unavailable", health.ok ? "ready" : "error");
  state.invoices = invoices;
  state.mappings = mappings;

  const requestedId = new URLSearchParams(window.location.search).get("invoice");
  if (requestedId && invoices.some(invoice => invoice.id === requestedId)) state.selectedId = requestedId;
  if (!state.selectedId && invoices[0]) state.selectedId = invoices[0].id;

  renderInvoices();
  renderDashboard();
  renderReview();
  renderMappings();
  switchTab(state.activeTab, false);
  refreshIcons();
}

function filteredInvoices() {
  if (state.filter === "all") return state.invoices;
  if (state.filter === "pending_review") {
    return state.invoices.filter(invoice => ["pending_review", "needs_correction"].includes(invoice.status));
  }
  return state.invoices.filter(invoice => invoice.status === state.filter);
}

function renderInvoices() {
  const list = $("#invoiceList");
  const invoices = filteredInvoices();
  const pendingCount = state.invoices.filter(invoice => ["pending_review", "needs_correction"].includes(invoice.status)).length;
  const approvedCount = state.invoices.filter(invoice => invoice.status === "approved").length;
  $("#queueCount").textContent = state.invoices.length;
  $("#allCount").textContent = state.invoices.length;
  $("#reviewCount").textContent = pendingCount;
  $("#approvedCount").textContent = approvedCount;
  list.innerHTML = invoices.length ? "" : '<div class="message">No invoices in this view.</div>';

  for (const invoice of invoices) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `invoiceCard ${invoice.id === state.selectedId ? "active" : ""}`;
    const fields = invoice.fields || {};
    const issueCount = (invoice.validation?.errors?.length || 0) + (invoice.validation?.warnings?.length || 0);
    const status = statusClass(invoice.status);
    card.innerHTML = `
      <strong>${escapeHtml(fields.supplier || "Unknown Supplier")}</strong>
      <span class="invoiceNumber">${escapeHtml(fields.invoiceNumber || "No Invoice Number")}</span>
      <span class="invoiceAmount">${money(fields.totalAmount)}</span>
      <span class="invoiceMetaLine">${issueCount ? `${issueCount} issue${issueCount === 1 ? "" : "s"}` : "Checks Passed"}</span>
      <span class="queueStatus ${status}"><i data-lucide="${issueCount ? "circle-alert" : "circle-check"}" aria-hidden="true"></i>${statusLabel(invoice.status)}</span>
    `;
    card.addEventListener("click", () => {
      state.selectedId = invoice.id;
      renderInvoices();
      renderReview();
      switchTab("review");
      focusWorkspaceOnMobile();
    });
    list.appendChild(card);
  }
  refreshIcons();
}

function invoiceIssues(invoice) {
  return (invoice.validation?.errors?.length || 0) + (invoice.validation?.warnings?.length || 0);
}

function renderDashboard() {
  const invoices = state.invoices;
  const totalValue = invoices.reduce((sum, invoice) => sum + Number(invoice.fields?.totalAmount || 0), 0);
  const taxableValue = invoices.reduce((sum, invoice) => sum + Number(invoice.fields?.taxableAmount || 0), 0);
  const gstValue = invoices.reduce((sum, invoice) => {
    const fields = invoice.fields || {};
    return sum + Number(fields.cgst || 0) + Number(fields.sgst || 0) + Number(fields.igst || 0);
  }, 0);
  const approved = invoices.filter(invoice => invoice.status === "approved").length;
  const review = invoices.filter(invoice => invoice.status === "pending_review").length;
  const correction = invoices.filter(invoice => invoice.status === "needs_correction").length;
  const rejected = invoices.filter(invoice => invoice.status === "rejected").length;
  const exceptions = invoices.filter(invoice => invoiceIssues(invoice) > 0).length;
  const duplicates = invoices.filter(invoice => invoice.validation?.duplicateId).length;
  const approvalRate = invoices.length ? Math.round((approved / invoices.length) * 100) : 0;
  const averageConfidence = invoices.length
    ? Math.round(invoices.reduce((sum, invoice) => sum + Number(invoice.confidence?.ocrOverall || 0), 0) / invoices.length)
    : 0;
  const timeSaved = invoices.length * 8;

  $("#metricValue").textContent = money(totalValue);
  $("#metricValueNote").textContent = `Across ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`;
  $("#metricExceptions").textContent = exceptions;
  $("#metricExceptionsNote").textContent = exceptions ? `${exceptions} document${exceptions === 1 ? "" : "s"} need review` : "No Open Exceptions";
  $("#metricApproved").textContent = `${approvalRate}%`;
  $("#metricApprovedNote").textContent = `${approved} of ${invoices.length} invoices`;
  $("#metricTime").textContent = timeSaved < 60 ? `${timeSaved} min` : `${(timeSaved / 60).toFixed(1)} hrs`;
  $("#averageConfidence").textContent = `${averageConfidence}% Avg. Confidence`;
  $("#taxableSummary").textContent = money(taxableValue);
  $("#gstSummary").textContent = money(gstValue);
  $("#duplicateSummary").textContent = duplicates;

  const total = invoices.length || 1;
  $("#barApproved").style.width = `${(approved / total) * 100}%`;
  $("#barReview").style.width = `${(review / total) * 100}%`;
  $("#barCorrection").style.width = `${(correction / total) * 100}%`;
  $("#barRejected").style.width = `${(rejected / total) * 100}%`;
  $("#legendApproved").textContent = approved;
  $("#legendReview").textContent = review;
  $("#legendCorrection").textContent = correction;
  $("#legendRejected").textContent = rejected;

  const mappings = state.mappings || {};
  const companyReady = Boolean(mappings.companyName);
  const ledgersReady = Boolean(
    mappings.defaultPurchaseLedger &&
    mappings.defaultTaxLedgers?.cgst &&
    mappings.defaultTaxLedgers?.sgst &&
    mappings.defaultTaxLedgers?.igst
  );
  $("#readyCompany").textContent = companyReady ? "Yes" : "No";
  $("#readyLedgers").textContent = ledgersReady ? "Ready" : "Incomplete";
  $("#readyApproved").textContent = approved;
  const readiness = companyReady && ledgersReady;
  $("#tallyReadinessBadge").textContent = readiness ? "Export Ready" : "Setup Required";
  $("#tallyReadinessBadge").classList.toggle("ready", readiness);

  const recentRows = $("#recentInvoices");
  recentRows.innerHTML = "";
  for (const invoice of invoices.slice(0, 6)) {
    const fields = invoice.fields || {};
    const issues = invoiceIssues(invoice);
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><button class="tableLink" type="button">${escapeHtml(fields.supplier || "Unknown Supplier")}</button></td>
      <td>${escapeHtml(fields.invoiceNumber || "—")}</td>
      <td>${escapeHtml(formattedDate(fields.invoiceDate))}</td>
      <td><span class="tableCheck ${issues ? "issue" : "pass"}"><i data-lucide="${issues ? "circle-alert" : "circle-check"}" aria-hidden="true"></i>${issues ? `${issues} Issue${issues === 1 ? "" : "s"}` : "Passed"}</span></td>
      <td><span class="statusBadge ${statusClass(invoice.status)}">${statusLabel(invoice.status)}</span></td>
      <td class="numeric">${money(fields.totalAmount)}</td>
    `;
    row.querySelector(".tableLink").addEventListener("click", () => {
      state.selectedId = invoice.id;
      renderInvoices();
      renderReview();
      switchTab("review");
      focusWorkspaceOnMobile();
    });
    recentRows.appendChild(row);
  }
  if (!invoices.length) {
    recentRows.innerHTML = '<tr><td colspan="6" class="emptyCell">Add an invoice to begin the processing demo.</td></tr>';
  }
  refreshIcons();
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

function renderControlChecks(invoice) {
  const container = $("#controlChecks");
  let checks = invoice.validation?.checks || [];
  if (!checks.length) {
    const issues = invoiceIssues(invoice);
    checks = [{
      id: "legacy-validation",
      label: "Document Validation",
      status: issues ? "warn" : "pass",
      detail: issues ? "Review the listed exceptions." : "All available checks passed."
    }];
  }
  const passed = checks.filter(check => check.status === "pass").length;
  $("#controlScore").textContent = `${passed}/${checks.length} Passed`;
  container.innerHTML = checks.map(check => `
    <div class="controlCheck ${escapeHtml(check.status)}">
      <i data-lucide="${check.status === "pass" ? "circle-check" : check.status === "fail" ? "circle-x" : "triangle-alert"}" aria-hidden="true"></i>
      <span><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></span>
    </div>
  `).join("");
}

function renderValidation(invoice) {
  const box = $("#validationBox");
  const errors = invoice.validation?.errors || [];
  const warnings = invoice.validation?.warnings || [];
  box.innerHTML = "";
  if (!errors.length && !warnings.length) {
    box.innerHTML = '<div class="message ok"><i data-lucide="circle-check" aria-hidden="true"></i><span>Validation passed. Human review is still required before export.</span></div>';
    return;
  }
  for (const [type, messages] of [["error", errors], ["warn", warnings]]) {
    for (const message of messages) {
      const node = document.createElement("div");
      node.className = `message ${type}`;
      node.innerHTML = `<i data-lucide="${type === "error" ? "circle-x" : "triangle-alert"}" aria-hidden="true"></i><span>${escapeHtml(message)}</span>`;
      box.appendChild(node);
    }
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
    <label>Description<input data-line="description" autocomplete="off" value="${escapeHtml(item.description || "")}"></label>
    <label>Qty<input data-line="quantity" type="number" inputmode="decimal" step="0.01" autocomplete="off" value="${item.quantity || ""}"></label>
    <label>Rate<input data-line="rate" type="number" inputmode="decimal" step="0.01" autocomplete="off" value="${item.rate || ""}"></label>
    <label>Amount<input data-line="amount" type="number" inputmode="decimal" step="0.01" autocomplete="off" value="${item.amount || ""}"></label>
    <button class="removeButton" type="button" title="Remove line" aria-label="Remove line"><i data-lucide="trash-2" aria-hidden="true"></i></button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#lineItems").appendChild(row);
  refreshIcons();
}

function renderReview() {
  const invoice = selectedInvoice();
  $("#emptyState").hidden = Boolean(invoice);
  $("#reviewPane").hidden = !invoice;
  if (!invoice) {
    renderAudit();
    return;
  }

  const fields = invoice.fields || {};
  for (const name of ["supplier", "invoiceNumber", "invoiceDate", "gstin", "taxableAmount", "cgst", "sgst", "igst", "totalAmount"]) {
    setInput(name, fields[name]);
  }
  setInput("reviewer", invoice.review?.reviewer);
  setInput("notes", invoice.review?.notes);

  $("#invoiceMeta").textContent = `${invoice.originalName} · ${invoice.extractionMode} · OCR ${invoice.confidence?.ocrOverall ?? 0}%`;
  const pill = $("#statusPill");
  pill.textContent = statusLabel(invoice.status);
  pill.className = `pill ${statusClass(invoice.status)}`;
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

  renderControlChecks(invoice);
  renderValidation(invoice);
  renderLineItems(fields.lineItems || []);
  renderExports(invoice);
  renderAudit();
  refreshIcons();
}

function renderExports(invoice) {
  const approved = invoice.status === "approved";
  for (const [id, format] of [["exportXml", "xml"], ["exportCsv", "csv"], ["exportJson", "json"]]) {
    const link = $(`#${id}`);
    link.href = approved ? `/api/invoices/${invoice.id}/${format}` : "#";
    link.classList.toggle("disabled", !approved);
    link.setAttribute("aria-disabled", String(!approved));
  }
}

function renderMappings() {
  const mappings = state.mappings || {};
  $("#companyName").value = mappings.companyName || "";
  $("#voucherType").value = mappings.voucherType || "Purchase";
  $("#tallyUrl").value = mappings.tallyUrl || "http://127.0.0.1:9000";
  $("#defaultPurchaseLedger").value = mappings.defaultPurchaseLedger || "";
  $("#defaultCgstLedger").value = mappings.defaultTaxLedgers?.cgst || "";
  $("#defaultSgstLedger").value = mappings.defaultTaxLedgers?.sgst || "";
  $("#defaultIgstLedger").value = mappings.defaultTaxLedgers?.igst || "";
  const container = $("#supplierMappings");
  container.innerHTML = "";
  const entries = Object.entries(mappings.suppliers || {});
  if (!entries.length) addMappingRow();
  for (const [key, value] of entries) addMappingRow({ key, ...value });
}

function addMappingRow(mapping = {}) {
  const row = document.createElement("div");
  row.className = "mappingRow";
  row.innerHTML = `
    <label>Supplier Or GSTIN<input data-map="key" autocomplete="off" value="${escapeHtml(mapping.key || "")}" placeholder="GSTIN or supplier name…"></label>
    <label>Party Ledger<input data-map="partyLedger" autocomplete="off" value="${escapeHtml(mapping.partyLedger || "")}"></label>
    <label>Purchase Ledger<input data-map="purchaseLedger" autocomplete="off" value="${escapeHtml(mapping.purchaseLedger || "")}"></label>
    <button class="removeButton" type="button" title="Remove mapping" aria-label="Remove mapping"><i data-lucide="trash-2" aria-hidden="true"></i></button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#supplierMappings").appendChild(row);
  refreshIcons();
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
    companyName: $("#companyName").value.trim(),
    voucherType: $("#voucherType").value.trim() || "Purchase",
    tallyUrl: $("#tallyUrl").value.trim() || "http://127.0.0.1:9000",
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
  for (const event of [...(invoice.auditTrail || [])].reverse()) {
    const item = document.createElement("div");
    item.className = "auditItem";
    item.innerHTML = `
      <div class="auditIcon"><i data-lucide="history" aria-hidden="true"></i></div>
      <div>
        <strong>${escapeHtml(event.action.replaceAll("_", " "))}</strong>
        <time datetime="${escapeHtml(event.at)}">${escapeHtml(new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.at)))}</time>
        <pre>${escapeHtml(JSON.stringify(event.details || {}, null, 2))}</pre>
      </div>
    `;
    container.appendChild(item);
  }
  refreshIcons();
}

function replaceInvoice(updated) {
  state.invoices = state.invoices.map(invoice => invoice.id === updated.id ? updated : invoice);
  renderInvoices();
  renderDashboard();
  renderReview();
}

async function saveReview() {
  const invoice = selectedInvoice();
  if (!invoice) return;
  const updated = await api(`/api/invoices/${invoice.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(getReviewPayload())
  });
  replaceInvoice(updated);
  toast(updated.status === "pending_review" && invoice.status === "approved" ? "Saved. Approval was reset for re-review." : "Review Saved");
}

async function decideInvoice(action) {
  const invoice = selectedInvoice();
  if (!invoice) return;
  const updated = await api(`/api/invoices/${invoice.id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(getReviewPayload())
  });
  replaceInvoice(updated);
  toast({
    approve: "Approved For Export Only",
    "needs-correction": "Returned For Correction",
    reject: "Invoice Rejected"
  }[action]);
}

async function uploadForm(formData) {
  setServiceStatus("Extracting Invoice…", "working");
  const invoice = await api("/api/invoices", { method: "POST", body: formData });
  state.invoices.unshift(invoice);
  state.selectedId = invoice.id;
  renderInvoices();
  renderDashboard();
  renderReview();
  setServiceStatus("Local Service Ready");
  $("#fileInput").value = "";
  $("#fileSelection").hidden = true;
  switchTab("review");
  toast("OCR Extraction Complete");
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

async function testTallyConnection() {
  const button = $("#testTallyConnection");
  const message = $("#tallyConnectionMessage");
  button.disabled = true;
  button.innerHTML = '<span class="spinner" aria-hidden="true"></span>Testing Connection…';
  message.textContent = "Checking the local Tally HTTP service…";
  try {
    const result = await api("/api/tally/status");
    message.textContent = result.message;
    message.className = `connectionMessage ${result.connected ? "connected" : "notConnected"}`;
  } finally {
    button.disabled = false;
    button.innerHTML = '<i data-lucide="plug-zap" aria-hidden="true"></i>Test Tally Connection';
    refreshIcons();
  }
}

function bindEvents() {
  $("#fileInput").addEventListener("change", event => {
    const file = event.target.files[0];
    const selection = $("#fileSelection");
    selection.hidden = !file;
    selection.textContent = file ? `${file.name} (${Math.max(1, Math.round(file.size / 1024))}\u00A0KB)` : "";
  });

  $("#uploadForm").addEventListener("submit", async event => {
    event.preventDefault();
    const file = $("#fileInput").files[0];
    if (!file) return toast("Choose An Invoice Image Or PDF");
    const formData = new FormData();
    formData.append("document", file, file.name);
    try {
      await uploadForm(formData);
    } catch (error) {
      setServiceStatus("Local Service Ready");
      toast(error.message);
    }
  });

  $("#startCamera").addEventListener("click", () => startCamera().catch(error => toast(error.message)));
  $("#capturePhoto").addEventListener("click", () => capturePhoto().catch(error => toast(error.message)));
  $("#refreshInvoices").addEventListener("click", () => loadAll().catch(error => toast(error.message)));
  $("#saveReview").addEventListener("click", () => saveReview().catch(error => toast(error.message)));
  $("#approveInvoice").addEventListener("click", () => decideInvoice("approve").catch(error => toast(error.message)));
  $("#returnInvoice").addEventListener("click", () => decideInvoice("needs-correction").catch(error => toast(error.message)));
  $("#rejectInvoice").addEventListener("click", () => decideInvoice("reject").catch(error => toast(error.message)));
  $("#addLineItem").addEventListener("click", () => addLineItem());
  $("#testTallyConnection").addEventListener("click", () => testTallyConnection().catch(error => toast(error.message)));
  $("#toggleRaw").addEventListener("click", event => {
    const raw = $("#rawText");
    raw.hidden = !raw.hidden;
    event.currentTarget.textContent = raw.hidden ? "Show" : "Hide";
  });

  $$(".filters button").forEach(button => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      $$(".filters button").forEach(item => item.classList.toggle("active", item === button));
      renderInvoices();
    });
  });

  $$(".tabs button").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  $$("[data-go-tab]").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.goTab)));

  $("#addMapping").addEventListener("click", () => addMappingRow());
  $("#saveMappings").addEventListener("click", async () => {
    state.mappings = await api("/api/mappings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectMappings())
    });
    renderDashboard();
    toast("Tally Setup Saved");
  });
}

bindEvents();
refreshIcons();
loadAll().catch(error => {
  setServiceStatus("Service Error", "error");
  toast(error.message);
});
