import { createHmac, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AuthenticationError, requireRole } from "./supabase-server";
import { hashBillCode } from "./customer-bill-links";
import { gateCodePattern, gatePrivateHeaders } from "./gate-pass";
export function codeForGatePass(id: string) {
 const secret = process.env.GATE_PASS_SIGNING_SECRET;
 if (!secret || Buffer.byteLength(secret) < 32) throw new Error("Gate passes are not configured. Contact the administrator.");
 return createHmac("sha256", secret).update("billdesk-gate-pass-v1:" + id).digest("base64url");
}
export function newGatePass() {
 const id = randomUUID(), code = codeForGatePass(id);
 return { id, code, hash: hashBillCode(code) };
}
export const gateJson = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: gatePrivateHeaders });
export async function checkGatePass(request: Request, confirmExit: boolean) {
 try {
  const { profile, service } = await requireRole(request, "security");
  const { code } = await request.json();
  if (typeof code !== "string" || !gateCodePattern.test(code)) return gateJson({ status: "Invalid" });
  const { data, error } = await service.rpc("app_check_gate_pass", { staff: profile.id, pass_hash: hashBillCode(code), confirm_exit: confirmExit });
  if (error || !data) throw new Error("Verification failed");
  return gateJson(data);
 } catch (e) {
  return gateJson({ error: "Unable to verify—retry" }, e instanceof AuthenticationError ? 401 : 503);
 }
}
