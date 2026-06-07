import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { LabourSelectCombobox } from "../../components/LabourSelectCombobox";
import { SearchInput } from "../../components/SearchInput";
import { SubpageHeader } from "../../components/SubpageHeader";
import { formatMoney } from "../../lib/format";
import { hasPermission } from "../../lib/permissions";
import { offlineDb, workspaceRecords, type Account, type Advance, type Labourer } from "../../lib/offline-db";
import { deleteOperationalRecord, persistOperationalRecord } from "../../services/syncService";

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;
const money = formatMoney;

type Sort = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";

export function LabourAdvances() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [labourerId, setLabourerId] = useState("all");
  const [group, setGroup] = useState("all");
  const [paymentType, setPaymentType] = useState("all");
  const [sort, setSort] = useState<Sort>("date_desc");
  const [selected, setSelected] = useState<Advance | null>(null);
  const [editing, setEditing] = useState(false);
  const canManage = Boolean(user?.workspaceId && hasPermission(user, "MANAGE_RECORDS", user.workspaceId));

  const refresh = useCallback(async () => {
    const [nextAdvances, nextLabourers, nextAccounts] = await Promise.all([
      workspaceRecords(offlineDb.advances),
      workspaceRecords(offlineDb.labourers),
      workspaceRecords(offlineDb.accounts),
    ]);
    setAdvances(nextAdvances);
    setLabourers(nextLabourers);
    setAccounts(nextAccounts);
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener("muzare-data-refresh", refresh);
    window.addEventListener("muzare-local-data-change", refresh);
    return () => {
      window.removeEventListener("muzare-data-refresh", refresh);
      window.removeEventListener("muzare-local-data-change", refresh);
    };
  }, [refresh]);
  useEffect(() => {
    const recordId = searchParams.get("recordId");
    if (recordId) setSelected(advances.find((advance) => advance.id === recordId) ?? null);
  }, [advances, searchParams]);

  const labourById = useMemo(() => new Map(labourers.map((labourer) => [labourer.id, labourer])), [labourers]);
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account.name])), [accounts]);
  const groups = useMemo(() => [...new Set(labourers.map((labourer) => labourer.group).filter(Boolean))].sort(), [labourers]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return advances
      .filter((advance) => advance.date >= from && advance.date <= to)
      .filter((advance) => labourerId === "all" || advance.labourerId === labourerId)
      .filter((advance) => {
        const labourer = labourById.get(advance.labourerId);
        return group === "all" || labourer?.group === group;
      })
      .filter((advance) => {
        const labourer = labourById.get(advance.labourerId);
        return paymentType === "all" || (labourer?.paymentType ?? "daily_wage") === paymentType;
      })
      .filter((advance) => {
        if (!term) return true;
        const labourer = labourById.get(advance.labourerId);
        return labourer?.name.toLowerCase().includes(term)
          || labourer?.group.toLowerCase().includes(term)
          || String(advance.amount).includes(term)
          || advance.notes.toLowerCase().includes(term)
          || (accountById.get(advance.accountId ?? "") ?? advance.sourceAccountName ?? "").toLowerCase().includes(term);
      })
      .sort((left, right) => {
        if (sort === "date_asc") return left.date.localeCompare(right.date) || left.id.localeCompare(right.id);
        if (sort === "amount_desc") return right.amount - left.amount || right.date.localeCompare(left.date);
        if (sort === "amount_asc") return left.amount - right.amount || right.date.localeCompare(left.date);
        return right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt);
      });
  }, [accountById, advances, labourById, from, group, labourerId, paymentType, search, sort, to]);

  const total = filtered.reduce((sum, advance) => sum + advance.amount, 0);
  const labourCount = new Set(filtered.map((advance) => advance.labourerId)).size;
  const remove = async (advance: Advance) => {
    if (!canManage || !window.confirm(t("advancesPage.deleteConfirm"))) return;
    await deleteOperationalRecord("advance", advance);
    setSelected(null);
    await refresh();
  };

  return (
    <div className="dashboard-page">
      <SubpageHeader title={t("advancesPage.title")} />
      <main className="subpage module-workspace advances-register">
        <section className="workspace-intro">
          <div><h2>{t("advancesPage.introTitle")}</h2><p>{t("advancesPage.introDescription")}</p></div>
          <span className="local-pill">{t("advancesPage.databaseSynchronized")}</span>
        </section>
        <section className="advances-summary">
          <article><span>{t("advancesPage.totalAdvances")}</span><strong>{money(total)}</strong></article>
          <article><span>{t("advancesPage.transactions")}</span><strong>{filtered.length}</strong></article>
          <article><span>{t("advancesPage.labourWithAdvances")}</span><strong>{labourCount}</strong></article>
        </section>
        <section className="record-panel">
          <div className="advances-heading"><h2>{t("advancesPage.advanceHistory")}</h2><span>{t("advancesPage.transactionCount", { count: filtered.length })}</span></div>
          <div className="advances-filters">
            <SearchInput placeholder={t("advancesPage.searchPlaceholder")} value={search} onChange={setSearch} />
            <input aria-label={t("advancesPage.dateFrom")} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            <input aria-label={t("advancesPage.dateTo")} type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            <LabourSelectCombobox
              ariaLabel={t("advancesPage.labour")}
              options={labourers.slice().sort((a, b) => a.name.localeCompare(b.name))}
              value={labourerId}
              onChange={setLabourerId}
              clearValue="all"
              includeAllOption
              allOptionLabel={t("advancesPage.allLabour")}
              placeholder={t("workforcePage.searchLabour")}
              noResultsLabel={t("workforcePage.noLabourFound")}
            />
            <select aria-label={t("advancesPage.group")} value={group} onChange={(event) => setGroup(event.target.value)}>
              <option value="all">{t("advancesPage.allGroups")}</option>
              {groups.map((name) => <option key={name}>{name}</option>)}
            </select>
            <select aria-label={t("advancesPage.paymentType")} value={paymentType} onChange={(event) => setPaymentType(event.target.value)}>
              <option value="all">{t("advancesPage.allPaymentTypes")}</option>
              <option value="daily_wage">{t("workforcePage.dailyWage")}</option><option value="production_based">Production Based</option>
              <option value="contract_lump_sum">Contract</option><option value="monthly_salary">Monthly Salary</option><option value="other">Other</option>
            </select>
            <select aria-label={t("advancesPage.transactions")} value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
              <option value="date_desc">{t("advancesPage.newestFirst")}</option><option value="date_asc">{t("advancesPage.oldestFirst")}</option>
              <option value="amount_desc">{t("advancesPage.highestAmount")}</option><option value="amount_asc">{t("advancesPage.lowestAmount")}</option>
            </select>
          </div>
          {!filtered.length ? <p className="empty-records">{t("advancesPage.noResults")}</p> : <div className="advances-list">
            {filtered.map((advance) => {
              const labourer = labourById.get(advance.labourerId);
              return <button type="button" className="advance-row" key={advance.id} onClick={() => setSelected(advance)}>
                <span>{advance.date}</span><strong>{labourer?.name ?? t("advancesPage.labour")}</strong><span>{labourer?.group ?? "-"}</span>
                <b>{money(advance.amount)}</b><span>{advance.notes || "-"}</span><span>{accountById.get(advance.accountId ?? "") ?? advance.sourceAccountName ?? "-"}</span>
              </button>;
            })}
          </div>}
        </section>
        {selected && <AdvanceDetails advance={selected} labourer={labourById.get(selected.labourerId)} accountName={accountById.get(selected.accountId ?? "") ?? selected.sourceAccountName} canManage={canManage} onClose={() => setSelected(null)} onEdit={() => setEditing(true)} onDelete={() => void remove(selected)} />}
        {selected && editing && <EditAdvance advance={selected} accounts={accounts} onClose={() => setEditing(false)} onSave={async (record) => {
          await persistOperationalRecord("advance", record);
          setSelected(record); setEditing(false); await refresh();
        }} />}
      </main>
    </div>
  );
}

function AdvanceDetails({ advance, labourer, accountName, canManage, onClose, onEdit, onDelete }: {
  advance: Advance; labourer?: Labourer; accountName?: string; canManage: boolean; onClose: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  return <div className="worker-dialog-backdrop" role="presentation" onClick={onClose}><section className="worker-dialog" role="dialog" aria-modal="true" aria-label={t("advancesPage.detailsTitle")} onClick={(event) => event.stopPropagation()}>
    <header className="worker-dialog__header"><h2>{t("advancesPage.detailsTitle")}</h2></header>
    <div className="worker-dialog__body"><dl className="worker-stats">
      <div><dt>{t("advancesPage.date")}</dt><dd>{advance.date}</dd></div><div><dt>{t("advancesPage.labour")}</dt><dd>{labourer?.name ?? t("advancesPage.labour")}</dd></div>
      <div><dt>{t("advancesPage.group")}</dt><dd>{labourer?.group ?? "-"}</dd></div><div><dt>{t("advancesPage.amount")}</dt><dd>{money(advance.amount)}</dd></div>
      <div><dt>{t("advancesPage.paidFrom")}</dt><dd>{accountName ?? "-"}</dd></div><div><dt>{t("advancesPage.notesReference")}</dt><dd>{advance.notes || "-"}</dd></div><div><dt>{t("advancesPage.createdBy")}</dt><dd>-</dd></div>
    </dl></div>
    <footer className="worker-dialog__footer">{canManage && <button className="worker-dialog__link" type="button" onClick={onEdit}>{t("advancesPage.edit")}</button>}{canManage && <button className="worker-dialog__link worker-dialog__link--danger" type="button" onClick={onDelete}>{t("advancesPage.delete")}</button>}<button className="worker-dialog__close" type="button" onClick={onClose}>{t("advancesPage.close")}</button></footer>
  </section></div>;
}

function EditAdvance({ advance, accounts, onClose, onSave }: { advance: Advance; accounts: Account[]; onClose: () => void; onSave: (record: Advance) => Promise<void> }) {
  const { t } = useTranslation();
  const [date, setDate] = useState(advance.date); const [amount, setAmount] = useState(String(advance.amount)); const [notes, setNotes] = useState(advance.notes);
  const [accountId, setAccountId] = useState(advance.accountId ?? "");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); const nextAmount = Number(amount);
    if (!Number.isFinite(nextAmount) || nextAmount <= 0 || !accountId || busy) { setError(t("advancesPage.advanceValidation")); return; }
    setBusy(true); setError("");
    try { await onSave({ ...advance, date, amount: nextAmount, accountId, notes, updatedAt: new Date().toISOString() }); } catch (caught) { setError(caught instanceof Error ? caught.message : t("advancesPage.unableUpdate")); } finally { setBusy(false); }
  };
  return <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={onClose}><section className="worker-action-dialog" role="dialog" aria-modal="true" aria-label={t("advancesPage.editAdvance")} onClick={(event) => event.stopPropagation()}>
    <header><h2>{t("advancesPage.editAdvance")}</h2><button type="button" onClick={onClose} aria-label={t("advancesPage.closeEditAdvance")}><X size={18} /></button></header>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}><label><span>{t("advancesPage.date")} *</span><input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      <label><span>{t("advancesPage.amount")} *</span><input required min="0.01" step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
      <label><span>{t("advancesPage.paymentAccount")} *</span><select required value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">{t("advancesPage.selectAccount")}</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label><span>{t("advancesPage.notesReference")}</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>{error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>{t("common.close")}</button><button disabled={busy} type="submit">{busy ? t("advancesPage.saving") : t("advancesPage.saveChanges")}</button></footer>
    </form></section></div>;
}

