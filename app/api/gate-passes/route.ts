import { AuthenticationError, requireRole } from "@/lib/supabase-server";
import { customerBillOrigin } from "@/lib/customer-bill-links";
import { codeForGatePass, newGatePass, gateJson } from "@/lib/gate-pass-server";
import { gateMessage } from "@/lib/gate-pass";
import { customerPhone, whatsappUrl } from "@/lib/whatsapp";
export const runtime = "nodejs";
export async function POST(request: Request) {
 try {
  const { profile, service } = await requireRole(request, "cashier");
  const { billId, phone: value } = await request.json();
  if (typeof billId !== "string" || !/^[0-9a-f-]{36}$/i.test(billId)) return gateJson({ error: "Select a submitted bill" }, 400);
  const phone = customerPhone(value), origin = customerBillOrigin(), candidate = newGatePass();
  const { data, error } = await service.rpc("app_issue_gate_pass", {
   staff: profile.id, target: billId, phone, pass_id: candidate.id, pass_hash: candidate.hash,
  });
  if (error) return gateJson({ error: error.code === "P0001" ? error.message : "Gate pass could not be saved. Please retry." }, 503);
  if (data.error) return gateJson(data, 409);
  const link = `${origin}/g/${codeForGatePass(data.id)}`;
  return gateJson({ pass: data, link, whatsappUrl: whatsappUrl(phone, gateMessage(data, link)) });
 } catch (e) {
  return gateJson({ error: e instanceof Error ? e.message : "Gate pass could not be saved. Please retry." }, e instanceof AuthenticationError ? 401 : 400);
 }
}
