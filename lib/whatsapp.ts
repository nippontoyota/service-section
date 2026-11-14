import { billType, customerKey, type DeskBill } from "./desk";

export const customerLinkSeconds = 7 * 24 * 60 * 60;
export type BillContact = { phone: string | null; skipWhatsApp: boolean };

export const customerContactKey = (bill: DeskBill) => `${bill.uploaded_by}:${bill.customer_id || customerKey(bill)}`;

export function savedCustomerPhone(bill: DeskBill, candidates: DeskBill[]) {
  const numbers = new Set<string>();
  for (const candidate of candidates) {
    if (customerContactKey(candidate) !== customerContactKey(bill) || !candidate.customer_phone) continue;
    try { numbers.add(customerPhone(candidate.customer_phone)); } catch { /* Invalid saved values require fresh entry. */ }
  }
  return numbers.size > 1 ? "" : [...numbers][0] ?? "+91 ";
}

export function shareBillIds(value: unknown, selectedId: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
    || new Set(value).size !== value.length || !value.includes(selectedId)) throw new Error("Select the bills to include in this message");
  return value;
}

export function customerPhone(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !/^\+?[\d\s().-]+$/.test(value.trim())) {
    throw new Error("Enter a valid customer WhatsApp number with country code");
  }
  let phone = value.trim().replace(/[\s().-]/g, "");
  if (/^[6-9]\d{9}$/.test(phone)) phone = "+91" + phone;
  else if (/^91[6-9]\d{9}$/.test(phone)) phone = "+" + phone;
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || (phone.startsWith("+91") && !/^\+91[6-9]\d{9}$/.test(phone))) {
    throw new Error("Enter a valid customer WhatsApp number with country code");
  }
  return phone;
}

export function billContacts(value: unknown): Record<string, BillContact> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review the WhatsApp choice for every bill");
  return Object.fromEntries(Object.entries(value).map(([id, choice]) => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice) || typeof choice.skipWhatsApp !== "boolean") {
      throw new Error("Choose WhatsApp or explicitly skip it for every bill");
    }
    return [id, { phone: choice.skipWhatsApp ? null : customerPhone(choice.phone), skipWhatsApp: choice.skipWhatsApp }];
  }));
}

export function customerShareBills(selected: DeskBill, candidates: DeskBill[]) {
  const unique = new Map(candidates.map(bill => [bill.id, bill]));
  unique.set(selected.id, selected);
  return [...unique.values()].filter(bill => bill.uploads?.confirmed_at && bill.uploaded_by === selected.uploaded_by
    && (bill.id === selected.id || Boolean(selected.customer_id && bill.customer_id === selected.customer_id)))
    .sort((a, b) => Number(b.id === selected.id) - Number(a.id === selected.id)
      || a.created_at.localeCompare(b.created_at) || a.page_from - b.page_from || a.id.localeCompare(b.id));
}

type MessageBill = Pick<DeskBill, "customer_name" | "invoice_reference" | "vehicle_no_display" | "token_number" | "invoice_date" | "field_confidence" | "bill_type">;
export function whatsappMessage(bills: { bill: MessageBill; link: string }[], advisor: string) {
  if (!bills.length) throw new Error("At least one bill is required for WhatsApp sharing");
  const customer = bills[0].bill.customer_name;
  const sections = bills.map(({ bill, link }, index) => {
    const type = billType(bill);
    return [
      `*${index + 1}. ${type === "Type not identified" ? "Bill" : type}${bill.invoice_reference ? " — " + bill.invoice_reference : ""}*`,
      link,
      [bill.vehicle_no_display ? "Vehicle: " + bill.vehicle_no_display : "", bill.invoice_date ? "Date: " + bill.invoice_date : ""].filter(Boolean).join(" · "),
      bill.token_number ? "Token number: " + bill.token_number : "",
    ].filter(Boolean).join("\n");
  });
  return [
    `Hello${customer ? " " + customer : ""}, ${bills.length === 1 ? "here is your bill" : `here are your ${bills.length} bills`}.`,
    ...sections,
    `Please download your ${bills.length === 1 ? "bill" : "bills"} within 7 days.`,
    "Thank you" + (advisor ? ", " + advisor : "") + ".",
  ].join("\n\n");
}

export function whatsappUrl(phone: string, message: string) {
  return `https://wa.me/${customerPhone(phone).slice(1)}?text=${encodeURIComponent(message)}`;
}
