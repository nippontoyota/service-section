import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { AuthenticationError, requireStaff, startSession } from "@/lib/supabase-server";
import { hashPassword } from "@/lib/password";
import { loadDesk } from "@/lib/desk-session";
import { paymentMethod } from "@/lib/desk";
export const runtime = "nodejs";
export const maxDuration = 60;
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(request: Request) {
  try {
    return json(await loadDesk(request));
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Could not load workspace" }, e instanceof AuthenticationError ? 401 : 503); }
}
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const authStart = performance.now();
    const { service, profile, user } = await requireStaff(request, body.action === "password");
    if (body.action === "password") {
      if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) throw new Error("Use a password between 12 and 128 characters");
      const passwordHash = await hashPassword(body.password);
      const { error } = await service.rpc("app_staff_account", { actor: user.id, operation: "password", new_hash: passwordHash });
      if (error) throw error;
      const response = json({ ok: true });
      await startSession(response, user.id, passwordHash);
      return response;
    } else if (["approve", "collect", "reverse"].includes(body.action)) {
      const method = body.action === "collect" ? paymentMethod(body.method, body.otherMethod) : "";
      const { error } = await service.rpc("app_desk_action", { staff: user.id, action: body.action, target: body.target, reason: body.reason ?? "", payment_method: method });
      if (error) throw new Error(error.code === "23505" ? "This invoice has already been approved. Open the existing bill." : error.message);
    } else if (body.action === "reextract") {
      if (profile.role !== "super_admin") throw new Error("Super admin role required");
      const { data: bill } = await service.from("bills").select("*").eq("id",body.target).single();
      if (!bill || bill.approval_status !== "pending") throw new Error("Only pending historical bills can be re-extracted");
      const { count, error: paymentError } = await service.from("payments").select("id",{count:"exact",head:true}).eq("bill_id",bill.id);
      if (paymentError || count) throw new Error("A bill with payment history cannot be re-extracted");
      const { data: upload } = await service.from("uploads").select("storage_path").eq("id",bill.upload_id).single();
      if (!upload) throw new Error("Original upload not found");
      const { data: file, error } = await service.storage.from("bills").download(upload.storage_path);
      if (error || !file) throw new Error("Original PDF could not be loaded");
      const { extractBills, extractedBillFields } = await import("@/lib/pdf/extract");
      const result = await extractBills(new Uint8Array(await file.arrayBuffer()));
      const extracted = result.bills.find(b => b.pageFrom === bill.page_from && b.pageTo === bill.page_to);
      if (!extracted) throw new Error("Historical page ranges do not match this invoice. Upload the corrected PDF for review.");
      const { error: updateError } = await service.from("bills").update({
        ...extractedBillFields(extracted),
      }).eq("id",bill.id).eq("approval_status","pending");
      if (updateError) throw updateError;
      const { error: auditError } = await service.from("audit_events").insert({actor_id:user.id,bill_id:bill.id,action:"reextracted",detail:{previous_amount:bill.amount_paise,amount:extracted.amountPaise}});
      if (auditError) throw auditError;
    } else if (body.action === "pdf") {
      const { data: bill, error } = await service.from("bills")
        .select("upload_id,uploaded_by,uploads!inner(storage_path,confirmed_at)").eq("id", body.target).single();
      if (error || !bill) throw new Error("Bill not accessible");
      if (profile.role === "service_advisor" && bill.uploaded_by !== user.id) throw new Error("Bill not accessible");
      const upload = bill.uploads as unknown as { storage_path: string; confirmed_at: string | null };
      if (profile.role === "cashier" && !upload.confirmed_at) throw new Error("PDF not accessible");
      const authorization = performance.now() - authStart;
      const signingStart = performance.now();
      const expiresAt = Date.now() + 300_000;
      const { data, error: signedError } = await service.storage.from("bills").createSignedUrl(upload.storage_path, 300);
      if (signedError) throw signedError;
      const signing = performance.now() - signingStart;
      const response = json({ url: data.signedUrl, uploadId: bill.upload_id, expiresAt, timings: { authorization, signing } });
      response.headers.set("Server-Timing", `authorization;dur=${authorization.toFixed(1)}, signing;dur=${signing.toFixed(1)}`);
      return response;
    } else if (["create_staff", "reset_staff", "toggle_staff"].includes(body.action)) {
      if (profile.role !== "super_admin") throw new Error("Super admin role required");
      if (body.target === user.id) throw new Error("You cannot disable or reset your own account here.");
      if (body.action === "toggle_staff") {
        if (typeof body.active !== "boolean") throw new Error("Account status required");
        const { error } = await service.rpc("app_staff_account", { actor: user.id, operation: body.action, target: body.target, enabled: body.active });
        if (error) throw error;
      } else {
        const temporaryPassword = body.action === "reset_staff" ? randomBytes(18).toString("base64url") + "!a9" : undefined;
        if (body.action === "create_staff") {
          if (!/^[a-z0-9_]{3,40}$/.test(body.staffId ?? "") || !["cashier","service_advisor","super_admin"].includes(body.role) || typeof body.fullName !== "string" || !body.fullName.trim() || body.fullName.length > 100) throw new Error("Valid user ID, name and role required");
        }
        const passwordHash = await hashPassword(temporaryPassword ?? body.password);
        const { error } = await service.rpc("app_staff_account", {
          actor: user.id, operation: body.action, target: body.target ?? null, new_hash: passwordHash,
          login_id: body.staffId ?? null, name: body.fullName ?? null, role_name: body.role ?? null,
        });
        if (error) throw error;
        return json(temporaryPassword ? { temporaryPassword } : { ok: true });
      }
    } else throw new Error("Unknown action");
    return json({ ok: true });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Action failed" }, 400); }
}
