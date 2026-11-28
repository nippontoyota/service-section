import assert from "node:assert/strict";
import test from "node:test";
import { fixtureSnapshot } from "./test-fixtures";
import { balance, cashierDailyReport, indiaDate, type DeskBill } from "./desk";
import { cashierRows, demoSettlement, normalizeSettlementRequest, payerBalance, releaseCleared, rupees, sameCustomerBills, sameVehicleBills } from "./settlement";
import { demoAction } from "./desk-demo";
import { gatePassDocument } from "./gate-pass-document";

test("today uses submission date, search spans all dates and repeated tokens stay separate", () => {
 const data = fixtureSnapshot(); data.payments = [];
 data.bills[0].uploads!.confirmed_at = "2026-11-19T18:29:59Z";
 data.bills[2].uploads!.confirmed_at = "2026-11-19T18:30:00Z";
 data.bills[0].token_number = data.bills[2].token_number = "1";
 data.bills[2].invoice_date = "2026-10-01";
 assert.equal(cashierRows(data, "overview", "2026-11-20", "").some(b => b.id === data.bills[0].id), false);
 assert.equal(cashierRows(data, "overview", "2026-11-20", "").some(b => b.id === data.bills[2].id), true);
 assert.equal(cashierRows(data, "overview", "2026-11-20", "Asha").length, 2);
 assert.ok(cashierRows(data, "overview", "2026-11-20", "1").some(b => b.id === data.bills[0].id));
 assert.equal(sameVehicleBills(data.bills[0], data.bills).length, 1, "customer's other vehicle is excluded");
 data.bills[2].vehicle_no_display = data.bills[0].vehicle_no_display.replaceAll(" ", "");
 assert.equal(sameVehicleBills(data.bills[0], data.bills).length, 2);
 data.bills[0].vehicle_no_display = data.bills[2].vehicle_no_display = "";
 assert.equal(sameVehicleBills(data.bills[0], data.bills).length, 1);
});

test("legacy insurance release permission is preserved and respects payment reversal", () => {
 let data = fixtureSnapshot(); data.payments = [];
 const bill = data.bills[0], cashier = data.staff.find(p => p.role === "cashier")!, admin = data.staff.find(p => p.role === "super_admin")!;
 bill.settlement = { id: crypto.randomUUID(), number: 1, kind: "insurance", state: "legacy_approved", details: { insurer: "Legacy insurer" }, revoked: false, created_at: new Date().toISOString(), recorded_by: cashier.id };
 bill.customer_share_paise = 200000;
 data = demoSettlement(data, cashier, normalizeSettlementRequest({ action: "collect_batch", requestId: crypto.randomUUID(), entries: [{ billId: bill.id, amountPaise: 200000 }], payer: "customer", details: {}, method: "Cash" }));
 assert.equal(payerBalance(data.bills[0], data.payments), 0);
 assert.equal(payerBalance(data.bills[0], data.payments, "insurer"), 1800000);
 assert.equal(balance(data.bills[0], data.payments), 1800000);
 assert.equal(releaseCleared(data.bills[0], data.payments), true);
 assert.ok(cashierRows(data, "receivables", indiaDate(), "").some(b => b.id === bill.id));
 assert.equal(cashierDailyReport(data, indiaDate()).collectedAmount, 200000);
 data = demoAction(data, admin, "reverse", data.payments[0].id, "Wrong entry");
 assert.equal(releaseCleared(data.bills[0], data.payments), false);
});

test("combined demo collection is atomic and validates amounts, references and approvals", () => {
 const data = fixtureSnapshot(); data.payments = [];
 const cashier = data.staff.find(p => p.role === "cashier")!;
 const body = { action: "collect_batch", requestId: crypto.randomUUID(), entries: [{ billId: data.bills[0].id, amountPaise: data.bills[0].amount_paise! }, { billId: data.bills[2].id, amountPaise: data.bills[2].amount_paise! }], payer: "customer", method: "GPay", transactionId: "0001", details: {} };
 assert.equal(sameCustomerBills(data.bills[0], data.bills).length, 2);
 const wrongCustomer = { ...body, entries: [body.entries[0], { billId: data.bills[1].id, amountPaise: data.bills[1].amount_paise! }] };
 assert.throws(() => demoSettlement(data, cashier, normalizeSettlementRequest(wrongCustomer)), /one customer/);
 assert.equal(data.payments.length, 0);
 const unread = structuredClone(data); unread.bills[2].invoice_date = null;
 assert.throws(() => demoSettlement(unread, cashier, normalizeSettlementRequest(body)), /Readable submitted/);
 assert.equal(unread.payments.length, 0);
 const draft = structuredClone(data); draft.bills[2].uploads!.confirmed_at = null;
 assert.throws(() => demoSettlement(draft, cashier, normalizeSettlementRequest(body)), /Readable submitted/);
 const next = demoSettlement(data, cashier, normalizeSettlementRequest(body));
 assert.equal(next.payments.length, 2); assert.equal(next.payments[0].transaction_id, "0001");
 assert.equal(new Set(next.payments.map(p => p.collection_id)).size, 1);
 assert.equal(next.bills[0].status, "paid"); assert.equal(next.bills[2].status, "paid");
 assert.deepEqual(next.bills[1], data.bills[1], "unselected bill stays unchanged");
 assert.deepEqual(demoSettlement(next, cashier, normalizeSettlementRequest(body)), next, "retry does not duplicate payments");
 const credit = { ...body, action: "arrange", kind: "credit", details: { approvedBy: "Manager", approvedOn: "2026-11-28", dueDate: "2026-12-01" } };
 assert.throws(() => demoSettlement(data, cashier, normalizeSettlementRequest(credit)), /Refresh/);
 assert.throws(() => normalizeSettlementRequest({ ...body, transactionId: " " }), /required/);
 assert.throws(() => normalizeSettlementRequest({ ...body, action: "arrange", kind: "credit" }), /approver/);
 assert.throws(() => normalizeSettlementRequest({ ...body, entries: [body.entries[0], body.entries[0]] }), /only be selected once/);
 assert.throws(() => normalizeSettlementRequest({ ...body, entries: [{ ...body.entries[0], amountPaise: -1 }] }), /Invalid/);
 assert.equal(rupees("2000.01"), 200001);
 for (const value of ["1e3", "NaN", "-1", "1.234", ""]) assert.throws(() => rupees(value));
 const missing: DeskBill = { ...data.bills[0], amount_paise: null };
 assert.equal(releaseCleared(missing, []), false);
});

test("gate-pass print document escapes user text and includes all photographed fields and QR", () => {
 const html = gatePassDocument({ id: "test", status: "Valid", number: 123, customerName: '<script>alert("x")</script>', vehicle: "KL01AB1234", issuedBy: "Cashier", issuedAt: "2026-11-19T18:30:00Z", expiresAt: "2026-11-20T18:30:00Z", documents: [{ billId: "1", invoiceNumber: "INV-1", invoiceDate: "2026-11-19", jobNumber: "RO-1", jobDate: "2026-11-18" }] }, "data:image/png;base64,AAA", "test-nonce");
 assert.ok(html.includes("GP-000123")); assert.ok(html.includes("20/11/2026"));
 assert.ok(html.includes("R.O./W.O. No.")); assert.ok(html.includes("Tax Inv. No."));
 assert.ok(html.includes("RO-1")); assert.ok(html.includes("INV-1")); assert.ok(html.includes("Gate pass QR code"));
 assert.ok(html.includes("Signature of Cashier / Advisor")); assert.ok(html.includes("A5 portrait"));
 assert.ok(!html.includes('<script>alert("x")</script>')); assert.ok(html.includes("&lt;script&gt;"));
 assert.ok(gatePassDocument({ status: "Invalid" }, "", "nonce").includes("Invalid"));
});
