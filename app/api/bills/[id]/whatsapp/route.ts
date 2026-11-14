import { NextResponse } from "next/server";

// Retired: customer bill delivery is handled outside BillDesk.
export async function POST() {
  return NextResponse.json({ error: "Customer bill sharing is no longer available in BillDesk. Refresh the workspace and submit bills to the cashier." }, {
    status: 410, headers: { "Cache-Control": "private, no-store" },
  });
}
