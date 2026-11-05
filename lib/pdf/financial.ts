import type { PaymentEvidence } from "../desk";
export function paise(raw: string): number | null {
  const text = raw.replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(value) && value <= 100_000_000_000 ? value : null;
}
function isoDate(raw: string) {
  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  const iso = y + "-" + m.padStart(2, "0") + "-" + d.padStart(2, "0");
  const date = new Date(iso + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}
export function financialFields(text: string) {
  const issues: string[] = [];
  const amounts = [...text.matchAll(/\b(?:grand\s*total|g\.?\s*total|total\s+amount\s+after\s+tax|net\s+(?:amount\s+)?payable|invoice\s+total)\s*[:₹.]?\s*(?:INR|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)(?![\d.])/gi)];
  const values = [...new Set(amounts.map(m => paise(m[1])).filter(v => v !== null))];
  const amountPaise = values.length === 1 ? values[0] : null;
  if (amountPaise === null) issues.push(values.length > 1 ? "Conflicting invoice totals. Upload a corrected PDF." : "Invoice total could not be read. Upload a digital PDF with a labelled grand total.");
  const dateMatches = [...text.matchAll(/invoice\s+date(?:\s+and\s+time)?\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4})/gi)].map(m => m[1]);
  if (!dateMatches.length) {
    for (const m of text.matchAll(/invoice date and time/gi)) {
      const timed = text.slice(m.index! + m[0].length, m.index! + 500).match(/(\d{1,2}[/-]\d{1,2}[/-]\d{4})\s+\d{1,2}:\d{2}/);
      if (timed) dateMatches.push(timed[1]);
    }
  }
  if (!dateMatches.length && /Page No\.1\/1\s+Tax Invoice\(Cash\)/i.test(text)) {
    const header = text.match(/Tax Invoice\(Cash\)[^\n]*\n(\d{1,2}[/-]\d{1,2}[/-]\d{4})/i);
    if (header) dateMatches.push(header[1]);
  }
  if (!dateMatches.length && /Warranty Repair Note/i.test(text)) {
    const header = text.split(/SI\.?No|Labour charges/i)[0];
    for (const match of header.matchAll(/(\d{1,2}[/-]\d{1,2}[/-]\d{4})\s+\d{1,2}:\d{2}/g)) dateMatches.push(match[1]);
  }
  const dates = [...new Set(dateMatches.map(isoDate).filter(Boolean))];
  const invoiceDate = dates.length === 1 ? dates[0] : null;
  if (!invoiceDate) issues.push("Invoice date could not be read unambiguously. Upload a corrected PDF.");
  // Service bills settle in full. Receipt fragments never create partial collections.
  const paymentEvidence: PaymentEvidence[] = [];
  return { amountPaise, invoiceDate, amountEvidence: amounts.map(m => m[0]).join(" · "), paymentEvidence, extractionIssues: issues };
}
