import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { demoEnabled } from "@/lib/app-mode";
import { extractBills } from "@/lib/pdf/extract";
export async function POST(request: Request) {
  if (!demoEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    if (Number(request.headers.get("content-length")) > 11 * 1024 * 1024) throw new Error("PDF exceeds 10 MB");
    const data = await request.formData();
    const file = data.get("file");
    if (!(file instanceof File) || file.size > 10 * 1024 * 1024) throw new Error("Choose a PDF up to 10 MB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0,5)) !== "%PDF-") throw new Error("Invalid PDF");
    const extraction = await extractBills(bytes);
    return NextResponse.json({ ...extraction, hash: createHash("sha256").update(bytes).digest("hex") });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read PDF" }, { status: 422 }); }
}
