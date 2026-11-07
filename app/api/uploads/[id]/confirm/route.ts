import { NextResponse } from "next/server";
import { AuthenticationError, requireRole } from "@/lib/supabase-server";
import { tokenNumber } from "@/lib/desk";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { user, service } = await requireRole(request, "service_advisor");
    const body = await request.json();
    const tokens = body.tokens ?? {};
    if (typeof tokens !== "object" || Array.isArray(tokens)) return NextResponse.json({ error: "Invalid token numbers" }, { status: 400 });
    let normalizedTokens: Record<string, string | null>;
    try { normalizedTokens = Object.fromEntries(Object.entries(tokens).map(([key, value]) => [key, tokenNumber(value)])); }
    catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
    const { data, error } = await service.rpc("app_confirm_upload", { staff: user.id, target: id, tokens: normalizedTokens }).single();
    if (error) {
      if (error.code === "23505" && error.message.includes("uploads_confirmed_hash_unique")) {
        return NextResponse.json({ error: "This PDF has already been submitted. Use the existing bill." }, { status: 409 });
      }
      if (["P0002", "55000", "42501", "P0001", "22023"].includes(error.code)) {
        const status = error.code === "22023" ? 400 : error.code === "P0002" ? 404 : error.code === "55000" ? 409 : 403;
        return NextResponse.json({ error: error.message }, { status });
      }
      console.error("Upload confirmation failed:", error.code, error.message);
      return NextResponse.json({ error: "Submission is temporarily unavailable. Please try again or contact your centre administrator." }, { status: error.code === "PGRST202" ? 503 : 500 });
    }
    return NextResponse.json({ upload: data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not confirm upload";
    return NextResponse.json({ error: message }, { status: error instanceof AuthenticationError ? 401 : message.includes("required") ? 403 : 500 });
  }
}
