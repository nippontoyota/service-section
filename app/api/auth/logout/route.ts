import { NextResponse } from "next/server";
import { clearSessionCookie, createServiceClient, requestSessionHash, requireSameOrigin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const hash = requestSessionHash(request);
    if (hash) {
      const { error } = await createServiceClient().from("staff_sessions").delete().eq("token_hash", hash);
      if (error) throw error;
    }
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    clearSessionCookie(response);
    return response;
  } catch {
    return NextResponse.json({ error: "Could not sign out. Please retry." }, { status: 400 });
  }
}
