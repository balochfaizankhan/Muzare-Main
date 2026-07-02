import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { SearchInput } from "../../components/SearchInput";
import { SubpageHeader } from "../../components/SubpageHeader";
import { formatMoney } from "../../lib/format";
import { labourEarningTypeLabel, sumLabourEarnings } from "../../lib/labourEarnings";
import { canCreate } from "../../lib/permissions";
import { compareLabourers, getActiveFarmId, getActiveSeasonId, makeLocalRecord, offlineDb, workspaceRecords, type LabourEarning, type Labourer } from "../../lib/offline-db";
import { isActiveOperationalRecord } from "../../lib/operationalRecords";
import { useAuth } from "../../auth/AuthProvider";
import { persistOperationalRecord } from "../../services/syncService";

const money = formatMoney;
const today = () => new Date().toISOString().slice(0, 10);

export function LabourEarnings() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const activeFarmId = getActiveFarmId();
  const activeSeasonId = getActiveSeasonId();
  const canManage = Boolean(user && workspaceId && canCreate(user, "wages", workspaceId));

  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [earnings, setEarnings] = useState<LabourEarning[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [earningType, setEarningType] = useState<LabourEarning["earningType"] | "">("");
  const [selectedLabourerId, setSelectedLabourerId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [earningDate, setEarningDate] = useState(today());
  const [labourerId, setLabourerId] = useState("");
  const [amount, setAmount] = useState("");
  const [formType, setFormType] = useState<LabourEarning["earningType"]>("lump_sum");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    const refresh = async () => {
      const [nextLabourers, nextEarnings] = await Promise.all([
        workspaceRecords(offlineDb.labourers),
        workspaceRecords(offlineDb.labourEarnings, { includeDeleted: true }),
      ]);
      setLabourers(nextLabourers.sort(compareLabourers));
      setEarnings(nextEarnings.sort((left, right) => right.earningDate.localeCompare(left.earningDate) || right.updatedAt.localeCompare(left.updatedAt)));
    };
    void refresh();
    window.addEventListener("muzare-data-refresh", refresh);
    window.addEventListener("muzare-local-data-change", refresh);
    return () => {
      window.removeEventListener("muzare-data-refresh", refresh);
      window.removeEventListener("muzare-local-data-change", refresh);
    };
  }, []);
  useEffect(() => {
    const labourId = searchParams.get("labourId") ?? "";
    if (!labourId) return;
    setSelectedLabourerId(labourId);
    setLabourerId(labourId);
  }, [searchParams]);

  const labourById = useMemo(() => new Map(labourers.map((labourer) => [labourer.id, labourer])), [labourers]);
  const filtered = useMemo(() => earnings.filter((earning) => {
    const labourer = labourById.get(earning.labourerId);
    const term = search.trim().toLowerCase();
    return (!selectedLabourerId || earning.labourerId === selectedLabourerId)
      && (!status || earning.status === status)
      && (!earningType || earning.earningType === earningType)
      && (!from || earning.earningDate >= from)
      && (!to || earning.earningDate <= to)
      && (!term || [labourer?.name, earning.description, earning.notes, earning.earningType].join(" ").toLowerCase().includes(term));
  }), [earnings, labourById, search, selectedLabourerId, status, earningType, from, to]);

  const pending = filtered.filter((earning) => earning.status === "pending_settlement" && isActiveOperationalRecord(earning));
  const settled = filtered.filter((earning) => earning.status === "settled" && isActiveOperationalRecord(earning));
  const voided = filtered.filter((earning) => earning.status === "voided" || !isActiveOperationalRecord(earning));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!canManage) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    if (!activeFarmId || !activeSeasonId) {
      setError(t("farmsPage.noActiveSeason"));
      return;
    }
    const numericAmount = Number(amount);
    if (!labourerId || !Number.isFinite(numericAmount) || numericAmount <= 0 || !description.trim()) {
      setError("Enter labour, amount, and description before saving.");
      return;
    }
    setSaving(true);
    try {
      await persistOperationalRecord("labourEarning", {
        ...makeLocalRecord(),
        workspaceId,
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        labourerId,
        earningDate,
        amount: numericAmount,
        earningType: formType,
        description: description.trim(),
        notes: notes.trim() || undefined,
        status: "pending_settlement",
        createdBy: user?.id,
        updatedBy: user?.id,
      });
      setAmount("");
      setDescription("");
      setNotes("");
      setSuccess("Labour work recorded. It will be included in the next wage settlement.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to record this labour earning.");
    } finally {
      setSaving(false);
    }
  };

  const voidPendingEarning = async (earning: LabourEarning) => {
    if (!canManage) return;
    if (earning.status === "settled") {
      setError("Settled labour work must be reversed through settlement or adjustment workflow.");
      return;
    }
    await persistOperationalRecord("labourEarning", {
      ...earning,
      status: "voided",
      deletedAt: earning.deletedAt ?? null,
      updatedBy: user?.id,
    });
  };

  return (
    <div className="dashboard-page">
      <SubpageHeader title="Labour Work" />
      <main className="subpage module-workspace">
        <section className="workspace-intro">
          <div>
            <h2>Labour Work Ledger</h2>
            <p>Record non-attendance labour work as pending labour cost, then settle it later with wage settlement and one linked accounting voucher.</p>
          </div>
        </section>

        <section className="record-panel">
          <div className="advances-heading">
            <h2>Record labour work</h2>
            <span>These entries do not touch cash, accounts, or partner ledgers until settlement.</span>
          </div>
          <form className="module-form" onSubmit={(event) => void submit(event)}>
            <div className="advances-filter-row">
              <label className="advances-filter-field"><span>Date</span><input required type="date" value={earningDate} onChange={(event) => setEarningDate(event.target.value)} /></label>
              <label className="advances-filter-field"><span>Labour</span><select required value={labourerId} onChange={(event) => setLabourerId(event.target.value)}><option value="">Select labour</option>{labourers.map((labourer) => <option key={labourer.id} value={labourer.id}>{labourer.name}</option>)}</select></label>
              <label className="advances-filter-field"><span>Type</span><select value={formType} onChange={(event) => setFormType(event.target.value as LabourEarning["earningType"])}>{["lump_sum", "task", "bonus", "incentive", "adjustment", "other"].map((type) => <option key={type} value={type}>{labourEarningTypeLabel(type as LabourEarning["earningType"])}</option>)}</select></label>
            </div>
            <div className="advances-filter-row">
              <label className="advances-filter-field"><span>Amount</span><input required type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
              <label className="advances-filter-field advances-filter-field--full"><span>Description</span><input required value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What was earned?" /></label>
            </div>
            <label className="advances-filter-field advances-filter-field--full"><span>Notes</span><input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional notes" /></label>
            {error ? <p className="form-error">{error}</p> : null}
            {success ? <p className="context-message">{success}</p> : null}
            <button disabled={!canManage || saving} type="submit">{saving ? "Saving..." : "Record labour work"}</button>
          </form>
        </section>

        <section className="record-panel">
          <div className="advances-heading">
            <h2>Labour work ledger</h2>
            <span>{filtered.length} entries</span>
          </div>
          <div className="advances-filter-grid">
            <SearchInput placeholder="Search labour work" value={search} onChange={setSearch} />
            <label className="advances-filter-field"><span>Labour</span><select value={selectedLabourerId} onChange={(event) => setSelectedLabourerId(event.target.value)}><option value="">All labour</option>{labourers.map((labourer) => <option key={labourer.id} value={labourer.id}>{labourer.name}</option>)}</select></label>
            <label className="advances-filter-field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All status</option><option value="pending_settlement">Pending Settlement</option><option value="settled">Settled</option><option value="voided">Voided</option></select></label>
            <label className="advances-filter-field"><span>Type</span><select value={earningType} onChange={(event) => setEarningType(event.target.value as LabourEarning["earningType"] | "")}><option value="">All types</option>{["lump_sum", "task", "bonus", "incentive", "adjustment", "other"].map((type) => <option key={type} value={type}>{labourEarningTypeLabel(type as LabourEarning["earningType"])}</option>)}</select></label>
            <label className="advances-filter-field"><span>From</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label className="advances-filter-field"><span>To</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          </div>
          <div className="reports-kpis">
            <article><span>Pending labour work</span><strong>{money(sumLabourEarnings(pending))}</strong></article>
            <article><span>Settled labour work</span><strong>{money(sumLabourEarnings(settled))}</strong></article>
            <article><span>Voided labour work</span><strong>{money(sumLabourEarnings(voided))}</strong></article>
          </div>
          {!filtered.length ? <p className="context-message">No labour work entries match this filter yet.</p> : (
            <div className="attendance-import-table-wrap report-wide-table">
              <table className="report-data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Labour</th>
                    <th>Type</th>
                    <th>Description</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Settlement</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((earning) => (
                    <tr key={earning.id}>
                      <td>{earning.earningDate}</td>
                      <td>{labourById.get(earning.labourerId)?.name ?? earning.labourerId}</td>
                      <td>{labourEarningTypeLabel(earning.earningType)}</td>
                      <td>{earning.description}</td>
                      <td>{money(earning.amount)}</td>
                      <td><span className={`status-chip status-chip--${earning.status}`}>{earning.status === "pending_settlement" ? "Pending" : earning.status === "settled" ? "Settled" : "Voided"}</span></td>
                      <td>{earning.linkedSettlementId ?? "-"}</td>
                      <td>{earning.status === "pending_settlement" && canManage ? <button className="worker-dialog__link worker-dialog__link--danger" type="button" onClick={() => void voidPendingEarning(earning)}>Void</button> : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
