import { PDFDocument } from "pdf-lib";

export async function customerPdf(bytes: Uint8Array, pageFrom: number, pageTo: number) {
  const source = await PDFDocument.load(bytes);
  if (!Number.isInteger(pageFrom) || !Number.isInteger(pageTo) || pageFrom < 1 || pageTo < pageFrom || pageTo > source.getPageCount()) {
    throw new Error("Bill page range is invalid; customer sharing is unavailable");
  }
  // Copy into a new document even for a single bill: never serve the combined upload.
  const output = await PDFDocument.create();
  const pages = await output.copyPages(source, Array.from({ length: pageTo - pageFrom + 1 }, (_, i) => pageFrom - 1 + i));
  pages.forEach(page => output.addPage(page));
  return output.save();
}

export function customerCopyPath(bill: { id: string; upload_id: string; page_from: number; page_to: number; uploads: { file_hash: string | null } }) {
  return `customer-copies/v1/${bill.upload_id}/${bill.uploads.file_hash || "original"}/${bill.id}-${bill.page_from}-${bill.page_to}.pdf`;
}
