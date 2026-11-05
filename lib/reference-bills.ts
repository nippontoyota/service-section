import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { extractBills } from "./pdf/extract";
import { customerKey, type DeskBill } from "./desk";

// Types are supplied by the owner for these documents, not guessed from filenames.
export const referenceFiles = [
  { filename: "ATA545.pdf", type: "Counter sales" },
  { filename: "ACA1145.pdf", type: "Accessories · non-TGA" },
  { filename: "INA2600101.pdf", type: "Insurance claim" },
] as const;
export async function readReferenceFile(filename: string) {
  if (!referenceFiles.some(file => file.filename === filename)) throw new Error("Unknown reference document");
  return readFile(join(process.cwd(), filename));
}
export async function parseReferenceBills(): Promise<DeskBill[]> {
  const batches = await Promise.all(referenceFiles.map(async ({filename,type}) => {
    const bytes = await readReferenceFile(filename);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const result = await extractBills(new Uint8Array(bytes));
    const now = new Date().toISOString();
    return result.bills.map((b): DeskBill => {
      const bill: DeskBill = {
        id: "local-pdf-" + hash + "-" + b.pageFrom,
        upload_id: "local-pdf-" + hash,
        reference_file: filename, bill_type: type,
        customer_name: b.customerName, customer_reference: b.customerReference || null,
        vehicle_no_display: b.vehicleNo, vin: b.vin,
        invoice_reference: b.invoiceReference || null, invoice_date: b.invoiceDate,
        amount_paise: b.amountPaise, amount_evidence: b.amountEvidence,
        extraction_issues: b.extractionIssues, payment_evidence: [],
        uploaded_by: "demo-advisor", created_at: now,
        approved_at: null, approved_by: null, approval_status: "pending", status: "needs_review",
        page_from: b.pageFrom, page_to: b.pageTo,
        uploads: { original_filename: filename, file_hash: hash, confirmed_at: now },
      };
      bill.customer_id = "demo-customer:" + customerKey(bill);
      return bill;
    });
  }));
  return batches.flat();
}
