import assert from "node:assert/strict";
import test from "node:test";
import { fixtureSnapshot } from "./test-fixtures";
import { balance, cashierDailyReport, indiaDate, type DeskBill } from "./desk";
import { cashierRows, demoSettlement, normalizeSettlementRequest, payerBalance, releaseCleared, rupees, sameVehicleBills } from "./settlement";
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

test("credit and insurance record actual collections and release permissions separately", () => {
 let data = fixtureSnapshot(); data.payments = [];
 const cashier = data.staff.find(p => p.role === "cashier")!, admin = data.staff.find(p => p.role === "super_admin")!;
 const bill = data.bills[0];
 const request = normalizeSettlementRequest({ action: "arrange", requestId: crypto.randomUUID(), entries: [{ billId: bill.id, amountPaise: 200000, customerSharePaise: 200000 }], kind: "insurance", payer: "customer", details: { insurer: "Test insurer" }, method: "Cash" });
 data = demoSettlement(data, cashier, request);
 assert.deepEqual(demoSettlement(data, cashier, request), data);
 assert.equal(payerBalance(data.bills[0], data.payments), 0);
 assert.equal(payerBalance(data.bills[0], data.payments, "insurer"), 1800000);
 assert.equal(balance(data.bills[0], data.payments), 1800000);
 assert.equal(releaseCleared(data.bills[0], data.payments), true);
 assert.ok(cashierRows(data, "receivables", indiaDate(), "").some(b => b.id === bill.id));
 assert.ok(!cashierRows(data, "archive", indiaDate(), "").some(b => b.id === bill.id));
 assert.equal(cashierDailyReport(data, indiaDate()).collectedAmount, 200000);
 data = demoAction(data, admin, "reverse", data.payments[0].id, "Wrong entry");
 assert.equal(releaseCleared(data.bills[0], data.payments), false);
 const creditBill = data.bills[1];
 const credit = normalizeSettlementRequest({ action: "arrange", requestId: crypto.randomUUID(), entries: [{ billId: creditBill.id, amountPaise: 100000 }], kind: "credit", payer: "customer", method: "Cash", details: { approvedBy: "Manager", approvedOn: "2026-11-20", dueDate: "2026-12-01" } });
 data = demoSettlement(data, cashier, credit);
 assert.equal(releaseCleared(data.bills[1], data.payments), true);
 assert.equal(data.bills[1].credit_limit_paise, creditBill.amount_paise! - 100000);
 data = demoAction(data, admin, "reverse", data.payments.at(-1)!.id, "Deposit incorrect");
 assert.equal(releaseCleared(data.bills[1], data.payments), false, "reversal cannot enlarge authorized credit");
});

test("combined demo collection is atomic and validates amounts, references and approvals", () => {
 const data = fixtureSnapshot(); data.payments = [];
 const cashier = data.staff.find(p => p.role === "cashier")!;
 const body = { action: "collect_batch", requestId: crypto.randomUUID(), entries: [{ billId: data.bills[0].id, amountPaise: data.bills[0].amount_paise! }, { billId: data.bills[2].id, amountPaise: data.bills[2].amount_paise! }], payer: "customer", method: "GPay", transactionId: "0001", details: {} };
 assert.throws(() => demoSettlement(data, cashier, normalizeSettlementRequest(body)), /one customer and vehicle/);
 assert.equal(data.payments.length, 0);
 data.bills[2].vehicle_no_display = data.bills[0].vehicle_no_display;
 const next = demoSettlement(data, cashier, normalizeSettlementRequest(body));
 assert.equal(next.payments.length, 2); assert.equal(next.payments[0].transaction_id, "0001");
 assert.equal(new Set(next.payments.map(p => p.collection_id)).size, 1);
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
