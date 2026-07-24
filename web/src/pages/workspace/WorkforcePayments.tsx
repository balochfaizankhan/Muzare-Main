import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  ArrowRight,
  Banknote,
  HandCoins,
  PauseCircle,
  Plus,
  ReceiptText,
  Search,
  ShieldCheck,
  WalletCards,
  X,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useAuth } from "../../auth/AuthProvider";
import { useCanonicalLabourFinancials } from "../../hooks/useCanonicalLabourFinancials";
import { LabourSelectCombobox } from "../../components/LabourSelectCombobox";
import { eligiblePaymentAccounts, PaymentAccountSelect } from "../../components/PaymentAccountSelect";
import { translateStatus } from "../../lib/statusLabels";
import {
  createDirectLabourDue,
  ApiError,
  fetchLabourAdvancePools,
  fetchLabourDueAdvancePool,
  fetchLabourPaymentAdvances,
  fetchLabourPaymentDues,
  fetchLabourPaymentVouchers,
  postLabourAdvanceVoucher,
  recoverLabourAdvancePool,
  updateLabourAdvanceVoucher,
  deleteLabourAdvanceVoucher,
  setLabourDueHold,
  settleLabourPaymentDue,
  voidLabourPaymentVoucher,
  reverseLabourAdvanceApplicationEvent,
  voidLabourDue,
  type LabourAdvanceApplicationParentRecord,
  type LabourAdvancePosition,
  type LabourAdvanceListResponse,
  type LabourAdvancePoolActivity,
  type LabourDueAdvancePool,
  type LabourAdvancePoolsResponse,
  type LabourDueRecord,
  type LabourFinancialReadModel,
  type LabourPaymentVoucherRecord,
  type LabourRecipientScope
} from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { canCreate, canDelete, canEdit } from "../../lib/permissions";
import {
  getActiveFarmId,
  getActiveSeasonId,
  offlineDb,
  workspaceRecords,
  type Account,
  type LabourGroup,
  type Labourer,
} from "../../lib/offline-db";
import { filterLabourSelectableForAdvance, getWorkerDisplayGroup, sortLabourSelectableForAdvance } from "../../lib/workerEligibility";
import { resolveAdvanceCardIdentity } from "../../lib/labourAdvanceDisplay";

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const money = formatMoney;
const uuid = () => crypto.randomUUID();

function scopeOptions(t: TFunction): Array<{ value: LabourRecipientScope; label: string }> {
  return [
    { value: "INDIVIDUAL", label: t("workforcePaymentsPage.recipientScopeOptions.individual") },
    { value: "LABOUR_GROUP", label: t("workforcePaymentsPage.recipientScopeOptions.labourGroup") },
    { value: "CONTRACTOR_FOREMAN", label: t("workforcePaymentsPage.recipientScopeOptions.contractorForeman") },
    { value: "TEMPORARY_CREW", label: t("workforcePaymentsPage.recipientScopeOptions.temporaryCrew") },
    { value: "UNREGISTERED_LABOUR", label: t("workforcePaymentsPage.recipientScopeOptions.unregisteredLabour") },
    { value: "NO_SPECIFIC_RECIPIENT", label: t("workforcePaymentsPage.recipientScopeOptions.noSpecificRecipient") },
  ];
}

function scopeLabel(t: TFunction, scope: LabourRecipientScope) {
  return scopeOptions(t).find((option) => option.value === scope)?.label ?? scope;
}

function statusLabel(t: TFunction, value: string) {
  return translateStatus(t, value);
}

function advanceLabourStatus(labourer: Labourer): "active" | "inactive" | "deactivated" {
  const status = typeof labourer.status === "string" ? labourer.status.trim().toLowerCase() : "";
  if (status === "deactivated" || labourer.deactivatedAt) return "deactivated";
  if (getWorkerDisplayGroup(labourer) === "inactive") return "inactive";
  return "active";
}

function renderAdvanceLabourOption(t: TFunction, labourer: Labourer) {
  const lifecycle = advanceLabourStatus(labourer);
  return (
    <span className="workforce-advance-labour-option">
      <strong>{labourer.name}</strong>
      {lifecycle !== "active" ? <small>{translateStatus(t, lifecycle)}</small> : null}
    </span>
  );
}

function recipientLabel(
  t: TFunction,
  record: Pick<
    LabourDueRecord | LabourPaymentVoucherRecord,
    "recipientScope" | "recipientSnapshot" | "labourerId" | "labourGroupId"
  >,
  labourById: Map<string, Labourer>,
  groupById: Map<string, LabourGroup>,
) {
  if (record.labourerId)
    return (
      labourById.get(record.labourerId)?.name ??
      String(record.recipientSnapshot.labourerName ?? t("workforcePaymentsPage.recipientScopeOptions.individual"))
    );
  if (record.labourGroupId)
    return (
      groupById.get(record.labourGroupId)?.name ??
      String(record.recipientSnapshot.labourGroupName ?? t("workforcePaymentsPage.recipientScopeOptions.labourGroup"))
    );
  return String(
    record.recipientSnapshot.recipientReference ??
      record.recipientSnapshot.manualRecipientName ??
      record.recipientSnapshot.crewReference ??
      record.recipientSnapshot.contractorReference ??
      record.recipientSnapshot.batchIdentity ??
      scopeLabel(t, record.recipientScope),
  );
}

type View = "dues" | "direct" | "vouchers" | "advances";

export function WorkforcePaymentsPage() {
  const { t } = useTranslation();
  const { token, user } = useAuth();
  const canonicalFinancials = useCanonicalLabourFinancials();
  const location = useLocation();
  const navigate = useNavigate();
  const workspaceId = user?.workspaceId ?? "";
  const farmId = getActiveFarmId() ?? "";
  const seasonId = getActiveSeasonId() ?? "";
  const view: View = location.pathname.endsWith("/direct-due")
    ? "direct"
    : location.pathname.endsWith("/vouchers")
      ? "vouchers"
      : location.pathname.endsWith("/advances")
        ? "advances"
        : "dues";
  const canManage = Boolean(
    user && workspaceId && canCreate(user, "wages", workspaceId),
  );
  const canHold = Boolean(
    user && workspaceId && canEdit(user, "wages", workspaceId),
  );
  const canVoid = Boolean(
    user && workspaceId && canDelete(user, "wages", workspaceId),
  );
  const [dues, setDues] = useState<LabourDueRecord[]>([]);
  const [vouchers, setVouchers] = useState<LabourPaymentVoucherRecord[]>([]);
  const [advanceSummary, setAdvanceSummary] = useState<LabourAdvanceListResponse["summary"] | null>(null);
  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [groups, setGroups] = useState<LabourGroup[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "OPEN" | "ALL" | LabourDueRecord["paymentStatus"]
  >("OPEN");
  const [originFilter, setOriginFilter] = useState<
    "ALL" | "SETTLEMENT" | "DIRECT"
  >("ALL");
  const [scopeFilter, setScopeFilter] = useState<"ALL" | LabourRecipientScope>(
    "ALL",
  );
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [selectedDue, setSelectedDue] = useState<LabourDueRecord | null>(null);

  useEffect(() => {
    const requestedDueId = new URLSearchParams(location.search).get("dueId");
    if (!requestedDueId || view !== "dues") return;
    const requested = dues.find((due) => due.id === requestedDueId);
    if (requested) setSelectedDue(requested);
  }, [dues, location.search, view]);

  const refresh = useCallback(async () => {
    const [nextLabourers, nextGroups, nextAccounts] = await Promise.all([
      workspaceRecords(offlineDb.labourers, { includeDeleted: true }),
      workspaceRecords(offlineDb.labourGroups, { includeDeleted: true }),
      workspaceRecords(offlineDb.accounts, { includeDeleted: true }),
    ]);
    setLabourers(nextLabourers.filter((item) => !item.deletedAt));
    setGroups(nextGroups.filter((item) => !item.deletedAt));
    setAccounts(
      nextAccounts.filter(
        (item) =>
          !item.deletedAt && ["cash", "bank", "partner"].includes(item.type),
      ),
    );
    if (!token || !workspaceId || !farmId || !seasonId || !navigator.onLine)
      return;
    setLoading(true);
    setError("");
    try {
      if (view === "advances" || view === "direct") return;
      const [dueResponse, voucherResponse, advanceResponse] = await Promise.all(
        [
          fetchLabourPaymentDues(token, workspaceId, { farmId, seasonId }),
          view === "vouchers" ? fetchLabourPaymentVouchers(token, workspaceId, { farmId, seasonId }) : Promise.resolve({ vouchers: [] }),
          fetchLabourPaymentAdvances(token, workspaceId, farmId, seasonId, { pageSize: 1, status: "OPEN" }),
        ],
      );
      setDues(dueResponse.dues);
      setVouchers(voucherResponse.vouchers);
      setAdvanceSummary(advanceResponse.summary);
      setSelectedDue((current) =>
        current
          ? (dueResponse.dues.find((item) => item.id === current.id) ?? null)
          : null,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("workforcePaymentsPage.errors.unableLoadWorkforcePayments"),
      );
    } finally {
      setLoading(false);
    }
  }, [farmId, seasonId, token, view, workspaceId]);

  useEffect(() => {
    setAdvanceSummary(null);
  }, [farmId, seasonId, workspaceId]);

  useEffect(() => {
    void refresh();
    const handle = () => void refresh();
    window.addEventListener("muzare-data-refresh", handle);
    return () => window.removeEventListener("muzare-data-refresh", handle);
  }, [refresh]);

  const labourById = useMemo(
    () => new Map(labourers.map((item) => [item.id, item])),
    [labourers],
  );
  const groupById = useMemo(
    () => new Map(groups.map((item) => [item.id, item])),
    [groups],
  );
  const accountById = useMemo(
    () => new Map(accounts.map((item) => [item.id, item])),
    [accounts],
  );
  const openDues = dues.filter((due) =>
    ["UNPAID", "PARTIALLY_SETTLED", "ON_HOLD"].includes(due.paymentStatus),
  );
  const totalDue = openDues.reduce(
    (sum, due) => sum + Number(due.outstandingBalance),
    0,
  );
  const unpaidSettlements = openDues.filter(
    (due) => due.origin === "SETTLEMENT" && due.paymentStatus === "UNPAID",
  ).length;
  const partialCount = openDues.filter(
    (due) => due.paymentStatus === "PARTIALLY_SETTLED",
  ).length;
  const filteredDues = useMemo(() => {
    const term = search.trim().toLowerCase();
    return dues.filter((due) => {
      const statusMatches =
        statusFilter === "ALL" ||
        (statusFilter === "OPEN" &&
          ["UNPAID", "PARTIALLY_SETTLED", "ON_HOLD"].includes(
            due.paymentStatus,
          )) ||
        due.paymentStatus === statusFilter;
      const originMatches =
        originFilter === "ALL" || due.origin === originFilter;
      const scopeMatches =
        scopeFilter === "ALL" || due.recipientScope === scopeFilter;
      const dateMatches =
        (!fromFilter || due.workToDate >= fromFilter) &&
        (!toFilter || due.workFromDate <= toFilter);
      const textMatches =
        !term ||
        [
          due.dueNumber,
          due.description,
          recipientLabel(t, due, labourById, groupById),
          due.settlementBasis,
        ]
          .join(" ")
          .toLowerCase()
          .includes(term);
      return (
        statusMatches &&
        originMatches &&
        scopeMatches &&
        dateMatches &&
        textMatches
      );
    });
  }, [
    dues,
    fromFilter,
    groupById,
    labourById,
    originFilter,
    scopeFilter,
    search,
    statusFilter,
    toFilter,
  ]);

  if (!farmId || !seasonId)
    return (
      <section className="record-panel workforce-payments-context">
        <AlertCircle size={20} />
        <p>{t("workforcePaymentsPage.selectFarmSeason")}</p>
      </section>
    );

  return (
    <div className="workforce-payments-page">
      {error ? (
        <div className="workforce-payments-notice is-error">
          <AlertCircle size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      ) : null}
      {success ? (
        <div className="workforce-payments-notice is-success">
          <ShieldCheck size={16} />
          <span>{success}</span>
          <button type="button" onClick={() => setSuccess("")}>
            <X size={15} />
          </button>
        </div>
      ) : null}
      {view === "dues" ? (
        <>
          <section className="workforce-payments-summary-grid">
            <button type="button" onClick={() => setStatusFilter("OPEN")}>
              <WalletCards size={17} />
              <span>{t("workforcePaymentsPage.summary.totalPaymentsDue")}</span>
              <strong className="bidi-isolate">{money(totalDue)}</strong>
            </button>
            <button
              type="button"
              onClick={() => {
                setStatusFilter("UNPAID");
                setOriginFilter("SETTLEMENT");
              }}
            >
              <ReceiptText size={17} />
              <span>{t("workforcePaymentsPage.summary.unpaidSettlements")}</span>
              <strong className="bidi-isolate">{unpaidSettlements}</strong>
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter("PARTIALLY_SETTLED")}
            >
              <Banknote size={17} />
              <span>{t("workforcePaymentsPage.summary.partiallySettled")}</span>
              <strong className="bidi-isolate">{partialCount}</strong>
            </button>
            <button
              type="button"
              onClick={() => navigate("/workspace/labour-payments/advances")}
            >
              <HandCoins size={17} />
              <span>{t("workforcePaymentsPage.summary.advances")}</span>
              <strong className="bidi-isolate">{loading && !advanceSummary ? "—" : advanceSummary ? money(advanceSummary.totalOutstanding) : t("workforcePaymentsPage.unavailable")}</strong>
              {advanceSummary ? <small>{t("workforcePaymentsPage.summary.openCount", { count: advanceSummary.openCount })}</small> : null}
            </button>
          </section>
          <section className="record-panel workforce-payments-panel">
            <header className="workforce-payments-panel__header">
              <div>
                <h2>{t("workforcePaymentsPage.paymentsDue.title")}</h2>
                <p>
                  {t("workforcePaymentsPage.paymentsDue.subtitle")}
                </p>
              </div>
              <div className="workforce-payments-panel__actions">
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() =>
                    navigate("/workspace/labour-payments/direct-due")
                  }
                >
                  <Plus size={16} /> {t("workforcePaymentsPage.newDue")}
                </button>
              </div>
            </header>
            <div className="workforce-payments-filters">
              <label className="workforce-payments-search">
                <Search size={16} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("workforcePaymentsPage.searchDuePlaceholder")}
                />
              </label>
              <select
                aria-label={t("workforcePaymentsPage.paymentStatus")}
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as typeof statusFilter)
                }
              >
                <option value="OPEN">{t("workforcePaymentsPage.statusOptions.unpaidAndPartial")}</option>
                <option value="UNPAID">{translateStatus(t, "UNPAID")}</option>
                <option value="PARTIALLY_SETTLED">{translateStatus(t, "PARTIALLY_SETTLED")}</option>
                <option value="PAID">{translateStatus(t, "PAID")}</option>
                <option value="SETTLED_BY_ADVANCE">{translateStatus(t, "SETTLED_BY_ADVANCE")}</option>
                <option value="ON_HOLD">{translateStatus(t, "ON_HOLD")}</option>
                <option value="VOIDED">{translateStatus(t, "VOIDED")}</option>
                <option value="ALL">{t("workforcePaymentsPage.statusOptions.allStatuses")}</option>
              </select>
              <select
                aria-label={t("workforcePaymentsPage.dueOrigin")}
                value={originFilter}
                onChange={(event) =>
                  setOriginFilter(event.target.value as typeof originFilter)
                }
              >
                <option value="ALL">{t("workforcePaymentsPage.originOptions.allOrigins")}</option>
                <option value="SETTLEMENT">{translateStatus(t, "SETTLEMENT")}</option>
                <option value="DIRECT">{t("workforcePaymentsPage.originOptions.directDue")}</option>
              </select>
              <select
                aria-label={t("workforcePaymentsPage.recipientScope")}
                value={scopeFilter}
                onChange={(event) =>
                  setScopeFilter(event.target.value as typeof scopeFilter)
                }
              >
                <option value="ALL">{t("workforcePaymentsPage.scopeOptions.allRecipients")}</option>
                {scopeOptions(t).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <label className="workforce-payments-date-filter">
                <span>{t("workforcePaymentsPage.dateFilterFrom")}</span>
                <input
                  type="date"
                  value={fromFilter}
                  onChange={(event) => setFromFilter(event.target.value)}
                />
              </label>
              <label className="workforce-payments-date-filter">
                <span>{t("workforcePaymentsPage.dateFilterTo")}</span>
                <input
                  type="date"
                  min={fromFilter || undefined}
                  value={toFilter}
                  onChange={(event) => setToFilter(event.target.value)}
                />
              </label>
            </div>
            {loading ? (
              <p className="workforce-payments-empty">{t("workforcePaymentsPage.loadingPaymentsDue")}</p>
            ) : !filteredDues.length ? (
              <p className="workforce-payments-empty">
                {t("workforcePaymentsPage.noDuesMatchFilters")}
              </p>
            ) : (
              <div className="workforce-payments-due-list">
                {filteredDues.map((due) => (
                  <button
                    key={due.id}
                    type="button"
                    className="workforce-payment-due-card"
                    onClick={() => setSelectedDue(due)}
                  >
                    <span className="workforce-payment-due-card__top">
                      <strong className="bidi-isolate">{due.dueNumber}</strong>
                      <em
                        className={`workforce-payment-status status-${due.paymentStatus.toLowerCase()}`}
                      >
                        {statusLabel(t, due.paymentStatus)}
                      </em>
                    </span>
                    <span className="workforce-payment-due-card__recipient">
                      {recipientLabel(t, due, labourById, groupById)}
                    </span>
                    {due.recipientScope === "LABOUR_GROUP" && due.settlementBasis === "ATTENDANCE" ? (
                      <span className="workforce-payment-due-card__description">
                        {t("workforcePaymentsPage.leaderWithWorkers", {
                          name: String(due.recipientSnapshot.foremanName ?? due.recipientSnapshot.leaderName ?? t("workforcePaymentsPage.unavailable")),
                          count: Number(due.recipientSnapshot.memberCount ?? 0),
                        })}
                      </span>
                    ) : null}
                    {["TEMPORARY_CREW", "UNREGISTERED_LABOUR", "NO_SPECIFIC_RECIPIENT"].includes(due.recipientScope) ? (
                      <span className="workforce-payment-due-card__description">
                        {due.recipientSnapshot.contactPerson
                          ? t("workforcePaymentsPage.temporaryUnregisteredCrewWithContact", { contact: String(due.recipientSnapshot.contactPerson) })
                          : t("workforcePaymentsPage.temporaryUnregisteredCrew")}
                      </span>
                    ) : null}
                    <span className="workforce-payment-due-card__description">
                      {due.description}
                    </span>
                    <span className="workforce-payment-due-card__meta">
                      <i>
                        {due.origin === "SETTLEMENT"
                          ? t("workforcePaymentsPage.settlementBasisSuffix", { basis: statusLabel(t, due.settlementBasis ?? "Settlement") })
                          : t("workforcePaymentsPage.directLabourDue")}
                      </i>
                      <i className="bidi-isolate">
                        {due.workFromDate} – {due.workToDate}
                      </i>
                    </span>
                    <span className="workforce-payment-due-card__amounts">
                      <i>
                        {t("workforcePaymentsPage.amounts.gross")} <b className="bidi-isolate">{money(Number(due.grossAmount))}</b>
                      </i>
                      <i>
                        {t("workforcePaymentsPage.amounts.deductions")} <b className="bidi-isolate">{money(Number(due.authorizedDeductions))}</b>
                      </i>
                      <i>
                        {t("workforcePaymentsPage.amounts.advances")} <b className="bidi-isolate">{money(due.advancesApplied)}</b>
                      </i>
                      <i>
                        {t("workforcePaymentsPage.amounts.paid")} <b className="bidi-isolate">{money(due.previousPayments)}</b>
                      </i>
                      <i className="is-outstanding">
                        {t("workforcePaymentsPage.amounts.outstanding")} <b className="bidi-isolate">{money(due.outstandingBalance)}</b>
                      </i>
                    </span>
                    <span className="workforce-payment-due-card__action">
                      {t("workforcePaymentsPage.reviewAndSettle")} <ArrowRight size={15} />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
      {view === "direct" ? (
        <DirectDueForm
          labourers={labourers}
          groups={groups}
          canManage={canManage}
          onSaved={(message, due) => {
            setSuccess(message);
            setDues((current) => [due, ...current.filter((item) => item.id !== due.id)]);
            navigate("/workspace/labour-payments/overview");
          }}
          onError={setError}
          token={token ?? ""}
          workspaceId={workspaceId}
          farmId={farmId}
          seasonId={seasonId}
        />
      ) : null}
      {view === "vouchers" ? (
        <VoucherRegister
          vouchers={vouchers}
          applicationParents={canonicalFinancials.data?.advanceApplicationParents ?? []}
          dues={dues}
          canonicalSummary={canonicalFinancials.data?.summary ?? null}
          accounts={accountById}
          labourById={labourById}
          groupById={groupById}
          loading={loading}
          canVoid={canVoid}
          token={token ?? ""}
          workspaceId={workspaceId}
          farmId={farmId}
          seasonId={seasonId}
          onSaved={async (message) => {
            setSuccess(message);
            await refresh();
          }}
          onError={setError}
          onViewAdvances={() => navigate("/workspace/labour-payments/advances")}
        />
      ) : null}
      {view === "advances" ? (
        <AdvancesView
          labourers={labourers}
          groups={groups}
          accounts={accounts}
          canManage={canManage}
          token={token ?? ""}
          workspaceId={workspaceId}
          farmId={farmId}
          seasonId={seasonId}
          canonicalFinancials={canonicalFinancials}
          onSaved={async (message) => {
            setSuccess(message);
            window.dispatchEvent(new Event("muzare-data-refresh"));
          }}
          onError={setError}
        />
      ) : null}
      {selectedDue ? (
        <ReviewSettleDialog
          due={selectedDue}
          accounts={accounts}
          recipient={recipientLabel(t, selectedDue, labourById, groupById)}
          canManage={canManage}
          canHold={canHold}
          canVoid={canVoid}
          token={token ?? ""}
          workspaceId={workspaceId}
          farmId={farmId}
          seasonId={seasonId}
          onClose={() => setSelectedDue(null)}
          onSaved={async (message) => {
            setSelectedDue(null);
            setSuccess(message);
            await refresh();
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function DirectDueForm({
  labourers,
  groups,
  canManage,
  onSaved,
  onError,
  token,
  workspaceId,
  farmId,
  seasonId,
}: {
  labourers: Labourer[];
  groups: LabourGroup[];
  canManage: boolean;
  onSaved: (message: string, due: LabourDueRecord) => void;
  onError: (message: string) => void;
  token: string;
  workspaceId: string;
  farmId: string;
  seasonId: string;
}) {
  const { t } = useTranslation();
  const idempotencyKey = useRef(uuid());
  const location = useLocation();
  // Attendance-generated Labour Dues are retired: every new Labour Due is a
  // direct labour-group liability. There is no source selector, no attendance
  // preview, and the amount is never calculated from attendance or wage
  // rates — the work dates are descriptive information only.
  const initialParams = new URLSearchParams(location.search);
  const [scope, setScope] = useState<LabourRecipientScope>(initialParams.get("scope") === "individual" ? "INDIVIDUAL" : "LABOUR_GROUP");
  const [labourerId, setLabourerId] = useState("");
  const [groupId, setGroupId] = useState(initialParams.get("groupId") ?? "");
  const [recipientName, setRecipientName] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [agreedGrossAmount, setAgreedGrossAmount] = useState("");
  const [authorizedDeductions, setAuthorizedDeductions] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const labourerFieldRef = useRef<HTMLLabelElement>(null);
  const agreedAmountRef = useRef<HTMLInputElement>(null);
  const deductionsRef = useRef<HTMLInputElement>(null);
  const recipientReferenceRef = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const groupSelectorOptions = useMemo(() => groups.map((group) => ({ ...group, group: "Labour group", dailyWage: 0 } satisfies Labourer)), [groups]);
  const selectedGroup = useMemo(() => groups.find((group) => group.id === groupId) ?? null, [groups, groupId]);
  const groupLeaderName = useMemo(() => {
    const leaderId = (selectedGroup as { foremanLabourId?: string; foremanId?: string } | null)?.foremanLabourId
      ?? (selectedGroup as { foremanId?: string } | null)?.foremanId;
    return leaderId ? labourers.find((item) => item.id === leaderId)?.name ?? null : null;
  }, [selectedGroup, labourers]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManage || saving) return;
    setFieldErrors({});
    setSaving(true);
    let committed = false;
    const submitStartedAt = performance.now();
    try {
      if (!navigator.onLine)
        throw new Error(
          t("workforcePaymentsPage.errors.connectInternetApproveDue"),
        );
      const response = await createDirectLabourDue(token, workspaceId, {
        farmId,
        seasonId,
        idempotencyKey: idempotencyKey.current,
        source: "DIRECT",
        recipientScope: scope,
        labourerId: scope === "INDIVIDUAL" ? labourerId : null,
        labourGroupId: scope === "LABOUR_GROUP" ? groupId : null,
        recipientReference: !["INDIVIDUAL", "LABOUR_GROUP"].includes(scope) ? reference : null,
        contactPerson: !["INDIVIDUAL", "LABOUR_GROUP"].includes(scope) ? recipientName || null : null,
        description,
        workFromDate: from,
        workToDate: to,
        agreedGrossAmount,
        authorizedDeductions: authorizedDeductions || "0.00",
        notes,
      });
      committed = true;
      idempotencyKey.current = uuid();
      setSaving(false);
      performance.mark("labour-due-create-committed");
      console.info("labour_due_create_frontend_timing", { totalMs: performance.now() - submitStartedAt, server: response.performance ?? null });
      onSaved(t("workforcePaymentsPage.dueCreatedSuccess", { dueNumber: response.due.dueNumber }), response.due);
    } catch (caught) {
      const responseErrors = caught instanceof ApiError && caught.responseBody && typeof caught.responseBody === "object" && "errors" in caught.responseBody
        ? (caught.responseBody as { errors?: Record<string, string> }).errors ?? {}
        : {};
      const visibleFields = new Set(["labourerId", "labourGroupId", "recipientReference", "description", "workFromDate", "workToDate", "agreedGrossAmount", "authorizedDeductions"]);
      const normalizedErrors = Object.fromEntries(Object.entries(responseErrors).flatMap(([field, message]) => {
        const normalizedField = ["batchIdentity", "crewReference", "contractorReference", "settlementIdentity"].includes(field) ? "recipientReference" : field;
        return visibleFields.has(normalizedField) ? [[normalizedField, message]] : [];
      }));
      setFieldErrors(normalizedErrors);
      const firstField = Object.keys(normalizedErrors)[0];
      window.setTimeout(() => {
        if (firstField === "labourerId") labourerFieldRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        if (firstField === "agreedGrossAmount") agreedAmountRef.current?.focus();
        if (firstField === "authorizedDeductions") deductionsRef.current?.focus();
        if (firstField === "recipientReference") recipientReferenceRef.current?.focus();
      }, 0);
      onError(
        Object.keys(normalizedErrors).length ? t("workforcePaymentsPage.errors.correctHighlightedField", { count: Object.keys(normalizedErrors).length }) : Object.values(responseErrors)[0] ?? (caught instanceof Error
          ? caught.message
          : t("workforcePaymentsPage.errors.unableCreateLabourDue")),
      );
    } finally {
      if (!committed) setSaving(false);
    }
  };
  return (
    <section className="record-panel workforce-payments-panel workforce-direct-due-panel">
      <header className="workforce-payments-panel__header">
        <div>
          <h2>{t("workforcePaymentsPage.directDueForm.title")}</h2>
          <p>
            {t("workforcePaymentsPage.directDueForm.subtitle")}
          </p>
        </div>
      </header>
      <form
        className="workforce-payment-form"
        onSubmit={(event) => void submit(event)}
      >
        <label>
          <span>{t("workforcePaymentsPage.recipientScope")}</span>
          <select
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as LabourRecipientScope)
            }
          >
            {scopeOptions(t).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {scope === "INDIVIDUAL" ? (
          <label ref={labourerFieldRef} className={fieldErrors.labourerId ? "has-error" : undefined}>
            <span>{t("workforcePaymentsPage.labourer")}</span>
            <LabourSelectCombobox ariaLabel={t("workforcePaymentsPage.labourer")} options={labourers} value={labourerId} onChange={setLabourerId} placeholder={t("workforcePaymentsPage.searchLabourerPlaceholder")} noResultsLabel={t("workforcePaymentsPage.noMatchingLabourer")} includeInactive />
            {fieldErrors.labourerId ? <small className="workforce-field-error">{fieldErrors.labourerId}</small> : null}
          </label>
        ) : null}
        {scope === "LABOUR_GROUP" ? (
          <label className={fieldErrors.labourGroupId ? "has-error" : undefined}>
            <span>{t("workforcePaymentsPage.recipientScopeOptions.labourGroup")}</span>
            <LabourSelectCombobox ariaLabel={t("workforcePaymentsPage.recipientScopeOptions.labourGroup")} options={groupSelectorOptions} value={groupId} onChange={setGroupId} placeholder={t("workforcePaymentsPage.searchLabourGroupPlaceholder")} noResultsLabel={t("workforcePaymentsPage.noMatchingLabourGroup")} includeInactive />
            {groupLeaderName ? <small className="workforce-payments-inline-note">{t("workforcePaymentsPage.groupLeaderLabel", { name: groupLeaderName })}</small> : null}
            {fieldErrors.labourGroupId ? <small className="workforce-field-error">{fieldErrors.labourGroupId}</small> : null}
          </label>
        ) : null}
        {!["INDIVIDUAL", "LABOUR_GROUP"].includes(scope) ? (
          <>
            <label>
              <span>{t("workforcePaymentsPage.contactPersonOptional")}</span>
              <input
                value={recipientName}
                onChange={(event) => setRecipientName(event.target.value)}
                placeholder={t("workforcePaymentsPage.foremanNamePlaceholder")}
              />
            </label>
            <label className={fieldErrors.recipientReference ? "has-error" : undefined}>
              <span>{t("workforcePaymentsPage.crewReferenceName")}</span>
              <input
                required
                ref={recipientReferenceRef}
                value={reference}
                onChange={(event) => { setReference(event.target.value); setFieldErrors((current) => ({ ...current, recipientReference: "" })); }}
                placeholder={t("workforcePaymentsPage.crewReferencePlaceholder")}
              />
              {fieldErrors.recipientReference ? <small className="workforce-field-error">{fieldErrors.recipientReference}</small> : null}
            </label>
          </>
        ) : null}
        <label className={`is-full${fieldErrors.description ? " has-error" : ""}`}>
          <span>{t("workforcePaymentsPage.workDescription")}</span>
          <input
            required
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("workforcePaymentsPage.exampleWorkDescription")}
          />
          {fieldErrors.description ? <small className="workforce-field-error">{fieldErrors.description}</small> : null}
        </label>
        <label className={fieldErrors.workFromDate ? "has-error" : undefined}>
          <span>{t("workforcePaymentsPage.workFrom")}</span>
          <input
            required
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          {fieldErrors.workFromDate ? <small className="workforce-field-error">{fieldErrors.workFromDate}</small> : null}
        </label>
        <label className={fieldErrors.workToDate ? "has-error" : undefined}>
          <span>{t("workforcePaymentsPage.workTo")}</span>
          <input
            required
            type="date"
            min={from}
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
          {fieldErrors.workToDate ? <small className="workforce-field-error">{fieldErrors.workToDate}</small> : null}
        </label>
        <label className={fieldErrors.agreedGrossAmount ? "has-error" : undefined}>
          <span>{t("workforcePaymentsPage.finalAgreedAmount")}</span>
          <input
            required
            min="0.01"
            step="0.01"
            type="number"
            ref={agreedAmountRef}
            value={agreedGrossAmount}
            onChange={(event) => { setAgreedGrossAmount(event.target.value); setFieldErrors((current) => ({ ...current, agreedGrossAmount: "" })); }}
            placeholder="0.00"
          />
          {fieldErrors.agreedGrossAmount ? <small className="workforce-field-error">{fieldErrors.agreedGrossAmount}</small> : null}
        </label>
        <label className={fieldErrors.authorizedDeductions ? "has-error" : undefined}>
          <span>{t("workforcePaymentsPage.authorizedDeductions")}</span>
          <input
            min="0"
            step="0.01"
            type="number"
              ref={deductionsRef}
              value={authorizedDeductions}
              onChange={(event) => { setAuthorizedDeductions(event.target.value); setFieldErrors((current) => ({ ...current, authorizedDeductions: "" })); }}
            placeholder="0.00"
          />
          {fieldErrors.authorizedDeductions ? <small className="workforce-field-error">{fieldErrors.authorizedDeductions}</small> : null}
        </label>
        <label className="is-full">
          <span>{t("workforcePaymentsPage.notes")}</span>
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={t("workforcePaymentsPage.optionalNotes")}
          />
        </label>
        <footer className="workforce-payment-form__footer">
          <div>
            <strong>{t("workforcePaymentsPage.amounts.amountDue")}</strong>
            <span className="bidi-isolate">
              {money(Math.max(Number(agreedGrossAmount || 0) - Number(authorizedDeductions || 0), 0))}
            </span>
          </div>
          <button disabled={!canManage || saving} type="submit">
            {saving ? t("workforcePaymentsPage.creating") : t("workforcePaymentsPage.createLabourDue")}
          </button>
        </footer>
      </form>
    </section>
  );
}

function VoucherRegister({
  vouchers,
  applicationParents,
  dues,
  canonicalSummary,
  accounts,
  labourById,
  groupById,
  loading,
  canVoid,
  token,
  workspaceId,
  farmId,
  seasonId,
  onSaved,
  onError,
  onViewAdvances,
}: {
  vouchers: LabourPaymentVoucherRecord[];
  applicationParents: LabourAdvanceApplicationParentRecord[];
  dues: LabourDueRecord[];
  canonicalSummary: LabourFinancialReadModel["summary"] | null;
  accounts: Map<string, Account>;
  labourById: Map<string, Labourer>;
  groupById: Map<string, LabourGroup>;
  loading: boolean;
  canVoid: boolean;
  token: string;
  workspaceId: string;
  farmId: string;
  seasonId: string;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
  onViewAdvances: () => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const initialNature = new URLSearchParams(location.search).get("nature");
  const [search, setSearch] = useState("");
  const [nature, setNature] = useState(
    initialNature === "ADVANCE_APPLICATION" ||
      initialNature === "DIRECT_LABOUR_PAYMENT" ||
      initialNature === "SETTLEMENT_BALANCE_PAYMENT" ||
      initialNature === "REVERSAL"
      ? initialNature
      : "ALL",
  );
  const [voidingId, setVoidingId] = useState("");
  const voidIdempotencyKeys = useRef<Record<string, string>>({});
  type VoucherRegisterRow =
    | {
        id: string;
        kind: "application_parent";
        status: LabourAdvanceApplicationParentRecord["status"];
        nature: "ADVANCE_APPLICATION";
        voucherNumber: string;
        date: string;
        description: string;
        amount: number;
        recipient: string;
        dueNumber?: string | null;
        parent: LabourAdvanceApplicationParentRecord;
      }
    | {
        id: string;
        kind: "voucher";
        status: LabourPaymentVoucherRecord["status"];
        nature: LabourPaymentVoucherRecord["nature"];
        voucherNumber: string;
        date: string;
        description: string;
        amount: number;
        recipient: string;
        dueNumber?: null;
        sourceAdvanceVoucherNumber?: null;
        voucher: LabourPaymentVoucherRecord;
      };
  const reverseApplicationParent = async (
    parent: LabourAdvanceApplicationParentRecord,
  ) => {
    const reason = window.prompt(
      t("workforcePaymentsPage.voucherRegister.reasonForReversing", { voucherNumber: parent.displayVoucherNumber }),
    );
    if (!reason?.trim()) return;
    setVoidingId(parent.id);
    try {
      if (!navigator.onLine)
        throw new Error(
          t("workforcePaymentsPage.errors.connectInternetReverseTransaction"),
        );
      if (!voidIdempotencyKeys.current[parent.id])
        voidIdempotencyKeys.current[parent.id] = uuid();
      const response = await reverseLabourAdvanceApplicationEvent(
        token,
        workspaceId,
        parent.id,
        farmId,
        seasonId,
        {
          idempotencyKey: voidIdempotencyKeys.current[parent.id]!,
          reason: reason.trim(),
        },
      );
      delete voidIdempotencyKeys.current[parent.id];
      await onSaved(
        response.result.reversedApplicationCount
          ? t("workforcePaymentsPage.voucherRegister.reversedSuccess", { voucherNumber: parent.displayVoucherNumber })
          : t("workforcePaymentsPage.voucherRegister.alreadyReversed", { voucherNumber: parent.displayVoucherNumber }),
      );
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("workforcePaymentsPage.errors.unableReverseAppliedAdvancesVoucher"),
      );
    } finally {
      setVoidingId("");
    }
  };
  const voidVoucher = async (voucher: LabourPaymentVoucherRecord) => {
    const reason = window.prompt(
      t("workforcePaymentsPage.voucherRegister.reasonForReversing", { voucherNumber: voucher.voucherNumber }),
    );
    if (!reason?.trim()) return;
    setVoidingId(voucher.id);
    try {
      if (!navigator.onLine)
        throw new Error(
          t("workforcePaymentsPage.errors.connectInternetReverseTransaction"),
        );
      if (!voidIdempotencyKeys.current[voucher.id])
        voidIdempotencyKeys.current[voucher.id] = uuid();
      const response = await voidLabourPaymentVoucher(
        token,
        workspaceId,
        voucher.id,
        farmId,
        seasonId,
        {
          idempotencyKey: voidIdempotencyKeys.current[voucher.id]!,
          reason: reason.trim(),
        },
      );
      delete voidIdempotencyKeys.current[voucher.id];
      await onSaved(
        response.result.reversal
          ? t("workforcePaymentsPage.voucherRegister.voidedBy", { voucherNumber: voucher.voucherNumber, reversalVoucherNumber: response.result.reversal.voucherNumber })
          : t("workforcePaymentsPage.voucherRegister.alreadyVoided", { voucherNumber: voucher.voucherNumber }),
      );
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("workforcePaymentsPage.errors.unableVoidVoucher"),
      );
    } finally {
      setVoidingId("");
    }
  };
  const applicationRows: VoucherRegisterRow[] = applicationParents.map(
    (parent) => ({
      id: parent.id,
      kind: "application_parent" as const,
      status: parent.status,
      nature: "ADVANCE_APPLICATION",
      voucherNumber: parent.displayVoucherNumber,
      date: parent.date,
      description: parent.description,
      amount: parent.activeAmount,
      recipient: parent.recipientName,
      dueNumber: parent.dueNumber,
      parent,
    }),
  );
  const voucherRows: VoucherRegisterRow[] = vouchers.map((voucher) => ({
    id: voucher.id,
    kind: "voucher" as const,
    status: voucher.status,
    nature: voucher.nature,
    voucherNumber: voucher.voucherNumber,
    date: voucher.voucherDate,
    description: voucher.description,
    amount: Number(voucher.paymentAmount),
    recipient: recipientLabel(t, voucher, labourById, groupById),
    voucher,
  }));
  const filtered: VoucherRegisterRow[] = [...voucherRows, ...applicationRows].filter(
    (row) =>
      (nature === "ALL" || row.nature === nature) &&
      (!search.trim() ||
        [
          row.voucherNumber,
          row.description,
          row.recipient,
          row.dueNumber,
        ]
          .join(" ")
          .toLowerCase()
          .includes(search.trim().toLowerCase())),
  );
  const recognizedExpense = canonicalSummary?.wageExpense ?? 0;
  const labourCashPaid = canonicalSummary?.activePaymentAmount ?? 0;
  const appliedAdvances = canonicalSummary?.activeAdvanceApplied ?? 0;
  const payableOutstanding = canonicalSummary
    ? Math.max(
        0,
        Number(
          (
            canonicalSummary.wageExpense -
            canonicalSummary.activePaymentAmount -
            canonicalSummary.activeAdvanceApplied
          ).toFixed(2),
        ),
      )
    : dues
        .filter(
          (due) =>
            !["VOIDED", "PAID", "SETTLED_BY_ADVANCE"].includes(due.paymentStatus),
        )
        .reduce((sum, due) => sum + due.outstandingBalance, 0);
  return (
    <section className="record-panel workforce-payments-panel">
      <header className="workforce-payments-panel__header">
        <div>
          <h2>{t("workforcePaymentsPage.voucherRegister.title")}</h2>
          <p>
            {t("workforcePaymentsPage.voucherRegister.subtitle")}
          </p>
        </div>
      </header>
      <div className="workforce-payments-filters">
        <label className="workforce-payments-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("workforcePaymentsPage.voucherRegister.searchPlaceholder")}
          />
        </label>
        <select
          value={nature}
          onChange={(event) => setNature(event.target.value)}
        >
          <option value="ALL">{t("workforcePaymentsPage.voucherRegister.natureOptions.all")}</option>
          <option value="SETTLEMENT_BALANCE_PAYMENT">
            {t("workforcePaymentsPage.voucherRegister.natureOptions.settlementPayments")}
          </option>
          <option value="DIRECT_LABOUR_PAYMENT">{t("workforcePaymentsPage.voucherRegister.natureOptions.directDuePayments")}</option>
          <option value="ADVANCE_APPLICATION">{t("workforcePaymentsPage.voucherRegister.natureOptions.advanceAppliedNonCash")}</option>
          <option value="REVERSAL">{t("workforcePaymentsPage.voucherRegister.natureOptions.reversals")}</option>
        </select>
      </div>
      <div className="workforce-payment-report-grid">
        <article>
          <span>{t("workforcePaymentsPage.voucherRegister.report.labourExpenseRecognized")}</span>
          <strong className="bidi-isolate">{money(recognizedExpense)}</strong>
        </article>
        <article>
          <span>{t("workforcePaymentsPage.voucherRegister.report.finalLabourPayments")}</span>
          <strong className="bidi-isolate">{money(labourCashPaid)}</strong>
        </article>
        <button type="button" className="workforce-payment-report-card" onClick={onViewAdvances}>
          <span>{t("workforcePaymentsPage.voucherRegister.report.appliedAdvances")}</span>
          <strong className="bidi-isolate">{money(appliedAdvances)}</strong>
        </button>
        <article>
          <span>{t("workforcePaymentsPage.voucherRegister.report.outstandingPayables")}</span>
          <strong className="bidi-isolate">{money(payableOutstanding)}</strong>
        </article>
      </div>
      {loading ? (
        <p className="workforce-payments-empty">{t("workforcePaymentsPage.voucherRegister.loadingVouchers")}</p>
      ) : !filtered.length ? (
        <p className="workforce-payments-empty">
          {t("workforcePaymentsPage.voucherRegister.noVouchersMatchFilter")}
        </p>
      ) : (
        <div className="workforce-payment-voucher-list">
          {filtered.map((row) => (
            <article key={row.id}>
              <header>
                <strong className="bidi-isolate">{row.voucherNumber}</strong>
                <em
                  className={`workforce-payment-status status-${row.status.toLowerCase()}`}
                >
                  {statusLabel(t, row.status)}
                </em>
              </header>
              <h3>{row.recipient}</h3>
              <p>{row.kind === "application_parent"
                ? (row.dueNumber
                    ? t("workforcePaymentsPage.voucherRegister.descriptionAppliedToDueNonCash", { description: row.description, dueNumber: row.dueNumber })
                    : t("workforcePaymentsPage.voucherRegister.descriptionNonCash", { description: row.description }))
                : row.description}
              </p>
              <dl>
                <div>
                  <dt>{t("workforcePaymentsPage.voucherRegister.natureLabel")}</dt>
                  <dd>{row.kind === "application_parent" ? t("workforcePaymentsPage.voucherRegister.natureOptions.advanceAppliedNonCash") : statusLabel(t, row.nature)}</dd>
                </div>
                <div>
                  <dt>{t("workforcePaymentsPage.voucherRegister.dateLabel")}</dt>
                  <dd className="bidi-isolate">{row.date}</dd>
                </div>
                <div>
                  <dt>{row.kind === "application_parent" ? t("workforcePaymentsPage.voucherRegister.relatedDue") : t("workforcePaymentsPage.voucherRegister.accountLabel")}</dt>
                  <dd className={row.kind === "application_parent" ? "bidi-isolate" : undefined}>{row.kind === "application_parent" ? row.dueNumber ?? t("workforcePaymentsPage.voucherRegister.dueReferenceUnavailable") : (row.voucher.paymentAccountName ?? accounts.get(row.voucher.paymentAccountId ?? "")?.name ?? t("workforcePaymentsPage.voucherRegister.legacyReconciliation"))}</dd>
                </div>
                <div>
                  <dt>{t("workforcePaymentsPage.voucherRegister.amountLabel")}</dt>
                  <dd className="bidi-isolate">{money(row.amount)}</dd>
                </div>
              </dl>
              {row.kind === "application_parent" ? (
                <small className="bidi-isolate">
                  {row.parent.workFromDate && row.parent.workToDate
                    ? t("workforcePaymentsPage.voucherRegister.workPeriodRange", { from: row.parent.workFromDate, to: row.parent.workToDate })
                    : t("workforcePaymentsPage.voucherRegister.childAllocations", { active: row.parent.activeChildApplicationIds.length, total: row.parent.childApplicationIds.length })}
                </small>
              ) : null}
              {row.kind === "voucher" && row.voucher.legacy ? (
                <small>
                  {t("workforcePaymentsPage.voucherRegister.legacyMappedRecord", { status: statusLabel(t, row.voucher.reconciliationStatus) })}
                </small>
              ) : null}
              {row.kind === "application_parent" ? (
                <small>
                  {row.parent.createdByName
                    ? t("workforcePaymentsPage.voucherRegister.paymentMethodAppliedAdvancesWithCreator", { name: row.parent.createdByName })
                    : t("workforcePaymentsPage.voucherRegister.paymentMethodAppliedAdvances")}
                </small>
              ) : null}
              {row.kind === "application_parent" ? (
                <div className="workforce-payment-funding-sources">
                  <strong>{t("workforcePaymentsPage.voucherRegister.fundingSources")}</strong>
                  {row.parent.fundingSources.map((source) => (
                    <span key={source.accountId ?? source.accountName}>{source.accountName} — <span className="bidi-isolate">{money(source.amount)}</span></span>
                  ))}
                  <small className="bidi-isolate">{t("workforcePaymentsPage.voucherRegister.fundingSourceTotal", { total: money(row.parent.fundingSourceTotal), cash: money(0) })}</small>
                </div>
              ) : null}
              {canVoid &&
              row.kind === "voucher" &&
              row.voucher.status === "POSTED" &&
              row.voucher.nature !== "REVERSAL" &&
              !row.voucher.legacy ? (
                <button
                  className="secondary-action"
                  disabled={voidingId === row.voucher.id}
                  type="button"
                  onClick={() => void voidVoucher(row.voucher)}
                >
                  {voidingId === row.voucher.id ? t("workforcePaymentsPage.voucherRegister.reversing") : t("workforcePaymentsPage.voucherRegister.voidReverse")}
                </button>
              ) : null}
              {canVoid &&
              row.kind === "application_parent" &&
              row.parent.status !== "REVERSED" ? (
                <button
                  className="secondary-action"
                  disabled={voidingId === row.parent.id}
                  type="button"
                  onClick={() => void reverseApplicationParent(row.parent)}
                >
                  {voidingId === row.parent.id ? t("workforcePaymentsPage.voucherRegister.reversing") : t("workforcePaymentsPage.voucherRegister.voidReverse")}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function AdvancesView({
  labourers,
  groups,
  accounts,
  canManage,
  token,
  workspaceId,
  farmId,
  seasonId,
  canonicalFinancials,
  onSaved,
  onError,
}: {
  labourers: Labourer[];
  groups: LabourGroup[];
  accounts: Account[];
  canManage: boolean;
  token: string;
  workspaceId: string;
  farmId: string;
  seasonId: string;
  canonicalFinancials: ReturnType<typeof useCanonicalLabourFinancials>;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  void canonicalFinancials;
  const labourerById = useMemo(
    () => new Map(labourers.map((item) => [item.id, item])),
    [labourers],
  );
  // THE canonical pool ledger (GET /labour-payments/advance-pools): pool cards,
  // pool details, metric strip, voucher context labels and pool activity all
  // read from this one response — no UI-side recalculation.
  const [pools, setPools] = useState<LabourAdvancePoolsResponse | null>(null);
  const [poolsLoading, setPoolsLoading] = useState(true);
  const [poolView, setPoolView] = useState<"groups" | "individual" | "vouchers">("groups");
  const [selectedPoolKey, setSelectedPoolKey] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [rows, setRows] = useState<LabourAdvancePosition[]>([]);
  const [pageInfo, setPageInfo] = useState<
    LabourAdvanceListResponse["pageInfo"]
  >({ page: 1, pageSize: 20, totalCount: 0, hasMore: false });
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("VALID");
  const [accountFilter, setAccountFilter] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedAdvance, setSelectedAdvance] =
    useState<LabourAdvancePosition | null>(null);
  const [editingAdvance, setEditingAdvance] =
    useState<LabourAdvancePosition | null>(null);
  const [deleteAdvance, setDeleteAdvance] =
    useState<LabourAdvancePosition | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [scope, setScope] = useState<LabourRecipientScope>("INDIVIDUAL");
  const [labourerId, setLabourerId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [receivedByLabourerId, setReceivedByLabourerId] = useState("");
  const [reference, setReference] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [method, setMethod] = useState("Cash");
  const [description, setDescription] = useState("");
  const [transactionReference, setTransactionReference] = useState("");
  const [saving, setSaving] = useState(false);
  // Pool-level recovery only: the target is a group pool or an individual
  // pool, never a specific advance voucher.
  const [recoveryTarget, setRecoveryTarget] = useState<
    { kind: "group"; groupId: string; name: string; available: number }
    | { kind: "individual"; labourerId: string; name: string; available: number }
    | null
  >(null);
  const [recoveryAmount, setRecoveryAmount] = useState("");
  const [recoveryAccountId, setRecoveryAccountId] = useState("");
  const [recoveryDate, setRecoveryDate] = useState(today());
  const [recoveryMethod, setRecoveryMethod] = useState("Recovery");
  const [recoveryNotes, setRecoveryNotes] = useState("");
  const [recovering, setRecovering] = useState(false);
  const groupLeaderName = useCallback((group?: LabourGroup | null) => {
    const leaderId = (group as { foremanLabourId?: string } | null | undefined)?.foremanLabourId
      ?? (group as { foremanId?: string } | null | undefined)?.foremanId;
    return leaderId ? labourerById.get(leaderId)?.name ?? null : null;
  }, [labourerById]);
  const advanceGroupLeaderName = useMemo(
    () => groupLeaderName(groups.find((item) => item.id === groupId)),
    [groupLeaderName, groups, groupId],
  );
  // The recipient's CURRENT group — shown as the pool this advance will
  // contribute to. An ungrouped labourer's advance stays in their own
  // individual pool; there is nothing to block.
  const recipientGroup = useMemo(() => {
    const worker = labourers.find((item) => item.id === labourerId);
    return worker?.groupId ? groups.find((item) => item.id === worker.groupId) ?? null : null;
  }, [groups, labourerId, labourers]);
  const recipientGroupLeaderName = useMemo(
    () => groupLeaderName(recipientGroup),
    [groupLeaderName, recipientGroup],
  );
  const idempotencyKey = useRef(uuid());
  const recoveryIdempotencyKey = useRef(uuid());
  const recipientScopeRef = useRef<HTMLSelectElement>(null);
  const recordAdvanceDialogRef = useRef<HTMLFormElement>(null);
  const recordAdvanceButtonRef = useRef<HTMLButtonElement>(null);
  const modalHistoryEntryRef = useRef(false);
  const handledDeepActionRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const abortTimerRef = useRef<number | null>(null);
  const inFlightKeyRef = useRef("");
  const requestSequence = useRef(0);
  const resetRecordAdvanceForm = useCallback(() => {
    setScope("INDIVIDUAL");
    setLabourerId("");
    setGroupId("");
    setReceivedByLabourerId("");
    setReference("");
    setRecipientName("");
    setDate(today());
    setAmount("");
    setAccountId("");
    setMethod("Cash");
    setDescription("");
    setTransactionReference("");
    idempotencyKey.current = uuid();
  }, []);
  const populateAdvanceForm = useCallback((advance: LabourAdvancePosition) => {
    setScope(advance.recipientScope);
    setLabourerId(advance.recipientScope === "INDIVIDUAL" ? advance.labourerId ?? advance.financialOwnerId ?? "" : "");
    setGroupId(advance.recipientScope === "LABOUR_GROUP" ? advance.labourGroupId ?? "" : "");
    setReceivedByLabourerId(advance.receivedByLabourerId ?? "");
    setReference(String(advance.recipientSnapshot.contractorReference ?? advance.recipientSnapshot.crewReference ?? advance.recipientSnapshot.batchIdentity ?? ""));
    setRecipientName(String(advance.recipientSnapshot.manualRecipientName ?? ""));
    setDate(advance.voucherDate);
    setAmount(String(advance.originalAmount));
    setAccountId(advance.paymentAccountId ?? "");
    setMethod(advance.paymentMethod ?? "Cash");
    setDescription(advance.description);
    setTransactionReference(advance.transactionReference ?? "");
  }, []);
  const refreshPools = useCallback(async (signal?: AbortSignal) => {
    if (!navigator.onLine) { setPoolsLoading(false); return; }
    setPoolsLoading(true);
    try {
      const response = await fetchLabourAdvancePools(token, workspaceId, farmId, seasonId, { signal });
      if (!signal?.aborted) setPools(response);
    } catch (caught) {
      if (!signal?.aborted) onError(caught instanceof Error ? caught.message : t("workforcePaymentsPage.errors.unableLoadWorkforcePayments"));
    } finally {
      if (!signal?.aborted) setPoolsLoading(false);
    }
  }, [farmId, onError, seasonId, t, token, workspaceId]);
  useEffect(() => {
    const controller = new AbortController();
    void refreshPools(controller.signal);
    return () => controller.abort();
  }, [refreshPools]);
  const openRecordAdvance = useCallback((deepAction = false) => {
    if (showForm) return;
    setEditingAdvance(null);
    resetRecordAdvanceForm();
    const currentUrl = `${location.pathname}${location.search}${location.hash}`;
    if (deepAction) {
      const cleanSearch = new URLSearchParams(location.search);
      cleanSearch.delete("action");
      const cleanUrl = `${location.pathname}${cleanSearch.size ? `?${cleanSearch.toString()}` : ""}${location.hash}`;
      window.history.replaceState(window.history.state, "", cleanUrl);
      window.history.pushState({ ...window.history.state, muzareRecordAdvance: true }, "", currentUrl);
    } else {
      window.history.pushState({ ...window.history.state, muzareRecordAdvance: true }, "", currentUrl);
    }
    modalHistoryEntryRef.current = true;
    setShowForm(true);
  }, [location.hash, location.pathname, location.search, resetRecordAdvanceForm, showForm]);
  const openEditAdvance = useCallback((advance: LabourAdvancePosition) => {
    setSelectedAdvance(null);
    setEditingAdvance(advance);
    populateAdvanceForm(advance);
    window.history.pushState({ ...window.history.state, muzareRecordAdvance: true }, "", `${location.pathname}${location.search}${location.hash}`);
    modalHistoryEntryRef.current = true;
    setShowForm(true);
  }, [location.hash, location.pathname, location.search, populateAdvanceForm]);
  const closeRecordAdvance = useCallback(() => {
    setShowForm(false);
    setEditingAdvance(null);
    if (modalHistoryEntryRef.current) {
      modalHistoryEntryRef.current = false;
      window.history.back();
    }
  }, []);
  useEffect(() => {
    const action = new URLSearchParams(location.search).get("action");
    if (action !== "record-advance") {
      handledDeepActionRef.current = false;
      return;
    }
    if (canManage && !handledDeepActionRef.current && !showForm) {
      handledDeepActionRef.current = true;
      openRecordAdvance(true);
    }
  }, [canManage, location.search, openRecordAdvance, showForm]);
  useEffect(() => {
    if (!showForm) return;
    window.requestAnimationFrame(() => {
      const target = recipientScopeRef.current
        ?? recordAdvanceDialogRef.current?.querySelector<HTMLElement>("input, select");
      target?.focus();
    });
  }, [showForm]);
  useEffect(() => {
    const handlePopState = () => {
      if (!modalHistoryEntryRef.current) return;
      modalHistoryEntryRef.current = false;
      setShowForm(false);
      window.requestAnimationFrame(() => recordAdvanceButtonRef.current?.focus());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  useEffect(() => {
    if (!showForm) return;
    const dialog = recordAdvanceDialogRef.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRecordAdvance();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog?.addEventListener("keydown", handleKeyDown);
    return () => dialog?.removeEventListener("keydown", handleKeyDown);
  }, [closeRecordAdvance, showForm]);
  useEffect(() => {
    const handle = window.setTimeout(() => setSearch(searchInput.trim()), 320);
    return () => window.clearTimeout(handle);
  }, [searchInput]);
  const cacheKey = useMemo(
    () =>
      `muzare:advance-list:v3:${workspaceId}:${farmId}:${seasonId}:${search}:${scopeFilter}:${statusFilter}:${accountFilter}:${fromFilter}:${toFilter}`,
    [
      accountFilter,
      farmId,
      fromFilter,
      scopeFilter,
      search,
      seasonId,
      statusFilter,
      toFilter,
      workspaceId,
    ],
  );
  const loadPage = useCallback(
    async (page: number, append = false) => {
      const requestKey = `${cacheKey}:${page}`;
      if (inFlightKeyRef.current === requestKey) return;
      inFlightKeyRef.current = requestKey;
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      const sequence = ++requestSequence.current;
      if (append) setLoadingMore(true);
      else setInitialLoading(true);
      setLoadError("");
      try {
        const response = await fetchLabourPaymentAdvances(
          token,
          workspaceId,
          farmId,
          seasonId,
          {
            page,
            pageSize: 20,
            search: search || undefined,
            recipientScope: scopeFilter || undefined,
            status: statusFilter,
            accountId: accountFilter || undefined,
            from: fromFilter || undefined,
            to: toFilter || undefined,
            signal: controller.signal,
          },
        );
        if (sequence !== requestSequence.current) return;
        setRows((current) =>
          append
            ? [
                ...current,
                ...response.advances.filter(
                  (next) => !current.some((item) => item.id === next.id),
                ),
              ]
            : response.advances,
        );
        setPageInfo(response.pageInfo);
        if (!append) sessionStorage.setItem(cacheKey, JSON.stringify(response));
      } catch (caught) {
        if (controller.signal.aborted) return;
        setLoadError(
          caught instanceof Error
            ? caught.message
            : t("workforcePaymentsPage.errors.unableLoadAdvances"),
        );
      } finally {
        if (inFlightKeyRef.current === requestKey) inFlightKeyRef.current = "";
        if (sequence === requestSequence.current) {
          setInitialLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [
      accountFilter,
      cacheKey,
      farmId,
      fromFilter,
      scopeFilter,
      search,
      seasonId,
      statusFilter,
      toFilter,
      token,
      workspaceId,
    ],
  );
  useEffect(() => {
    if (abortTimerRef.current !== null) {
      window.clearTimeout(abortTimerRef.current);
      abortTimerRef.current = null;
    }
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        const value = JSON.parse(cached) as LabourAdvanceListResponse;
        setRows(value.advances);
        setPageInfo(value.pageInfo);
        setInitialLoading(false);
      } catch {
        sessionStorage.removeItem(cacheKey);
      }
    }
    void loadPage(1, false);
    return () => {
      abortTimerRef.current = window.setTimeout(
        () => abortRef.current?.abort(),
        0,
      );
    };
  }, [cacheKey, loadPage]);
  useEffect(() => {
    const refreshAdvances = () => {
      void loadPage(1, false);
      void refreshPools();
    };
    window.addEventListener("muzare-data-refresh", refreshAdvances);
    return () => window.removeEventListener("muzare-data-refresh", refreshAdvances);
  }, [loadPage, refreshPools]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      if (!navigator.onLine)
        throw new Error(
          t("workforcePaymentsPage.errors.connectInternetPostTransaction"),
        );
      const receiver = labourers.find(
        (item) =>
          item.id ===
          (scope === "INDIVIDUAL" ? labourerId : receivedByLabourerId),
      );
      const payload = {
        farmId,
        seasonId,
        voucherDate: date,
        recipientScope: scope,
        labourerId: scope === "INDIVIDUAL" ? labourerId : null,
        labourGroupId: scope === "LABOUR_GROUP" ? groupId : null,
        receivedByLabourerId: ["INDIVIDUAL", "LABOUR_GROUP"].includes(scope)
          ? (receiver?.id ?? null)
          : null,
        receivedByNameSnapshot: ["INDIVIDUAL", "LABOUR_GROUP"].includes(scope)
          ? (receiver?.name ?? null)
          : null,
        contractorReference: scope === "CONTRACTOR_FOREMAN" ? reference : null,
        crewReference: ["TEMPORARY_CREW", "UNREGISTERED_LABOUR"].includes(scope)
          ? reference
          : null,
        manualRecipientName: recipientName || null,
        batchIdentity: scope === "NO_SPECIFIC_RECIPIENT" ? reference : null,
        amount: Number(amount),
        paymentAccountId: accountId,
        paymentMethod: method,
        transactionReference: transactionReference || null,
        description,
      };
      const response = editingAdvance
        ? await updateLabourAdvanceVoucher(token, workspaceId, editingAdvance.id, payload)
        : await postLabourAdvanceVoucher(token, workspaceId, {
            ...payload,
            idempotencyKey: idempotencyKey.current,
          });
      if (!editingAdvance) idempotencyKey.current = uuid();
      closeRecordAdvance();
      await onSaved(
        editingAdvance
          ? t("workforcePaymentsPage.advanceUpdatedSuccess", { voucherNumber: response.voucher.voucherNumber })
          : t("workforcePaymentsPage.advancePostedSuccess", { voucherNumber: response.voucher.voucherNumber }),
      );
      await loadPage(1, false);
      void refreshPools();
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("workforcePaymentsPage.errors.unablePostAdvance"),
      );
    } finally {
      setSaving(false);
    }
  };
  const openRecovery = useCallback((target: NonNullable<typeof recoveryTarget>) => {
    setRecoveryTarget(target);
    setRecoveryAmount("");
    setRecoveryAccountId("");
    setRecoveryDate(today());
    setRecoveryMethod("Recovery");
    setRecoveryNotes("");
    recoveryIdempotencyKey.current = uuid();
  }, []);
  const submitRecovery = async (event: FormEvent) => {
    event.preventDefault();
    if (!recoveryTarget || recovering) return;
    const recovery = Number(recoveryAmount);
    if (recovery > recoveryTarget.available + 0.005) {
      onError(t("workforcePaymentsPage.errors.recoveryExceedsOutstanding"));
      return;
    }
    setRecovering(true);
    try {
      const response = await recoverLabourAdvancePool(token, workspaceId, {
        farmId,
        seasonId,
        labourGroupId: recoveryTarget.kind === "group" ? recoveryTarget.groupId : null,
        labourerId: recoveryTarget.kind === "individual" ? recoveryTarget.labourerId : null,
        payment: {
          idempotencyKey: recoveryIdempotencyKey.current,
          voucherDate: recoveryDate,
          amount: recovery,
          paymentAccountId: recoveryAccountId,
          paymentMethod: recoveryMethod,
          description:
            recoveryNotes ||
            t("workforcePaymentsPage.advancesView.defaultPoolRecoveryDescription", { name: recoveryTarget.name }),
        },
      });
      recoveryIdempotencyKey.current = uuid();
      setRecoveryTarget(null);
      await onSaved(t("workforcePaymentsPage.recoveryPostedSuccess", { voucherNumber: response.voucher.voucherNumber }));
      await loadPage(1, false);
      void refreshPools();
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("workforcePaymentsPage.errors.unablePostRecovery"),
      );
    } finally {
      setRecovering(false);
    }
  };
  const submitDeleteAdvance = async () => {
    if (!deleteAdvance || deleting) return;
    setDeleting(true);
    try {
      const response = await deleteLabourAdvanceVoucher(token, workspaceId, deleteAdvance.id, farmId, seasonId);
      setDeleteAdvance(null);
      setSelectedAdvance(null);
      await onSaved(t("workforcePaymentsPage.advanceDeletedSuccess", { voucherNumber: response.result.voucherNumber }));
      await loadPage(1, false);
      void refreshPools();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t("workforcePaymentsPage.errors.unableDeleteAdvance"));
    } finally {
      setDeleting(false);
    }
  };
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`));
  const scopeCopy = (advance: LabourAdvancePosition) =>
    advance.recipientScope === "INDIVIDUAL"
      ? t("workforcePaymentsPage.recipientScopeOptions.individual")
      : advance.recipientScope === "LABOUR_GROUP"
        ? t("workforcePaymentsPage.recipientScopeOptions.labourGroup")
        : scopeLabel(t, advance.recipientScope);
  const selectableLabourers = useMemo(
    () => sortLabourSelectableForAdvance(filterLabourSelectableForAdvance(labourers, date)),
    [date, labourers],
  );
  const groupOptions = useMemo(
    () =>
      groups.map(
        (item) => ({ id: item.id, name: item.name, active: true }) as Labourer,
      ),
    [groups],
  );
  const selectedIndividualLabourer = labourers.find((item) => item.id === labourerId);
  const selectedReceiverLabourer = labourers.find((item) => item.id === receivedByLabourerId);
  const formValid = Boolean(
    date &&
    Number(amount) > 0 &&
    accountId &&
    method &&
    (scope === "INDIVIDUAL"
      ? labourerId
      : scope === "LABOUR_GROUP"
        ? groupId
        : reference) &&
    description.trim(),
  );
  const accountNameById = useMemo(() => new Map(accounts.map((item) => [item.id, item.name])), [accounts]);
  const clearFilters = () => {
    setScopeFilter("");
    setStatusFilter("VALID");
    setAccountFilter("");
    setFromFilter("");
    setToFilter("");
  };
  const statusFilterLabel = (value: string) =>
    value === "VALID" ? t("workforcePaymentsPage.advancesView.statusOptions.valid")
    : value === "VOIDED" ? t("workforcePaymentsPage.advancesView.statusOptions.voidedReversed")
    : t("workforcePaymentsPage.advancesView.statusOptions.allHistory");
  const activeFilterChips = [
    scopeFilter ? { key: "scope", label: scopeLabel(t, scopeFilter as LabourRecipientScope), clear: () => setScopeFilter("") } : null,
    statusFilter !== "VALID" ? { key: "status", label: statusFilterLabel(statusFilter), clear: () => setStatusFilter("VALID") } : null,
    accountFilter ? { key: "account", label: accountNameById.get(accountFilter) ?? t("workforcePaymentsPage.paymentAccount"), clear: () => setAccountFilter("") } : null,
    fromFilter ? { key: "from", label: `${t("workforcePaymentsPage.advancesView.advanceDateFromAria")}: ${formatDate(fromFilter)}`, clear: () => setFromFilter("") } : null,
    toFilter ? { key: "to", label: `${t("workforcePaymentsPage.advancesView.advanceDateToAria")}: ${formatDate(toFilter)}`, clear: () => setToFilter("") } : null,
  ].filter((chip): chip is { key: string; label: string; clear: () => void } => chip !== null);
  const anyQueryActive = activeFilterChips.length > 0 || Boolean(search);
  const poolSearch = search.toLowerCase();
  const visibleGroupPools = useMemo(
    () => (pools?.pools ?? []).filter((pool) =>
      !poolSearch
      || pool.groupName?.toLowerCase().includes(poolSearch)
      || pool.groupLeaderName?.toLowerCase().includes(poolSearch)),
    [pools, poolSearch],
  );
  const visibleIndividualPools = useMemo(
    () => (pools?.individualPools ?? []).filter((pool) =>
      !poolSearch || pool.labourerName?.toLowerCase().includes(poolSearch)),
    [pools, poolSearch],
  );
  const selectedGroupPool = selectedPoolKey?.startsWith("group:")
    ? pools?.pools.find((pool) => pool.labourGroupId === selectedPoolKey.slice("group:".length)) ?? null
    : null;
  const selectedIndividualPool = selectedPoolKey?.startsWith("individual:")
    ? pools?.individualPools.find((pool) => pool.labourerId === selectedPoolKey.slice("individual:".length)) ?? null
    : null;
  const selectedPoolVouchers = useMemo(
    () => (selectedPoolKey ? (pools?.vouchers ?? []).filter((voucher) => voucher.poolKey === selectedPoolKey) : []),
    [pools, selectedPoolKey],
  );
  const selectedPoolActivity = useMemo(
    () => (selectedPoolKey ? (pools?.activity ?? []).filter((event) => event.poolKey === selectedPoolKey) : []),
    [pools, selectedPoolKey],
  );
  const activityTypeLabel = (type: LabourAdvancePoolActivity["type"]) =>
    type === "ADVANCE_RECORDED" ? t("workforcePaymentsPage.advancesView.activityAdvanceRecorded")
    : type === "APPLIED_TO_DUE" ? t("workforcePaymentsPage.advancesView.activityAppliedToDue")
    : type === "APPLICATION_REVERSED" ? t("workforcePaymentsPage.advancesView.activityApplicationReversed")
    : type === "RECOVERY_RECORDED" ? t("workforcePaymentsPage.advancesView.activityRecoveryRecorded")
    : t("workforcePaymentsPage.advancesView.activityVoucherReversed");
  const metric = (value: number | undefined) =>
    poolsLoading && !pools ? "—" : money(value ?? 0);
  const closePoolDetail = () => setSelectedPoolKey(null);
  const poolDetailOpen = Boolean(selectedGroupPool || selectedIndividualPool);
  return (
    <>
      <section className="record-panel workforce-payments-panel workforce-advances-panel">
        <header className="workforce-payments-panel__header workforce-advances-header">
          <div>
            <h2>{t("workforcePaymentsPage.advancesView.pageTitle")}</h2>
            <p>{t("workforcePaymentsPage.advancesView.pageSubtitle")}</p>
          </div>
          {canManage ? (
            <button
              ref={recordAdvanceButtonRef}
              className="primary-action workforce-record-advance"
              type="button"
              onClick={() => openRecordAdvance(false)}
            >
              <Plus size={16} /> {t("workforcePaymentsPage.advancesView.recordAdvance")}
            </button>
          ) : null}
        </header>
        <div className="workforce-advance-summary" role="list" aria-label={t("workforcePaymentsPage.advancesView.summaryAria")}>
          <div role="listitem" className="is-primary">
            <span>{t("workforcePaymentsPage.advancesView.availableAdvanceBalance")}</span>
            <strong className="bidi-isolate">{metric(pools?.farmWide.outstandingAdvances)}</strong>
          </div>
          <div role="listitem">
            <span>{t("workforcePaymentsPage.advancesView.appliedToLabourDues")}</span>
            <strong className="bidi-isolate">{metric(pools?.farmWide.appliedAdvances)}</strong>
          </div>
          <div role="listitem">
            <span>{t("workforcePaymentsPage.advancesView.totalAdvancesRecorded")}</span>
            <strong className="bidi-isolate">{metric(pools?.farmWide.totalAdvances)}</strong>
          </div>
          <div role="listitem">
            <span>{t("workforcePaymentsPage.advancesView.recoveredRefunded")}</span>
            <strong className="bidi-isolate">{metric(pools?.farmWide.refundedAdvances)}</strong>
          </div>
        </div>
        {canManage && pools?.reviewAdvances.length ? (
          <button type="button" className="workforce-advance-review-notice" onClick={() => setReviewOpen(true)}>
            <AlertCircle size={14} aria-hidden="true" />
            <span>{t("workforcePaymentsPage.advancesView.recordsRequireReview", { count: pools.reviewAdvances.length })}</span>
            <strong>{t("workforcePaymentsPage.advancesView.review")}</strong>
          </button>
        ) : null}
        <div className="workforce-advance-view-tabs" role="tablist" aria-label={t("workforcePaymentsPage.advancesView.advanceDisplayAria")}>
          <button type="button" role="tab" aria-selected={poolView === "groups"} onClick={() => setPoolView("groups")}>
            {t("workforcePaymentsPage.advancesView.groupPoolsTab")}
          </button>
          <button type="button" role="tab" aria-selected={poolView === "individual"} onClick={() => setPoolView("individual")}>
            {t("workforcePaymentsPage.advancesView.individualTab")}
          </button>
          <button type="button" role="tab" aria-selected={poolView === "vouchers"} onClick={() => setPoolView("vouchers")}>
            {t("workforcePaymentsPage.advancesView.allVouchersTab")}
          </button>
        </div>
        <div className="workforce-advance-toolbar">
          <label className="workforce-payments-search">
            <Search size={16} />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t("workforcePaymentsPage.advancesView.searchPlaceholder")}
            />
          </label>
          {poolView === "vouchers" ? (
            <button
              className="secondary-action"
              type="button"
              aria-expanded={showFilters}
              onClick={() => setShowFilters(true)}
            >
              {t("workforcePaymentsPage.advancesView.filtersToggle")}
              {activeFilterChips.length ? ` · ${activeFilterChips.length}` : ""}
            </button>
          ) : null}
        </div>
        {poolView === "vouchers" && activeFilterChips.length ? (
          <div className="workforce-advance-filter-chip-row">
            {activeFilterChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className="workforce-advance-filter-chip"
                aria-label={t("workforcePaymentsPage.advancesView.removeFilter", { filter: chip.label })}
                onClick={chip.clear}
              >
                <span>{chip.label}</span>
                <X size={12} aria-hidden="true" />
              </button>
            ))}
            <button type="button" className="workforce-advance-link" onClick={clearFilters}>
              {t("workforcePaymentsPage.advancesView.clearFilters")}
            </button>
          </div>
        ) : null}
        {poolView === "groups" ? (
          <section className="workforce-group-pools" aria-label={t("workforcePaymentsPage.advancesView.groupPoolsAria")}>
            <p className="workforce-advance-membership-note">
              {t("workforcePaymentsPage.advancesView.poolsFollowMembershipNote")}
            </p>
            {poolsLoading && !pools ? (
              <p className="workforce-payments-inline-note">{t("workforcePaymentsPage.advancesView.loadingGroupPools")}</p>
            ) : !visibleGroupPools.length ? (
              <p className="workforce-payments-inline-note">{t("workforcePaymentsPage.advancesView.noGroupPools")}</p>
            ) : (
              <div className="workforce-group-pool-cards">
                {visibleGroupPools.map((pool) => (
                  <article
                    key={pool.labourGroupId}
                    className="workforce-group-pool-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedPoolKey(`group:${pool.labourGroupId}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedPoolKey(`group:${pool.labourGroupId}`);
                      }
                    }}
                  >
                    <header>
                      <strong>{pool.groupName}</strong>
                      <small>
                        {pool.groupLeaderName
                          ? t("workforcePaymentsPage.groupLeaderLabel", { name: pool.groupLeaderName })
                          : t("workforcePaymentsPage.advancesView.noGroupLeader")}
                        {" · "}
                        {t("workforcePaymentsPage.advancesView.memberCount", { count: pool.memberCount ?? 0 })}
                      </small>
                    </header>
                    <div className="workforce-group-pool-card__balance">
                      <span>{t("workforcePaymentsPage.advancesView.availableAdvanceBalance")}</span>
                      <strong className={`bidi-isolate${pool.outstandingAdvances < -0.005 ? " is-negative" : ""}`}>{money(pool.outstandingAdvances)}</strong>
                    </div>
                    <dl className="workforce-group-pool-card__totals">
                      <div><dt>{t("workforcePaymentsPage.advancesView.appliedToLabourDues")}</dt><dd className="bidi-isolate">{money(pool.appliedAdvances)}</dd></div>
                      <div><dt>{t("workforcePaymentsPage.advancesView.totalAdvancesRecorded")}</dt><dd className="bidi-isolate">{money(pool.totalAdvances)}</dd></div>
                      {pool.refundedAdvances > 0.005 ? (
                        <div><dt>{t("workforcePaymentsPage.advancesView.recoveredRefunded")}</dt><dd className="bidi-isolate">{money(pool.refundedAdvances)}</dd></div>
                      ) : null}
                    </dl>
                    <footer>
                      <small>{t("workforcePaymentsPage.advancesView.voucherCount", { count: pool.voucherCount ?? 0 })}</small>
                      <span className="workforce-advance-link">
                        {t("workforcePaymentsPage.advancesView.viewPool")} <ArrowRight size={14} aria-hidden="true" />
                      </span>
                    </footer>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : null}
        {poolView === "individual" ? (
          <section className="workforce-group-pools" aria-label={t("workforcePaymentsPage.advancesView.individualPoolsAria")}>
            <p className="workforce-advance-membership-note">
              {t("workforcePaymentsPage.advancesView.individualPoolsNote")}
            </p>
            {poolsLoading && !pools ? (
              <p className="workforce-payments-inline-note">{t("workforcePaymentsPage.advancesView.loadingGroupPools")}</p>
            ) : !visibleIndividualPools.length ? (
              <p className="workforce-payments-inline-note">{t("workforcePaymentsPage.advancesView.noIndividualPools")}</p>
            ) : (
              <div className="workforce-group-pool-cards">
                {visibleIndividualPools.map((pool) => (
                  <article
                    key={pool.labourerId}
                    className="workforce-group-pool-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedPoolKey(`individual:${pool.labourerId}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedPoolKey(`individual:${pool.labourerId}`);
                      }
                    }}
                  >
                    <header>
                      <strong>{pool.labourerName}</strong>
                      <small>{t("workforcePaymentsPage.advancesView.ungroupedLabourer")}</small>
                    </header>
                    <div className="workforce-group-pool-card__balance">
                      <span>{t("workforcePaymentsPage.advancesView.availableAdvanceBalance")}</span>
                      <strong className={`bidi-isolate${pool.outstandingAdvances < -0.005 ? " is-negative" : ""}`}>{money(pool.outstandingAdvances)}</strong>
                    </div>
                    <dl className="workforce-group-pool-card__totals">
                      <div><dt>{t("workforcePaymentsPage.advancesView.appliedToLabourDues")}</dt><dd className="bidi-isolate">{money(pool.appliedAdvances)}</dd></div>
                      <div><dt>{t("workforcePaymentsPage.advancesView.totalAdvancesRecorded")}</dt><dd className="bidi-isolate">{money(pool.totalAdvances)}</dd></div>
                      {pool.refundedAdvances > 0.005 ? (
                        <div><dt>{t("workforcePaymentsPage.advancesView.recoveredRefunded")}</dt><dd className="bidi-isolate">{money(pool.refundedAdvances)}</dd></div>
                      ) : null}
                    </dl>
                    <footer>
                      <small>{t("workforcePaymentsPage.advancesView.voucherCount", { count: pool.voucherCount ?? 0 })}</small>
                      <span className="workforce-advance-link">
                        {t("workforcePaymentsPage.advancesView.viewPool")} <ArrowRight size={14} aria-hidden="true" />
                      </span>
                    </footer>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : null}
        {poolView === "vouchers" ? (
          initialLoading && !rows.length ? (
            <div
              className="workforce-advance-skeletons"
              aria-label={t("workforcePaymentsPage.advancesView.loadingAdvances")}
            >
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="workforce-advance-skeleton" />
              ))}
            </div>
          ) : loadError && !rows.length ? (
            <div className="workforce-payments-empty">
              <p>{loadError}</p>
              <button
                className="secondary-action"
                type="button"
                onClick={() => void loadPage(1, false)}
              >
                {t("workforcePaymentsPage.retry")}
              </button>
            </div>
          ) : !rows.length ? (
            anyQueryActive ? (
              <div className="workforce-payments-empty workforce-advance-empty">
                <p><strong>{t("workforcePaymentsPage.advancesView.noMatchingAdvancesTitle")}</strong></p>
                <p>{t("workforcePaymentsPage.advancesView.noMatchingAdvancesBody")}</p>
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() => {
                    clearFilters();
                    setSearchInput("");
                  }}
                >
                  {t("workforcePaymentsPage.advancesView.clearFilters")}
                </button>
              </div>
            ) : (
              <div className="workforce-payments-empty workforce-advance-empty">
                <p><strong>{t("workforcePaymentsPage.advancesView.noAdvancesTitle")}</strong></p>
                <p>{t("workforcePaymentsPage.advancesView.noAdvancesBody")}</p>
                {canManage ? (
                  <button className="primary-action" type="button" onClick={() => openRecordAdvance(false)}>
                    {t("workforcePaymentsPage.advancesView.recordAdvance")}
                  </button>
                ) : null}
              </div>
            )
          ) : (
            <div className="workforce-advance-position-list">
              {rows.map((advance) => {
                const identity = resolveAdvanceCardIdentity(advance, labourerById);
                const canModifyAdvance =
                  canManage &&
                  !advance.readOnlyLegacy &&
                  advance.status === "POSTED" &&
                  !advance.linkedDueId;
                const contextGroup = advance.currentGroupName
                  ?? (advance.poolKind === "INDIVIDUAL" ? t("workforcePaymentsPage.advancesView.individualPoolLabel") : null);
                return (
                  <article
                    key={advance.id}
                    className="workforce-advance-card"
                    tabIndex={0}
                    role="button"
                    onClick={() => setSelectedAdvance(advance)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedAdvance(advance);
                      }
                    }}
                  >
                    <header>
                      <span>{identity.title}</span>
                      <strong className="workforce-advance-card__amount bidi-isolate">{money(advance.originalAmount)}</strong>
                    </header>
                    <div className="workforce-advance-card__reference">
                      <span className="bidi-isolate">{advance.displayVoucherNumber}</span>
                      <span aria-hidden="true">·</span>
                      <time className="bidi-isolate">{formatDate(advance.voucherDate)}</time>
                      {advance.status === "VOIDED" ? (
                        <em className="workforce-payment-status status-voided">
                          {t("workforcePaymentsPage.advancesView.statusOptions.voidedReversed")}
                        </em>
                      ) : null}
                    </div>
                    <div className="workforce-advance-card__meta">
                      <small>
                        {contextGroup ? `${contextGroup} · ` : ""}
                        {t("workforcePaymentsPage.advancesView.paidFrom", { source: advance.paymentSourceDisplayName ?? advance.paymentAccountName ?? advance.fundingAccountName ?? t("workforcePaymentsPage.unresolvedPaymentSource") })}
                      </small>
                      {advance.description ? (
                        <small className="workforce-advance-card__description">{advance.description}</small>
                      ) : null}
                    </div>
                    <details
                      className="workforce-advance-actions-menu"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <summary aria-label={t("workforcePaymentsPage.advancesView.actions")}>⋮</summary>
                      <div>
                        <button type="button" onClick={() => setSelectedAdvance(advance)}>
                          {t("common.view")}
                        </button>
                        {canModifyAdvance ? (
                          <button type="button" onClick={() => openEditAdvance(advance)}>
                            {t("common.edit")}
                          </button>
                        ) : null}
                        {canModifyAdvance ? (
                          <button type="button" className="danger-action" onClick={() => setDeleteAdvance(advance)}>
                            {t("common.delete")}
                          </button>
                        ) : null}
                      </div>
                    </details>
                  </article>
                );
              })}
            </div>
          )
        ) : null}
        {poolView === "vouchers" && rows.length && pageInfo.hasMore ? (
          <div className="workforce-advance-pagination">
            <button
              className="secondary-action"
              disabled={loadingMore}
              type="button"
              onClick={() => void loadPage(pageInfo.page + 1, true)}
            >
              {loadingMore ? t("workforcePaymentsPage.loadingMore") : t("workforcePaymentsPage.loadMore")}
            </button>
          </div>
        ) : null}
      </section>
      {poolDetailOpen ? (
        <div
          className="worker-dialog-backdrop workforce-payment-review-backdrop"
          role="presentation"
          onClick={closePoolDetail}
        >
          <section
            className="workforce-payment-review workforce-pool-detail"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>
                  {selectedGroupPool
                    ? t("workforcePaymentsPage.advancesView.groupPoolTitle")
                    : t("workforcePaymentsPage.advancesView.individualPoolTitle")}
                </span>
                <h2>{selectedGroupPool ? selectedGroupPool.groupName : selectedIndividualPool?.labourerName}</h2>
                {selectedGroupPool ? (
                  <p>
                    {selectedGroupPool.groupLeaderName
                      ? t("workforcePaymentsPage.groupLeaderLabel", { name: selectedGroupPool.groupLeaderName })
                      : t("workforcePaymentsPage.advancesView.noGroupLeader")}
                    {" · "}
                    {t("workforcePaymentsPage.advancesView.memberCount", { count: selectedGroupPool.memberCount ?? 0 })}
                  </p>
                ) : (
                  <p>{t("workforcePaymentsPage.advancesView.ungroupedLabourer")}</p>
                )}
              </div>
              <button type="button" onClick={closePoolDetail} aria-label={t("common.close")}>
                <X size={18} />
              </button>
            </header>
            <div className="workforce-payment-review__body">
              {selectedGroupPool ? (
                <p className="workforce-advance-membership-note">
                  {t("workforcePaymentsPage.advancesView.combinedPoolNote")}
                </p>
              ) : null}
              <dl className="workforce-payment-position">
                <div>
                  <dt>{t("workforcePaymentsPage.advancesView.totalAdvancesRecorded")}</dt>
                  <dd className="bidi-isolate">{money((selectedGroupPool ?? selectedIndividualPool)!.totalAdvances)}</dd>
                </div>
                <div>
                  <dt>{t("workforcePaymentsPage.advancesView.appliedToLabourDues")}</dt>
                  <dd className="bidi-isolate">{money((selectedGroupPool ?? selectedIndividualPool)!.appliedAdvances)}</dd>
                </div>
                <div>
                  <dt>{t("workforcePaymentsPage.advancesView.recoveredRefunded")}</dt>
                  <dd className="bidi-isolate">{money((selectedGroupPool ?? selectedIndividualPool)!.refundedAdvances)}</dd>
                </div>
                <div className="is-total">
                  <dt>{t("workforcePaymentsPage.advancesView.availableAdvanceBalance")}</dt>
                  <dd className={`bidi-isolate${(selectedGroupPool ?? selectedIndividualPool)!.outstandingAdvances < -0.005 ? " is-negative" : ""}`}>
                    {money((selectedGroupPool ?? selectedIndividualPool)!.outstandingAdvances)}
                  </dd>
                </div>
              </dl>
              {(selectedGroupPool ?? selectedIndividualPool)!.outstandingAdvances < -0.005 ? (
                <p className="worker-action-warning">{t("workforcePaymentsPage.advancesView.negativePoolWarning")}</p>
              ) : null}
              <section>
                <h3>{t("workforcePaymentsPage.advancesView.advanceVouchersSection", { count: selectedPoolVouchers.length })}</h3>
                {!selectedPoolVouchers.length ? (
                  <p className="workforce-payments-inline-note">{t("workforcePaymentsPage.advancesView.noPoolVouchers")}</p>
                ) : (
                  <div className="workforce-pool-voucher-list">
                    {selectedPoolVouchers.map((voucher) => (
                      <article key={voucher.id} className="workforce-pool-voucher-row">
                        <header>
                          <span>{voucher.recipientName ?? voucher.labourerName ?? t("workforcePaymentsPage.recipientUnavailable")}</span>
                          <strong className="bidi-isolate">{money(voucher.amount)}</strong>
                        </header>
                        <small className="bidi-isolate">{voucher.voucherNumber} · {formatDate(voucher.voucherDate)}</small>
                        {voucher.paymentAccountName ? (
                          <small>{t("workforcePaymentsPage.advancesView.paidFrom", { source: voucher.paymentAccountName })}</small>
                        ) : null}
                        {voucher.description ? (
                          <small className="workforce-advance-card__description">{voucher.description}</small>
                        ) : null}
                      </article>
                    ))}
                  </div>
                )}
              </section>
              <section>
                <h3>{t("workforcePaymentsPage.advancesView.poolActivitySection")}</h3>
                {!selectedPoolActivity.length ? (
                  <p className="workforce-payments-inline-note">{t("workforcePaymentsPage.advancesView.noPoolActivity")}</p>
                ) : (
                  <div className="workforce-pool-activity-list">
                    {selectedPoolActivity.map((event) => (
                      <div key={event.id} className="workforce-pool-activity-row">
                        <div>
                          <span>{activityTypeLabel(event.type)}</span>
                          <small className="bidi-isolate">
                            {formatDate(event.date)}
                            {event.voucherNumber ? ` · ${event.voucherNumber}` : ""}
                            {event.dueNumber ? ` · ${event.dueNumber}` : ""}
                          </small>
                          {event.description ? <small className="workforce-advance-card__description">{event.description}</small> : null}
                        </div>
                        <strong className={`bidi-isolate${event.direction < 0 ? " is-outflow" : " is-inflow"}`}>
                          {event.direction < 0 ? "− " : "+ "}
                          {money(event.amount)}
                        </strong>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
            <footer>
              <div className="workforce-payment-review__actions">
                {canManage ? (
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => {
                      const pool = selectedGroupPool ?? selectedIndividualPool;
                      if (!pool) return;
                      openRecovery(selectedGroupPool
                        ? { kind: "group", groupId: selectedGroupPool.labourGroupId, name: selectedGroupPool.groupName ?? "", available: selectedGroupPool.outstandingAdvances }
                        : { kind: "individual", labourerId: selectedIndividualPool!.labourerId, name: selectedIndividualPool!.labourerName ?? "", available: selectedIndividualPool!.outstandingAdvances });
                    }}
                  >
                    {t("workforcePaymentsPage.advancesView.recordRecovery")}
                  </button>
                ) : null}
                {canManage ? (
                  <button
                    type="button"
                    className="primary-action"
                    onClick={() => {
                      closePoolDetail();
                      openRecordAdvance(false);
                    }}
                  >
                    <Plus size={16} /> {t("workforcePaymentsPage.advancesView.recordAdvance")}
                  </button>
                ) : null}
              </div>
            </footer>
          </section>
        </div>
      ) : null}
      {reviewOpen && pools ? (
        <div
          className="worker-dialog-backdrop workforce-payment-review-backdrop"
          role="presentation"
          onClick={() => setReviewOpen(false)}
        >
          <section
            className="workforce-payment-review workforce-pool-detail"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>{t("workforcePaymentsPage.advancesView.dataReviewTitle")}</span>
                <h2>{t("workforcePaymentsPage.advancesView.recordsRequireReview", { count: pools.reviewAdvances.length })}</h2>
                <p>{t("workforcePaymentsPage.advancesView.dataReviewNote")}</p>
              </div>
              <button type="button" onClick={() => setReviewOpen(false)} aria-label={t("common.close")}>
                <X size={18} />
              </button>
            </header>
            <div className="workforce-payment-review__body">
              <div className="workforce-pool-voucher-list">
                {pools.reviewAdvances.map((advance) => (
                  <article key={advance.id} className="workforce-pool-voucher-row">
                    <header>
                      <span>{advance.recipientName ?? t("workforcePaymentsPage.recipientUnavailable")}</span>
                      <strong className="bidi-isolate">{money(advance.amount)}</strong>
                    </header>
                    <small className="bidi-isolate">{advance.voucherNumber} · {formatDate(advance.voucherDate)}</small>
                    <small>{advance.reason}</small>
                  </article>
                ))}
              </div>
            </div>
          </section>
        </div>
      ) : null}
      {showForm ? (
        <div
          className="worker-dialog-backdrop workforce-payment-review-backdrop"
          role="presentation"
          onClick={closeRecordAdvance}
        >
          <form
            ref={recordAdvanceDialogRef}
            className="workforce-payment-review workforce-advance-entry-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="record-advance-title"
            onSubmit={(event) => void submit(event)}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2 id="record-advance-title">
                  {editingAdvance ? t("workforcePaymentsPage.advancesView.editAdvanceVoucherTitle", { voucherNumber: editingAdvance.displayVoucherNumber }) : t("workforcePaymentsPage.advancesView.recordAdvance")}
                </h2>
                <p>{editingAdvance ? t("workforcePaymentsPage.advancesView.updateUnusedAdvanceVoucher") : t("workforcePaymentsPage.advancesView.recordMoneyPaidBeforeSettlement")}</p>
              </div>
              <button
                type="button"
                onClick={closeRecordAdvance}
                aria-label={t("common.close")}
              >
                <X size={18} />
              </button>
            </header>
            <div className="workforce-payment-review__body workforce-advance-entry-body">
              <div className="workforce-advance-entry-fields">
                {/* The voucher records the original recipient. Pool ownership
                    follows the recipient's CURRENT group membership, resolved
                    by the server — the note below only previews it. */}
                {editingAdvance ? (
                  <label>
                    <span>{t("workforcePaymentsPage.recipientScope")}</span>
                    <select
                      ref={recipientScopeRef}
                      value={scope}
                      onChange={(event) =>
                        setScope(event.target.value as LabourRecipientScope)
                      }
                    >
                      {scopeOptions(t).slice(0, 5).map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {scope === "INDIVIDUAL" ? (
                  <label>
                    <span>{t("workforcePaymentsPage.labourer")}</span>
                    <LabourSelectCombobox
                      ariaLabel={t("workforcePaymentsPage.labourer")}
                      options={selectableLabourers}
                      value={labourerId}
                      onChange={setLabourerId}
                      placeholder={t("workforcePaymentsPage.advancesView.searchLabourersPlaceholder")}
                      noResultsLabel={t("workforcePaymentsPage.advancesView.noSelectableLabourersFound")}
                      includeInactive
                      renderOption={(option) => renderAdvanceLabourOption(t, option)}
                    />
                    {selectedIndividualLabourer && advanceLabourStatus(selectedIndividualLabourer) !== "active" ? (
                      <small className="workforce-advance-inactive-note">{t("workforcePaymentsPage.advancesView.inactiveLabourerNote")}</small>
                    ) : null}
                    {!editingAdvance && labourerId ? (
                      recipientGroup ? (
                        <small className="workforce-payments-inline-note">
                          {t("workforcePaymentsPage.advancesView.recipientGroupLabel", { name: recipientGroup.name })}
                          {recipientGroupLeaderName ? ` · ${t("workforcePaymentsPage.groupLeaderLabel", { name: recipientGroupLeaderName })}` : ""}
                        </small>
                      ) : (
                        <small className="workforce-payments-inline-note">{t("workforcePaymentsPage.advancesView.individualPoolNote")}</small>
                      )
                    ) : null}
                  </label>
                ) : null}
                {scope === "LABOUR_GROUP" ? (
                  <>
                    <label>
                      <span>{t("workforcePaymentsPage.recipientScopeOptions.labourGroup")}</span>
                      <LabourSelectCombobox
                        ariaLabel={t("workforcePaymentsPage.recipientScopeOptions.labourGroup")}
                        options={groupOptions}
                        value={groupId}
                        onChange={setGroupId}
                        placeholder={t("workforcePaymentsPage.advancesView.searchLabourGroupsPlaceholder")}
                      />
                      {advanceGroupLeaderName ? <small className="workforce-payments-inline-note">{t("workforcePaymentsPage.groupLeaderLabel", { name: advanceGroupLeaderName })}</small> : null}
                    </label>
                    <label>
                      <span>{t("workforcePaymentsPage.advancesView.receivedByInformationalLabel")}</span>
                      <LabourSelectCombobox
                        ariaLabel={t("workforcePaymentsPage.advancesView.receivedByLabourerAria")}
                        options={groupId ? selectableLabourers.filter((worker) => worker.groupId === groupId) : selectableLabourers}
                        value={receivedByLabourerId}
                        onChange={setReceivedByLabourerId}
                        placeholder={t("workforcePaymentsPage.advancesView.searchReceivingLabourerPlaceholder")}
                        noResultsLabel={t("workforcePaymentsPage.advancesView.noSelectableLabourersFound")}
                        includeInactive
                        renderOption={(option) => renderAdvanceLabourOption(t, option)}
                      />
                      <small className="workforce-payments-inline-note">{t("workforcePaymentsPage.advancesView.receivedByInformationalNote")}</small>
                      {selectedReceiverLabourer && advanceLabourStatus(selectedReceiverLabourer) !== "active" ? (
                        <small className="workforce-advance-inactive-note">{t("workforcePaymentsPage.advancesView.inactiveLabourerNote")}</small>
                      ) : null}
                    </label>
                  </>
                ) : null}
                {!["INDIVIDUAL", "LABOUR_GROUP"].includes(scope) ? (
                  <>
                    <label>
                      <span>{t("workforcePaymentsPage.advancesView.recipientNameLabel")}</span>
                      <input
                        value={recipientName}
                        onChange={(event) =>
                          setRecipientName(event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>{t("workforcePaymentsPage.advancesView.stableReferenceLabel")}</span>
                      <input
                        required
                        value={reference}
                        onChange={(event) => setReference(event.target.value)}
                      />
                    </label>
                  </>
                ) : null}
                <label>
                  <span>{t("workforcePaymentsPage.voucherRegister.amountLabel")}</span>
                  <div className="workforce-advance-amount">
                    <span aria-hidden="true">SAR</span>
                    <input
                      required
                      min="0.01"
                      step="0.01"
                      type="number"
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label={t("workforcePaymentsPage.amountSar")}
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                    />
                  </div>
                </label>
                <label>
                  <span>{t("workforcePaymentsPage.description")}</span>
                  <input
                    required
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={t("workforcePaymentsPage.advancesView.purposeOfAdvancePlaceholder")}
                  />
                </label>
                <div className="workforce-advance-entry-row">
                  <label>
                    <span>{t("workforcePaymentsPage.voucherRegister.dateLabel")}</span>
                    <input
                      required
                      type="date"
                      value={date}
                      onChange={(event) => setDate(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{t("workforcePaymentsPage.paidFromAccount")}</span>
                    <PaymentAccountSelect
                      accounts={eligiblePaymentAccounts(accounts, { alsoIncludeId: editingAdvance?.paymentAccountId ?? null })}
                      value={accountId}
                      onChange={setAccountId}
                    />
                  </label>
                </div>
              </div>
            </div>
            <footer>
              <div className="workforce-payment-review__actions">
                <button
                  className="secondary-action"
                  type="button"
                  onClick={closeRecordAdvance}
                >
                  {t("common.cancel")}
                </button>
                <button
                  className="primary-action"
                  disabled={saving || !formValid}
                  type="submit"
                >
                  {saving ? t("workforcePaymentsPage.saving") : editingAdvance ? t("workforcePaymentsPage.advancesView.updateAdvance") : t("workforcePaymentsPage.advancesView.postAdvance")}
                </button>
              </div>
            </footer>
          </form>
        </div>
      ) : null}
      {deleteAdvance ? (
        <div
          className="worker-dialog-backdrop workforce-payment-review-backdrop"
          role="presentation"
          onClick={() => setDeleteAdvance(null)}
        >
          <section
            className="workforce-payment-review workforce-advance-detail"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>{t("workforcePaymentsPage.advancesView.deleteAdvanceVoucher")}</span>
                <h2>{t("workforcePaymentsPage.advancesView.deleteAdvanceVoucherTitle", { voucherNumber: deleteAdvance.displayVoucherNumber })}</h2>
                <p>{t("workforcePaymentsPage.advancesView.deleteAdvanceWarning")}</p>
              </div>
              <button type="button" onClick={() => setDeleteAdvance(null)} aria-label={t("common.close")}>
                <X size={18} />
              </button>
            </header>
            <div className="workforce-payment-review__body">
              <dl className="workforce-payment-position">
                <div><dt>{t("workforcePaymentsPage.voucherRegister.amountLabel")}</dt><dd className="bidi-isolate">{money(deleteAdvance.originalAmount)}</dd></div>
                <div><dt>{t("workforcePaymentsPage.recipient")}</dt><dd>{deleteAdvance.financialOwnerName ?? t("workforcePaymentsPage.recipientUnavailable")}</dd></div>
                {deleteAdvance.currentGroupName ? (
                  <div><dt>{t("workforcePaymentsPage.advancesView.currentGroupLabel")}</dt><dd>{deleteAdvance.currentGroupName}</dd></div>
                ) : null}
                <div><dt>{t("workforcePaymentsPage.advancesView.fundingPartnerAccount")}</dt><dd>{deleteAdvance.paymentSourceDisplayName ?? deleteAdvance.paymentAccountName ?? t("workforcePaymentsPage.unresolvedPaymentSource")}</dd></div>
                <div><dt>{t("workforcePaymentsPage.voucherRegister.dateLabel")}</dt><dd className="bidi-isolate">{formatDate(deleteAdvance.voucherDate)}</dd></div>
              </dl>
              <p className="workforce-payments-inline-note">{t("workforcePaymentsPage.advancesView.deleteAdvancePoolNote")}</p>
            </div>
            <footer>
              <div className="workforce-payment-review__actions">
                <button className="secondary-action" type="button" onClick={() => setDeleteAdvance(null)}>
                  {t("common.cancel")}
                </button>
                <button className="danger-action" type="button" disabled={deleting} onClick={() => void submitDeleteAdvance()}>
                  {deleting ? t("workforcePaymentsPage.advancesView.deleting") : t("workforcePaymentsPage.advancesView.deleteAdvance")}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}
      {recoveryTarget ? (
        <div
          className="worker-dialog-backdrop workforce-payment-review-backdrop"
          role="presentation"
          onClick={() => setRecoveryTarget(null)}
        >
          <form
            className="workforce-payment-review workforce-recovery-sheet"
            onSubmit={(event) => void submitRecovery(event)}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>{recoveryTarget.name}</span>
                <h2>{t("workforcePaymentsPage.advancesView.recordRecovery")}</h2>
                <p>
                  {recoveryTarget.kind === "group"
                    ? t("workforcePaymentsPage.advancesView.poolRecoveryGroupNote")
                    : t("workforcePaymentsPage.advancesView.poolRecoveryIndividualNote")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRecoveryTarget(null)}
                aria-label={t("common.close")}
              >
                <X size={18} />
              </button>
            </header>
            <div className="workforce-payment-review__body">
              <div className="workforce-recovery-balance">
                <span>{t("workforcePaymentsPage.advancesView.availableAdvanceBalance")}</span>
                <strong className="bidi-isolate">{money(recoveryTarget.available)}</strong>
              </div>
              <div className="workforce-payment-review-form">
                <label>
                  <span>{t("workforcePaymentsPage.advancesView.recoveryAmount")}</span>
                  <input
                    required
                    type="number"
                    min="0.01"
                    max={Math.max(recoveryTarget.available, 0)}
                    step="0.01"
                    value={recoveryAmount}
                    onChange={(event) => setRecoveryAmount(event.target.value)}
                  />
                </label>
                <label>
                  <span>{t("workforcePaymentsPage.advancesView.receivedIntoAccount")}</span>
                  <PaymentAccountSelect
                    accounts={eligiblePaymentAccounts(accounts)}
                    value={recoveryAccountId}
                    onChange={setRecoveryAccountId}
                  />
                </label>
                <label>
                  <span>{t("workforcePaymentsPage.voucherRegister.dateLabel")}</span>
                  <input
                    required
                    type="date"
                    value={recoveryDate}
                    onChange={(event) => setRecoveryDate(event.target.value)}
                  />
                </label>
                <label>
                  <span>{t("workforcePaymentsPage.method")}</span>
                  <select
                    value={recoveryMethod}
                    onChange={(event) => setRecoveryMethod(event.target.value)}
                  >
                    <option value="Recovery">{translateStatus(t, "RECOVERY")}</option>
                    <option value="Cash">{translateStatus(t, "CASH")}</option>
                    <option value="Bank Transfer">{translateStatus(t, "BANK_TRANSFER")}</option>
                  </select>
                </label>
                <label className="is-full">
                  <span>{t("workforcePaymentsPage.notes")}</span>
                  <input
                    value={recoveryNotes}
                    onChange={(event) => setRecoveryNotes(event.target.value)}
                    placeholder={t("workforcePaymentsPage.optionalNotes")}
                  />
                </label>
              </div>
              <div className="workforce-recovery-preview">
                <span>{t("workforcePaymentsPage.advancesView.availableAfterRecovery")}</span>
                <strong className="bidi-isolate">
                  {money(recoveryTarget.available - Number(recoveryAmount || 0))}
                </strong>
              </div>
            </div>
            <footer>
              <div className="workforce-payment-review__actions">
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() => setRecoveryTarget(null)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  className="primary-action"
                  disabled={
                    recovering ||
                    Number(recoveryAmount) <= 0 ||
                    Number(recoveryAmount) > recoveryTarget.available + 0.005 ||
                    !recoveryAccountId
                  }
                  type="submit"
                >
                  {recovering ? t("workforcePaymentsPage.posting") : t("workforcePaymentsPage.advancesView.confirmRecovery")}
                </button>
              </div>
            </footer>
          </form>
        </div>
      ) : null}
      {selectedAdvance ? (
        <div
          className="worker-dialog-backdrop workforce-payment-review-backdrop"
          role="presentation"
          onClick={() => setSelectedAdvance(null)}
        >
          <section
            className="workforce-payment-review workforce-advance-detail"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>{scopeCopy(selectedAdvance)}</span>
                <h2 className="bidi-isolate">{selectedAdvance.displayVoucherNumber}</h2>
                <p>
                  {selectedAdvance.financialOwnerName ??
                    t("workforcePaymentsPage.recipientUnavailable")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAdvance(null)}
                aria-label={t("common.close")}
              >
                <X size={18} />
              </button>
            </header>
            <div className="workforce-payment-review__body">
              <dl className="workforce-payment-position">
                <div>
                  <dt>{t("workforcePaymentsPage.advancesView.paidTo")}</dt>
                  <dd>
                    {selectedAdvance.financialOwnerName ??
                      t("workforcePaymentsPage.recipientUnavailable")}
                  </dd>
                </div>
                <div>
                  <dt>{t("workforcePaymentsPage.advancesView.recipientTypeLabel")}</dt>
                  <dd>{scopeCopy(selectedAdvance)}</dd>
                </div>
                {selectedAdvance.recipientScope === "LABOUR_GROUP" && selectedAdvance.receivedByName ? (
                  <div>
                    <dt>{t("workforcePaymentsPage.advancesView.receivedByLabel")}</dt>
                    <dd>{selectedAdvance.receivedByName}</dd>
                  </div>
                ) : null}
                {selectedAdvance.currentGroupName ? (
                  <div>
                    <dt>{t("workforcePaymentsPage.advancesView.currentGroupLabel")}</dt>
                    <dd>{selectedAdvance.currentGroupName}</dd>
                  </div>
                ) : selectedAdvance.poolKind === "INDIVIDUAL" ? (
                  <div>
                    <dt>{t("workforcePaymentsPage.advancesView.currentGroupLabel")}</dt>
                    <dd>{t("workforcePaymentsPage.advancesView.individualPoolLabel")}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t("workforcePaymentsPage.voucherRegister.dateLabel")}</dt>
                  <dd className="bidi-isolate">{formatDate(selectedAdvance.voucherDate)}</dd>
                </div>
                <div>
                  <dt>{t("workforcePaymentsPage.paidFrom")}</dt>
                  <dd>
                    {selectedAdvance.paymentSourceDisplayName ??
                      selectedAdvance.paymentAccountName ??
                      t("workforcePaymentsPage.unresolvedPaymentSource")}
                  </dd>
                </div>
                <div>
                  <dt>{t("workforcePaymentsPage.advancesView.advanceAmountLabel")}</dt>
                  <dd className="bidi-isolate">{money(selectedAdvance.originalAmount)}</dd>
                </div>
              </dl>
              <section>
                <h3>{t("workforcePaymentsPage.description")}</h3>
                <p>{selectedAdvance.description}</p>
              </section>
              <section>
                <h3>{t("workforcePaymentsPage.advancesView.postingAndAudit")}</h3>
                <p>
                  {statusLabel(t, selectedAdvance.status)} ·{" "}
                  {selectedAdvance.createdByName ?? t("workforcePaymentsPage.creatorUnavailable")}
                </p>
                {selectedAdvance.legacy ? (
                  <p>{t("workforcePaymentsPage.advancesView.legacySource", { sourceType: selectedAdvance.sourceType })}</p>
                ) : null}
              </section>
            </div>
          </section>
        </div>
      ) : null}
      {showFilters ? (
        <div className="account-sheet-backdrop" role="presentation" onClick={() => setShowFilters(false)}>
          <section
            className="account-sheet workforce-advance-filter-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t("workforcePaymentsPage.advancesView.filtersToggle")}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="account-sheet__header">
              <h3>{t("workforcePaymentsPage.advancesView.filtersToggle")}</h3>
              <button type="button" className="account-sheet__close" aria-label={t("common.close")} onClick={() => setShowFilters(false)}>
                <X size={20} aria-hidden="true" />
              </button>
            </header>
            <div className="workforce-advance-filter-sheet__body">
              <label>
                <span>{t("workforcePaymentsPage.recipientScope")}</span>
                <select
                  value={scopeFilter}
                  onChange={(event) => setScopeFilter(event.target.value)}
                >
                  <option value="">{t("workforcePaymentsPage.scopeOptions.allRecipients")}</option>
                  {scopeOptions(t).map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("workforcePaymentsPage.advancesView.advanceStatusAria")}</span>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                >
                  <option value="VALID">{t("workforcePaymentsPage.advancesView.statusOptions.valid")}</option>
                  <option value="VOIDED">{t("workforcePaymentsPage.advancesView.statusOptions.voidedReversed")}</option>
                  <option value="ALL">{t("workforcePaymentsPage.advancesView.statusOptions.allHistory")}</option>
                </select>
              </label>
              <label>
                <span>{t("workforcePaymentsPage.paymentAccount")}</span>
                <select
                  value={accountFilter}
                  onChange={(event) => setAccountFilter(event.target.value)}
                >
                  <option value="">{t("workforcePaymentsPage.advancesView.allAccounts")}</option>
                  {accounts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="workforce-advance-filter-sheet__row">
                <label>
                  <span>{t("workforcePaymentsPage.advancesView.advanceDateFromAria")}</span>
                  <input
                    type="date"
                    value={fromFilter}
                    onChange={(event) => setFromFilter(event.target.value)}
                  />
                </label>
                <label>
                  <span>{t("workforcePaymentsPage.advancesView.advanceDateToAria")}</span>
                  <input
                    type="date"
                    value={toFilter}
                    onChange={(event) => setToFilter(event.target.value)}
                  />
                </label>
              </div>
            </div>
            <footer className="workforce-advance-filter-sheet__footer">
              <button type="button" className="workforce-advance-filter-sheet__clear" onClick={clearFilters}>
                {t("workforcePaymentsPage.advancesView.clearFilters")}
              </button>
              <button type="button" className="primary-action" onClick={() => setShowFilters(false)}>
                {t("workforcePaymentsPage.advancesView.applyFilters")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function ReviewSettleDialog({
  due,
  accounts,
  recipient,
  canManage,
  canHold,
  canVoid,
  token,
  workspaceId,
  farmId,
  seasonId,
  onClose,
  onSaved,
  onError,
}: {
  due: LabourDueRecord;
  accounts: Account[];
  recipient: string;
  canManage: boolean;
  canHold: boolean;
  canVoid: boolean;
  token: string;
  workspaceId: string;
  farmId: string;
  seasonId: string;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const paymentIdempotencyKey = useRef(uuid());
  const poolIdempotencyKey = useRef(uuid());
  const [advancePool, setAdvancePool] = useState<LabourDueAdvancePool | null>(null);
  const [loadingAdvances, setLoadingAdvances] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoadingAdvances(true);
    void fetchLabourDueAdvancePool(token, workspaceId, due.id, farmId, seasonId, { signal: controller.signal })
      .then((response) => {
        setAdvancePool(response.pool);
        setAdvanceAmount(response.pool.defaultApplyAmount > 0 ? response.pool.defaultApplyAmount.toFixed(2) : "");
        setPayAmount(Math.max(due.outstandingBalance - response.pool.defaultApplyAmount, 0).toFixed(2));
      })
      .catch((caught) => { if (!controller.signal.aborted) onError(caught instanceof Error ? caught.message : t("workforcePaymentsPage.errors.unableLoadEligibleAdvances")); })
      .finally(() => { if (!controller.signal.aborted) setLoadingAdvances(false); });
    return () => controller.abort();
  }, [due.id, due.outstandingBalance, farmId, onError, seasonId, token, workspaceId]);
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [method, setMethod] = useState("Cash");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const advanceTotal = Number(advanceAmount || 0);
  const isGroupDue = due.recipientScope === "LABOUR_GROUP";
  const advanceInvalid =
    advanceTotal > due.outstandingBalance + 0.005 ||
    advanceTotal > (advancePool?.maximumApplicable ?? 0) + 0.005;
  const afterAdvances = Math.max(due.outstandingBalance - advanceTotal, 0);
  const cashNow = Number(payAmount || 0);
  const paymentInvalid = cashNow > afterAdvances + 0.005;
  const remaining = Math.max(afterAdvances - cashNow, 0);
  const setPoolApplication = (value: number) => {
    const normalized = Math.max(0, Math.min(value, advancePool?.maximumApplicable ?? 0));
    setAdvanceAmount(normalized > 0 ? normalized.toFixed(2) : "");
    setPayAmount(Math.max(due.outstandingBalance - normalized, 0).toFixed(2));
  };
  const submit = async () => {
    if (!canManage || saving) return;
    setSaving(true);
    try {
      if (!navigator.onLine)
        throw new Error(
          t("workforcePaymentsPage.errors.connectInternetPostTransaction"),
        );
      const response = await settleLabourPaymentDue(
        token,
        workspaceId,
        due.id,
        {
          farmId,
          seasonId,
          advancePool: advanceTotal > 0 ? { amount: advanceTotal, idempotencyKey: poolIdempotencyKey.current, settlementDate: today() } : null,
          advanceApplications: [],
          payment:
            cashNow > 0
              ? {
                  idempotencyKey: paymentIdempotencyKey.current,
                  voucherDate: today(),
                  amount: cashNow,
                  paymentAccountId: accountId,
                  paymentMethod: method,
                  transactionReference: reference || null,
                }
              : null,
        },
      );
      paymentIdempotencyKey.current = uuid();
      poolIdempotencyKey.current = uuid();
      await onSaved(
        response.result.voucher
          ? t("workforcePaymentsPage.reviewSettle.voucherPostedRemaining", { voucherNumber: response.result.voucher.voucherNumber, remaining: money(response.result.due.outstandingBalance) })
          : t("workforcePaymentsPage.reviewSettle.advancesAppliedRemaining", { remaining: money(response.result.due.outstandingBalance) }),
      );
    } catch (caught) {
      onError(
        caught instanceof Error ? caught.message : t("workforcePaymentsPage.errors.unableSettleDue"),
      );
    } finally {
      setSaving(false);
    }
  };
  const toggleHold = async () => {
    if (!canHold) return;
    try {
      await setLabourDueHold(token, workspaceId, due.id, farmId, seasonId, {
        hold: due.paymentStatus !== "ON_HOLD",
        reason:
          due.paymentStatus === "ON_HOLD"
            ? null
            : t("workforcePaymentsPage.reviewSettle.holdReasonFromReview"),
      });
      await onSaved(
        due.paymentStatus === "ON_HOLD"
          ? t("workforcePaymentsPage.reviewSettle.paymentHoldRemoved")
          : t("workforcePaymentsPage.reviewSettle.paymentPlacedOnHold"),
      );
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("workforcePaymentsPage.errors.unableUpdatePaymentHold"),
      );
    }
  };
  const voidDue = async () => {
    const reason = window.prompt(t("workforcePaymentsPage.reviewSettle.reasonForVoiding", { dueNumber: due.dueNumber }));
    if (!reason?.trim()) return;
    try {
      if (!navigator.onLine)
        throw new Error(t("workforcePaymentsPage.errors.connectInternetVoidDue"));
      await voidLabourDue(token, workspaceId, due.id, farmId, seasonId, {
        idempotencyKey: uuid(),
        reason: reason.trim(),
      });
      await onSaved(t("workforcePaymentsPage.reviewSettle.dueVoided", { dueNumber: due.dueNumber }));
    } catch (caught) {
      onError(
        caught instanceof Error ? caught.message : t("workforcePaymentsPage.errors.unableVoidDue"),
      );
    }
  };
  return (
    <div
      className="worker-dialog-backdrop workforce-payment-review-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="workforce-payment-review"
        role="dialog"
        aria-modal="true"
        aria-label={t("workforcePaymentsPage.reviewSettle.reviewAria", { dueNumber: due.dueNumber })}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>
              {t("workforcePaymentsPage.reviewSettle.labourDue")}
            </span>
            <h2 className="bidi-isolate">{due.dueNumber}</h2>
            <p>{recipient}{typeof due.recipientSnapshot.foremanName === "string" ? ` · ${t("workforcePaymentsPage.reviewSettle.leaderName", { name: due.recipientSnapshot.foremanName })}` : ""} · {statusLabel(t, due.paymentStatus)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close")}>
            <X size={18} />
          </button>
        </header>
        <div className="workforce-payment-review__body">
          <section>
            <h3>{t("workforcePaymentsPage.reviewSettle.workOrSettlementSummary")}</h3>
            <dl className="workforce-payment-review-grid">
              <div>
                <dt>{t("workforcePaymentsPage.description")}</dt>
                <dd>{due.description}</dd>
              </div>
              <div>
                <dt>{t("workforcePaymentsPage.reviewSettle.workPeriod")}</dt>
                <dd className="bidi-isolate">
                  {due.workFromDate} – {due.workToDate}
                </dd>
              </div>
              <div>
                <dt>{t("workforcePaymentsPage.reviewSettle.source")}</dt>
                <dd>
                  {due.origin === "SETTLEMENT"
                    ? t("workforcePaymentsPage.settlementBasisSuffix", { basis: statusLabel(t, due.settlementBasis ?? "Settlement") })
                    : t("workforcePaymentsPage.directLabourDue")}
                </dd>
              </div>
              <div>
                <dt>{t("workforcePaymentsPage.reviewSettle.status")}</dt>
                <dd>
                  <em
                    className={`workforce-payment-status status-${due.paymentStatus.toLowerCase()}`}
                  >
                    {statusLabel(t, due.paymentStatus)}
                  </em>
                </dd>
              </div>
            </dl>
          </section>
          <section>
            <h3>{t("workforcePaymentsPage.reviewSettle.financialPosition")}</h3>
            <dl className="workforce-payment-position">
              <div>
                <dt>{t("workforcePaymentsPage.reviewSettle.originalGrossDue")}</dt>
                <dd className="bidi-isolate">{money(Number(due.grossAmount))}</dd>
              </div>
              {Number(due.adjustmentAmount) !== 0 ? (
                <div>
                  <dt>{t("workforcePaymentsPage.reviewSettle.authorizedAdjustment")}</dt>
                  <dd className="bidi-isolate">
                    {Number(due.adjustmentAmount) > 0 ? "+ " : "− "}
                    {money(Math.abs(Number(due.adjustmentAmount)))}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{t("workforcePaymentsPage.authorizedDeductions")}</dt>
                <dd className="bidi-isolate">− {money(Number(due.authorizedDeductions))}</dd>
              </div>
              <div>
                <dt>{t("workforcePaymentsPage.amounts.advances")}</dt>
                <dd className="bidi-isolate">− {money(due.advancesApplied)}</dd>
              </div>
              <div>
                <dt>{t("workforcePaymentsPage.reviewSettle.previousPayments")}</dt>
                <dd className="bidi-isolate">− {money(due.previousPayments)}</dd>
              </div>
              <div className="is-total">
                <dt>{t("workforcePaymentsPage.reviewSettle.outstandingBalance")}</dt>
                <dd className="bidi-isolate">{money(due.outstandingBalance)}</dd>
              </div>
            </dl>
          </section>
          {due.paymentStatus !== "ON_HOLD" && due.outstandingBalance > 0 ? (
            <section>
              <h3>{t("workforcePaymentsPage.reviewSettle.advancePool")}</h3>
              {loadingAdvances ? (
                <p className="workforce-payments-inline-note">{t("workforcePaymentsPage.reviewSettle.calculatingEligiblePool")}</p>
              ) : !advancePool || advancePool.maximumApplicable <= 0 ? (
                <>
                  <p className="workforce-payments-inline-note">
                    {t("workforcePaymentsPage.reviewSettle.noEligibleAdvances")}
                  </p>
                  {advancePool && advancePool.availableAdvances < -0.005 ? (
                    <p className="worker-action-warning">
                      {t("workforcePaymentsPage.reviewSettle.negativePoolBlocked", { amount: money(advancePool.availableAdvances) })}
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="workforce-advance-pool">
                  <div className="workforce-advance-pool__summary">
                    {isGroupDue && advancePool.groupPool ? <>
                      <div><span>{t("workforcePaymentsPage.recipientScopeOptions.labourGroup")}</span><strong>{advancePool.groupPool.groupName ?? recipient}</strong></div>
                      <div><span>{t("workforcePaymentsPage.reviewSettle.groupLeader")}</span><strong>{advancePool.groupPool.groupLeaderName ?? "—"}</strong></div>
                      <div><span>{t("workforcePaymentsPage.reviewSettle.totalGroupAdvances")}</span><strong className="bidi-isolate">{money(advancePool.groupPool.totalAdvances)}</strong></div>
                      <div><span>{t("workforcePaymentsPage.reviewSettle.previouslyAppliedAdvances")}</span><strong className="bidi-isolate">{money(advancePool.groupPool.appliedAdvances)}</strong></div>
                      <div><span>{t("workforcePaymentsPage.reviewSettle.groupOutstandingAdvances")}</span><strong className="bidi-isolate">{money(advancePool.groupPool.outstandingAdvances)}</strong></div>
                    </> : advancePool.groupPool ? <>
                      <div><span>{t("workforcePaymentsPage.recipientScopeOptions.labourGroup")}</span><strong>{advancePool.groupPool.groupName ?? recipient}</strong></div>
                      <div><span>{t("workforcePaymentsPage.reviewSettle.groupLeader")}</span><strong>{advancePool.groupPool.groupLeaderName ?? "—"}</strong></div>
                      <div><span>{t("workforcePaymentsPage.reviewSettle.groupOutstandingAdvances")}</span><strong className="bidi-isolate">{money(advancePool.groupPool.outstandingAdvances)}</strong></div>
                    </> : (
                      <div><span>{t("workforcePaymentsPage.reviewSettle.totalAvailableForDue")}</span><strong className="bidi-isolate">{money(advancePool.availableAdvances)}</strong></div>
                    )}
                    <div><span>{t("workforcePaymentsPage.reviewSettle.remainingLabourDue")}</span><strong className="bidi-isolate">{money(due.outstandingBalance)}</strong></div>
                    <div><span>{t("workforcePaymentsPage.reviewSettle.maximumApplicable")}</span><strong className="bidi-isolate">{money(advancePool.maximumApplicable)}</strong></div>
                  </div>
                  <label className="workforce-advance-pool__amount">
                    <span>{t("workforcePaymentsPage.reviewSettle.applyFromAdvancePool")}</span>
                    <input type="number" min="0" max={advancePool.maximumApplicable} step="0.01" value={advanceAmount}
                      onChange={(event) => setPoolApplication(Number(event.target.value || 0))} />
                  </label>
                  {advanceInvalid ? <small className="field-error">{t("workforcePaymentsPage.reviewSettle.applicationExceedsPoolOrBalance")}</small> : null}
                  <div className="workforce-advance-pool__quick-actions">
                    <button type="button" onClick={() => setPoolApplication(advancePool.maximumApplicable)}>{t("workforcePaymentsPage.reviewSettle.useAllAvailable")}</button>
                    <button type="button" onClick={() => setPoolApplication(0)}>{t("common.clear")}</button>
                  </div>
                  <div className="workforce-advance-pool__carry"><span>{t("workforcePaymentsPage.reviewSettle.advanceCarriedForward")}</span><strong className="bidi-isolate">{money(Math.max(advancePool.availableAdvances - advanceTotal, 0))}</strong></div>
                </div>
              )}
            </section>
          ) : null}
          {due.paymentStatus !== "ON_HOLD" && afterAdvances > 0 ? (
            <section>
              <h3>{t("workforcePaymentsPage.reviewSettle.paymentNow")}</h3>
              <div className="workforce-payment-review-form">
                <label>
                  <span>{t("workforcePaymentsPage.amountSar")}</span>
                  <input
                    type="number"
                    min="0"
                    max={afterAdvances}
                    step="0.01"
                    value={payAmount}
                    onChange={(event) => setPayAmount(event.target.value)}
                    placeholder={String(afterAdvances.toFixed(2))}
                  />
                  {paymentInvalid ? (
                    <small className="field-error">
                      {t("workforcePaymentsPage.reviewSettle.paymentExceedsBalance")}
                    </small>
                  ) : null}
                </label>
                <label>
                  <span>{t("workforcePaymentsPage.paymentAccount")}</span>
                  <PaymentAccountSelect
                    accounts={eligiblePaymentAccounts(accounts)}
                    value={accountId}
                    onChange={setAccountId}
                    invalid={cashNow > 0 && !accountId}
                  />
                </label>
                <label>
                  <span>{t("workforcePaymentsPage.method")}</span>
                  <select
                    value={method}
                    onChange={(event) => setMethod(event.target.value)}
                  >
                    <option value="Cash">{translateStatus(t, "CASH")}</option>
                    <option value="Bank Transfer">{translateStatus(t, "BANK_TRANSFER")}</option>
                    <option value="Other">{translateStatus(t, "OTHER")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("workforcePaymentsPage.reviewSettle.transactionReference")}</span>
                  <input
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder={t("workforcePaymentsPage.optional")}
                  />
                </label>
              </div>
            </section>
          ) : null}
        </div>
        <footer>
          <div className="workforce-payment-review__preview">
            <span>
              {t("workforcePaymentsPage.reviewSettle.applyAdvances")} <b className="bidi-isolate">{money(advanceTotal)}</b>
            </span>
            <span>
              {t("workforcePaymentsPage.reviewSettle.payNow")} <b className="bidi-isolate">{money(cashNow)}</b>
            </span>
            <span>
              {t("workforcePaymentsPage.reviewSettle.remaining")} <b className="bidi-isolate">{money(remaining)}</b>
            </span>
          </div>
          <div className="workforce-payment-review__actions">
            {canVoid &&
            due.origin === "DIRECT" &&
            due.previousPayments <= 0 &&
            due.advancesApplied <= 0 ? (
              <button
                type="button"
                className="secondary-action"
                onClick={() => void voidDue()}
              >
                {t("workforcePaymentsPage.reviewSettle.voidDue")}
              </button>
            ) : null}
            {canHold ? (
              <button
                type="button"
                className="secondary-action"
                onClick={() => void toggleHold()}
              >
                <PauseCircle size={16} />{" "}
                {due.paymentStatus === "ON_HOLD"
                  ? t("workforcePaymentsPage.reviewSettle.removeHold")
                  : t("workforcePaymentsPage.reviewSettle.putOnHold")}
              </button>
            ) : null}
            <button
              type="button"
              className="primary-action"
              disabled={
                !canManage ||
                saving ||
                due.paymentStatus === "ON_HOLD" ||
                advanceInvalid ||
                paymentInvalid ||
                (advanceTotal <= 0 && cashNow <= 0) ||
                (cashNow > 0 && !accountId)
              }
              onClick={() => void submit()}
            >
              {saving
                ? t("workforcePaymentsPage.posting")
                : advanceTotal > 0 && cashNow > 0
                  ? t("workforcePaymentsPage.reviewSettle.applyAndPayAmounts", { apply: money(advanceTotal), pay: money(cashNow) })
                  : advanceTotal > 0
                    ? t("workforcePaymentsPage.reviewSettle.applyAmountOnly", { apply: money(advanceTotal) })
                    : remaining > 0 ? t("workforcePaymentsPage.reviewSettle.recordPartialSettlement") : t("workforcePaymentsPage.reviewSettle.markAsPaid")}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
