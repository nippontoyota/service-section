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
let confirms = 0, preparations = 0, failMappings = true, storageUploads = 0, failBill = null, failLookup = false, failStorage = false, redirectStorage = false, storageReads = 0, mappingReads = 0, streamFinished = false;
function draft(name, from, to) {
  const upload = { id: randomUUID(), original_filename: name + ".pdf", storage_path: "test.pdf", confirmed_at: null, file_hash: createHash("sha256").update(name).digest("hex"), status: "review" };
  const bill = { id: randomUUID(), upload_id: upload.id, uploaded_by: advisorId, customer_name: name, customer_reference: name, customer_id: name, customer_phone: null, token_number: null, invoice_reference: "INV-" + name, vehicle_no_display: "KL01AB1234", vin: "", invoice_date: "2026-11-11", amount_paise: 10000, approval_status: "pending", approved_at: null, approved_by: null, created_at: new Date().toISOString(), page_from: from, page_to: to, amount_evidence: "Total 100", extraction_issues: [], payment_evidence: [], uploads: upload };
  uploads.push(upload); bills.push(bill); return bill;
}
const alpha = draft("ALPHA", 1, 2);
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
      assert.ok(Date.parse(body.expires_at) > Date.now() + 6.9 * 86400000);
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
  await click("Submit & open WhatsApp");
  await page.getByText("Token number is required for every bill at this branch", { exact: true }).waitFor();
  await page.getByLabel("Token number (required)").fill("0012");
  await click("Submit & open WhatsApp");
  await page.getByText("Enter a valid customer WhatsApp number with country code", { exact: true }).waitFor();
  assert.equal(confirms, 0);
  await page.getByLabel("Customer WhatsApp number").fill("9876543210");
  await click("Submit & open WhatsApp");
  await page.getByRole("dialog", { name: "Upload and review bills" }).getByText(/Submitted to cashier; WhatsApp preparation failed/).waitFor();
  assert.equal(confirms, 1); assert.equal(preparations, 0); assert.ok(alpha.uploads.confirmed_at);
  assert.equal(storageUploads, 1); assert.equal(handoffs.length, 0);
  // Reproduce a deployment that omitted the route and serves an HTML 404 page.
  const missingRoute = "**/api/bills/*/whatsapp";
  await page.route(missingRoute, route => route.fulfill({ status: 404, contentType: "text/html", body: "<!DOCTYPE html><html>Not found</html>" }));
  await click("Open WhatsApp");
  await page.getByRole("dialog", { name: "Upload and review bills" }).getByText(/This action is unavailable on the server \(HTTP 404\)/).waitFor();
  assert.doesNotMatch(await page.locator(".sd-notice").last().innerText(), /Unexpected token|DOCTYPE/);
  assert.equal(confirms, 1); assert.equal(preparations, 0); assert.equal(handoffs.length, 0);
  await page.unroute(missingRoute);
  failMappings = false;
  // Block popups to verify the visible handoff link still works.
  await page.evaluate(() => { window.open = () => null; });
  await click("Open WhatsApp");
  const fallback = page.getByRole("link", { name: "Open WhatsApp", exact: true });
  await fallback.waitFor();
  assert.equal(await fallback.innerText(), "", "WhatsApp action uses an icon with an accessible name");
  assert.equal(await fallback.locator("svg").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Prepare fresh WhatsApp message" }).count(), 0);
  assert.equal(await page.locator(".sd-whatsapp textarea, .sd-whatsapp [contenteditable=true]").count(), 0, "The preset stays read-only");
  assert.equal(confirms, 1); assert.equal(preparations, 1); assert.equal(storageUploads, 1);
  const whatsapp = new URL(await fallback.getAttribute("href"));
  assert.equal(whatsapp.pathname, "/919876543210");
  const message = whatsapp.searchParams.get("text"); assert.match(message, /Token number: 0012/); assert.match(message, /Thank you, Test Advisor/);
  const link = message.split("\n").find(line => line.startsWith("http"));
  const download = await fetch(link); assert.equal(download.status, 200);
  const parser = new PDFParse({ data: new Uint8Array(await download.arrayBuffer()) });
  try { const text = (await parser.getText()).text; assert.match(text, /ALPHA CONTINUATION/); assert.doesNotMatch(text, /BRAVO/); } finally { await parser.destroy(); }
  assert.equal((await fetch(backend + "/storage/v1/object/bills/test.pdf")).status, 403);
  assert.match(link, /^http:\/\/127\.0\.0\.1:3119\/b\/[A-Za-z0-9_-]{22}$/);
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
  assert.equal(download.headers.get("content-disposition"), 'inline; filename="bill.pdf"');
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
  const largeResponse = await fetch(link); privateResponse(largeResponse);
  assert.equal(largeResponse.status, 200);
  const reader = largeResponse.body.getReader(), firstChunk = await reader.read();
  assert.equal(streamFinished, false, "Customer receives bytes before the upstream finishes");
  const chunks = [Buffer.from(firstChunk.value)];
  for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(Buffer.from(next.value)); }
  assert.deepEqual(Buffer.concat(chunks), largeBytes);
  storage.set(mappedPath, savedPdf);
  await page.getByLabel("Customer WhatsApp number").fill("+44 7700 900123");
  assert.equal(await fallback.count(), 0, "Correcting the recipient removes the old handoff");
  await click("Open WhatsApp"); await fallback.waitFor();
  assert.equal(new URL(await fallback.getAttribute("href")).pathname, "/447700900123");
  assert.equal(alpha.customer_phone, "+447700900123");
  const refreshedLink = new URL(await fallback.getAttribute("href")).searchParams.get("text").split("\n").find(line => line.startsWith("http"));
  assert.notEqual(refreshedLink, link, "Each preparation issues a fresh code");
  assert.equal((await fetch(link)).status, 200, "Previous links remain usable");
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.screenshot({ path: "/tmp/billdesk-whatsapp-desktop.png", fullPage: true });
  await click("Close upload dialog");
  const bravo = draft("BRAVO", 3, 3);
  await page.reload(); await click("Upload bills (1)");
  await page.getByLabel("Token number (required)").fill("A-013");
  await click("Submit all without WhatsApp");
  await page.getByText("0 ready · 0 failed · 0 / 10 PDFs", { exact: true }).waitFor();
  assert.equal(confirms, 2); assert.equal(bravo.customer_phone, null); assert.ok(bravo.uploads.confirmed_at);
  assert.equal(preparations, 2);
  await click("Close upload dialog");
  // Restored My bills allows sharing a previously skipped bill and a normal automatic handoff.
  await page.reload(); await click("INV-BRAVO");
  await page.getByLabel("Customer WhatsApp number").fill("9876543212");
  const popup = context.waitForEvent("page"); await click("Open WhatsApp");
  const whatsappTab = await popup; await whatsappTab.waitForURL("https://wa.me/**");
  assert.equal(handoffs.length, 1); assert.equal(confirms, 2);
  assert.equal(new URL(handoffs[0]).pathname, "/919876543212");
  await whatsappTab.close();
  // A fresh single-bill submission opens its reserved tab automatically.
  await click("Close bill details");
  const charlie = draft("CHARLIE", 1, 2);
  await page.reload(); await click("Upload bills (1)");
  await page.getByLabel("Customer WhatsApp number").fill("9876543213");
  await page.getByLabel("Token number (required)").fill("003");
  const submissionPopup = context.waitForEvent("page");
  await click("Submit & open WhatsApp");
  const submissionTab = await submissionPopup;
  await submissionTab.waitForURL("https://wa.me/**");
  assert.equal(new URL(submissionTab.url()).pathname, "/919876543213");
  assert.ok(charlie.uploads.confirmed_at); assert.equal(confirms, 3);
  await submissionTab.close(); // Closing WhatsApp does not undo cashier submission.
  assert.ok(charlie.uploads.confirmed_at);
  // Two related bills are shown in the preview and sent as one message with two links.
  await click("Close upload dialog");
  const sibling = draft("ALPHA-SERVICE", 3, 3);
  sibling.customer_id = alpha.customer_id; sibling.customer_name = alpha.customer_name;
  sibling.bill_type = "Service invoice"; sibling.token_number = "002";
  sibling.uploads.confirmed_at = new Date().toISOString(); sibling.uploads.status = "confirmed";
  alpha.bill_type = "Body & paint";
  const hiddenDraft = draft("ALPHA-DRAFT", 1, 1); hiddenDraft.customer_id = alpha.customer_id;
  const hiddenOwner = draft("ALPHA-OTHER-ADVISOR", 1, 1); hiddenOwner.customer_id = alpha.customer_id;
  hiddenOwner.uploaded_by = randomUUID(); hiddenOwner.uploads.confirmed_at = new Date().toISOString();
  await page.reload(); await click("INV-ALPHA");
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
  const groupPopup = context.waitForEvent("page"); await click("Open WhatsApp");
  const groupTab = await groupPopup; await groupTab.waitForURL("https://wa.me/**");
  const groupMessage = new URL(groupTab.url()).searchParams.get("text");
  const groupLinks = groupMessage.split("\n").filter(line => line.startsWith("http"));
  assert.doesNotMatch(groupMessage, /customer-copies|supabase|3120/);
  assert.equal(groupLinks.length, 2); assert.notEqual(groupLinks[0], groupLinks[1]);
  assert.match(groupMessage, /\*1\. Body & paint — INV-ALPHA\*\nhttp/);
  assert.match(groupMessage, /\*2\. Service invoice — INV-ALPHA-SERVICE\*\nhttp/);
  for (const [index, link] of groupLinks.entries()) {
    const response = await fetch(link); assert.equal(response.status, 200);
    const parser = new PDFParse({ data: new Uint8Array(await response.arrayBuffer()) });
    try {
      const text = (await parser.getText()).text;
      assert.match(text, index === 0 ? /ALPHA CONTINUATION/ : /CUSTOMER BRAVO/);
      assert.doesNotMatch(text, index === 0 ? /CUSTOMER BRAVO/ : /CUSTOMER ALPHA/);
    } finally { await parser.destroy(); }
  }
  await groupTab.close();
  assert.equal(preparations, beforeGroup + 2); assert.equal(confirms, 3);
  assert.equal(await page.locator(".sd-message-preview").innerText(), groupMessage);
  const reopen = context.waitForEvent("page"); await fallback.click();
  const reopenedTab = await reopen; await reopenedTab.waitForURL("https://wa.me/**");
  assert.equal(new URL(reopenedTab.url()).searchParams.get("text"), groupMessage);
  assert.equal(preparations, beforeGroup + 2, "Reopening reuses the ready preset");
  await reopenedTab.close();
  // Expired messages refresh from the same icon without an extra advisor action.
  await page.evaluate(() => { const now = Date.now(); Date.now = () => now + 8 * 86400000; });
  const renewal = context.waitForEvent("page"); await fallback.click();
  const renewedTab = await renewal; await renewedTab.waitForURL("https://wa.me/**");
  assert.equal(preparations, beforeGroup + 4);
  assert.notEqual(new URL(renewedTab.url()).searchParams.get("text"), groupMessage);
  await renewedTab.close();
  await page.screenshot({ path: "/tmp/billdesk-whatsapp-icon.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("WhatsApp passed: short hashed links, anonymous GET/HEAD, streaming >4.5 MB, no storage leaks, safe failures, customer-group headings and links, matching preview, private page ranges, draft/owner/customer isolation, all-links-or-error, authorization, tokens, retries, expiry, popup fallback and intercepted handoff.");
} catch (error) { console.error(appLogs); await page.screenshot({ path: "/tmp/billdesk-whatsapp-failure.png", fullPage: true }).catch(() => {}); throw error; }
finally { await browser.close(); app.kill("SIGTERM"); await new Promise(resolve => server.close(resolve)); }
