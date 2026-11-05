import { ServiceDesk } from "@/components/service-desk";
import { configured, demoEnabled } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

export default function Home() {
  return <ServiceDesk demo={demoEnabled()} ready={configured()} />;
}
