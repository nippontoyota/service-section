import { balance, collected, customerKey, indiaDate, isPaid, isSupportingNote, paymentMethod, transactionId, type DeskBill, type Payment, type Snapshot, type Staff } from "./desk";

export type SettlementDetails = {
  insurer?: string; contactPerson?: string; contactNumber?: string; responsibleStaff?: string;
  approvedBy?: string; approvedOn?: string; dueDate?: string; remarks?: string;
  followup1?: string; followup2?: string;
};
export type Settlement = { id: string; number: number; kind: "insurance" | "credit"; details: SettlementDetails; revoked: boolean; created_at: string; recorded_by: string | null };
export type SettlementEntry = { billId: string; amountPaise: number; customerSharePaise?: number };
export type SettlementRequest = {
  action: "collect_batch" | "arrange" | "update_settlement" | "revoke_settlement";
  requestId: string; entries: SettlementEntry[]; payer: "customer" | "insurer";
  kind?: "insurance" | "credit"; settlementId?: string; details: SettlementDetails;
  method: string; transactionId: string | null;
};
export const vehicleKey = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const submittedDay = (bill: DeskBill) => bill.uploads?.confirmed_at ? indiaDate(bill.uploads.confirmed_at) : "";
export function payerCollected(bill: DeskBill, payments: Payment[], payer: "customer" | "insurer") {
  return payments.filter(p => p.bill_id === bill.id && !p.is_archived && (p.payer || "customer") === payer).reduce((sum, p) => sum + p.amount_paise, 0);
}
export function payerBalance(bill: DeskBill, payments: Payment[], payer: "customer" | "insurer" = "customer") {
  if (bill.amount_paise === null) return null;
  const insurance = bill.settlement?.kind === "insurance";
  const share = insurance ? bill.customer_share_paise ?? bill.amount_paise : bill.amount_paise;
  return (payer === "customer" ? share : insurance ? bill.amount_paise - share : 0) - payerCollected(bill, payments, payer);
}
export function releaseCleared(bill: DeskBill, payments: Payment[]) {
  if (!bill.uploads?.confirmed_at) return false;
  if (isSupportingNote(bill) || isPaid(bill, payments)) return true;
  if (bill.approval_status !== "approved" || !bill.settlement || bill.settlement.revoked || bill.amount_paise === null) return false;
  return bill.settlement.kind === "insurance" ? payerBalance(bill, payments) === 0
    : balance(bill, payments)! <= (bill.credit_limit_paise ?? -1);
}
export function settlementStatus(bill: DeskBill, payments: Payment[]) {
  if (isSupportingNote(bill)) return "No collection required";
  if (isPaid(bill, payments)) return "Paid in full";
  if (bill.settlement?.revoked) return "Approval revoked";
  if (bill.settlement?.kind === "credit") return releaseCleared(bill, payments) ? "Credit outstanding" : "Credit needs review";
  if (bill.settlement?.kind === "insurance") return payerBalance(bill, payments) === 0 ? "Insurer outstanding" : "Customer share due";
  return collected(bill, payments) > 0 ? "Part paid" : "In progress";
}
export function sameVehicleBills(selected: DeskBill, bills: DeskBill[]) {
  const vehicle = vehicleKey(selected.vehicle_no_display);
  return bills.filter(b => b.uploads?.confirmed_at && (b.id === selected.id || (vehicle && vehicleKey(b.vehicle_no_display) === vehicle && (b.customer_id || customerKey(b)) === (selected.customer_id || customerKey(selected)))))
    .sort((a, b) => (a.invoice_date || "9999").localeCompare(b.invoice_date || "9999") || a.id.localeCompare(b.id));
}
export function sameCustomerBills(selected: DeskBill, bills: DeskBill[]) {
  const customer = selected.customer_id || customerKey(selected);
  return bills.filter(b => (b.customer_id || customerKey(b)) === customer)
    .sort((a, b) => (a.invoice_date || "9999").localeCompare(b.invoice_date || "9999") || a.id.localeCompare(b.id));
}
export function cashierRows(snapshot: Snapshot, tab: string, day: string, query: string) {
  const search = query.trim().toLowerCase();
  return snapshot.bills.filter(b => {
    if (!b.uploads?.confirmed_at) return false;
    const paid = isPaid(b, snapshot.payments) || isSupportingNote(b);
    const inView = tab === "archive" ? paid : tab === "receivables" ? !paid && Boolean(b.settlement) : !paid && !releaseCleared(b, snapshot.payments);
    // Search spans submitted history, including released receivables and paid bills.
    if (search) return [b.token_number, b.customer_name, b.customer_reference, b.vehicle_no_display, b.vin, b.invoice_reference, b.job_card_reference].some(v => v?.toLowerCase().includes(search));
    return inView && (tab !== "overview" || submittedDay(b) === day);
  });
}
export function rupees(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error("Enter a valid amount with up to two decimal places");
  const [whole, fraction = ""] = value.trim().split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > 100000000000) throw new Error("Amount is too large");
  return result;
}
export function normalizeSettlementRequest(body: Record<string, unknown>): SettlementRequest {
  if (!["collect_batch", "arrange", "update_settlement", "revoke_settlement"].includes(String(body.action))) throw new Error("Unknown settlement operation");
  if (typeof body.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.requestId)) throw new Error("Collection reference required");
  if (!Array.isArray(body.entries) || body.entries.length > 100 || ((body.action === "arrange" || body.action === "collect_batch") && !body.entries.length)) throw new Error("Select between 1 and 100 bills");
  const entries = body.entries.map((entry: SettlementEntry) => {
    if (!entry || typeof entry.billId !== "string" || !Number.isSafeInteger(entry.amountPaise) || entry.amountPaise < 0 || entry.amountPaise > 100000000000) throw new Error("Invalid bill allocation");
    if (entry.customerSharePaise !== undefined && (!Number.isSafeInteger(entry.customerSharePaise) || entry.customerSharePaise < 0 || entry.customerSharePaise > 100000000000)) throw new Error("Invalid customer share");
    return { billId: entry.billId, amountPaise: entry.amountPaise, ...(entry.customerSharePaise !== undefined ? { customerSharePaise: entry.customerSharePaise } : {}) };
  });
  if (new Set(entries.map(e => e.billId)).size !== entries.length) throw new Error("A bill can only be selected once");
  if (body.payer !== "customer" && body.payer !== "insurer") throw new Error("Select the payer");
  if (body.action === "arrange" && !["insurance", "credit"].includes(String(body.kind))) throw new Error("Select insurance or credit");
  const details: SettlementDetails = {};
  for (const key of ["insurer", "contactPerson", "contactNumber", "responsibleStaff", "approvedBy", "approvedOn", "dueDate", "remarks", "followup1", "followup2"] as const) {
    const value = (body.details as SettlementDetails | undefined)?.[key];
    if (value !== undefined && (typeof value !== "string" || value.length > 1000)) throw new Error("Invalid form details");
    if (value !== undefined) details[key] = value.trim();
  }
  for (const key of ["approvedOn", "dueDate"] as const) if (details[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(details[key]!) || new Date(details[key]!).toISOString().slice(0, 10) !== details[key])) throw new Error("Invalid date");
  if (body.action === "arrange") {
    if (body.payer !== "customer") throw new Error("Initial collection must be from the customer");
    if (body.kind === "insurance" && !details.insurer) throw new Error("Insurer name required");
    if (body.kind === "credit" && (!details.approvedBy || !details.approvedOn || !details.dueDate || details.dueDate < details.approvedOn)) throw new Error("Outside approver, approval date and valid due date required");
  }
  if (body.action === "revoke_settlement" && !details.remarks) throw new Error("A correction reason is required");
  const hasMoney = entries.some(e => e.amountPaise > 0);
  if (body.action === "collect_batch" && !hasMoney) throw new Error("Enter an amount to collect");
  const method = hasMoney ? paymentMethod(body.method, body.otherMethod) : "";
  return { action: body.action as SettlementRequest["action"], requestId: body.requestId, entries, payer: body.payer,
    kind: body.kind as SettlementRequest["kind"], settlementId: typeof body.settlementId === "string" ? body.settlementId : undefined,
    details, method, transactionId: hasMoney ? transactionId(body.transactionId, method) : null };
}

export function demoSettlement(snapshot: Snapshot, actor: Staff, request: SettlementRequest): Snapshot {
  if (!actor.active || actor.must_change_password || !["cashier", "super_admin"].includes(actor.role)) throw new Error("Cashier access required");
  const previous = snapshot.audit.find(a => a.detail.requestId === request.requestId);
  if (previous) { if (JSON.stringify(previous.detail.request) !== JSON.stringify(request)) throw new Error("Collection reference already used"); return snapshot; }
  const next = structuredClone(snapshot), now = new Date().toISOString();
  let bills: DeskBill[];
  if (request.action === "update_settlement" || request.action === "revoke_settlement") {
    bills = next.bills.filter(b => b.settlement?.id === request.settlementId);
    if (!bills.length) throw new Error("Settlement not found");
    if (request.action === "revoke_settlement" && actor.role !== "super_admin") throw new Error("Admin correction required");
    for (const bill of bills) {
      if (request.action === "revoke_settlement") bill.settlement!.revoked = true;
      else for (const key of ["followup1", "followup2", "remarks"] as const) if (request.details[key] !== undefined) bill.settlement!.details[key] = request.details[key];
    }
  } else {
    if (actor.role !== "cashier") throw new Error("Cashier role required");
    bills = request.entries.map(e => { const b = next.bills.find(b => b.id === e.billId); if (!b) throw new Error("Bill not found"); return b; });
    const allowed = request.action === "collect_batch" ? sameCustomerBills(bills[0], next.bills) : sameVehicleBills(bills[0], next.bills);
    if (bills.some(b => !allowed.includes(b) || !b.uploads?.confirmed_at || isSupportingNote(b) || b.amount_paise === null || !b.invoice_date || !b.invoice_reference?.trim())) throw new Error(request.action === "collect_batch" ? "Readable submitted bills for one customer required" : "Readable submitted bills for one customer and vehicle required");
    const settlement: Settlement | undefined = request.action === "arrange" ? { id: request.requestId, number: Math.max(0, ...next.bills.map(b => b.settlement?.number ?? 0)) + 1, kind: request.kind!, details: request.details, revoked: false, created_at: now, recorded_by: actor.id } : undefined;
    for (const [index, bill] of bills.entries()) {
      const entry = request.entries[index];
      if (settlement) {
        if (bill.settlement && !bill.settlement.revoked) throw new Error("Correct the existing arrangement before replacing it");
        const share = entry.customerSharePaise;
        if (settlement.kind === "insurance" && (share === undefined || share > bill.amount_paise! || share < payerCollected(bill, next.payments, "customer") + entry.amountPaise || bill.amount_paise! - share < payerCollected(bill, next.payments, "insurer"))) throw new Error("Customer share must cover collections and fit the invoice total");
        if (settlement.kind === "credit" && payerCollected(bill, next.payments, "insurer") > 0) throw new Error("Reverse insurer payments before changing to credit");
        bill.settlement = structuredClone(settlement); bill.customer_share_paise = settlement.kind === "insurance" ? share : null;
        bill.credit_limit_paise = settlement.kind === "credit" ? balance(bill, next.payments)! - entry.amountPaise : null;
      }
      if (entry.amountPaise > payerBalance(bill, next.payments, request.payer)!) throw new Error("Collection exceeds the outstanding balance");
      if (!bill.settlement && entry.amountPaise !== payerBalance(bill, next.payments)) throw new Error("Use a credit form for part payment");
      if (next.bills.some(b => b.id !== bill.id && b.approval_status === "approved" && b.invoice_reference?.trim().toUpperCase() === bill.invoice_reference?.trim().toUpperCase())) throw new Error("This invoice has already been approved");
      bill.approval_status = "approved"; bill.approved_at ||= now; bill.approved_by ||= actor.id;
      if (entry.amountPaise > 0) next.payments.push({ id: crypto.randomUUID(), bill_id: bill.id, amount_paise: entry.amountPaise, payer: request.payer, collection_id: request.requestId, method: request.method, transaction_id: request.transactionId, occurred_at: now, recorded_at: now, recorded_by: actor.id, source: "cashier", reversal_of: null, reason: null });
      bill.status = isPaid(bill, next.payments) ? "paid" : "ready";
    }
  }
  for (const bill of bills) next.audit.unshift({ id: crypto.randomUUID(), bill_id: bill.id, actor_id: actor.id, action: request.action, created_at: now, detail: { requestId: request.requestId, request } });
  next.as_of = now;
  return next;
}
