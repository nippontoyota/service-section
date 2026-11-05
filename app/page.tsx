import { headers } from "next/headers";
import { ServiceDesk } from "@/components/service-desk";
import { configured, demoEnabled } from "@/lib/app-mode";
import { loadDesk } from "@/lib/desk-session";
import { AuthenticationError } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const demo = demoEnabled(), ready = configured();
  let initial: Awaited<ReturnType<typeof loadDesk>> | undefined;
  let initialError = "";
  if (ready && !demo) {
    try { initial = await loadDesk(new Request("http://billdesk.local", { headers: await headers() })); }
    catch (error) { if (!(error instanceof AuthenticationError)) initialError = "Workspace temporarily unavailable. Please retry."; }
  }
  return <ServiceDesk demo={demo} ready={ready} initial={initial} initialError={initialError} />;
}
