import { AdminSection } from "./AdminSection";
import { BuildDiagnostics } from "../../components/BuildDiagnostics";
import { Link } from "react-router-dom";
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
      <section className="record-panel">
        <h2>Accounting Reconciliation Trace</h2>
        <p>Temporary admin-only trace for labour wage settlement reconciliation.</p>
        <Link to="/admin/accounting-reconciliation-debug">
          Accounting Reconciliation Trace
        </Link>
      </section>
    </main>
  </>;
}
