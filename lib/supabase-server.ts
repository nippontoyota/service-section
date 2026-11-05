import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { hashSessionToken } from "./password";
import { requireSameOrigin } from "./request-security";
import type { Role, Staff } from "./desk";
export { requireSameOrigin } from "./request-security";

export const sessionCookie = "billdesk_session";
const sessionSeconds = 12 * 60 * 60;
export class AuthenticationError extends Error {}

export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase database connection is not configured");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function requestSessionHash(request: Request) {
  const token = request.headers.get("cookie")?.split(";").map(p => p.trim()).find(p => p.startsWith(sessionCookie + "="))?.slice(sessionCookie.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hashSessionToken(token) : null;
}

export async function startSession(response: NextResponse, staffId: string, expectedHash: string) {
  const token = randomBytes(32).toString("base64url");
  const { error } = await createServiceClient().rpc("app_open_session", {
    staff: staffId, expected_hash: expectedHash, session_hash: hashSessionToken(token),
  });
  if (error) throw new Error("Could not start staff session");
  response.cookies.set(sessionCookie, token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: sessionSeconds,
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(sessionCookie, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 0 });
}

export async function requireStaff(request: Request, allowPasswordChange = false) {
  if (request.method !== "GET") requireSameOrigin(request);
  const sessionHash = requestSessionHash(request);
  if (!sessionHash) throw new AuthenticationError("Staff login required");
  const service = createServiceClient();
  const { data, error } = await service.from("staff_sessions").select("staff_id,profiles(*)")
    .eq("token_hash", sessionHash).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error) throw new Error("Staff session could not be verified. Check the database migration.");
  const profile = data?.profiles as unknown as Staff | undefined;
  if (!profile?.active) throw new AuthenticationError("Staff login required");
  if (profile.must_change_password && !allowPasswordChange) throw new Error("Password change required");
  return { user: { id: profile.id }, profile, service, sessionHash };
}
export async function requireRole(request: Request, role: Role) {
  const auth = await requireStaff(request);
  if (auth.profile.role !== role) throw new Error(role.replaceAll("_", " ") + " role required");
  return auth;
}
