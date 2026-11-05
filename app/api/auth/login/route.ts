import { NextResponse } from "next/server";
import { createServiceClient, requireSameOrigin, startSession } from "@/lib/supabase-server";
import { dummyPasswordHash, verifyPassword } from "@/lib/password";
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { staffId, password } = await request.json();
    if (typeof staffId !== "string" || !/^[a-z0-9_]{3,40}$/.test(staffId) || typeof password !== "string" || password.length > 128) throw new Error("Invalid login");
    const service = createServiceClient();
    const { data: allowed, error: limitError } = await service.rpc("app_login_attempt", { login_id: staffId });
    if (limitError) return NextResponse.json({ error: "Staff login setup is incomplete. Apply the app-auth migration and run bootstrap:staff." }, { status: 503 });
    if (!allowed) return NextResponse.json({ error: "Too many sign-in attempts. Try again in 15 minutes." }, { status: 429, headers: { "Retry-After": "900", "Cache-Control": "no-store" } });
    const { data: profile, error } = await service.from("profiles").select("*").eq("staff_id", staffId).maybeSingle();
    if (error) throw error;
    const { data: credential } = profile ? await service.from("staff_credentials").select("password_hash").eq("staff_id", profile.id).maybeSingle() : { data: null };
    const valid = await verifyPassword(password, credential?.password_hash ?? dummyPasswordHash);
    if (!valid || !credential || !profile?.active) throw new Error("Invalid login");
    const response = NextResponse.json({ profile }, { headers: { "Cache-Control": "no-store" } });
    await startSession(response, profile.id, credential.password_hash);
    return response;
  } catch {
    return NextResponse.json({ error: "Invalid user ID or password." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
}
