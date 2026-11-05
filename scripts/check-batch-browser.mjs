// Run after a build with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3120.
// Uses an isolated backend and synthetic records; never touches production data.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ? process.env.PLAYWRIGHT_PATH + "/index.mjs" : "playwright");
const base = "http://127.0.0.1:3119", backend = "http://127.0.0.1:3120";
assert(readFileSync(".next/server/app/page.js", "utf8").includes(backend), "Build with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3120 before running this isolated test.");
const profile = { id: "test-advisor", staff_id: "advisor01", full_name: "Test Advisor", role: "service_advisor", active: true, must_change_password: false };
const token = "a".repeat(43), hash = createHash("sha256").update(token).digest("hex");
const pdf = readFileSync("TXA24-23030.pdf");
const fixtures = mkdtempSync(join(tmpdir(), "billdesk-picker-"));
let bills = [], uploads = new Map(), payments = [], next = 0, processActive = 0, maxProcess = 0, confirmActive = 0, maxConfirm = 0, failProcess = true, failSubmit = true, signedRequests = 0, downloadRequests = 0, sessionDelay = 0, backendUnavailable = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = () => ({ bills, payments, staff: [profile], audit: [], as_of: new Date().toISOString() });
const json = (res, data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(data)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, backend);
  if (url.pathname === "/rest/v1/staff_sessions") {
    await delay(sessionDelay);
    if (backendUnavailable) return json(res, { message: "Temporary backend outage" }, 400);
    return json(res, url.searchParams.get("token_hash") === "eq." + hash ? { staff_id: profile.id, profiles: profile } : null);
  }
  if (url.pathname === "/rest/v1/rpc/app_desk_snapshot") return json(res, snapshot());
  if (url.pathname === "/rest/v1/uploads") return json(res, [...uploads].filter(([,u]) => !u.confirmed).map(([id,u]) => ({ id, original_filename: u.name, status: u.state, processing_error: u.error || null, bills: bills.filter(b => b.upload_id === id) })));
  if (url.pathname === "/rest/v1/bills") {
    await delay(40);
    const bill = bills.find(b => "eq." + b.id === url.searchParams.get("id"));
    return json(res, bill ? { upload_id: bill.upload_id, uploaded_by: bill.uploaded_by, uploads: { storage_path: "test.pdf", confirmed_at: bill.uploads.confirmed_at } } : null);
  }
  if (url.pathname.startsWith("/storage/v1/object/sign/bills/") && req.method === "POST") { signedRequests++; await delay(25); return json(res, { signedURL: "/object/sign/bills/test.pdf?token=test" }); }
  if (url.pathname.startsWith("/storage/v1/object/sign/bills/") && req.method === "GET") { downloadRequests++; await delay(60); res.writeHead(200, { "Content-Type": "application/pdf", "Access-Control-Allow-Origin": "*" }); return res.end(pdf); }
  console.error("Unexpected test backend route", req.method, url.pathname); json(res, { message: "Unexpected test route" }, 500);
});
await new Promise(resolve => server.listen(3120, "127.0.0.1", resolve));
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--port", "3119", "--hostname", "127.0.0.1"], { env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: backend, SUPABASE_SERVICE_ROLE_KEY: "isolated-test-key", SERVICE_DESK_DEMO: "false" }, stdio: ["ignore", "pipe", "pipe"] });
let appLogs = ""; app.stdout.on("data", b => { appLogs += b; }); app.stderr.on("data", b => { appLogs += b; });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on("pageerror", error => errors.push(error.message));
page.on("dialog", dialog => void dialog.accept());
await page.addInitScript(() => {
  window.loginSeen = false;
  new MutationObserver(() => { if (document.querySelector('input[name="staffId"]')) window.loginSeen = true; }).observe(document, { subtree: true, childList: true });
});
const fulfill = (route, data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
await page.route("**/api/**", async route => {
  const req = route.request(), url = new URL(req.url());
  if (url.pathname === "/api/desk") return route.continue();
  if (url.pathname === "/api/auth/login") { await page.context().addCookies([{ name: "billdesk_session", value: token, url: base, httpOnly: true }]); return fulfill(route, {}); }
  if (url.pathname === "/api/auth/logout") { await page.context().clearCookies(); return fulfill(route, {}); }
  if (url.pathname === "/api/uploads/init") { const body = req.postDataJSON(), id = String(++next); uploads.set(id, { name: body.filename, state: "uploading" }); return fulfill(route, { uploadId: id, signedUrl: base + "/test-upload/" + id }); }
  const id = url.pathname.split("/")[3], item = uploads.get(id);
  if (url.pathname.endsWith("/process")) {
    processActive++; maxProcess = Math.max(maxProcess, processActive); await delay(item.name === "a.pdf" ? 350 : 100); processActive--;
    if (item.name === "fail.pdf" && failProcess) { failProcess = false; item.state = "failed"; item.error = "Synthetic read failure"; return fulfill(route, { error: item.error }, 422); }
    item.state = "review"; item.error = null;
    const rows = Array.from({ length: item.name === "b.pdf" ? 2 : 1 }, (_, i) => ({ id: id + "-" + i, upload_id: id, customer_name: "Test customer", customer_id: "customer", customer_reference: "TEST", vehicle_no_display: "KL01AB1234", vin: "TEST1234567890123", invoice_reference: item.name + "-" + i, invoice_date: "2020-01-01", amount_paise: 10000, uploaded_by: profile.id, created_at: new Date().toISOString(), approved_at: null, approved_by: null, approval_status: "pending", status: "ready", page_from: i + 1, page_to: i + 1, extraction_issues: [], amount_evidence: "Total 100", payment_evidence: [], uploads: { original_filename: item.name, confirmed_at: null } }));
    bills.push(...rows); return fulfill(route, { bills: rows });
  }
  if (url.pathname.endsWith("/confirm")) {
    confirmActive++; maxConfirm = Math.max(maxConfirm, confirmActive); await delay(100); confirmActive--;
    if (item.name === "b.pdf" && failSubmit) { failSubmit = false; return fulfill(route, { error: "Synthetic submission failure" }, 503); }
    item.confirmed = true; bills.filter(b => b.upload_id === id).forEach(b => { b.uploads.confirmed_at = new Date().toISOString(); }); return fulfill(route, {});
  }
  if (url.pathname.endsWith("/delete")) {
    if (url.pathname.startsWith("/api/bills/")) { const bill = bills.find(b => b.id === id); assert(!bill.uploads.confirmed_at); bills = bills.filter(b => b.id !== id); if (!bills.some(b => b.upload_id === bill.upload_id)) uploads.delete(bill.upload_id); }
    else { assert(!item.confirmed); bills = bills.filter(b => b.upload_id !== id); uploads.delete(id); }
    return fulfill(route, {});
  }
  throw new Error("Unexpected browser API: " + url.pathname);
});
await page.route("**/test-upload/*", route => route.fulfill({ status: 200, body: "ok" }));
const pick = names => page.getByLabel("Add PDFs", { exact: true }).setInputFiles(names.map(name => { const path = join(fixtures, name); if (!existsSync(path)) writeFileSync(path, pdf); return path; }));
const click = name => page.getByRole("button", { name, exact: true }).click();
try {
  for (let n = 0; n < 100; n++) { try { if ((await fetch(base)).ok) break; } catch {} await delay(100); }
  await page.goto(base); await page.getByLabel("User ID", { exact: true }).fill("advisor01"); await page.getByLabel("Password", { exact: true }).fill("test-password"); await click("Sign in");
  await click("Upload bills"); await pick(["a.pdf"]); await pick(["b.pdf", "fail.pdf"]); await pick(["a.pdf"]);
  assert.equal(await page.locator(".sd-queue-item").count(), 3); assert.equal(next, 0);
  await click("Close upload dialog"); await click("Upload bills (3)"); assert.equal(await page.locator(".sd-queue-item").count(), 3);
  await click("Upload & read all"); await page.getByText("Synthetic read failure", { exact: true }).waitFor(); await page.getByText("2 ready · 1 failed · 3 / 10 PDFs", { exact: true }).waitFor();
  assert.equal(maxProcess, 2); assert.deepEqual(await page.locator(".sd-review-reference").allTextContents(), ["a.pdf-0", "b.pdf-0", "b.pdf-1"]);
  await click("Retry processing"); await page.getByText("3 ready · 0 failed · 3 / 10 PDFs", { exact: true }).waitFor(); assert.equal(next, 3, "Retry must reuse upload ID");
  await page.locator(".sd-review-card").nth(2).getByRole("button", { name: "View bill", exact: true }).click();
  await page.getByTitle("Original bill PDF").waitFor(); assert.match(await page.getByTitle("Original bill PDF").getAttribute("src"), /^blob:.*#page=2$/); assert.equal(signedRequests, 0);
  await click("Close bill details");
  await page.locator(".sd-review-card").nth(1).getByRole("button", { name: "Delete draft", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".sd-review-card").length === 3); assert.equal(bills.filter(b => b.uploads.original_filename === "b.pdf").length, 1);
  for (const width of [320,390,768,1440]) {
    await page.setViewportSize({ width, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const box = await page.getByRole("dialog", { name: "Upload and review bills" }).boundingBox(); assert(box.x >= 0 && box.x + box.width <= width + 1);
    await page.keyboard.press("Tab"); assert(await page.evaluate(() => document.activeElement.closest("dialog") !== null));
    if (width === 1440) { await page.getByRole("dialog", { name: "Upload and review bills" }).evaluate(el => { el.scrollTop = 0; }); await page.screenshot({ path: "/tmp/billdesk-upload-tiles-desktop.png" }); }
    if (width === 320) await page.screenshot({ path: "/tmp/billdesk-upload-320.png", fullPage: true });
  }
  await click("Submit all"); await page.getByText("Synthetic submission failure", { exact: true }).waitFor(); await page.waitForFunction(() => document.querySelectorAll(".sd-queue-item").length === 1); assert.equal(maxConfirm, 2); assert.equal(await page.locator(".sd-queue-item").count(), 1);
  // Valid server session restores the draft without rendering login or fetching the desk twice.
  let clientDeskGets = 0; page.on("request", req => { if (new URL(req.url()).pathname === "/api/desk" && req.method() === "GET") clientDeskGets++; });
  sessionDelay = 500; await page.reload(); await page.getByRole("button", { name: "Upload bills (1)", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.loginSeen), false); assert.equal(clientDeskGets, 0);
  await click("Upload bills (1)"); await page.getByRole("button", { name: "View bill", exact: true }).click(); await click("Close bill details");
  await page.getByRole("button", { name: "View bill", exact: true }).click(); await page.getByTitle("Original bill PDF").waitFor();
  await page.waitForFunction(() => performance.getEntriesByName("pdf-display").length > 0);
  assert.equal(signedRequests, 1, "Details prefetch and repeated view share the same signed request"); assert.equal(downloadRequests, 1);
  console.log("Controlled first stored-view timings (ms):", await page.evaluate(() => Object.fromEntries(["pdf-authorization","pdf-signing","pdf-download","pdf-display"].map(name => [name, performance.getEntriesByName(name).at(-1)?.duration]))));
  await click("Close bill details"); await click("Submit all"); await page.getByText("0 ready · 0 failed · 0 / 10 PDFs", { exact: true }).waitFor();
  await pick(Array.from({ length: 12 }, (_, i) => `limit-${i}.pdf`)); assert.equal(await page.locator(".sd-queue-item").count(), 10);
  await pick(["limit-0.pdf"]); assert.equal(await page.locator(".sd-queue-item").count(), 10);
  await click("Close upload dialog");
  // Refresh failures keep the workspace, and logout revokes browser preview URLs.
  backendUnavailable = true; await click("Refresh"); await page.getByRole("button", { name: "Retry refresh", exact: true }).waitFor(); assert.equal(await page.locator('input[name="staffId"]').count(), 0);
  backendUnavailable = false; sessionDelay = 0; await click("Retry refresh");
  await page.evaluate(() => { window.revokedUrls = []; const original = URL.revokeObjectURL; URL.revokeObjectURL = value => { window.revokedUrls.push(value); original(value); }; });
  await click("Sign out"); await page.getByLabel("User ID", { exact: true }).waitFor(); assert((await page.evaluate(() => window.revokedUrls.length)) > 0);
  await page.context().addCookies([{ name: "billdesk_session", value: "b".repeat(43), url: base, httpOnly: true }]); await page.reload(); await page.getByLabel("User ID", { exact: true }).waitFor();
  // Cashier defaults to Overview, independently of invoice date; no-charge notes are archived.
  profile.role = "cashier"; profile.id = "test-cashier";
  const note = { ...bills[0], id: "note", amount_paise: null, amount_evidence: "No monetary total stated; supporting note", field_confidence: { document: { kind: "warranty_note", billType: "Warranty", billedTo: "", typeEvidence: "" } } }; bills.push(note);
  await page.context().addCookies([{ name: "billdesk_session", value: token, url: base, httpOnly: true }]); await page.reload();
  await page.locator('nav button[aria-current="page"]').filter({ hasText: "Overview" }).waitFor(); assert.equal(await page.locator(".sd-invoice").count(), 3);
  await page.getByRole("button", { name: /^Archive/ }).click(); assert.match(await page.locator("main").innerText(), /No collection required/); assert.equal(await page.locator(".sd-invoice").count(), 1);
  assert.deepEqual(errors, []);
  console.log("PASS: picker append/dedup/limit, concurrency, ordering, retries, popup recovery, page previews, multi-bill deletion, partial submission, 320/390/tablet/desktop, focus, session SSR/no login flash, transient failures, signed cache, logout cleanup and cashier views.");
} catch (error) { console.error(appLogs); await page.screenshot({ path: "/tmp/billdesk-browser-failure.png", fullPage: true }).catch(() => {}); throw error; }
finally { rmSync(fixtures, { recursive: true, force: true }); await browser.close(); app.kill("SIGTERM"); await new Promise(resolve => server.close(resolve)); }
