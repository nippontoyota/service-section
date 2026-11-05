// Synthetic records are test-only; the application never imports this module.
import { indiaDate, type Snapshot, type Staff, type Payment } from "./desk";
import { demoAccounts } from "./desk-demo";
export function fixtureSnapshot(): Snapshot {
  const now = new Date().toISOString();
  const date = indiaDate();
  const staff: Staff[] = demoAccounts.map(p => ({ id: p.id, staff_id: p.staff_id, full_name: p.full_name, role: p.role, active: true, must_change_password: false }));
  const bills = ["Asha Nair", "Rahul Menon", "Asha Nair", "Suresh Kumar", "Priya Das", "Arjun Nair"].map((name, i) => ({
    customer_reference: i === 2 ? "DEMO-CUSTOMER-0" : "DEMO-CUSTOMER-" + i,
    customer_id: "demo-customer:REF:DEMOCUSTOMER" + (i === 2 ? 0 : i),
    id: "sample-" + i, upload_id: "sample-upload-" + i, customer_name: name, vehicle_no_display: "KL 07 AB " + (1234 + i),
    vin: "MA3FJEB1S00A1234" + i, invoice_reference: "DEMO-260" + i, invoice_date: date,
    amount_paise: [2000000, 4130500, 1488100, 1275900, 4075200, 950000][i],
    created_at: now, uploaded_by: "demo-advisor", approved_at: i < 4 ? now : null,
    approved_by: i < 4 ? "demo-cashier" : null, approval_status: i < 4 ? "approved" as const : "pending" as const,
    status: "ready", page_from: 1, page_to: 1, extraction_issues: [], payment_evidence: [],
    amount_evidence: "Synthetic demo invoice total", uploads: { original_filename: "demo-service-bill.pdf", confirmed_at: now },
  }));
  const payments: Payment[] = [
    { id: "sample-payment-0", bill_id: bills[0].id, amount_paise: bills[0].amount_paise, method: "not stated", occurred_at: now, recorded_at: now, recorded_by: "demo-cashier", source: "cashier", reversal_of: null, reason: null },
    { id: "sample-payment-1", bill_id: bills[1].id, amount_paise: bills[1].amount_paise, method: "not stated", occurred_at: now, recorded_at: now, recorded_by: "demo-cashier", source: "cashier", reversal_of: null, reason: null },
  ];
  return { bills, payments, staff, audit: [], as_of: now, schema_version: 2 };
}
