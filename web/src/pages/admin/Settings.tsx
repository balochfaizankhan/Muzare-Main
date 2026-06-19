import { AdminSection } from "./AdminSection";
export function Settings() {
  return <AdminSection
    title="Platform Settings"
    description="Configure Muzare-wide settings without entering customer operations."
    emptyTitle="Platform settings"
    emptyDescription="Use this area for global guardrails, support defaults, and future platform-wide configuration. Customer farm data should stay in workspace settings."
  />;
}
