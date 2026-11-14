// Run after a build with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3120.
// Exercises real Next routes against an isolated storage/database stub; never sends messages.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { PDFDocument } from "pdf-lib";
import { PDFParse } from "pdf-parse";
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ? process.env.PLAYWRIGHT_PATH + "/index.mjs" : "playwright");
const base = "http://127.0.0.1:3119", backend = "http://127.0.0.1:3120";
const advisorId = randomUUID();
const profile = { id: advisorId, staff_id: "advisor01", full_name: "Test Advisor", role: "service_advisor", active: true, must_change_password: false };
const session = "a".repeat(43), hash = createHash("sha256").update(session).digest("hex");
const source = await PDFDocument.create();
for (const text of ["CUSTOMER ALPHA", "ALPHA CONTINUATION", "CUSTOMER BRAVO"]) source.addPage().drawText(text);
const original = Buffer.from(await source.save());
const storage = new Map([["test.pdf", original]]), signedLinks = new Map(), mappings = new Map();
const codeHash = link => createHash("sha256").update(new URL(link).pathname.slice(3)).digest("hex");
const bills = [], uploads = [], audit = [];
let confirms = 0, preparations = 0, failMappings = true, storageUploads = 0, failBill = null, failConfirm = null, failLookup = false, failStorage = false, redirectStorage = false, storageReads = 0, mappingReads = 0, streamFinished = false;
function draft(name, from, to) {
  const upload = { id: randomUUID(), original_filename: name + ".pdf", storage_path: "test.pdf", confirmed_at: null, file_hash: createHash("sha256").update(name).digest("hex"), status: "review" };
  const bill = { id: randomUUID(), upload_id: upload.id, uploaded_by: advisorId, customer_name: name, customer_reference: name, customer_id: name, customer_phone: null, token_number: null, invoice_reference: "INV-" + name, vehicle_no_display: "KL01AB1234", vin: "", invoice_date: "2026-11-11", amount_paise: 10000, approval_status: "pending", approved_at: null, approved_by: null, created_at: new Date().toISOString(), page_from: from, page_to: to, amount_evidence: "Total 100", extraction_issues: [], payment_evidence: [], uploads: upload };
  uploads.push(upload); bills.push(bill); return bill;
}
const alpha = draft("ALPHA", 1, 2);
// Exercise the existing advisor submission/retry/popup fallback with a no-amount note.
Object.assign(alpha, { amount_paise: null, amount_evidence: "No monetary total stated; supporting note", field_confidence: { document: { kind: "warranty_note" } } });
const snapshot = () => ({ bills, drafts: uploads.filter(u => !u.confirmed_at).map(u => ({ ...u, bills: bills.filter(b => b.upload_id === u.id) })), staff: [profile], payments: [], audit, as_of: new Date().toISOString() });
const json = (res, body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const bytes = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, backend), path = decodeURIComponent(url.pathname);
    if (path === "/rest/v1/customer_bill_links") {
      assert.equal(req.headers.authorization, "Bearer isolated-test-key");
      if (req.method === "POST") {
        const rows = JSON.parse(await bytes(req));
        if (failMappings || rows.some(row => row.bill_id === failBill)) return json(res, { message: "Synthetic mapping failure" }, 503);
        for (const row of rows) {
          assert.deepEqual(Object.keys(row).sort(), ["bill_id", "code_hash", "expires_at", "storage_path"]);
          assert.match(row.code_hash, /^[a-f0-9]{64}$/);
          assert(!mappings.has(row.code_hash));
          assert(storage.has(row.storage_path));
          assert(Math.abs(Date.parse(row.expires_at) - Date.now() - 7 * 86400000) < 10000);
        }
        for (const row of rows) mappings.set(row.code_hash, row);
        return json(res, null, 201);
      }
      mappingReads++;
      if (failLookup) return json(res, { message: "Sensitive database error" }, 503);
      return json(res, mappings.get(url.searchParams.get("code_hash")?.slice(3)) || null);
    }
    if (path === "/rest/v1/staff_sessions") return json(res, url.searchParams.get("token_hash") === "eq." + hash ? { staff_id: profile.id, profiles: profile } : null);
    if (path === "/rest/v1/rpc/app_desk_snapshot") return json(res, snapshot());
    if (path === "/rest/v1/uploads") return json(res, snapshot().drafts);
    if (path === "/rest/v1/bills") {
      if (url.searchParams.get("id")?.startsWith("in.(")) {
        const ids = url.searchParams.get("id").slice(4, -1).split(',');
        return json(res, bills.filter(b => ids.includes(b.id) && "eq." + b.uploaded_by === url.searchParams.get("uploaded_by")));
      }
      if (url.searchParams.has("customer_id")) {
        assert.equal(url.searchParams.get("uploaded_by"), "eq." + advisorId);
        assert.equal(url.searchParams.get("uploads.confirmed_at"), "not.is.null");
        return json(res, bills.filter(b => "eq." + b.customer_id === url.searchParams.get("customer_id") && "eq." + b.uploaded_by === url.searchParams.get("uploaded_by") && b.uploads.confirmed_at));
      }
      const bill = bills.find(b => "eq." + b.id === url.searchParams.get("id") && (!url.searchParams.has("uploaded_by") || "eq." + b.uploaded_by === url.searchParams.get("uploaded_by")));
      return json(res, bill || null);
    }
    if (path === "/rest/v1/rpc/app_confirm_upload") {
      const body = JSON.parse(await bytes(req));
      const upload = uploads.find(u => u.id === body.target);
      if (upload.id === failConfirm) return json(res, { code: "P0001", message: "Synthetic submission failure" }, 400);
      assert.equal(body.require_token, true, "Deployment setting must reach the server RPC");
      if (upload.confirmed_at) return json(res, upload);
      const rows = bills.filter(b => b.upload_id === upload.id);
      if (rows.some(b => !body.tokens[b.id])) return json(res, { code: "22023", message: "Token number is required for every bill at this branch" }, 400);
      for (const bill of rows) {
        assert.equal(typeof body.contacts[bill.id].skipWhatsApp, "boolean");
        bill.token_number = body.tokens[bill.id]; bill.customer_phone = body.contacts[bill.id].phone;
      }
      confirms++; upload.confirmed_at = new Date().toISOString(); upload.status = "confirmed";
      return json(res, upload);
    }
    if (path === "/rest/v1/rpc/app_prepare_whatsapp") {
      const body = JSON.parse(await bytes(req)), bill = bills.find(b => b.id === body.target);
      assert.equal(body.staff, advisorId); assert.ok(bill.uploads.confirmed_at);
      assert.equal(body.expires_at, null);
      if (failMappings) return json(res, {message: "Synthetic preparation failure"}, 503);
      bill.customer_phone = body.phone; preparations++;
      audit.push({ id: randomUUID(), bill_id: bill.id, actor_id: advisorId, action: "whatsapp_prepared", detail: {}, created_at: new Date().toISOString() });
      return json(res, null);
    }
    const signPrefix = "/storage/v1/object/sign/bills/";
    if (path.startsWith(signPrefix)) {
      const key = path.slice(signPrefix.length);
      if (req.method === "POST") {
        const body = JSON.parse(await bytes(req));
        assert(!key.startsWith("customer-copies/"), "Customer URLs must never be signed");
        const token = randomUUID(); signedLinks.set(token, { key, expiresAt: Date.now() + body.expiresIn * 1000 });
        return json(res, { signedURL: "/object/sign/bills/" + key + "?token=" + token });
      }
      const link = signedLinks.get(url.searchParams.get("token"));
      if (!link || link.key !== key || link.expiresAt <= Date.now()) return json(res, { error: "Expired or invalid link" }, 403);
      res.writeHead(200, { "Content-Type": "application/pdf" }); return res.end(storage.get(key));
    }
    const objectPrefix = "/storage/v1/object/bills/";
    if (path.startsWith(objectPrefix)) {
      if (req.headers.authorization !== "Bearer isolated-test-key") return json(res, { error: "Private storage" }, 403);
      const key = path.slice(objectPrefix.length);
      if (failBill && key.includes(failBill)) return json(res, {message: "Synthetic copy failure"}, 503);
      if (req.method === "POST") { assert(!storage.has(key)); storage.set(key, await bytes(req)); storageUploads++; return json(res, { Key: "bills/" + key }); }
      storageReads++;
      if (failStorage) return json(res, { message: "Private storage failure: " + key }, 503);
      if (redirectStorage) { res.writeHead(302, { Location: backend + "/private-target" }); return res.end(); }
      if (!storage.has(key)) return json(res, { statusCode: "404", message: "Not found" }, 404);
      res.writeHead(200, { "Content-Type": "application/pdf", "X-Storage-Path": key, "Content-Location": backend + path });
      if (req.method === "HEAD") return res.end();
      if (storage.get(key).length > 4.5 * 1024 * 1024) {
        const body = storage.get(key);
        streamFinished = false;
        res.write(body.subarray(0, 1024));
        setTimeout(() => { streamFinished = true; res.end(body.subarray(1024)); }, 1000);
        return;
      }
      return res.end(storage.get(key));
    }
    throw new Error("Unexpected backend request: " + req.method + " " + path);
  } catch (error) { console.error(error); json(res, { message: error.message }, 500); }
});
await new Promise(resolve => server.listen(3120, "127.0.0.1", resolve));
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--port", "3119", "--hostname", "127.0.0.1"], { env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: backend, SUPABASE_SERVICE_ROLE_KEY: "isolated-test-key", SERVICE_DESK_DEMO: "false", BILLDESK_REQUIRE_TOKEN: "true", BILLDESK_PUBLIC_URL: base }, stdio: ["ignore", "pipe", "pipe"] });
let appLogs = ""; app.stdout.on("data", b => { appLogs += b; }); app.stderr.on("data", b => { appLogs += b; });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
// Intercept the handoff itself: no contact with WhatsApp and no message delivery.
const handoffs = [];
await context.route("https://wa.me/**", route => { handoffs.push(route.request().url()); return route.fulfill({ body: "WhatsApp handoff intercepted" }); });
const page = await context.newPage(), errors = [];
page.on("pageerror", e => errors.push(e.message));
const post = (path, body, cookie = session, origin = base) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: "billdesk_session=" + cookie }, body: JSON.stringify(body) });
const sharing = `/api/bills/${alpha.id}/whatsapp`;
await page.addLocatorHandler(page.locator('.sd-operation[data-outcome="failure"][open]'), async dialog => {
  assert.equal(await dialog.locator('.sd-operation-tick').count(), 0, 'Failed outcomes never show a success tick');
  await dialog.getByRole('button', {name:'Continue',exact:true}).click();
});
// Isolate each historical fixture while retaining the active partial-batch recovery record.
const reload = async () => { await page.evaluate(() => { for (const key of Object.keys(sessionStorage)) if (key.startsWith('desk-shared-batches:')) sessionStorage.removeItem(key); }); await page.reload(); };
const closedUpload = () => page.getByRole('dialog', {name:'Upload and review bills'}).waitFor({state:'hidden'});
const settled = () => page.waitForFunction(() => !document.querySelector('.sd-operation[open], .sd-operation-inline'));
const click = name => page.getByRole("button", { name, exact: true }).click();
try {
  for (let n = 0; n < 100; n++) { try { if ((await fetch(base)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal((await post(sharing, { customerPhone: "9876543210" }, "invalid")).status, 401);
  assert.equal((await post(sharing, { customerPhone: "bad" })).status, 400);
  assert.equal((await post(sharing, { customerPhone: "9876543210" })).status, 409);
  const confirmation = `/api/uploads/${alpha.upload_id}/confirm`;
  assert.equal((await post(confirmation, { tokens: {} })).status, 400);
  assert.equal((await post(confirmation, { tokens: {}, contacts: { [alpha.id]: { phone: "9876543210", skipWhatsApp: false } }, require_token: false })).status, 400, "The client cannot disable the deployment token requirement");
  assert.equal((await post(sharing, { customerPhone: "9876543210" }, session, "https://external.test")).status, 403);
  profile.role = "cashier";
  assert.equal((await post(sharing, { customerPhone: "9876543210" })).status, 403);
  profile.role = "service_advisor"; profile.id = randomUUID();
  assert.equal((await post(sharing, { customerPhone: "9876543210" })).status, 404);
  profile.id = advisorId;
  await context.addCookies([{ name: "billdesk_session", value: session, url: base, httpOnly: true }]);
  await page.goto(base); await click("Upload bills (1)");
  await page.getByLabel("Customer WhatsApp number").fill("bad");
  await click("Submit & prepare PDFs");
  await page.getByText("Token number is required for every bill at this branch", { exact: true }).last().waitFor();
  await page.getByLabel("Token number (required)").fill("0012");
  await click("Submit & prepare PDFs");
  await page.getByText("Enter a valid customer WhatsApp number with country code", { exact: true }).last().waitFor();
  assert.equal(confirms, 0);
  await page.getByLabel("Customer WhatsApp number").fill("9876543210");
  await click("Submit & prepare PDFs");
  await closedUpload();
  await page.locator('.sd-sharing-queue').getByText(/Bills submitted; PDF preparation failed/).waitFor();
  assert.equal(confirms, 1); assert.equal(preparations, 0); assert.ok(alpha.uploads.confirmed_at);
  assert.equal(storageUploads, 1); assert.equal(handoffs.length, 0);
  // Reproduce a deployment that omitted the route and serves an HTML 404 page.
  const missingRoute = "**/api/bills/*/whatsapp";
  await page.route(missingRoute, route => route.fulfill({ status: 404, contentType: "text/html", body: "<!DOCTYPE html><html>Not found</html>" }));
  await click("Prepare PDFs");
  await page.locator(".sd-sharing-queue").getByText(/This action is unavailable on the server \(HTTP 404\)/).waitFor();
  assert.doesNotMatch(await page.locator(".sd-notice").last().innerText(), /Unexpected token|DOCTYPE/);
  assert.equal(confirms, 1); assert.equal(preparations, 0); assert.equal(handoffs.length, 0);
  await page.unroute(missingRoute);
  failMappings = false;
  // Block popups to verify the visible handoff link still works.
  await page.evaluate(() => { window.open = () => null; });
  await click("Prepare PDFs");
  const fallback = page.getByRole("link", { name: "Open customer chat", exact: true });
  await fallback.waitFor();
  assert.equal(await fallback.innerText(), "Open customer chat", "Prepared messages keep a visible fallback label");
  assert.equal(await fallback.locator("svg").count(), 1);

  assert.equal(await page.locator(".sd-whatsapp textarea, .sd-whatsapp [contenteditable=true]").count(), 0, "The preset stays read-only");
  assert.equal(confirms, 1); assert.equal(preparations, 1); assert.equal(storageUploads, 1);
  const whatsapp = new URL(await fallback.getAttribute("href"));
  assert.equal(whatsapp.pathname, "/919876543210");
  const message = whatsapp.searchParams.get("text"); assert.match(message, /Token number: 0012/); assert.match(message, /Thank you, Test Advisor/);
  assert.doesNotMatch(message, /https?:|within 7 days/);
  const attachmentUrl = await page.getByRole("link", {name:"Download PDF 1",exact:true}).getAttribute("href");
  assert.equal((await fetch(base + attachmentUrl)).status, 401);
  const attachmentFetch = () => fetch(base + attachmentUrl, {headers:{Cookie:"billdesk_session=" + session}});
  profile.role = 'cashier'; assert.equal((await attachmentFetch()).status,403); profile.role = 'service_advisor';
  alpha.uploaded_by = randomUUID(); assert.equal((await attachmentFetch()).status,404); alpha.uploaded_by = advisorId;
  const confirmedAt = alpha.uploads.confirmed_at;
  alpha.uploads.confirmed_at = null; assert.equal((await attachmentFetch()).status,409); alpha.uploads.confirmed_at = confirmedAt;
  const download = await attachmentFetch(); assert.equal(download.status, 200);
  const parser = new PDFParse({ data: new Uint8Array(await download.arrayBuffer()) });
  try { const text = (await parser.getText()).text; assert.match(text, /ALPHA CONTINUATION/); assert.doesNotMatch(text, /BRAVO/); } finally { await parser.destroy(); }
  assert.equal((await fetch(backend + "/storage/v1/object/bills/test.pdf")).status, 403);
  const privateResponse = response => {
    assert.equal(response.redirected, false);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("content-location"), null);
    assert.equal(response.headers.get("x-storage-path"), null);
    assert.match(response.headers.get("cache-control"), /private.*no-store/);
    assert.match(response.headers.get("x-robots-tag"), /noindex/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.doesNotMatch(JSON.stringify([...response.headers]), /customer-copies|isolated-test-key|3120|supabase/);
  };
  privateResponse(download);
  assert.match(download.headers.get("content-disposition"), /^attachment; filename="INV-ALPHA-/);
  assert.equal(mappings.size, 0, "Attachment preparation must never create public links");
  // Seed a previously issued legacy link; it must remain usable until its expiry.
  const link = base + "/b/" + randomBytes(16).toString("base64url");
  const copyPath = [...storage.keys()].find(path => path.includes(alpha.id));
  const savedCopy = storage.get(copyPath); storage.delete(copyPath);
  assert.equal((await attachmentFetch()).status,404); storage.set(copyPath,savedCopy);
  mappings.set(codeHash(link), {storage_path:copyPath, expires_at:new Date(Date.now()+86400000).toISOString()});
  for (const method of ["HEAD", "GET", "GET"]) {
    const response = await fetch(link, { method });
    assert.equal(response.status, 200); privateResponse(response);
    assert.equal((await response.arrayBuffer()).byteLength > 0, method !== "HEAD");
  }
  // A fresh browser with no staff cookie fetches only BillDesk, including its PDF bytes.
  const customerContext = await browser.newContext();
  const customerPage = await customerContext.newPage(), customerRequests = [];
  customerPage.on("request", req => customerRequests.push(req.url()));
  await customerPage.goto(base + "/b/invalid");
  assert.equal(await customerPage.evaluate(async url => (await fetch(url)).status, link), 200);
  assert(customerRequests.every(url => new URL(url).origin === base));
  await customerContext.close();
  const readsBeforeInvalid = storageReads, lookupsBeforeInvalid = mappingReads;
  assert.equal((await fetch(base + "/b/invalid")).status, 404);
  assert.equal(mappingReads, lookupsBeforeInvalid);
  const altered = link.slice(0, -22) + (link.at(-22) === "A" ? "B" : "A") + link.slice(-21);
  assert.equal((await fetch(altered)).status, 404);
  mappings.get(codeHash(link)).expires_at = new Date(Date.now() - 1).toISOString();
  for (const method of ["GET", "HEAD"]) {
    const expired = await fetch(link, { method });
    assert.equal(expired.status, 410); privateResponse(expired);
  }
  assert.equal(storageReads, readsBeforeInvalid, "Invalid/expired codes never reach storage");
  mappings.get(codeHash(link)).expires_at = new Date(Date.now() + 7 * 86400000).toISOString();
  for (const failure of ["database", "storage", "redirect"]) {
    failLookup = failure === "database"; failStorage = failure === "storage"; redirectStorage = failure === "redirect";
    if (failure !== "database") {
      const attachmentFailure = await attachmentFetch(); assert.equal(attachmentFailure.status,503);
      privateResponse(attachmentFailure);
      assert.doesNotMatch(await attachmentFailure.text(), /customer-copies|3120|isolated-test-key/);
    }
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(link, { method });
      assert.equal(response.status, 503); privateResponse(response);
      assert.doesNotMatch(await response.text(), /Sensitive|customer-copies|3120|supabase|isolated-test-key/);
    }
  }
  failLookup = false; failStorage = false; redirectStorage = false;
  // Valid PDF with an uncompressed synthetic attachment exceeds Vercel's buffered limit.
  const largePdf = await PDFDocument.create(); largePdf.addPage().drawText("SYNTHETIC LARGE BILL");
  await largePdf.attach(randomBytes(5 * 1024 * 1024), "synthetic.bin");
  const largeBytes = Buffer.from(await largePdf.save());
  assert(largeBytes.length > 4.5 * 1024 * 1024);
  const mappedPath = mappings.get(codeHash(link)).storage_path, savedPdf = storage.get(mappedPath);
  storage.set(mappedPath, largeBytes);
  const largeResponse = await attachmentFetch(); privateResponse(largeResponse);
  assert.equal(largeResponse.status, 200);
  const reader = largeResponse.body.getReader(), firstChunk = await reader.read();
  assert.equal(streamFinished, false, "Customer receives bytes before the upstream finishes");
  const chunks = [Buffer.from(firstChunk.value)];
  for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(Buffer.from(next.value)); }
  assert.deepEqual(Buffer.concat(chunks), largeBytes);
  storage.set(mappedPath, savedPdf);
  await page.getByLabel("Customer WhatsApp number").fill("+44 7700 900123");
  assert.equal(await fallback.count(), 0, "Correcting the recipient removes the old handoff");
  await click("Prepare PDFs"); await fallback.waitFor();
  assert.equal(new URL(await fallback.getAttribute("href")).pathname, "/447700900123");
  assert.equal(alpha.customer_phone, "+447700900123");
  assert.equal(mappings.size, 1, "Repreparing creates no public links");
  assert.equal((await fetch(link)).status, 200, "Previous links remain usable");
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.screenshot({ path: "/tmp/billdesk-whatsapp-desktop.png", fullPage: true });
  await closedUpload();
  const bravo = draft("BRAVO", 3, 3);
  await reload(); await click("Upload bills (1)");
  await page.getByLabel("Token number (required)").fill("A-013");
  let heldSkip;
  await page.route('**/api/uploads/' + bravo.upload_id + '/confirm', route => { heldSkip = route; });
  await click("Submit all without WhatsApp");
  await page.locator('.sd-upload-footer .sd-operation-inline').waitFor();
  assert.equal(await page.locator('.sd-operation[open]').count(),0,'Skipping WhatsApp keeps submission inline');
  for (let i=0;i<100 && !heldSkip;i++) await new Promise(resolve => setTimeout(resolve,10));
  await heldSkip.continue(); await page.unroute('**/api/uploads/' + bravo.upload_id + '/confirm');
  await closedUpload(); await settled();
  assert.equal(confirms, 2); assert.equal(bravo.customer_phone, null); assert.ok(bravo.uploads.confirmed_at);
  assert.equal(preparations, 2);
  await closedUpload();
  // Sharing a previously skipped bill requires an explicit customer-chat click.
  await reload(); await click("INV-BRAVO");
  await page.getByLabel("Customer WhatsApp number").fill("9876543212");
  await click("Prepare PDFs"); await fallback.waitFor(); await settled();
  const popup = context.waitForEvent("page"); await fallback.click();
  const whatsappTab = await popup; await whatsappTab.waitForURL("https://wa.me/**");
  assert.equal(handoffs.length, 1); assert.equal(confirms, 2);
  assert.equal(new URL(handoffs[0]).pathname, "/919876543212");
  await whatsappTab.close();
  // Single-customer submission prepares PDFs; opening WhatsApp is explicit.
  await page.getByRole("dialog", {name:/^Bill /}).waitFor({state:"hidden"});
  const charlie = draft("CHARLIE", 1, 2);
  Object.assign(charlie, { amount_paise: null, amount_evidence: "No monetary total stated; supporting note", field_confidence: { document: { kind: "amc_note", billType: "AMC" } } });
  await reload(); await click("Upload bills (1)");
  await page.getByLabel("Customer WhatsApp number").fill("9876543213");
  await page.getByLabel("Token number (required)").fill("003");
  await click("Submit & prepare PDFs"); await fallback.waitFor(); await settled();
  assert.equal(handoffs.length, 1, "Preparation never opens WhatsApp automatically");
  const submissionPopup = context.waitForEvent("page"); await fallback.click();
  const submissionTab = await submissionPopup;
  await submissionTab.waitForURL("https://wa.me/**");
  assert.equal(new URL(submissionTab.url()).pathname, "/919876543213");
  assert.ok(charlie.uploads.confirmed_at); assert.equal(confirms, 3);
  await submissionTab.close(); // Closing WhatsApp does not undo cashier submission.
  assert.ok(charlie.uploads.confirmed_at);
  // Two related bills have separate PDF attachments and a shared message.
  await closedUpload();
  const sibling = draft("ALPHA-SERVICE", 3, 3);
  sibling.customer_id = alpha.customer_id; sibling.customer_name = alpha.customer_name;
  sibling.bill_type = "Service invoice"; sibling.token_number = "002";
  sibling.uploads.confirmed_at = new Date().toISOString(); sibling.uploads.status = "confirmed";
  alpha.bill_type = "Body & paint";
  const hiddenDraft = draft("ALPHA-DRAFT", 1, 1); hiddenDraft.customer_id = alpha.customer_id;
  const hiddenOwner = draft("ALPHA-OTHER-ADVISOR", 1, 1); hiddenOwner.customer_id = alpha.customer_id;
  hiddenOwner.uploaded_by = randomUUID(); hiddenOwner.uploads.confirmed_at = new Date().toISOString();
  await reload(); await click("INV-ALPHA");
  await page.getByText("Preview preset message", { exact: true }).click();
  const preview = await page.locator(".sd-message-preview").innerText();
  assert.match(preview, /2 bills/); assert.match(preview, /Body & paint — INV-ALPHA/); assert.match(preview, /Service invoice — INV-ALPHA-SERVICE/);
  assert.doesNotMatch(preview, /ALPHA-DRAFT|ALPHA-OTHER-ADVISOR|INV-BRAVO/);
  const beforeGroup = preparations;
  const mappingsBeforeGroup = mappings.size;
  failStorage = true;
  const storageFailure = await post(sharing, { customerPhone: "9876543210" });
  assert.equal(storageFailure.status, 503);
  assert.equal((await storageFailure.json()).whatsappUrl, undefined);
  assert.equal(mappings.size, mappingsBeforeGroup);
  assert.equal(preparations, beforeGroup);
  failStorage = false;
  failBill = sibling.id;
  const failed = await post(sharing, { customerPhone: "9876543210" });
  assert.equal(failed.status, 503); assert.equal((await failed.json()).whatsappUrl, undefined);
  assert.equal(preparations, beforeGroup, "Do not audit or hand off a partial set of links");
  assert.equal(mappings.size, mappingsBeforeGroup);
  failBill = null;
  await click("Prepare PDFs"); await fallback.waitFor(); await settled();
  const groupPopup = context.waitForEvent("page"); await fallback.click();
  const groupTab = await groupPopup; await groupTab.waitForURL("https://wa.me/**");
  const groupMessage = new URL(groupTab.url()).searchParams.get("text");
  assert.doesNotMatch(groupMessage, /https?:|within 7 days/);
  const groupLinks = await page.locator(".sd-attachments a[download]").evaluateAll(nodes => nodes.map(node => node.href));
  assert.doesNotMatch(groupMessage, /customer-copies|supabase|3120/);
  assert.equal(groupLinks.length, 2); assert.notEqual(groupLinks[0], groupLinks[1]);
  assert.match(groupMessage, /\*1\. Body & paint — INV-ALPHA\*/);
  assert.match(groupMessage, /\*2\. Service invoice — INV-ALPHA-SERVICE\*/);
  for (const [index, link] of groupLinks.entries()) {
    const response = await fetch(link, {headers:{Cookie:"billdesk_session="+session}}); assert.equal(response.status, 200);
    const parser = new PDFParse({ data: new Uint8Array(await response.arrayBuffer()) });
    try {
      const text = (await parser.getText()).text;
      assert.match(text, index === 0 ? /ALPHA CONTINUATION/ : /CUSTOMER BRAVO/);
      assert.doesNotMatch(text, index === 0 ? /CUSTOMER BRAVO/ : /CUSTOMER ALPHA/);
    } finally { await parser.destroy(); }
  }
  await groupTab.close();
  assert.equal(preparations, beforeGroup + 2); assert.equal(confirms, 3);
  await page.locator(".sd-sharing-queue details summary").click();
  assert.equal(await page.locator(".sd-message-preview").innerText(), groupMessage);
  const reopen = context.waitForEvent("page"); await fallback.click();
  const reopenedTab = await reopen; await reopenedTab.waitForURL("https://wa.me/**");
  assert.equal(new URL(reopenedTab.url()).searchParams.get("text"), groupMessage);
  assert.equal(preparations, beforeGroup + 2, "Reopening reuses the ready preset");
  await reopenedTab.close();
  // Explicit batch selections reject the whole request before making any links.
  const beforeDenied = mappings.size;
  for (const ids of [[alpha.id, bravo.id], [alpha.id, hiddenDraft.id], [alpha.id, hiddenOwner.id], [alpha.id, randomUUID()]]) {
    assert.equal((await post(sharing, { customerPhone: "9876543210", billIds: ids })).status, 409);
  }
  for (const ids of [[], [alpha.id, alpha.id], [sibling.id], [alpha.id, "invalid"]]) {
    assert.equal((await post(sharing, { customerPhone: "9876543210", billIds: ids })).status, 400);
  }
  assert.equal(mappings.size, beforeDenied);
  // Remove the deliberately hidden draft fixture before exercising a fresh upload batch.
  bills.splice(bills.indexOf(hiddenDraft), 1); uploads.splice(uploads.indexOf(hiddenDraft.uploads), 1);
  const batch = [draft("BATCH-1", 1, 1), draft("BATCH-2", 2, 2), draft("BATCH-3", 3, 3)];
  batch.forEach((b, index) => Object.assign(b, { customer_id: alpha.customer_id, customer_reference: alpha.customer_reference, customer_name: alpha.customer_name, token_number: index === 2 ? null : "B-" + index }));
  Object.assign(batch[1], { amount_paise: null, amount_evidence: "No monetary total stated; supporting note", field_confidence: { document: { kind: "warranty_note", billType: "Warranty" } } });
  Object.assign(batch[2], { amount_paise: null, amount_evidence: "No monetary total stated; supporting note", field_confidence: { document: { kind: "amc_note", billType: "AMC" } } });
  await reload(); await click("Upload bills (3)");
  await page.evaluate(() => { window.open = () => null; });
  const review = page.locator('.sd-customer-review');
  assert.equal(await review.locator('.sd-customer-group').count(), 1);
  assert.equal(await review.getByLabel('Customer WhatsApp number').count(), 1);
  assert.equal(await review.locator('.sd-review-card').count(), 3);
  await review.getByLabel('Customer WhatsApp number').fill('9876543214');
  await review.getByText('Preview preset message', {exact:true}).click();
  let batchPreview = await review.locator('.sd-message-preview').innerText();
  for (const bill of batch) assert.ok(batchPreview.includes(bill.invoice_reference));
  assert.doesNotMatch(batchPreview, /INV-ALPHA/);
  const beforeBatch = confirms, beforeBatchPrep = preparations;
  await click('Submit & prepare PDFs');
  await page.getByText('Token number is required for every bill at this branch', {exact:true}).last().waitFor();
  assert.equal(confirms, beforeBatch, 'Preflight must not submit a partial batch');
  await review.getByLabel('Token number (required)').nth(2).fill('B-2');
  failConfirm = batch[2].upload_id;
  await review.getByRole('button', {name:'View bill',exact:true}).first().click();
  const batchDetails = page.getByRole('dialog', {name:'Bill INV-BATCH-1',exact:true});
  assert.equal(await batchDetails.getByLabel('Customer WhatsApp number').inputValue(), '9876543214');
  await batchDetails.getByRole('button', {name:'Submit & prepare PDFs',exact:true}).click();
  await page.getByText('Synthetic submission failure', {exact:true}).waitFor();
  await page.getByText('Finish submitting or remove this customer’s remaining PDFs before sharing.', {exact:true}).waitFor();
  assert.equal(confirms, beforeBatch + 2); assert.equal(preparations, beforeBatchPrep);
  assert.equal(await page.getByRole('button', {name:'Prepare PDFs',exact:true}).isDisabled(), true);
  assert.ok(batch.slice(0,2).every(b => b.customer_phone === '+919876543214'));
  assert.equal(await review.getByLabel('Customer WhatsApp number').inputValue(), '9876543214');
  await click('Retry submission');
  await page.getByText('Synthetic submission failure', {exact:true}).waitFor();
  assert.equal(confirms, beforeBatch + 2);
  await reload(); await click('Upload bills (1)');
  await page.evaluate(() => { window.open = () => null; });
  assert.equal(await review.getByLabel('Customer WhatsApp number').inputValue(), '+919876543214');
  assert.equal(await page.getByRole('button', {name:'Prepare PDFs',exact:true}).isDisabled(), true);
  await review.getByLabel('Token number (required)').fill('B-2');
  failConfirm = null;
  await click('Submit & prepare PDFs');
  const batchLink = page.getByRole('link', {name:'Open customer chat',exact:true});
  await batchLink.waitFor();
  assert.equal(confirms, beforeBatch + 3); assert.equal(preparations, beforeBatchPrep + 3);
  const batchMessage = new URL(await batchLink.getAttribute('href')).searchParams.get('text');
  assert.doesNotMatch(batchMessage, /https?:/);
  assert.equal(await page.locator('.sd-attachments a[download]').count(),3);
  for (const bill of batch) assert.ok(batchMessage.includes(bill.invoice_reference));
  assert.doesNotMatch(batchMessage, /INV-ALPHA|INV-BRAVO|INV-CHARLIE/);
  assert.ok(batch.every(b => b.customer_phone === '+919876543214'));
  for (const width of [320,390,1440]) {
    await page.setViewportSize({width,height:1000});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  // A combined PDF can contain two customers, each with their own contact and message.
  const mixedA = draft('MIXED-A', 1, 2), mixedB = draft('MIXED-B', 3, 3);
  const unusedUpload = mixedB.uploads;
  mixedB.uploads = mixedA.uploads; mixedB.upload_id = mixedA.upload_id;
  uploads.splice(uploads.indexOf(unusedUpload), 1);
  const mixedExtra = draft('MIXED-A-EXTRA', 1, 1);
  Object.assign(mixedExtra, {customer_id:mixedA.customer_id,customer_reference:mixedA.customer_reference,customer_name:mixedA.customer_name});
  mixedA.customer_phone = '+919876543215'; mixedExtra.customer_phone = '+919876543216';
  [mixedA,mixedB,mixedExtra].forEach(b => { b.token_number = 'M'; });
  await reload(); await click('Upload bills (2)');
  const mixedGroupA = page.getByRole('region', {name:'Review MIXED-A',exact:true});
  const mixedGroupB = page.getByRole('region', {name:'Review MIXED-B',exact:true});
  assert.equal(await review.getByLabel('Customer WhatsApp number').count(), 2);
  assert.equal(await mixedGroupA.getByLabel('Customer WhatsApp number').inputValue(), '');
  await mixedGroupA.getByText('Saved numbers differ. Enter the correct number for this customer.', {exact:true}).waitFor();
  await mixedGroupA.getByLabel('Customer WhatsApp number').fill('9876543215');
  await mixedGroupB.getByLabel('Customer WhatsApp number').fill('9876543216');
  const handoffsBefore = handoffs.length;
  const confirmationRequests = new Map();
  await page.route('**/api/uploads/*/confirm', route => { confirmationRequests.set(route.request().url(), route); });
  const confirmsBeforeMixed = confirms;
  await click('Submit all');
  const submitting = page.getByRole('dialog', {name:'Submitting bills…',exact:true});
  await submitting.getByText('0 / 3 completed', {exact:true}).waitFor();
  await page.keyboard.press('Escape'); assert.equal(await submitting.isVisible(), true);
  await page.getByRole('button', {name:'Submit all',exact:true,includeHidden:true}).dispatchEvent('click');
  for (let i = 0; i < 100 && confirmationRequests.size < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(confirmationRequests.size, 2, 'Duplicate click must not create more requests');
  await confirmationRequests.get(base + '/api/uploads/' + mixedA.upload_id + '/confirm').continue();
  await submitting.getByText('2 / 3 completed', {exact:true}).waitFor();
  await confirmationRequests.get(base + '/api/uploads/' + mixedExtra.upload_id + '/confirm').continue();
  await page.unroute('**/api/uploads/*/confirm');
  await closedUpload(); await settled();
  assert.equal(confirms, confirmsBeforeMixed + 2);
  assert.equal(handoffs.length, handoffsBefore, 'Multiple customers use separate explicit handoffs');
  assert.equal(await page.locator('.sd-sharing-queue').evaluate(el => document.activeElement === el), true);
  assert.equal(await page.locator('.sd-sharing-queue article').count(), 2);
  assert.match(await page.locator('.sd-sharing-queue').innerText(), /MIXED-A — 2 bills/);
  assert.match(await page.locator('.sd-sharing-queue').innerText(), /MIXED-B — 1 bill/);
  assert.equal(await page.getByRole('button', {name:'Prepare PDFs',exact:true}).count(), 2);
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole('button', {name:'Prepare PDFs',exact:true}).first().click();
  await batchLink.waitFor();
  const mixedUrlA = new URL(await batchLink.getAttribute('href'));
  assert.equal(mixedUrlA.pathname, '/919876543215');
  const mixedMessageA = mixedUrlA.searchParams.get('text');
  assert.doesNotMatch(mixedMessageA, /https?:/);
  assert.equal(await page.locator('.sd-sharing-queue article').first().locator('a[download]').count(),2);
  assert.equal(await page.locator('.sd-sharing-queue article').count(), 2);
  assert.match(mixedMessageA, /INV-MIXED-A-EXTRA/); assert.doesNotMatch(mixedMessageA, /INV-MIXED-B|INV-BATCH/);
  await page.getByRole('button', {name:'Prepare PDFs',exact:true}).click();
  await page.waitForFunction(() => document.querySelectorAll('.sd-sharing-queue a[href^="https://wa.me/"]').length === 2);
  const mixedLinks = await batchLink.all();
  const mixedUrlB = new URL(await mixedLinks[1].getAttribute('href'));
  assert.equal(mixedUrlB.pathname, '/919876543216');
  const mixedMessageB = mixedUrlB.searchParams.get('text');
  assert.doesNotMatch(mixedMessageB, /https?:/);
  assert.equal(await page.locator('.sd-sharing-queue article').nth(1).locator('a[download]').count(),1);
  assert.equal(await mixedLinks[0].getAttribute('href'), mixedUrlA.href, 'Preparing B retains A’s link');
  assert.match(mixedMessageB, /INV-MIXED-B/); assert.doesNotMatch(mixedMessageB, /INV-MIXED-A/);
  await closedUpload();
  const later = draft('MIXED-A-NEXT', 1, 1);
  Object.assign(later, {customer_id:mixedA.customer_id,customer_reference:mixedA.customer_reference,customer_name:mixedA.customer_name,token_number:'NEXT'});
  await click('Refresh'); await click('Upload bills (1)');
  assert.equal(await review.getByLabel('Customer WhatsApp number').inputValue(), '+919876543215');
  await click('Submit & prepare PDFs');
  await page.waitForFunction(() => document.querySelectorAll('.sd-sharing-queue a[href^="https://wa.me/"]').length === 3);
  const nextMessage = new URL(await batchLink.last().getAttribute('href')).searchParams.get('text');
  assert.match(nextMessage, /INV-MIXED-A-NEXT/);
  assert.doesNotMatch(nextMessage, /INV-MIXED-A-EXTRA|INV-MIXED-B/);
  assert.doesNotMatch(nextMessage, /https?:/);
  await page.screenshot({path:'/tmp/billdesk-customer-batches.png',fullPage:true});
  await page.reload();
  await page.locator('.sd-sharing-queue').waitFor();
  assert.equal(await page.locator('.sd-sharing-queue article').count(), 3);
  await page.evaluate(() => {
    window.sharedFiles = [];
    Object.defineProperty(navigator, 'canShare', {configurable:true,value: data => Boolean(data.files?.every(f => f.type === 'application/pdf'))});
    Object.defineProperty(navigator, 'share', {configurable:true,value: async data => {
      if (window.cancelShare) throw new DOMException('Cancelled', 'AbortError');
      if (window.failShare) throw new DOMException('Unavailable', 'NotAllowedError');
      window.sharedFiles = await Promise.all(data.files.map(async f => ({name:f.name,size:f.size,type:f.type})));
    }});
  });
  const firstCard = page.locator('.sd-sharing-queue article').first();
  await firstCard.getByRole('button',{name:'Prepare PDFs',exact:true}).click();
  await firstCard.getByRole('button',{name:'Share PDFs',exact:true}).waitFor(); await settled();
  await page.evaluate(() => { window.cancelShare = true; });
  await firstCard.getByRole('button',{name:'Share PDFs',exact:true}).click();
  assert.equal(await firstCard.getByRole('alert').count(),0);
  await page.evaluate(() => { window.cancelShare = false; });
  await firstCard.getByRole('button',{name:'Share PDFs',exact:true}).click();
  await page.waitForFunction(() => window.sharedFiles.length === 2);
  assert((await page.evaluate(() => window.sharedFiles)).every(f => f.size > 0 && f.type === 'application/pdf'));
  await page.evaluate(() => { window.failShare = true; });
  await firstCard.getByRole('button',{name:'Share PDFs',exact:true}).click();
  await firstCard.getByText('Sharing is unavailable. Download the PDFs and attach them in WhatsApp.').waitFor();
  const downloaded = page.waitForEvent('download');
  await firstCard.getByRole('link',{name:'Download PDF 1',exact:true}).click();
  assert.match((await downloaded).suggestedFilename(), /\.pdf$/);
  // Multi-file sharing unsupported: keep the desktop download/chat path available.
  await page.evaluate(() => Object.defineProperty(navigator,'canShare',{configurable:true,value: data => data.files.length === 1}));
  await firstCard.getByRole('button',{name:'Prepare again',exact:true}).click(); await settled();
  assert.equal(await firstCard.getByRole('button',{name:'Share PDFs',exact:true}).count(),0);
  assert.equal(await firstCard.locator('a[download]').count(),2);
  const uncertainBill = draft('TIMEOUT', 1, 1); uncertainBill.token_number = 'T';
  await reload(); await click('Upload bills (1)');
  await page.getByLabel('Customer WhatsApp number').fill('9876543217');
  await page.evaluate(() => { window.open = () => null; });
  await page.clock.install();
  let committed = false;
  const beforeTimeout = confirms;
  await page.route('**/api/uploads/' + uncertainBill.upload_id + '/confirm', async route => {
    await route.fetch(); committed = true; // Commit on the server, lose the foreground response.
  });
  await click('Submit & prepare PDFs');
  for (let i = 0; i < 100 && !committed; i++) await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(committed,true);
  await page.clock.fastForward(120_100);
  await page.getByText(/Its result is uncertain/).last().waitFor();
  await page.evaluate(() => document.querySelector('.sd-operation[data-outcome="failure"][open] button')?.click());
  assert.equal(await page.getByRole('button',{name:'Submit & prepare PDFs',exact:true}).isDisabled(),true);
  assert.equal(confirms,beforeTimeout+1);
  await click('Refresh status'); await settled();
  assert.equal(await page.locator('.sd-queue-item').count(),0,'Confirmed timed-out PDFs must leave the retry queue after refresh');
  assert.equal(confirms,beforeTimeout+1,'Status recovery must not resubmit');
  await click('Close upload dialog');
  assert.equal(await page.locator('.sd-sharing-queue article').count(),1);
  await page.unroute('**/api/uploads/' + uncertainBill.upload_id + '/confirm');
  await click('Prepare PDFs'); await batchLink.waitFor();
  const recoveredMessage = new URL(await batchLink.getAttribute('href')).searchParams.get('text');
  assert.match(recoveredMessage,/INV-TIMEOUT/);
  assert.doesNotMatch(recoveredMessage, /https?:/);
  assert.deepEqual(errors, []);
  console.log("WhatsApp attachments passed: native share/cancel/failure, desktop downloads, no generated public links, legacy links retained, grouped batch contacts, explicit bill selection, partial retries/reload recovery, mixed customers, later-batch isolation, short hashed links, anonymous GET/HEAD, streaming >4.5 MB, no storage leaks, safe failures, customer-group headings and attachments, matching preview, private page ranges, draft/owner/customer isolation, all-copies-or-error, authorization, tokens, retries, expiry, popup fallback and intercepted handoff.");
} catch (error) { console.error(appLogs); await page.screenshot({ path: "/tmp/billdesk-whatsapp-failure.png", fullPage: true }).catch(() => {}); throw error; }
finally { await browser.close(); app.kill("SIGTERM"); await new Promise(resolve => server.close(resolve)); }
