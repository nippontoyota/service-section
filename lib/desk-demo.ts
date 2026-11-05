import { collected, customerKey, type Snapshot, type Staff } from "./desk";
export const DEMO_KEY = "service-desk-finance-demo-v1";
export const demoAccounts = [
  { id: "demo-cashier", staff_id: "cashier01", full_name: "Riya Nair", role: "cashier", password: "CashierDemo!2026" },
  { id: "demo-advisor", staff_id: "advisor01", full_name: "Amal Joseph", role: "service_advisor", password: "AdvisorDemo!2026" },
  { id: "demo-admin", staff_id: "admin01", full_name: "Centre Administrator", role: "super_admin", password: "AdminDemo!2026" },
] as const;
export function freshDemo(): Snapshot {
  const staff: Staff[] = demoAccounts.map(p => ({ id:p.id,staff_id:p.staff_id,full_name:p.full_name,role:p.role,active:true,must_change_password:false }));
  return { bills:[],payments:[],staff,audit:[],as_of:new Date().toISOString(),schema_version:2 };
}
export function upgradeDemo(snapshot: Snapshot): Snapshot {
  if (snapshot.schema_version === 2) return snapshot;
  const next = structuredClone(snapshot);
  for (const b of next.bills) {
    b.customer_id = b.customer_id || "demo-customer:" + customerKey(b);
    if (next.payments.some(p => p.bill_id === b.id && !p.is_archived && Math.abs(p.amount_paise) !== b.amount_paise)) {
      const net = collected(b,next.payments);
      const last = next.payments.filter(p => p.bill_id === b.id && p.amount_paise > 0 && !p.is_archived).at(-1);
      for (const p of next.payments) if (p.bill_id === b.id) p.is_archived = true;
      if (last && net === b.amount_paise && net > 0) next.payments.push({ ...last, id:crypto.randomUUID(),amount_paise:net,source:"cashier",method:"not stated",is_archived:false });
      next.audit.unshift({ id: crypto.randomUUID(), bill_id: b.id, actor_id: b.uploaded_by, action: "legacy_payment_history_preserved", created_at: new Date().toISOString(), detail: { reason: "Previous payment history preserved; the current workflow records full invoices only." } });
    }
    b.payment_evidence = [];
  }
  next.schema_version = 2;
  return next;
}
export function demoAction(snapshot: Snapshot, user: Staff, action: string, target: string, reason = ""): Snapshot {
  const next = structuredClone(snapshot);
  if (!user.active) throw new Error("Account disabled");
  let bill = next.bills.find(b => b.id === target);
  const now = new Date().toISOString();
  if (action === "reverse") {
    if (user.role !== "super_admin" || reason.trim().length < 3) throw new Error("Admin and reversal reason required");
    const payment = next.payments.find(p => p.id === target && p.source !== "reversal" && !p.is_archived);
    if (!payment) throw new Error("Payment not found");
    if (next.payments.some(p => p.reversal_of === target)) return next;
    bill = next.bills.find(b => b.id === payment.bill_id);
    next.payments.push({ ...payment, id: crypto.randomUUID(), amount_paise: -payment.amount_paise, occurred_at: now, recorded_at: now, source: "reversal", reversal_of: target, recorded_by: user.id, reason });
  } else {
    if (user.role !== "cashier" || !bill?.uploads?.confirmed_at) throw new Error("Cashier and submitted bill required");
    if (action === "approve") {
      if (bill.approval_status === "approved") return next;
      if (bill.amount_paise === null || !bill.invoice_date || !bill.invoice_reference) throw new Error("Upload a PDF with a readable total, date and invoice number");
      const approving = bill;
      if (next.bills.some(b => b.id !== approving.id && b.approval_status === "approved" && b.invoice_reference?.trim().toUpperCase() === approving.invoice_reference?.trim().toUpperCase())) throw new Error("This invoice has already been approved");
      bill.approval_status = "approved"; bill.approved_at = now; bill.approved_by = user.id;
    } else if (action === "collect") {
      if (bill.approval_status !== "approved") throw new Error("Approve this bill first");
      const received = collected(bill, next.payments);
      if (received === bill.amount_paise) return next;
      if (received !== 0 || bill.amount_paise === null) throw new Error("Only full-bill collection is supported");
      next.payments.push({ id: crypto.randomUUID(), bill_id: bill.id, amount_paise: bill.amount_paise, method: "not stated", occurred_at: now, recorded_at: now, recorded_by: user.id, source: "cashier", reversal_of: null, reason: null });
    } else throw new Error("Unknown operation");
  }
  if (bill) next.audit.unshift({ id: crypto.randomUUID(), bill_id: bill.id, actor_id: user.id, action, created_at: now, detail: { target, reason } });
  next.as_of = now;
  return next;
}
export async function demoPdf(id: string, file?: File): Promise<Blob | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("service-desk-demo-pdfs", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("pdfs");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("pdfs", file ? "readwrite" : "readonly");
      const request = file ? tx.objectStore("pdfs").put(file, id) : tx.objectStore("pdfs").get(id);
      tx.oncomplete = () => { db.close(); resolve(file ?? request.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
