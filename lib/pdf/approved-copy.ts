import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { customerPdf } from './customer-copy';

export async function approvedPdf(bytes: Uint8Array, pageFrom: number, pageTo: number, approval: { name: string; at: string; number: number; revoked: boolean }) {
  const invoice = await PDFDocument.load(await customerPdf(bytes, pageFrom, pageTo));
  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const bold = await output.embedFont(StandardFonts.HelveticaBold);
  const pages = await output.embedPages(invoice.getPages());
  for (const original of pages) {
    const page = output.addPage([original.width, original.height + 92]);
    page.drawPage(original, { x: 0, y: 92 });
    const color = approval.revoked ? rgb(.65, .1, .15) : rgb(.08, .36, .25);
    page.drawRectangle({ x: 14, y: 10, width: original.width - 28, height: 70, borderWidth: 1.5, borderColor: color });
    const lines = [approval.revoked ? 'APPROVAL REVOKED' : 'VERIFIED', `Signed by ${approval.name}`, `Team Leader | Request ${String(approval.number).padStart(5, '0')} | ${new Date(approval.at).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })} IST`];
    lines.forEach((text, index) => {
      const face = index === 0 ? bold : font;
      const size = Math.min(index === 0 ? 13 : 10, (original.width - 50) / face.widthOfTextAtSize(text, 1));
      page.drawText(text, { x: 24, y: 62 - index * 18, size, font: face, color });
    });
  }
  output.setTitle(`Verified insurer bill - Request ${approval.number}`);
  return output.save();
}
