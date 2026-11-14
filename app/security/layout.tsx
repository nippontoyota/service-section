import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthenticationError, requireStaff } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";
export const metadata = { title: "BillDesk security", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default async function SecurityLayout({ children }: { children: React.ReactNode }) {
 let auth;
 try { auth = await requireStaff(new Request("http://billdesk.local", { headers: await headers() }), true); }
 catch (e) {
  if (e instanceof AuthenticationError) redirect("/");
  return <main><p>Unable to verify—retry</p><a href="/security">Retry</a></main>;
 }
 if (auth.profile.must_change_password || auth.profile.role !== "security") redirect("/");
 return children;
}
