import { SecurityWorkspace } from "@/components/security-workspace";
import { customerBillOrigin } from "@/lib/customer-bill-links";
export default async function VerifyPage({ params }: { params: Promise<{ code: string }> }) {
 return <SecurityWorkspace origin={customerBillOrigin()} code={(await params).code}/>;
}
