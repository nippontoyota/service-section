import { randomBytes } from "node:crypto";
import { gatePassDocument } from "@/lib/gate-pass-document";
import QRCode from "qrcode";
import { createServiceClient } from "@/lib/supabase-server";
import { customerBillOrigin, hashBillCode } from "@/lib/customer-bill-links";
import { gateCodePattern, gatePrivateHeaders, type GatePass } from "@/lib/gate-pass";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
 const { code } = await context.params;
 let pass: GatePass = { status: "Invalid" }, qr = "", status = 200;
 let failure = "";
 try {
  if (gateCodePattern.test(code)) {
   const { data, error } = await createServiceClient().rpc("app_public_gate_pass", { pass_hash: hashBillCode(code) });
   if (error || !data) throw new Error();
   pass = data;
   if (pass.id) qr = await QRCode.toDataURL(`${customerBillOrigin()}/g/${code}`, { width: 480, margin: 4, errorCorrectionLevel: "M" });
  }
  if (pass.status === "Invalid") status = 404;
 } catch { failure = "Unable to verify—retry"; status = 503; }
 const nonce = randomBytes(16).toString("base64");
 const html = gatePassDocument(pass, qr, nonce, failure);
 return new Response(request.method === "HEAD" ? null : html, { status, headers: { ...gatePrivateHeaders,
  "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `script-src 'nonce-${nonce}'; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
 } });
}
export const HEAD = GET;
