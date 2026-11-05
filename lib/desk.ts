export type Role = "cashier" | "service_advisor" | "super_admin";
export type Staff = { id: string; staff_id: string; full_name: string; role: Role; active: boolean; must_change_password: boolean };
export type PaymentEvidence = { amount_paise: number; method: string; date: string; evidence: string };
export type BillDocument = {
  kind: "invoice" | "warranty_note" | "amc_note" | "unknown";
  billType: string;
  billedTo: string;
  typeEvidence: string;
};
export type DeskBill = {
  bill_type?: string; reference_file?: string;
  job_card_reference?: string | null;
  field_confidence?: { document?: BillDocument };
  customer_id?: string; customer_reference?: string | null;
  id: string; upload_id: string; customer_name: string; vehicle_no_display: string; vin: string;
  invoice_reference: string | null; invoice_date: string | null; amount_paise: number | null;
  uploaded_by: string; created_at: string; approved_at: string | null; approved_by: string | null;
  approval_status: "pending" | "approved"; status: string; page_from: number; page_to: number;
  extraction_issues: string[]; amount_evidence: string; payment_evidence: PaymentEvidence[];
  uploads?: { original_filename: string; confirmed_at: string | null; file_hash?: string };
};
export type Payment = { id: string; bill_id: string; amount_paise: number; method: string; occurred_at: string; recorded_at: string; recorded_by: string; source: string; reversal_of: string | null; reason: string | null; is_archived?: boolean };
export type Audit = { id: string; bill_id: string | null; actor_id: string; action: string; created_at: string; detail: Record<string, unknown> };
export type DraftUpload = { id: string; original_filename: string; status: string; processing_error: string | null; bills: DeskBill[] };
export type Snapshot = { drafts?: DraftUpload[]; bills: DeskBill[]; payments: Payment[]; staff: Staff[]; audit: Audit[]; as_of: string; schema_version?: number };
export type Metric = "paid" | "unpaid" | "pending";
export const money = (paise: number | null) => paise === null ? "Not extracted" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);
export const billType = (bill: DeskBill) => bill.field_confidence?.document?.billType || bill.bill_type || "Type not identified";
export const isSupportingNote = (bill: DeskBill) => bill.amount_paise === null
  && ["warranty_note", "amc_note"].includes(bill.field_confidence?.document?.kind ?? "")
  && bill.amount_evidence.startsWith("No monetary total stated;");
export const billAmount = (bill: DeskBill) => isSupportingNote(bill) ? "No amount stated" : money(bill.amount_paise);
export const indiaDate = (value = new Date().toISOString()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
export const collected = (bill: DeskBill, payments: Payment[]) => payments.filter(p => p.bill_id === bill.id && !p.is_archived).reduce((sum, p) => sum + p.amount_paise, 0);
export const balance = (bill: DeskBill, payments: Payment[]) => bill.amount_paise === null ? null : bill.amount_paise - collected(bill, payments);
export const isPaid = (bill: DeskBill, payments: Payment[]) => bill.approval_status === "approved" && bill.amount_paise !== null && collected(bill, payments) === bill.amount_paise;
export function customerKey(bill: Pick<DeskBill,"id"|"customer_reference"|"customer_name"|"vin"|"vehicle_no_display">) {
  const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ref = normalize(bill.customer_reference ?? "");
  if (ref) return "REF:" + ref;
  const name = normalize(bill.customer_name);
  const vin = normalize(bill.vin);
  const vehicle = normalize(bill.vehicle_no_display);
  if (name && vin.length === 17) return "VIN:" + vin + ":" + name;
  if (name && vehicle) return "VEHICLE:" + vehicle + ":" + name;
  return "UNMATCHED:" + bill.id;
}
export function groupCustomers(bills: DeskBill[]) {
  const groups = new Map<string, { id: string; name: string; reference: string | null; bills: DeskBill[]; total: number; missingAmounts: number }>();
  for (const bill of bills) {
    const id = bill.customer_id || customerKey(bill);
    const group = groups.get(id) ?? { id, name: bill.customer_name || "Unidentified customer", reference: bill.customer_reference || null, bills: [], total: 0, missingAmounts: 0 };
    group.bills.push(bill);
    if (bill.amount_paise === null) { if (!isSupportingNote(bill)) group.missingAmounts++; } else group.total += bill.amount_paise;
    groups.set(id, group);
  }
  return [...groups.values()];
}
export function report(snapshot: Snapshot, staffId = "") {
  const bills = snapshot.bills.filter(b => b.uploads?.confirmed_at && !isSupportingNote(b) && (!staffId || b.uploaded_by === staffId));
  const paid = bills.filter(b => isPaid(b, snapshot.payments));
  const unpaid = bills.filter(b => !isPaid(b, snapshot.payments));
  const pending = unpaid.filter(b => b.approval_status !== "approved");
  const total = (rows: DeskBill[]) => rows.reduce((sum, b) => sum + (b.amount_paise ?? 0), 0);
  return { paid, unpaid, pending, paidAmount: total(paid), unpaidAmount: total(unpaid),
    unreadAmounts: unpaid.filter(b => b.amount_paise === null).length };
}

export function cashierView(bill: DeskBill, payments: Payment[]) {
  if (!bill.uploads?.confirmed_at) return null;
  if (isSupportingNote(bill) || isPaid(bill, payments)) return "archive";
  return "overview";
}

export function cashierDailyReport(snapshot: Snapshot, day: string) {
  const bills = snapshot.bills.filter(b => b.uploads?.confirmed_at && b.invoice_date === day && !isSupportingNote(b));
  const paid = bills.filter(b => isPaid(b, snapshot.payments));
  const unpaid = bills.filter(b => !isPaid(b, snapshot.payments));
  const total = (rows: DeskBill[]) => rows.reduce((sum, b) => sum + (b.amount_paise ?? 0), 0);
  return { bills: bills.length, paid: paid.length, unpaid: unpaid.length,
    billedAmount: total(bills), paidAmount: total(paid), unpaidAmount: total(unpaid),
    unreadAmounts: bills.filter(b => b.amount_paise === null).length };
}
