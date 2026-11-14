import { SecurityWorkspace } from "@/components/security-workspace";
import { customerBillOrigin } from "@/lib/customer-bill-links";
export default function SecurityPage() { return <SecurityWorkspace origin={customerBillOrigin()}/>; }
