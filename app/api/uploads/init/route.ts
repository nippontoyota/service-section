import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabase-server";

const MAX_SIZE = 10 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const { user, service } = await requireRole(request, "service_advisor");
    const body = (await request.json()) as { filename?: string; size?: number; type?: string };
    const filename = body.filename?.trim();
    if (!filename || !filename.toLowerCase().endsWith(".pdf") || body.type !== "application/pdf") {
      return NextResponse.json({ error: "Only PDF files are accepted." }, { status: 400 });
    }
    if (!Number.isInteger(body.size) || !body.size || body.size < 1 || body.size > MAX_SIZE) {
      return NextResponse.json({ error: "PDFs must be 10 MB or smaller." }, { status: 400 });
    }

    const uploadId = randomUUID();
    const storagePath = `${user.id}/${uploadId}.pdf`;
    const { error: insertError } = await service.from("uploads").insert({
      id: uploadId,
      uploaded_by: user.id,
      storage_path: storagePath,
      original_filename: filename,
      status: "uploading",
    });
    if (insertError) throw insertError;

    const { data, error } = await service.storage.from("bills").createSignedUploadUrl(storagePath);
    if (error) throw error;
    return NextResponse.json({ uploadId, signedUrl: data.signedUrl }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start upload";
    return NextResponse.json({ error: message }, { status: message.includes("required") ? 401 : 500 });
  }
}
