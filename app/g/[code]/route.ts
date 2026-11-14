import QRCode from "qrcode";
import { createServiceClient } from "@/lib/supabase-server";
import { customerBillOrigin, hashBillCode } from "@/lib/customer-bill-links";
import { gateCodePattern, gatePrivateHeaders, type GatePass } from "@/lib/gate-pass";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
 const { code } = await context.params;
 let pass: GatePass = { status: "Invalid" }, qr = "", status = 200;
 let failure = "";
 try {
  if (gateCodePattern.test(code)) {
   const { data, error } = await createServiceClient().rpc("app_public_gate_pass", { pass_hash: hashBillCode(code) });
   if (error || !data) throw new Error();
   pass = data;
   if (pass.id) qr = await QRCode.toDataURL(`${customerBillOrigin()}/g/${code}`, { width: 360, margin: 4, errorCorrectionLevel: "M" });
  }
  if (pass.status === "Invalid") status = 404;
 } catch { failure = "Unable to verify—retry"; status = 503; }
 const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>BillDesk gate pass</title><style>body{font:18px system-ui;margin:0;padding:24px;background:#f3f5f8;color:#192b3c}main{max-width:440px;margin:auto;padding:24px;background:white;border-radius:18px}h1{font-size:32px;overflow-wrap:anywhere}img{display:block;width:100%;height:auto}dt{color:#586575;margin-top:18px}dd{margin:4px 0;overflow-wrap:anywhere}a{display:inline-block;padding:14px 0;color:#17489d}</style></head><body><main><p>BillDesk · Gate pass</p><h1>${escape(failure || pass.status)}</h1>${!failure && pass.id ? `<h2>${escape(pass.vehicle!)}</h2><p>${escape(pass.customerName!)}</p>${qr ? `<img src="${qr}" width="360" height="360" alt="Gate pass QR code">` : ""}<dl><dt>Pass number</dt><dd>${escape(pass.id)}</dd><dt>Expires</dt><dd>${escape(new Date(pass.expiresAt!).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))} IST</dd></dl><p>Show this pass to security. Online verification and confirmation are required for departure.</p>` : ""}<a href="">Refresh status</a></main></body></html>`;
 return new Response(request.method === "HEAD" ? null : html, { status, headers: { ...gatePrivateHeaders,
  "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
 } });
}
export const HEAD = GET;
