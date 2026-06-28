import { AdminSection } from "./AdminSection";
import { BuildDiagnostics } from "../../components/BuildDiagnostics";
export function Settings() {
  return <>
    <AdminSection
      title="adminSettings.title"
      description="adminSettings.description"
      emptyTitle="adminSettings.emptyTitle"
      emptyDescription="adminSettings.emptyDescription"
    />
    <main className="shell-page">
      <BuildDiagnostics />
    </main>
  </>;
}
