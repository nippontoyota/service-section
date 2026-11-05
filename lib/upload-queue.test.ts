import assert from "node:assert/strict";
import { test } from "node:test";
import { selectFiles, fileIdentity, restoreDrafts, withTwoWorkers, type UploadFile } from "./upload-queue";
import { PdfLinks } from "./pdf-preview";
import { cashierView } from "./desk";
import { fixtureSnapshot } from "./test-fixtures";
import { demoAction } from "./desk-demo";

const file = (name: string, size = 10, lastModified = 1) => ({ name, size, lastModified }) as File;
test("picker appends across openings, deduplicates, and enforces total count and size", () => {
  const first = file("one.pdf");
  const queue: UploadFile[] = [{ id: "one", identity: fileIdentity(first), name: first.name, file: first, bills: [], progress: 0, state: "selected" }];
  assert.deepEqual(selectFiles(queue, [first, file("two.pdf")]).added.map(f => f.name), ["two.pdf"]);
  assert.equal(selectFiles(queue, Array.from({ length: 12 }, (_, i) => file(`${i}.pdf`))).added.length, 9);
  assert.equal(selectFiles([], [file("empty.pdf", 0), file("huge.pdf", 10 * 1024 * 1024 + 1), file("text.txt")]).errors.length, 3);
  assert.equal(selectFiles([], [file("limit.pdf", 10 * 1024 * 1024)]).added.length, 1);
});
test("workers cap concurrency at two and retain ordered successes after a failure", async () => {
  let active = 0, max = 0;
  const results: string[] = [], failures: number[] = [];
  await withTwoWorkers([0,1,2,3], async index => {
    active++; max = Math.max(max, active);
    try { await new Promise(resolve => setTimeout(resolve, index === 0 ? 30 : 5)); if (index === 2) throw new Error("read failed"); results[index] = `bill-${index}`; }
    catch { failures.push(index); } finally { active--; }
  });
  assert.equal(max, 2); assert.deepEqual(results.filter(Boolean), ["bill-0", "bill-1", "bill-3"]); assert.deepEqual(failures, [2]);
});
test("draft recovery groups multiple bills in original page order and retains failed upload IDs", () => {
  const snapshot = fixtureSnapshot();
  snapshot.drafts = [{ id: "stored", original_filename: "batch.pdf", status: "review", processing_error: null, bills: [{ ...snapshot.bills[0], page_from: 3 }, { ...snapshot.bills[1], page_from: 1 }] }, { id: "failed", original_filename: "retry.pdf", status: "failed", processing_error: "Read failed", bills: [] }];
  const restored = restoreDrafts(snapshot);
  assert.deepEqual(restored[0].bills.map(b => b.page_from), [1,3]); assert.equal(restored[1].uploadId, "failed"); assert.equal(restored[1].stored, true); assert.equal(restored[1].state, "failed");
});
test("signed links deduplicate, expire early, retry failures and cannot repopulate after logout", async () => {
  const links = new PdfLinks(); let calls = 0;
  const fetchLink = async () => { calls++; return { uploadId: "upload", url: "signed", expiresAt: Date.now() + 300_000 }; };
  await Promise.all([links.get("upload", fetchLink), links.get("upload", fetchLink)]);
  await links.get("upload", fetchLink); assert.equal(calls, 1);
  links.delete("upload"); await links.get("upload", fetchLink); assert.equal(calls, 2);
  links.clear(); await links.get("upload", async () => ({ ...(await fetchLink()), expiresAt: Date.now() + 10_000 }));
  await links.get("upload", fetchLink); assert.equal(calls, 4);
  links.clear(); await assert.rejects(links.get("upload", async () => { throw new Error("offline"); }));
  await links.get("upload", fetchLink); assert.equal(calls, 5);
  links.clear(); const pending = links.get("upload", fetchLink); links.clear(); await pending;
  await links.get("upload", fetchLink); assert.equal(calls, 7);
});
test("cashier views include historical pending bills, payment transitions, reversal and no-charge archive", () => {
  let snapshot = fixtureSnapshot();
  const cashier = snapshot.staff.find(p => p.role === "cashier")!, admin = snapshot.staff.find(p => p.role === "super_admin")!;
  const bill = snapshot.bills.find(b => b.id === "sample-4")!; bill.invoice_date = "2020-01-01";
  assert.equal(cashierView(bill, snapshot.payments), "overview");
  assert.equal(cashierView(snapshot.bills.find(b => b.id === "sample-2")!, snapshot.payments), "overview");
  snapshot = demoAction(snapshot, cashier, "collect", bill.id);
  assert.equal(cashierView(snapshot.bills.find(b => b.id === bill.id)!, snapshot.payments), "archive");
  assert.equal(snapshot.bills.find(b => b.id === bill.id)!.approved_by, cashier.id);
  const paymentCount = snapshot.payments.length;
  snapshot = demoAction(snapshot, cashier, "collect", bill.id);
  assert.equal(snapshot.payments.length, paymentCount);
  snapshot = demoAction(snapshot, admin, "reverse", snapshot.payments.at(-1)!.id, "Correction");
  assert.equal(cashierView(snapshot.bills.find(b => b.id === bill.id)!, snapshot.payments), "overview");
  const note = { ...bill, amount_paise: null, amount_evidence: "No monetary total stated; supporting note", field_confidence: { document: { kind: "warranty_note" as const, billType: "Warranty", billedTo: "", typeEvidence: "" } } };
  assert.equal(cashierView(note, []), "archive");
  assert.equal(cashierView({ ...bill, uploads: { original_filename: "draft.pdf", confirmed_at: null } }, []), null);
});
