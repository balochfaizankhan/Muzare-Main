import { AdminSection } from "./AdminSection";
export function Billing() {
  return <AdminSection
    title="Billing"
    description="Manage billing records, invoices, and payment status."
    emptyTitle="Billing console not enabled"
    emptyDescription="This area is reserved for subscription invoices, renewals, and payment follow-up once platform billing is switched on."
  />;
}
