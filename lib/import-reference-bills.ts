import type { DeskBill, Snapshot } from "./desk";

export function isBuiltInSample(bill: DeskBill) {
  return /^sample-\d+$/.test(bill.id) && bill.uploads?.original_filename === "demo-service-bill.pdf";
}
export function importReferenceBills(snapshot: Snapshot, incoming: DeskBill[]): Snapshot {
  const next = structuredClone(snapshot);
  const removed = new Set(next.bills.filter(isBuiltInSample).map(b => b.id));
  next.bills = next.bills.filter(b => !removed.has(b.id));
  next.payments = next.payments.filter(p => !removed.has(p.bill_id));
  next.audit = next.audit.filter(a => !a.bill_id || !removed.has(a.bill_id));
  for (const bill of incoming) {
    const existing = next.bills.find(b => b.id === bill.id || (b.uploads?.file_hash === bill.uploads?.file_hash && b.page_from === bill.page_from && b.page_to === bill.page_to));
    if (existing) {
      // Preserve original IDs, approval/collection decisions and financial values.
      existing.bill_type = bill.bill_type;
      existing.reference_file = bill.reference_file;
      continue;
    }
    next.bills.push(bill);
    next.audit.unshift({id:"import-" + bill.id,bill_id:bill.id,actor_id:"demo-advisor",action:"local_pdf_import",created_at:bill.created_at,detail:{filename:bill.reference_file}});
  }
  next.as_of = new Date().toISOString();
  return next;
}
