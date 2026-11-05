import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { extractBills, extractedBillFields } from "./extract";
import { billType, customerKey, groupCustomers, isSupportingNote, report, type DeskBill } from "../desk";
import { freshDemo } from "../desk-demo";

// Expected values verified against PDF contents, independent of their filenames.
type Sample = [file: string, invoice: string, pages: number, amount: number | null, date: string, customer: string, name: string, vehicle: string, job: string, type: string];
// Customer expectations stay local with the private source PDFs.
const expectationsPath = "samples/private/bill-expectations.json";
const samples: Sample[] = existsSync(expectationsPath)
  ? JSON.parse(readFileSync(expectationsPath, "utf8")) : [];
const cache = new Map<string, ReturnType<typeof extractBills>>();
test("PDF page limit is enforced using the document's actual page count", async () => {
  const pages = Array.from({ length: 101 }, (_, i) => `${i + 3} 0 R`).join(" ");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages}] /Count 101 >>`,
    ...Array.from({ length: 101 }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>")];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await assert.rejects(extractBills(new Uint8Array(Buffer.from(pdf))), /100-page limit/);
});
function sample(file: string) {
  if (!cache.has(file)) cache.set(file, extractBills(new Uint8Array(readFileSync("bills/" + file))));
  return cache.get(file)!;
}
test("PDF parsing preserves input bytes and distinct upload hashes", { skip: !existsSync("bills/BP Insurance.pdf") }, async () => {
  const bytes = new Uint8Array(readFileSync("bills/BP Insurance.pdf"));
  const hash = () => createHash("sha256").update(bytes).digest("hex");
  const before = hash();
  const size = bytes.byteLength;
  await extractBills(bytes);
  assert.equal(bytes.byteLength, size);
  assert.equal(hash(), before);
  assert.notEqual(hash(), createHash("sha256").update("").digest("hex"));
});
for (const [file, invoice, pages, amount, date, customer, name, vehicle, job, type] of samples) {
  test("Content extraction: " + file, { skip: !existsSync("bills/" + file) }, async () => {
    const result = await sample(file);
    assert.equal(result.pageCount, pages);
    assert.equal(result.bills.length, 1, "Continuation pages stay with their invoice");
    const b = result.bills[0];
    assert.equal(b.invoiceReference, invoice, "A job card must never become the invoice number");
    assert.equal(b.amountPaise, amount);
    assert.equal(b.invoiceDate, date);
    assert.equal(b.customerReference, customer);
    assert.equal(b.customerName, name, "Group by vehicle owner, not third-party payer");
    assert.equal(b.vehicleNo, vehicle);
    assert.equal(b.jobCardReference, job);
    assert.equal(b.document.billType, type);
    assert.ok(b.document.billedTo);
    assert.ok(b.document.typeEvidence);
    assert.equal(b.vin.length, 17);
    assert.deepEqual(b.extractionIssues, []);
    assert.deepEqual(b.paymentEvidence, [], "Cash headings / filenames cannot record collections");
  });
}

test("Shared owner IDs link service and coverage documents without grouping providers together", {
  skip: samples.length === 0 || !samples.every(([file]) => existsSync("bills/" + file)),
}, async () => {
  const bills: DeskBill[] = await Promise.all(samples.map(async ([file]) => {
    const b = (await sample(file)).bills[0];
    return {
      ...extractedBillFields(b), id: b.invoiceReference, upload_id: file, page_from: b.pageFrom, page_to: b.pageTo,
      uploaded_by: "demo-advisor", created_at: new Date().toISOString(), approved_at: null, approved_by: null,
      approval_status: "pending", status: "needs_review", uploads: { original_filename: file, confirmed_at: new Date().toISOString() },
    };
  }));
  const groups = groupCustomers(bills);
  assert.equal(groups.length, 10);
  const extendedWarranty = groups.find(g => g.reference === samples.find(([file]) => file === "Service & EW warranty.pdf")![5])!;
  const warranty = groups.find(g => g.reference === samples.find(([file]) => file === "Service & warranty.pdf")![5])!;
  assert.equal(extendedWarranty.bills.length, 2);
  assert.equal(extendedWarranty.total, 2951800);
  assert.equal(warranty.bills.length, 2);
  assert.equal(warranty.total, 2641800);
  assert.equal(warranty.missingAmounts, 0, "Covered notes are not failed monetary extractions");
  assert.equal(new Set(extendedWarranty.bills.map(b => b.vin)).size, 1);
  assert.equal(new Set(extendedWarranty.bills.map(b => b.job_card_reference)).size, 1);
  assert.equal(new Set(warranty.bills.map(b => b.job_card_reference)).size, 1);
  const assurant = bills.filter(b => billType(b) === "Extended warranty · Assurant");
  assert.equal(new Set(assurant.map(customerKey)).size, 2, "Same warranty company does not mean same customer");
  assert.equal(bills.filter(isSupportingNote).length, 4);
  const conflictingNote = { ...warranty.bills.find(isSupportingNote)!, amount_evidence: "Grand Total 100 · Grand Total 200", extraction_issues: ["Conflicting invoice totals. Upload a corrected PDF."] };
  assert.equal(isSupportingNote(conflictingNote), false, "Conflicting numeric totals still require review");
  const summary = report({ ...freshDemo(), bills }, "", "");
  assert.equal(summary.pending.length, 8);
  assert.equal(summary.totals.billed, 0, "Import does not approve invoices");
  assert.equal(summary.totals.collections, 0, "Import does not invent payments");
  assert.equal(bills.reduce((sum,b) => sum + (b.amount_paise ?? 0),0), 35912100);
});
