import { NextResponse } from "next/server";
import { demoEnabled } from "@/lib/app-mode";
import { parseReferenceBills, readReferenceFile, referenceFiles } from "@/lib/reference-bills";

let parsed: ReturnType<typeof parseReferenceBills> | undefined;
export async function GET(request: Request) {
  if (!demoEnabled()) return NextResponse.json({error:"Not found"},{status:404});
  const file = new URL(request.url).searchParams.get("file");
  if (file && !referenceFiles.some(item => item.filename === file)) return NextResponse.json({error:"Not found"},{status:404});
  try {
    if (file) return new Response(new Uint8Array(await readReferenceFile(file)), {headers:{
      "Content-Type":"application/pdf", "Content-Disposition":'inline; filename="' + file + '"',
      "Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff",
    }});
    parsed ??= parseReferenceBills().catch(error => { parsed=undefined; throw error; });
    return NextResponse.json({bills:await parsed},{headers:{"Cache-Control":"private, no-store"}});
  } catch {
    return NextResponse.json({error:"Could not read the three local reference PDFs. Check that ATA545.pdf, ACA1145.pdf and INA2600101.pdf are present and readable."},{status:503});
  }
}
