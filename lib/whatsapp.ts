import type { DeskBill } from "./desk";

export const customerLinkSeconds = 7 * 24 * 60 * 60;
export type BillContact = { phone: string | null; skipWhatsApp: boolean };

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

export function whatsappMessage(bill: Pick<DeskBill, "customer_name" | "invoice_reference" | "vehicle_no_display" | "token_number">, link: string, advisor: string) {
  return [
    `Hello${bill.customer_name ? " " + bill.customer_name : ""}, here is your bill${bill.invoice_reference ? " " + bill.invoice_reference : ""}${bill.vehicle_no_display ? " for " + bill.vehicle_no_display : ""}.`,
    link,
    bill.token_number ? "Token number: " + bill.token_number : "",
    "Please download your bill within 7 days.",
    "Thank you" + (advisor ? ", " + advisor : "") + ".",
  ].filter(Boolean).join("\n");
}

export function whatsappUrl(phone: string, message: string) {
  return `https://wa.me/${customerPhone(phone).slice(1)}?text=${encodeURIComponent(message)}`;
}
