import { checkGatePass } from "@/lib/gate-pass-server";
export const runtime = "nodejs";
export async function POST(request: Request) { return checkGatePass(request, false); }
