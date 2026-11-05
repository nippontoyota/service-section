import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { paise, financialFields } from "./pdf/financial";
import { extractBills, extractCustomerReference } from "./pdf/extract";
import { balance, cashierDailyReport, customerKey, groupCustomers, indiaDate, report } from "./desk";
import { freshDemo, demoAction, upgradeDemo } from "./desk-demo";
import { fixtureSnapshot } from "./test-fixtures";
import { importReferenceBills } from "./import-reference-bills";
import { parseReferenceBills } from "./reference-bills";

test("money uses exact paise and rejects malformed values", () => {
  assert.equal(paise("1,25,075.09"), 12507509);
  assert.equal(paise("41305.0"), 4130500);
  for (const invalid of ["-1", "1.999", "NaN", "", "999999999999999"]) assert.equal(paise(invalid), null);
});
test("conflicting totals and dates are not guessed", () => {
  const result = financialFields("Grand Total: 100\nG.Total 200\nInvoice Date 31/02/2026");
  assert.equal(result.amountPaise, null); assert.equal(result.invoiceDate, null);
});
test("cash heading and standard terms do not imply a collection", () => {
  const result = financialFields("Tax Invoice(Cash)\nGrand Total 100.00\nInvoice Date 04/11/2026\nCustomer has made the payment thereafter.");
  assert.equal(result.amountPaise, 10000); assert.deepEqual(result.paymentEvidence, []);
});
test("payment fragments never override the service invoice total or create partial collections", () => {
  const result = financialFields("Grand Total: 20,000\nInvoice Date 04/11/2026\nPayment Date: 04/11/2026\nCash paid: 5,000\nUPI paid: 15,000\nAmount paid: 20,000");
  assert.equal(result.amountPaise,2000000);
  assert.deepEqual(result.paymentEvidence,[]);
  assert.deepEqual(financialFields("Grand Total 100\nAmount Paid 50").paymentEvidence,[]);
});
test("full bill settlement, retries, reversal and drill-down reconcile", () => {
  let data = fixtureSnapshot();
  const cashier = data.staff.find(p => p.role === "cashier")!;
  const admin = data.staff.find(p => p.role === "super_admin")!;
  const advisor = data.staff.find(p => p.role === "service_advisor")!;
  assert.throws(() => demoAction(data,advisor,"approve","sample-4"));
  assert.throws(() => demoAction(data,advisor,"collect","sample-4"));
  data.payments = data.payments.filter(p => p.bill_id !== "sample-0");
  assert.equal(balance(data.bills[0], data.payments),2000000);
  data = demoAction(data,cashier,"collect","sample-0");
  const count = data.payments.length;
  data = demoAction(data,cashier,"collect","sample-0");
  assert.equal(data.payments.length,count);
  assert.equal(balance(data.bills[0],data.payments),0);
  const payment = data.payments.at(-1)!;
  data = demoAction(data,admin,"reverse",payment.id,"Wrong bill selected");
  data = demoAction(data,admin,"reverse",payment.id,"Repeated request");
  assert.equal(data.payments.length,count+1);
  assert.equal(balance(data.bills[0],data.payments),2000000);
  const summary = report(data);
  assert.deepEqual(summary.paid.map(b => b.id), ["sample-1"]);
  assert.deepEqual(summary.unpaid.map(b => b.id), ["sample-0", "sample-2", "sample-3", "sample-4", "sample-5"]);
  assert.equal(summary.paidAmount, 4130500);
  assert.equal(summary.unpaidAmount, 9789200);
  assert.equal(summary.pending.length,2);
  data = demoAction(data,cashier,"collect","sample-0");
  assert.equal(report(data).paid.length, 2, "Repaid bills count once despite multiple payment entries");
  assert.equal(report(data).unpaid.length, 4);
});
test("admin bill totals cover all dates, exclude drafts and notes, and respect advisor and payment status", () => {
  const data = fixtureSnapshot();
  data.bills[0].invoice_date = "2000-01-01";
  data.bills[5].amount_paise = null;
  const bill = data.bills[4];
  data.bills.push(
    { ...bill, id: "missing-date", invoice_date: null, uploaded_by: "other-advisor" },
    { ...bill, id: "draft", uploads: { original_filename: "draft.pdf", confirmed_at: null } },
    { ...bill, id: "note", amount_paise: null, amount_evidence: "No monetary total stated; supporting note", field_confidence: { document: { kind: "warranty_note", billType: "Warranty", billedTo: "", typeEvidence: "" } } },
  );
  data.payments.push({ ...data.payments[0], id: "archived", bill_id: data.bills[2].id, amount_paise: data.bills[2].amount_paise!, is_archived: true });
  const summary = report(data);
  assert.equal(summary.paid.length, 2);
  assert.equal(summary.unpaid.length, 5);
  assert.equal(summary.pending.length, 3);
  assert.equal(summary.paidAmount, 6130500);
  assert.equal(summary.unpaidAmount, 10914400);
  assert.equal(summary.unreadAmounts, 1);
  assert.ok(summary.pending.every(b => summary.unpaid.includes(b)));
  const filtered = report(data, "other-advisor");
  assert.deepEqual(filtered.paid, []);
  assert.deepEqual(filtered.unpaid.map(b => b.id), ["missing-date"]);
  assert.equal(filtered.pending.length, 1);
  assert.equal(filtered.unpaidAmount, bill.amount_paise);
  assert.equal(report(data, "no-advisor").unpaid.length, 0);
});
test("India midnight is reported on the correct day", () => {
  assert.equal(indiaDate("2026-11-03T18:29:59Z"), "2026-11-03");
  assert.equal(indiaDate("2026-11-03T18:30:00Z"), "2026-11-04");
});
test("cashier daily analytics includes pending invoices and tracks their current payment status", () => {
  let data = fixtureSnapshot();
  const day = "2026-11-05";
  data.bills.forEach(b => { b.invoice_date = day; });
  data.bills[5].amount_paise = null;
  const bill = data.bills[4];
  data.bills.push(
    { ...bill, id: "other-day", invoice_date: "2026-11-04" },
    { ...bill, id: "missing-date", invoice_date: null },
    { ...bill, id: "draft", uploads: { original_filename: "draft.pdf", confirmed_at: null } },
    { ...bill, id: "note", amount_paise: null, amount_evidence: "No monetary total stated; supporting note", field_confidence: { document: { kind: "warranty_note", billType: "Warranty", billedTo: "", typeEvidence: "" } } },
  );
  data.payments.push({ ...data.payments[0], id: "archived", bill_id: data.bills[2].id, amount_paise: data.bills[2].amount_paise!, is_archived: true });
  assert.deepEqual(cashierDailyReport(data, day), { bills: 6, paid: 2, unpaid: 4, billedAmount: 12969700, paidAmount: 6130500, unpaidAmount: 6839200, unreadAmounts: 1 });
  const cashier = data.staff.find(p => p.role === "cashier")!;
  data = demoAction(data, cashier, "collect", bill.id);
  // Payment on a later day still settles the invoice in its original day's summary.
  data.payments.at(-1)!.occurred_at = "2026-11-06T18:30:00Z";
  const paid = cashierDailyReport(data, day);
  assert.equal(paid.paid, 3); assert.equal(paid.unpaid, 3);
  assert.equal(paid.billedAmount, paid.paidAmount + paid.unpaidAmount);
  data = demoAction(data, data.staff.find(p => p.role === "super_admin")!, "reverse", data.payments.at(-1)!.id, "Correction");
  assert.equal(cashierDailyReport(data, day).unpaid, 4);
  assert.deepEqual(cashierDailyReport(data, "2026-11-07"), { bills: 0, paid: 0, unpaid: 0, billedAmount: 0, paidAmount: 0, unpaidAmount: 0, unreadAmounts: 0 });
});
test("customer groups span bills and vehicles without merging names alone", () => {
  const data = fixtureSnapshot();
  const groups = groupCustomers(data.bills);
  const asha = groups.find(g=>g.name==="Asha Nair")!;
  assert.equal(asha.bills.length,2);
  assert.equal(asha.total,3488100);
  const bill = data.bills[0];
  assert.equal(customerKey(bill),customerKey({...bill,vin:"DIFFERENT",vehicle_no_display:"OTHER"}));
  assert.notEqual(customerKey(bill),customerKey({...bill,customer_reference:"OTHER"}));
  const unknown={...bill,customer_reference:null,vin:"",vehicle_no_display:""};
  assert.notEqual(customerKey(unknown),customerKey({...unknown,id:"another"}));
  const fallback={...bill,customer_reference:null};
  assert.equal(customerKey(fallback),customerKey({...fallback,customer_name:" asha  NAIR "}));
  assert.notEqual(customerKey(fallback),customerKey({...fallback,vin:"MA3FJEB1S00A99999"}));
});
test("customer IDs preserve leading zeros and ambiguous IDs are not guessed", () => {
  assert.equal(extractCustomerReference("Customer ID: 00013680"),"00013680");
  assert.equal(extractCustomerReference("Customer ID C16008923"),"C16008923");
  assert.equal(extractCustomerReference("Customer ID C16008923\nCustomer ID C16008924"),"");
});
test("old demo partials remain archived without inventing a full collection", () => {
  const data=fixtureSnapshot(); delete data.schema_version;
  data.payments[0].amount_paise=500000;
  const migrated=upgradeDemo(data);
  assert.equal(migrated.payments[0].amount_paise,500000);
  assert.equal(migrated.payments[0].is_archived,true);
  assert.equal(balance(migrated.bills[0],migrated.payments),2000000);
  const full=structuredClone(data);
  full.payments.push({...full.payments[0],id:"old-second",amount_paise:1500000});
  const reconciled=upgradeDemo(full);
  assert.equal(balance(reconciled.bills[0],reconciled.payments),0);
  assert.equal(reconciled.payments.filter(p=>p.bill_id==="sample-0"&&!p.is_archived).length,1);
});
const samples: [string, number, string, string][] = [
  ["ACA1145.pdf",4075200,"2026-09-23","ACA/26-27/1145"], ["ATA545.pdf",1488100,"2026-08-31","AA26-01545"],
  ["INA2600101.pdf",4130500,"2026-04-22","INA26-00101"], ["TXA24-23030.pdf",1275900,"2025-01-22","TXA24-23030"],
];
for (const [file, amount, date, reference] of samples) test("PDF extraction: " + file, { skip: !existsSync(file) }, async () => {
  const result = await extractBills(new Uint8Array(readFileSync(file)));
  assert.equal(result.bills.length,1,"Continuation pages must remain one invoice");
  assert.equal(result.bills[0].amountPaise,amount);
  assert.equal(result.bills[0].invoiceDate,date);
  assert.equal(result.bills[0].invoiceReference,reference);
  assert.ok(result.bills[0].customerName);
  assert.ok(!/^(ID|Invoice No|Customer Add)/.test(result.bills[0].customerName));
  assert.deepEqual(result.bills[0].paymentEvidence,[]);
  const expected: Record<string,string>={"ACA1145.pdf":"","ATA545.pdf":"00013680","INA2600101.pdf":"I22307224","TXA24-23030.pdf":"C16008923"};
  assert.equal(result.bills[0].customerReference,expected[file]);
});

test("local workspace starts empty, with no fabricated bills or payments", () => {
  assert.equal(freshDemo().bills.length,0);
  assert.equal(freshDemo().payments.length,0);
});
test("reference import removes only built-in samples and preserves decisions on repeats", () => {
  const existing=fixtureSnapshot();
  const real={...existing.bills[0],id:"user-upload",upload_id:"user-upload",uploads:{original_filename:"user.pdf",confirmed_at:new Date().toISOString(),file_hash:"user-hash"}};
  existing.bills.push(real);
  const imported={...real,id:"reference",upload_id:"reference",reference_file:"ATA545.pdf",bill_type:"Counter sales",approval_status:"pending" as const,approved_at:null,approved_by:null,uploads:{original_filename:"ATA545.pdf",confirmed_at:new Date().toISOString(),file_hash:"reference-hash"}};
  const first=importReferenceBills(existing,[imported]);
  assert.deepEqual(first.bills.map(b=>b.id),["user-upload","reference"]);
  assert.equal(first.payments.length,0);
  assert.equal(existing.bills.length,7,"Original snapshot remains available for backup");
  first.bills[1].approval_status="approved";
  first.bills[1].approved_by="demo-cashier";
  const again=importReferenceBills(first,[imported]);
  assert.equal(again.bills.length,2);
  assert.equal(again.bills[1].approval_status,"approved");
  assert.equal(again.audit.length,1);
});
test("three reference files use the real parser with supplied types and no invented payment state",
  {skip:!["ATA545.pdf","ACA1145.pdf","INA2600101.pdf"].every(f=>existsSync(f))},async()=>{
  const bills=await parseReferenceBills();
  assert.equal(bills.length,3);
  assert.equal(bills.reduce((s,b)=>s+b.amount_paise!,0),9693800);
  assert.deepEqual(bills.map(b=>b.bill_type),["Counter sales","Accessories · non-TGA","Insurance claim"]);
  assert.ok(bills.every(b=>b.approval_status==="pending"&&b.approved_by===null&&b.reference_file&&b.uploads?.file_hash));
  assert.equal(importReferenceBills(importReferenceBills(freshDemo(),bills),await parseReferenceBills()).bills.length,3);
});

test("single-step payment rejects incomplete, duplicate and draft bills without recording a collection", () => {
  const data = fixtureSnapshot();
  const cashier = data.staff.find(p => p.role === "cashier")!;
  const bill = data.bills.find(b => b.id === "sample-4")!;
  for (const change of [{ amount_paise: null }, { invoice_date: null }, { invoice_reference: " " }, { invoice_reference: data.bills[0].invoice_reference }, { uploads: { original_filename: "draft.pdf", confirmed_at: null } }]) {
    const invalid = structuredClone(data);
    Object.assign(invalid.bills.find(b => b.id === bill.id)!, change);
    assert.throws(() => demoAction(invalid, cashier, "collect", bill.id));
    assert.equal(invalid.payments.length, data.payments.length);
    assert.equal(invalid.bills.find(b => b.id === bill.id)!.approval_status, "pending");
  }
  bill.amount_paise = 0;
  const paid = demoAction(data, cashier, "collect", bill.id);
  assert.equal(paid.bills.find(b => b.id === bill.id)!.approval_status, "approved");
  assert.equal(paid.payments.length, data.payments.length);
  assert.equal(paid.audit[0].action, "collect");
});
