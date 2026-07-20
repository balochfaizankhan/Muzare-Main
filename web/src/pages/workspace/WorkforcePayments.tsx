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
import { useAuth } from "../../auth/AuthProvider";
import { LabourSelectCombobox } from "../../components/LabourSelectCombobox";
import {
  createDirectLabourDue,
  ApiError,
  previewLabourAttendanceDue,
  fetchAllLabourPaymentAdvances,
  fetchLabourPaymentAdvances,
  fetchLabourPaymentDues,
  fetchLabourPaymentVouchers,
  postLabourAdvanceVoucher,
  refundLabourAdvance,
  setLabourDueHold,
  settleLabourPaymentDue,
  voidLabourPaymentVoucher,
  voidLabourDue,
  type LabourAdvancePosition,
  type LabourAdvanceListResponse,
  type LabourDueRecord,
  type LabourAttendanceDuePreview,
  type LabourPaymentVoucherRecord,
  type LabourRecipientScope,
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

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const money = formatMoney;
const uuid = () => crypto.randomUUID();

const scopeOptions: Array<{ value: LabourRecipientScope; label: string }> = [
  { value: "INDIVIDUAL", label: "Individual labourer" },
  { value: "LABOUR_GROUP", label: "Labour group" },
  { value: "CONTRACTOR_FOREMAN", label: "Contractor / foreman" },
  { value: "TEMPORARY_CREW", label: "Temporary crew" },
  { value: "UNREGISTERED_LABOUR", label: "Unregistered labour" },
  { value: "NO_SPECIFIC_RECIPIENT", label: "No specific recipient" },
];

function scopeLabel(scope: LabourRecipientScope) {
  return scopeOptions.find((option) => option.value === scope)?.label ?? scope;
}

function statusLabel(value: string) {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function advanceLabourStatus(labourer: Labourer) {
  const status = typeof labourer.status === "string" ? labourer.status.trim().toLowerCase() : "";
  if (status === "deactivated" || labourer.deactivatedAt) return "Deactivated";
  if (getWorkerDisplayGroup(labourer) === "inactive") return "Inactive";
  return "Active";
}

function renderAdvanceLabourOption(labourer: Labourer) {
  const lifecycle = advanceLabourStatus(labourer);
  return (
    <span className="workforce-advance-labour-option">
      <strong>{labourer.name}</strong>
      {lifecycle !== "Active" ? <small>{lifecycle}</small> : null}
    </span>
  );
}

function recipientLabel(
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
      String(record.recipientSnapshot.labourerName ?? "Individual labourer")
    );
  if (record.labourGroupId)
    return (
      groupById.get(record.labourGroupId)?.name ??
      String(record.recipientSnapshot.labourGroupName ?? "Labour group")
    );
  return String(
    record.recipientSnapshot.recipientReference ??
      record.recipientSnapshot.manualRecipientName ??
      record.recipientSnapshot.crewReference ??
      record.recipientSnapshot.contractorReference ??
      record.recipientSnapshot.batchIdentity ??
      scopeLabel(record.recipientScope),
  );
}

type View = "dues" | "direct" | "vouchers" | "advances";

export function WorkforcePaymentsPage() {
  const { token, user } = useAuth();
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
  const [advances, setAdvances] = useState<LabourAdvancePosition[]>([]);
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
          fetchLabourPaymentAdvances(token, workspaceId, farmId, seasonId, { pageSize: view === "dues" ? 1 : 20, status: "OPEN" }),
        ],
      );
      setDues(dueResponse.dues);
      setVouchers(voucherResponse.vouchers);
      setAdvances(advanceResponse.advances);
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
          : "Unable to load Workforce Payments.",
      );
    } finally {
      setLoading(false);
    }
  }, [farmId, seasonId, token, view, workspaceId]);

  useEffect(() => {
    setAdvanceSummary(null);
    setAdvances([]);
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
          recipientLabel(due, labourById, groupById),
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
        <p>Select an active farm and season to manage labour payments.</p>
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
              <span>Total payments due</span>
              <strong>{money(totalDue)}</strong>
            </button>
            <button
              type="button"
              onClick={() => {
                setStatusFilter("UNPAID");
                setOriginFilter("SETTLEMENT");
              }}
            >
              <ReceiptText size={17} />
              <span>Unpaid settlements</span>
              <strong>{unpaidSettlements}</strong>
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter("PARTIALLY_SETTLED")}
            >
              <Banknote size={17} />
              <span>Partially settled</span>
              <strong>{partialCount}</strong>
            </button>
            <button
              type="button"
              onClick={() => navigate("/workspace/labour-payments/advances")}
            >
              <HandCoins size={17} />
              <span>Outstanding advances</span>
              <strong>{loading && !advanceSummary ? "—" : advanceSummary ? money(advanceSummary.totalOutstanding) : "Unavailable"}</strong>
              {advanceSummary ? <small>{advanceSummary.openCount} open</small> : null}
            </button>
          </section>
          <section className="record-panel workforce-payments-panel">
            <header className="workforce-payments-panel__header">
              <div>
                <h2>Payments Due</h2>
                <p>
                  Settlement and direct labour obligations waiting to be
                  cleared.
                </p>
              </div>
              <div className="workforce-payments-panel__actions">
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() =>
                    navigate("/workspace/labour-payments/direct-due?source=attendance&scope=group")
                  }
                >
                  <ReceiptText size={16} /> Attendance due
                </button>
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() =>
                    navigate("/workspace/labour-payments/direct-due")
                  }
                >
                  <Plus size={16} /> New due
                </button>
              </div>
            </header>
            <div className="workforce-payments-filters">
              <label className="workforce-payments-search">
                <Search size={16} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search due, recipient, or description"
                />
              </label>
              <select
                aria-label="Payment status"
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as typeof statusFilter)
                }
              >
                <option value="OPEN">Unpaid & partial</option>
                <option value="UNPAID">Unpaid</option>
                <option value="PARTIALLY_SETTLED">Partially settled</option>
                <option value="PAID">Paid</option>
                <option value="SETTLED_BY_ADVANCE">Settled by advance</option>
                <option value="ON_HOLD">On hold</option>
                <option value="VOIDED">Voided</option>
                <option value="ALL">All statuses</option>
              </select>
              <select
                aria-label="Due origin"
                value={originFilter}
                onChange={(event) =>
                  setOriginFilter(event.target.value as typeof originFilter)
                }
              >
                <option value="ALL">All origins</option>
                <option value="SETTLEMENT">Settlement</option>
                <option value="DIRECT">Direct due</option>
              </select>
              <select
                aria-label="Recipient scope"
                value={scopeFilter}
                onChange={(event) =>
                  setScopeFilter(event.target.value as typeof scopeFilter)
                }
              >
                <option value="ALL">All recipients</option>
                {scopeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <label className="workforce-payments-date-filter">
                <span>From</span>
                <input
                  type="date"
                  value={fromFilter}
                  onChange={(event) => setFromFilter(event.target.value)}
                />
              </label>
              <label className="workforce-payments-date-filter">
                <span>To</span>
                <input
                  type="date"
                  min={fromFilter || undefined}
                  value={toFilter}
                  onChange={(event) => setToFilter(event.target.value)}
                />
              </label>
            </div>
            {loading ? (
              <p className="workforce-payments-empty">Loading payments due…</p>
            ) : !filteredDues.length ? (
              <p className="workforce-payments-empty">
                No labour dues match these filters.
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
                      <strong>{due.dueNumber}</strong>
                      <em
                        className={`workforce-payment-status status-${due.paymentStatus.toLowerCase()}`}
                      >
                        {statusLabel(due.paymentStatus)}
                      </em>
                    </span>
                    <span className="workforce-payment-due-card__recipient">
                      {recipientLabel(due, labourById, groupById)}
                    </span>
                    {due.recipientScope === "LABOUR_GROUP" && due.settlementBasis === "ATTENDANCE" ? (
                      <span className="workforce-payment-due-card__description">
                        Leader: {String(due.recipientSnapshot.foremanName ?? due.recipientSnapshot.leaderName ?? "Unavailable")} · {Number(due.recipientSnapshot.memberCount ?? 0)} workers
                      </span>
                    ) : null}
                    {["TEMPORARY_CREW", "UNREGISTERED_LABOUR", "NO_SPECIFIC_RECIPIENT"].includes(due.recipientScope) ? (
                      <span className="workforce-payment-due-card__description">
                        Temporary / unregistered crew{due.recipientSnapshot.contactPerson ? ` · Contact: ${String(due.recipientSnapshot.contactPerson)}` : ""}
                      </span>
                    ) : null}
                    <span className="workforce-payment-due-card__description">
                      {due.description}
                    </span>
                    <span className="workforce-payment-due-card__meta">
                      <i>
                        {due.origin === "SETTLEMENT"
                          ? `${statusLabel(due.settlementBasis ?? "Settlement")} settlement`
                          : "Direct labour due"}
                      </i>
                      <i>
                        {due.workFromDate} – {due.workToDate}
                      </i>
                    </span>
                    <span className="workforce-payment-due-card__amounts">
                      <i>
                        Gross <b>{money(Number(due.grossAmount))}</b>
                      </i>
                      <i>
                        Deductions <b>{money(Number(due.authorizedDeductions))}</b>
                      </i>
                      <i>
                        Advances <b>{money(due.advancesApplied)}</b>
                      </i>
                      <i>
                        Paid <b>{money(due.previousPayments)}</b>
                      </i>
                      <i className="is-outstanding">
                        Outstanding <b>{money(due.outstandingBalance)}</b>
                      </i>
                    </span>
                    <span className="workforce-payment-due-card__action">
                      Review and settle <ArrowRight size={15} />
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
          dues={dues}
          advances={advances}
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
          recipient={recipientLabel(selectedDue, labourById, groupById)}
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
  const idempotencyKey = useRef(uuid());
  const location = useLocation();
  const navigate = useNavigate();
  const initialAttendance = new URLSearchParams(location.search).get("source") === "attendance";
  const [source, setSource] = useState<"ATTENDANCE_PERIOD" | "DIRECT">(initialAttendance ? "ATTENDANCE_PERIOD" : "DIRECT");
  const initialParams = new URLSearchParams(location.search);
  const [scope, setScope] = useState<LabourRecipientScope>(initialParams.get("scope") === "group" ? "LABOUR_GROUP" : "INDIVIDUAL");
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
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<LabourAttendanceDuePreview | null>(null);
  useEffect(() => setPreview(null), [scope, labourerId, groupId, from, to]);
  const groupSelectorOptions = useMemo(() => groups.map((group) => ({ ...group, group: "Labour group", dailyWage: 0 } satisfies Labourer)), [groups]);
  const calculateAttendance = async () => {
    if (previewing || !["INDIVIDUAL", "LABOUR_GROUP"].includes(scope)) return;
    setPreviewing(true);
    try {
      const response = await previewLabourAttendanceDue(token, workspaceId, { farmId, seasonId, recipientScope: scope as "INDIVIDUAL" | "LABOUR_GROUP", labourerId: scope === "INDIVIDUAL" ? labourerId : null, labourGroupId: scope === "LABOUR_GROUP" ? groupId : null, fromDate: from, toDate: to, recordDate: today() });
      setPreview(response.preview);
    } catch (caught) { onError(caught instanceof Error ? caught.message : "Unable to calculate attendance wages."); }
    finally { setPreviewing(false); }
  };
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
          "Connect to the internet before approving a labour due.",
        );
      const response = await createDirectLabourDue(token, workspaceId, {
        farmId,
        seasonId,
        idempotencyKey: idempotencyKey.current,
        source,
        recipientScope: scope,
        labourerId: scope === "INDIVIDUAL" ? labourerId : null,
        labourGroupId: scope === "LABOUR_GROUP" ? groupId : null,
        recipientReference: !["INDIVIDUAL", "LABOUR_GROUP"].includes(scope) ? reference : null,
        contactPerson: !["INDIVIDUAL", "LABOUR_GROUP"].includes(scope) ? recipientName || null : null,
        description: description || (source === "ATTENDANCE_PERIOD" ? `Attendance wages ${from} to ${to}` : ""),
        workFromDate: from,
        workToDate: to,
        agreedGrossAmount: source === "DIRECT" ? agreedGrossAmount : undefined,
        authorizedDeductions: authorizedDeductions || "0.00",
        notes,
      });
      committed = true;
      idempotencyKey.current = uuid();
      setSaving(false);
      performance.mark("labour-due-create-committed");
      console.info("labour_due_create_frontend_timing", { totalMs: performance.now() - submitStartedAt, server: response.performance ?? null });
      onSaved(`Labour due ${response.due.dueNumber} created successfully.`, response.due);
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
        Object.keys(normalizedErrors).length ? `Please correct the highlighted field${Object.keys(normalizedErrors).length === 1 ? "" : "s"}.` : Object.values(responseErrors)[0] ?? (caught instanceof Error
          ? caught.message
          : "Unable to create the labour due."),
      );
    } finally {
      if (!committed) setSaving(false);
    }
  };
  return (
    <section className="record-panel workforce-payments-panel workforce-direct-due-panel">
      <header className="workforce-payments-panel__header">
        <div>
          <h2>New Labour Due</h2>
          <p>
            Record the agreed labour obligation first. Payment is posted
            separately.
          </p>
        </div>
      </header>
      <form
        className="workforce-payment-form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="workforce-due-source is-full" role="tablist" aria-label="Due source">
          <button type="button" role="tab" aria-selected={source === "ATTENDANCE_PERIOD"} onClick={() => { setSource("ATTENDANCE_PERIOD"); if (!["INDIVIDUAL", "LABOUR_GROUP"].includes(scope)) setScope("INDIVIDUAL"); }}>Attendance period</button>
          <button type="button" role="tab" aria-selected={source === "DIRECT"} onClick={() => setSource("DIRECT")}>Direct / lump-sum</button>
        </div>
        <label>
          <span>Recipient scope</span>
          <select
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as LabourRecipientScope)
            }
          >
            {scopeOptions.filter((option) => source === "DIRECT" || ["INDIVIDUAL", "LABOUR_GROUP"].includes(option.value)).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {scope === "INDIVIDUAL" ? (
          <label ref={labourerFieldRef} className={fieldErrors.labourerId ? "has-error" : undefined}>
            <span>Labourer</span>
            <LabourSelectCombobox ariaLabel="Labourer" options={labourers} value={labourerId} onChange={setLabourerId} placeholder="Search labourer" noResultsLabel="No matching labourer" includeInactive />
            {fieldErrors.labourerId ? <small className="workforce-field-error">{fieldErrors.labourerId}</small> : null}
          </label>
        ) : null}
        {scope === "LABOUR_GROUP" ? (
          <label className={fieldErrors.labourGroupId ? "has-error" : undefined}>
            <span>Labour group</span>
            <LabourSelectCombobox ariaLabel="Labour group" options={groupSelectorOptions} value={groupId} onChange={setGroupId} placeholder="Search labour group" noResultsLabel="No matching labour group" includeInactive />
            {fieldErrors.labourGroupId ? <small className="workforce-field-error">{fieldErrors.labourGroupId}</small> : null}
          </label>
        ) : null}
        {!["INDIVIDUAL", "LABOUR_GROUP"].includes(scope) ? (
          <>
            <label>
              <span>Contact person (optional)</span>
              <input
                value={recipientName}
                onChange={(event) => setRecipientName(event.target.value)}
                placeholder="Enter foreman or representative name"
              />
            </label>
            <label className={fieldErrors.recipientReference ? "has-error" : undefined}>
              <span>Crew / reference name</span>
              <input
                required
                ref={recipientReferenceRef}
                value={reference}
                onChange={(event) => { setReference(event.target.value); setFieldErrors((current) => ({ ...current, recipientReference: "" })); }}
                placeholder="Enter crew, contractor, foreman, or reference"
              />
              {fieldErrors.recipientReference ? <small className="workforce-field-error">{fieldErrors.recipientReference}</small> : null}
            </label>
          </>
        ) : null}
        <label className={`is-full${fieldErrors.description ? " has-error" : ""}`}>
          <span>Work description</span>
          <input
            required={source === "DIRECT"}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={source === "ATTENDANCE_PERIOD" ? "Optional attendance due description" : "e.g. Temporary workers for onion loading"}
          />
          {fieldErrors.description ? <small className="workforce-field-error">{fieldErrors.description}</small> : null}
        </label>
        <label className={fieldErrors.workFromDate ? "has-error" : undefined}>
          <span>Work from</span>
          <input
            required
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          {fieldErrors.workFromDate ? <small className="workforce-field-error">{fieldErrors.workFromDate}</small> : null}
        </label>
        <label className={fieldErrors.workToDate ? "has-error" : undefined}>
          <span>Work to</span>
          <input
            required
            type="date"
            min={from}
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
          {fieldErrors.workToDate ? <small className="workforce-field-error">{fieldErrors.workToDate}</small> : null}
        </label>
        {source === "DIRECT" ? <label className={fieldErrors.agreedGrossAmount ? "has-error" : undefined}>
          <span>Final agreed amount (SAR)</span>
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
        </label> : null}
        {source === "DIRECT" ? <label className={fieldErrors.authorizedDeductions ? "has-error" : undefined}>
          <span>Authorized deductions</span>
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
        </label> : null}
        {source === "ATTENDANCE_PERIOD" ? <div className="workforce-attendance-preview is-full">
          <button type="button" className="secondary-action" disabled={previewing || !(scope === "INDIVIDUAL" ? labourerId : groupId)} onClick={() => void calculateAttendance()}>{previewing ? "Calculating…" : "Preview attendance wages"}</button>
          {preview ? <section aria-label="Attendance calculation preview">
            <header><div><strong>{preview.groupName || labourers.find((item) => item.id === labourerId)?.name || "Attendance due"}</strong><span>{preview.includedLabourCount} worker{preview.includedLabourCount === 1 ? "" : "s"} · {preview.attendanceTotals.payableDays} payable days</span></div><b>{money(preview.grossWages)}</b></header>
            <p>{preview.attendanceTotals.present} full days · {preview.attendanceTotals.halfDay} half days{preview.excludedAttendanceCount ? ` · ${preview.excludedAttendanceCount} already used` : ""}</p>
            {preview.excludedOwners?.map((owner) => <div className="workforce-attendance-owner" key={`${owner.ownerType}:${owner.ownerId}`}>
              <span>{owner.attendanceCount} attendance entr{owner.attendanceCount === 1 ? "y is" : "ies are"} already included in {owner.ownerType === "LABOUR_DUE" ? "Labour Due" : "historical settlement"} <strong>{owner.ownerNumber}</strong>.</span>
              {owner.ownerType === "LABOUR_DUE" ? <button type="button" className="secondary-action" onClick={() => navigate(`/workspace/labour-payments/overview?dueId=${encodeURIComponent(owner.ownerId)}`)}>View labour due</button> : null}
            </div>)}
            {preview.orphanedAttendanceCount ? <p className="workforce-attendance-warning">{preview.orphanedAttendanceCount} attendance entries have invalid source links and require repair.</p> : null}
            {!preview.orphanedAttendanceCount && preview.grossWages <= 0 ? <p className="workforce-attendance-warning">{preview.excludedOwners?.length === 1 ? `This attendance is already included in ${preview.excludedOwners[0]!.ownerNumber}.` : "No eligible attendance remains for this period."}</p> : null}
            <details><summary>Member wage breakdown</summary>{preview.includedLabourRows.map((row) => <div className="workforce-attendance-member" key={row.labourerId}><span>{row.labourName}<small>{row.payableDays} days · rate {row.wageRateLabel ?? "missing"}</small></span><strong>{money(row.grossWage)}</strong></div>)}</details>
          </section> : null}
        </div> : null}
        <label className="is-full">
          <span>Notes</span>
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Optional notes"
          />
        </label>
        <footer className="workforce-payment-form__footer">
          <div>
            <strong>Amount due</strong>
            <span>
              {money(source === "ATTENDANCE_PERIOD" ? (preview?.grossWages ?? 0) :
                Number(agreedGrossAmount || 0) - Number(authorizedDeductions || 0),
              )}
            </span>
          </div>
          <button disabled={!canManage || saving || (source === "ATTENDANCE_PERIOD" && (!preview || preview.grossWages <= 0 || preview.includedLabourCount <= 0 || Boolean(preview.orphanedAttendanceCount)))} type="submit">
            {saving ? "Creating…" : "Create labour due"}
          </button>
        </footer>
      </form>
    </section>
  );
}

function VoucherRegister({
  vouchers,
  dues,
  advances,
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
}: {
  vouchers: LabourPaymentVoucherRecord[];
  dues: LabourDueRecord[];
  advances: LabourAdvancePosition[];
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
}) {
  const [search, setSearch] = useState("");
  const [nature, setNature] = useState("ALL");
  const [voidingId, setVoidingId] = useState("");
  const voidIdempotencyKeys = useRef<Record<string, string>>({});
  const voidVoucher = async (voucher: LabourPaymentVoucherRecord) => {
    const reason = window.prompt(
      `Reason for reversing ${voucher.voucherNumber}:`,
    );
    if (!reason?.trim()) return;
    setVoidingId(voucher.id);
    try {
      if (!navigator.onLine)
        throw new Error(
          "Connect to the internet before reversing a financial transaction.",
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
          ? `${voucher.voucherNumber} voided by ${response.result.reversal.voucherNumber}.`
          : `${voucher.voucherNumber} is already voided.`,
      );
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "Unable to void this voucher.",
      );
    } finally {
      setVoidingId("");
    }
  };
  const filtered = vouchers.filter(
    (voucher) =>
      (nature === "ALL" || voucher.nature === nature) &&
      (!search.trim() ||
        [
          voucher.voucherNumber,
          voucher.description,
          recipientLabel(voucher, labourById, groupById),
        ]
          .join(" ")
          .toLowerCase()
          .includes(search.trim().toLowerCase())),
  );
  const recognizedExpense = dues
    .filter(
      (due) =>
        due.calculationStatus === "APPROVED" && due.paymentStatus !== "VOIDED",
    )
    .reduce(
      (sum, due) =>
        sum +
        Math.max(
          Number(due.grossAmount) +
            Number(due.adjustmentAmount) -
            Number(due.authorizedDeductions),
          0,
        ),
      0,
    );
  const labourCashPaid = vouchers
    .filter((voucher) => voucher.status === "POSTED")
    .reduce((sum, voucher) => {
      const amount = Number(voucher.paymentAmount);
      if (voucher.nature === "REFUND_RECOVERY") return sum - amount;
      if (voucher.nature !== "REVERSAL") return sum + amount;
      const original = vouchers.find(
        (item) => item.id === voucher.reversalReference,
      );
      return sum + (original?.nature === "REFUND_RECOVERY" ? amount : -amount);
    }, 0);
  const payableOutstanding = dues
    .filter(
      (due) =>
        !["VOIDED", "PAID", "SETTLED_BY_ADVANCE"].includes(due.paymentStatus),
    )
    .reduce((sum, due) => sum + due.outstandingBalance, 0);
  const advanceOutstanding = advances.reduce(
    (sum, advance) => sum + advance.outstandingAmount,
    0,
  );
  return (
    <section className="record-panel workforce-payments-panel">
      <header className="workforce-payments-panel__header">
        <div>
          <h2>Labour Payment Vouchers</h2>
          <p>
            One register for advances, final payments, refunds, and reversals.
          </p>
        </div>
      </header>
      <div className="workforce-payments-filters">
        <label className="workforce-payments-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search voucher or recipient"
          />
        </label>
        <select
          value={nature}
          onChange={(event) => setNature(event.target.value)}
        >
          <option value="ALL">All voucher natures</option>
          <option value="ADVANCE">Advances</option>
          <option value="SETTLEMENT_BALANCE_PAYMENT">
            Settlement payments
          </option>
          <option value="DIRECT_LABOUR_PAYMENT">Direct due payments</option>
          <option value="REFUND_RECOVERY">Refunds / recoveries</option>
          <option value="REVERSAL">Reversals</option>
        </select>
      </div>
      <div className="workforce-payment-report-grid">
        <article>
          <span>Labour expense recognized</span>
          <strong>{money(recognizedExpense)}</strong>
        </article>
        <article>
          <span>Labour cash paid</span>
          <strong>{money(labourCashPaid)}</strong>
        </article>
        <article>
          <span>Outstanding advances</span>
          <strong>{money(advanceOutstanding)}</strong>
        </article>
        <article>
          <span>Outstanding payables</span>
          <strong>{money(payableOutstanding)}</strong>
        </article>
      </div>
      {loading ? (
        <p className="workforce-payments-empty">Loading vouchers…</p>
      ) : !filtered.length ? (
        <p className="workforce-payments-empty">
          No Labour Payment Vouchers match this filter.
        </p>
      ) : (
        <div className="workforce-payment-voucher-list">
          {filtered.map((voucher) => (
            <article key={voucher.id}>
              <header>
                <strong>{voucher.voucherNumber}</strong>
                <em
                  className={`workforce-payment-status status-${voucher.status.toLowerCase()}`}
                >
                  {statusLabel(voucher.status)}
                </em>
              </header>
              <h3>{recipientLabel(voucher, labourById, groupById)}</h3>
              <p>{voucher.description}</p>
              <dl>
                <div>
                  <dt>Nature</dt>
                  <dd>{statusLabel(voucher.nature)}</dd>
                </div>
                <div>
                  <dt>Date</dt>
                  <dd>{voucher.voucherDate}</dd>
                </div>
                <div>
                  <dt>Account</dt>
                  <dd>
                    {accounts.get(voucher.paymentAccountId ?? "")?.name ??
                      "Legacy / reconciliation"}
                  </dd>
                </div>
                <div>
                  <dt>Amount</dt>
                  <dd>{money(Number(voucher.paymentAmount))}</dd>
                </div>
              </dl>
              {voucher.legacy ? (
                <small>
                  Legacy mapped record ·{" "}
                  {statusLabel(voucher.reconciliationStatus)}
                </small>
              ) : null}
              {canVoid &&
              voucher.status === "POSTED" &&
              voucher.nature !== "REVERSAL" &&
              !voucher.legacy ? (
                <button
                  className="secondary-action"
                  disabled={voidingId === voucher.id}
                  type="button"
                  onClick={() => void voidVoucher(voucher)}
                >
                  {voidingId === voucher.id ? "Reversing…" : "Void / reverse"}
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
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const location = useLocation();
  const [rows, setRows] = useState<LabourAdvancePosition[]>([]);
  const [summary, setSummary] = useState<LabourAdvanceListResponse["summary"]>({
    totalOutstanding: 0,
    openCount: 0,
    partiallyAppliedCount: 0,
  });
  const [pageInfo, setPageInfo] = useState<
    LabourAdvanceListResponse["pageInfo"]
  >({ page: 1, pageSize: 20, totalCount: 0, hasMore: false });
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("OPEN");
  const [accountFilter, setAccountFilter] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [groupMode, setGroupMode] = useState(false);
  const [selectedAdvance, setSelectedAdvance] =
    useState<LabourAdvancePosition | null>(null);
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
  const [refundAdvance, setRefundAdvance] =
    useState<LabourAdvancePosition | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundAccountId, setRefundAccountId] = useState("");
  const [refundDate, setRefundDate] = useState(today());
  const [refundMethod, setRefundMethod] = useState("Recovery");
  const [refundNotes, setRefundNotes] = useState("");
  const [refunding, setRefunding] = useState(false);
  const idempotencyKey = useRef(uuid());
  const refundIdempotencyKey = useRef(uuid());
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
  const openRecordAdvance = useCallback((deepAction = false) => {
    if (showForm) return;
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
    window.requestAnimationFrame(() => recipientScopeRef.current?.focus());
  }, [location.hash, location.pathname, location.search, resetRecordAdvanceForm, showForm]);
  const closeRecordAdvance = useCallback(() => {
    setShowForm(false);
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
    window.requestAnimationFrame(() => recipientScopeRef.current?.focus());
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
      `muzare:advance-list:v2:${workspaceId}:${farmId}:${seasonId}:${search}:${scopeFilter}:${statusFilter}:${accountFilter}:${fromFilter}:${toFilter}`,
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
        setSummary(response.summary);
        setPageInfo(response.pageInfo);
        if (!append) sessionStorage.setItem(cacheKey, JSON.stringify(response));
      } catch (caught) {
        if (controller.signal.aborted) return;
        setLoadError(
          caught instanceof Error
            ? caught.message
            : "Unable to load outstanding advances.",
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
        setSummary(value.summary);
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
    const refreshAdvances = () => void loadPage(1, false);
    window.addEventListener("muzare-data-refresh", refreshAdvances);
    return () => window.removeEventListener("muzare-data-refresh", refreshAdvances);
  }, [loadPage]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      if (!navigator.onLine)
        throw new Error(
          "Connect to the internet before posting a financial transaction.",
        );
      const receiver = labourers.find(
        (item) =>
          item.id ===
          (scope === "INDIVIDUAL" ? labourerId : receivedByLabourerId),
      );
      const response = await postLabourAdvanceVoucher(token, workspaceId, {
        farmId,
        seasonId,
        idempotencyKey: idempotencyKey.current,
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
      });
      idempotencyKey.current = uuid();
      closeRecordAdvance();
      await onSaved(`Advance ${response.voucher.voucherNumber} posted successfully.`);
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "Unable to post the advance.",
      );
    } finally {
      setSaving(false);
    }
  };
  const submitRefund = async (event: FormEvent) => {
    event.preventDefault();
    if (!refundAdvance || refunding) return;
    const recovery = Number(refundAmount);
    if (recovery > refundAdvance.outstandingAmount + 0.005) {
      onError("Recovery cannot exceed the outstanding advance amount.");
      return;
    }
    setRefunding(true);
    try {
      const response = await refundLabourAdvance(
        token,
        workspaceId,
        refundAdvance.id,
        {
          farmId,
          seasonId,
          payment: {
            idempotencyKey: refundIdempotencyKey.current,
            voucherDate: refundDate,
            amount: recovery,
            paymentAccountId: refundAccountId,
            paymentMethod: refundMethod,
            description:
              refundNotes ||
              `Advance recovery for ${refundAdvance.displayVoucherNumber}`,
          },
        },
      );
      refundIdempotencyKey.current = uuid();
      setRefundAdvance(null);
      setRefundAmount("");
      setRefundNotes("");
      await onSaved(`Recovery ${response.voucher.voucherNumber} posted.`);
      await loadPage(1, false);
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "Unable to post the recovery.",
      );
    } finally {
      setRefunding(false);
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
      ? "Individual labourer"
      : advance.recipientScope === "LABOUR_GROUP"
        ? "Labour group"
        : scopeLabel(advance.recipientScope);
  const recipientGroups = useMemo(
    () =>
      Array.from(
        rows
          .reduce((map, advance) => {
            const key = `${advance.recipientScope}:${advance.financialOwnerId ?? advance.financialOwnerName ?? "unavailable"}`;
            const current = map.get(key) ?? {
              key,
              name: advance.financialOwnerName ?? "Recipient unavailable",
              scope: scopeCopy(advance),
              count: 0,
              outstanding: 0,
              reviewRequired: false,
              receivers: new Set<string>(),
            };
            current.count += 1;
            current.outstanding += advance.outstandingAmount;
            current.reviewRequired ||= advance.reviewRequired;
            if (advance.receivedByName)
              current.receivers.add(advance.receivedByName);
            else if (
              advance.recipientScope === "INDIVIDUAL" &&
              advance.financialOwnerName
            )
              current.receivers.add(advance.financialOwnerName);
            map.set(key, current);
            return map;
          }, new Map<string, { key: string; name: string; scope: string; count: number; outstanding: number; reviewRequired: boolean; receivers: Set<string> }>())
          .values(),
      ),
    [rows],
  );
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
  const accountOptions = useMemo(
    () =>
      accounts.map(
        (item) => ({ id: item.id, name: item.name, active: true }) as Labourer,
      ),
    [accounts],
  );
  const selectedOwner =
    scope === "INDIVIDUAL"
      ? labourers.find((item) => item.id === labourerId)?.name
      : scope === "LABOUR_GROUP"
        ? groups.find((item) => item.id === groupId)?.name
        : recipientName || reference;
  const selectedReceiver =
    scope === "INDIVIDUAL"
      ? selectedOwner
      : scope === "LABOUR_GROUP"
        ? labourers.find((item) => item.id === receivedByLabourerId)?.name
        : "";
  const selectedAccount = accounts.find((item) => item.id === accountId)?.name;
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
        ? groupId && receivedByLabourerId
        : reference) &&
    description.trim(),
  );
  return (
    <>
      <section className="record-panel workforce-payments-panel workforce-advances-panel">
        <header className="workforce-payments-panel__header workforce-advances-header">
          <div>
            <h2>Outstanding Advances</h2>
            <p>
              {pageInfo.totalCount
                ? `${rows.length} of ${pageInfo.totalCount} advances loaded`
                : "Advance balances by financial owner"}
            </p>
          </div>
          {canManage ? (
            <button
              ref={recordAdvanceButtonRef}
              className="primary-action workforce-record-advance"
              type="button"
              onClick={() => openRecordAdvance(false)}
            >
              <Plus size={16} /> Record advance
            </button>
          ) : null}
        </header>
        <div className="workforce-advance-summary">
          <div>
            <span>Total outstanding</span>
            <strong>{money(summary.totalOutstanding)}</strong>
          </div>
          <div>
            <span>Open</span>
            <strong>{summary.openCount}</strong>
          </div>
          {summary.partiallyAppliedCount ? (
            <div>
              <span>Partial</span>
              <strong>{summary.partiallyAppliedCount}</strong>
            </div>
          ) : null}
        </div>
        <div className="workforce-advance-toolbar">
          <label className="workforce-payments-search">
            <Search size={16} />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search recipient, group, voucher, or account"
            />
          </label>
          <div
            className="workforce-advance-view-toggle"
            role="group"
            aria-label="Advance display"
          >
            <button
              type="button"
              aria-pressed={groupMode}
              onClick={() => setGroupMode(true)}
            >
              Grouped
            </button>
            <button
              type="button"
              aria-pressed={!groupMode}
              onClick={() => setGroupMode(false)}
            >
              Vouchers
            </button>
          </div>
          <button
            className="secondary-action"
            type="button"
            aria-expanded={showFilters}
            onClick={() => setShowFilters((value) => !value)}
          >
            Filters
          </button>
        </div>
        {showFilters ? (
          <div className="workforce-advance-filters">
            <select
              aria-label="Recipient scope"
              value={scopeFilter}
              onChange={(event) => setScopeFilter(event.target.value)}
            >
              <option value="">All recipients</option>
              {scopeOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Advance status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="OPEN">Outstanding & partial</option>
              <option value="OUTSTANDING">Outstanding</option>
              <option value="PARTIALLY_APPLIED">Partially applied</option>
              <option value="PARTIALLY_REFUNDED">Partially refunded</option>
              <option value="ALL">All history</option>
            </select>
            <select
              aria-label="Payment account"
              value={accountFilter}
              onChange={(event) => setAccountFilter(event.target.value)}
            >
              <option value="">All accounts</option>
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <input
              aria-label="Advance date from"
              type="date"
              value={fromFilter}
              onChange={(event) => setFromFilter(event.target.value)}
            />
            <input
              aria-label="Advance date to"
              type="date"
              value={toFilter}
              onChange={(event) => setToFilter(event.target.value)}
            />
          </div>
        ) : null}
        {initialLoading && !rows.length ? (
          <div
            className="workforce-advance-skeletons"
            aria-label="Loading outstanding advances"
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
              Retry
            </button>
          </div>
        ) : !rows.length ? (
          <p className="workforce-payments-empty">
            No outstanding advances match these filters.
          </p>
        ) : groupMode ? (
          <div className="workforce-advance-recipient-list">
            {recipientGroups.map((group) => {
              const receivers = [...group.receivers];
              return (
                <article key={group.key}>
                  <div>
                    <strong>{group.name}</strong>
                    <span>
                      {receivers.length
                        ? `Received by ${receivers[0]}${receivers.length > 1 ? ` +${receivers.length - 1}` : ""}`
                        : "Receiver unavailable"}
                    </span>
                  </div>
                  <div>
                    <b>{money(group.outstanding)} outstanding</b>
                    <span>
                      {group.count} loaded{" "}
                      {group.count === 1 ? "advance" : "advances"}
                      {group.reviewRequired ? " · Review required" : ""}
                    </span>
                  </div>
                  <div className="workforce-advance-group-actions">
                    <button
                      className="workforce-advance-link"
                      type="button"
                      disabled={group.name === "Recipient unavailable"}
                      onClick={() => {
                        setGroupMode(false);
                        setSearchInput(group.name);
                      }}
                    >
                      View advances
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="workforce-advance-position-list">
            {rows.map((advance) => {
              const receiver =
                advance.receivedByName ||
                (advance.recipientScope === "INDIVIDUAL"
                  ? advance.financialOwnerName
                  : null);
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
                    <div>
                      <span>{receiver ?? "Receiver unavailable"}</span>
                      <small>
                        {advance.recipientScope === "LABOUR_GROUP"
                          ? receiver
                            ? `Received by · for ${advance.financialOwnerName ?? "Owner unavailable"}`
                            : `For ${advance.financialOwnerName ?? "Owner unavailable"} · Legacy record · review required`
                          : "Individual labourer"}
                        {advance.reviewRequired ? " · Review required" : ""}
                      </small>
                    </div>
                    <em
                      className={`workforce-payment-status status-${advance.advanceStatus.toLowerCase()}`}
                    >
                      {statusLabel(advance.advanceStatus)}
                    </em>
                  </header>
                  <div className="workforce-advance-card__reference">
                    <span>{advance.displayVoucherNumber}</span>
                    <time>{formatDate(advance.voucherDate)}</time>
                  </div>
                  <div className="workforce-advance-card__money">
                    <div>
                      <span>Outstanding</span>
                      <strong>{money(advance.outstandingAmount)}</strong>
                    </div>
                    <small>
                      Original {money(advance.originalAmount)}
                      {advance.appliedAmount > 0
                        ? ` · Applied ${money(advance.appliedAmount)}`
                        : ""}
                      {advance.refundedAmount > 0
                        ? ` · Recovered ${money(advance.refundedAmount)}`
                        : ""}
                    </small>
                  </div>
                  <footer>
                    <span>Paid from: {advance.paymentAccountName ?? "Account unavailable"}</span>
                    <div>
                      <button
                        type="button"
                        className="workforce-advance-link"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedAdvance(advance);
                        }}
                      >
                        Details
                      </button>
                      {canManage &&
                      !advance.readOnlyLegacy &&
                      advance.status === "POSTED" ? (
                        <button
                          type="button"
                          className="secondary-action workforce-advance-recover"
                          onClick={(event) => {
                            event.stopPropagation();
                            setRefundAdvance(advance);
                            setRefundAmount(String(advance.outstandingAmount));
                          }}
                        >
                          Recover
                        </button>
                      ) : null}
                    </div>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
        {rows.length ? (
          <div className="workforce-advance-pagination">
            <span>
              Showing {rows.length} of {pageInfo.totalCount}
            </span>
            {pageInfo.hasMore ? (
              <button
                className="secondary-action"
                disabled={loadingMore}
                type="button"
                onClick={() => void loadPage(pageInfo.page + 1, true)}
              >
                {loadingMore ? "Loading more…" : "Load more"}
              </button>
            ) : (
              <small>End of results</small>
            )}
          </div>
        ) : null}
      </section>
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
                <span>Labour payment voucher</span>
                <h2 id="record-advance-title">Record advance</h2>
                <p>Record money paid before final settlement</p>
              </div>
              <button
                type="button"
                onClick={closeRecordAdvance}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </header>
            <div className="workforce-payment-review__body workforce-advance-entry-body">
              <section>
                <h3>
                  <span>1</span> Recipient
                </h3>
                <div className="workforce-payment-form">
                  <label>
                    <span>Recipient scope</span>
                    <select
                      ref={recipientScopeRef}
                      value={scope}
                      onChange={(event) =>
                        setScope(event.target.value as LabourRecipientScope)
                      }
                    >
                      {scopeOptions.slice(0, 5).map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {scope === "INDIVIDUAL" ? (
                    <label>
                      <span>Labourer</span>
                      <LabourSelectCombobox
                        ariaLabel="Labourer"
                        options={selectableLabourers}
                        value={labourerId}
                        onChange={setLabourerId}
                        placeholder="Search labourers"
                        noResultsLabel="No selectable labourers found"
                        includeInactive
                        renderOption={renderAdvanceLabourOption}
                      />
                      {selectedIndividualLabourer && advanceLabourStatus(selectedIndividualLabourer) !== "Active" ? (
                        <small className="workforce-advance-inactive-note">This labourer is currently inactive. The advance will still be recorded against their historical labour account.</small>
                      ) : null}
                    </label>
                  ) : null}
                  {scope === "LABOUR_GROUP" ? (
                    <>
                      <label>
                        <span>Labour group</span>
                        <LabourSelectCombobox
                          ariaLabel="Labour group"
                          options={groupOptions}
                          value={groupId}
                          onChange={setGroupId}
                          placeholder="Search labour groups"
                        />
                      </label>
                      <label>
                        <span>Received by</span>
                        <LabourSelectCombobox
                          ariaLabel="Received by labourer"
                          options={selectableLabourers}
                          value={receivedByLabourerId}
                          onChange={setReceivedByLabourerId}
                          placeholder="Search receiving labourer"
                          noResultsLabel="No selectable labourers found"
                          includeInactive
                          renderOption={renderAdvanceLabourOption}
                        />
                        {selectedReceiverLabourer && advanceLabourStatus(selectedReceiverLabourer) !== "Active" ? (
                          <small className="workforce-advance-inactive-note">This labourer is currently inactive. The advance will still be recorded against their historical labour account.</small>
                        ) : null}
                      </label>
                    </>
                  ) : null}
                  {!["INDIVIDUAL", "LABOUR_GROUP"].includes(scope) ? (
                    <>
                      <label>
                        <span>Recipient name</span>
                        <input
                          value={recipientName}
                          onChange={(event) =>
                            setRecipientName(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        <span>Stable reference</span>
                        <input
                          required
                          value={reference}
                          onChange={(event) => setReference(event.target.value)}
                        />
                      </label>
                    </>
                  ) : null}
                </div>
              </section>
              <section>
                <h3>
                  <span>2</span> Payment
                </h3>
                <div className="workforce-payment-form">
                  <label>
                    <span>Date</span>
                    <input
                      required
                      type="date"
                      value={date}
                      onChange={(event) => setDate(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Amount (SAR)</span>
                    <input
                      required
                      min="0.01"
                      step="0.01"
                      type="number"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Paid from account</span>
                    <LabourSelectCombobox
                      ariaLabel="Paid from account"
                      options={accountOptions}
                      value={accountId}
                      onChange={setAccountId}
                      placeholder="Search payment accounts"
                    />
                  </label>
                  <label>
                    <span>Method</span>
                    <select
                      value={method}
                      onChange={(event) => setMethod(event.target.value)}
                    >
                      <option>Cash</option>
                      <option>Bank Transfer</option>
                      <option>Other</option>
                    </select>
                  </label>
                </div>
              </section>
              <section>
                <h3>
                  <span>3</span> Details
                </h3>
                <div className="workforce-payment-form">
                  <label className="is-full">
                    <span>Description</span>
                    <input
                      required
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="Purpose of this advance"
                    />
                  </label>
                  <label className="is-full">
                    <span>Note / reference</span>
                    <input
                      value={transactionReference}
                      onChange={(event) =>
                        setTransactionReference(event.target.value)
                      }
                      placeholder="Optional"
                    />
                  </label>
                </div>
              </section>
              {selectedOwner && Number(amount) > 0 && selectedAccount ? (
                <section className="workforce-advance-preview">
                  <h3>
                    <span>4</span> Preview
                  </h3>
                  <dl>
                    <div>
                      <dt>For</dt>
                      <dd>{selectedOwner}</dd>
                    </div>
                    {selectedReceiver && selectedReceiver !== selectedOwner ? (
                      <div>
                        <dt>Received by</dt>
                        <dd>{selectedReceiver}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>Amount</dt>
                      <dd>{money(Number(amount))}</dd>
                    </div>
                    <div>
                      <dt>Paid from</dt>
                      <dd>{selectedAccount}</dd>
                    </div>
                    <div>
                      <dt>Method</dt>
                      <dd>{method}</dd>
                    </div>
                  </dl>
                </section>
              ) : null}
            </div>
            <footer>
              <div className="workforce-payment-review__actions">
                <button
                  className="secondary-action"
                  type="button"
                  onClick={closeRecordAdvance}
                >
                  Cancel
                </button>
                <button
                  className="primary-action"
                  disabled={saving || !formValid}
                  type="submit"
                >
                  {saving ? "Posting…" : "Post advance"}
                </button>
              </div>
            </footer>
          </form>
        </div>
      ) : null}
      {refundAdvance ? (
        <div
          className="worker-dialog-backdrop workforce-payment-review-backdrop"
          role="presentation"
          onClick={() => setRefundAdvance(null)}
        >
          <form
            className="workforce-payment-review workforce-recovery-sheet"
            onSubmit={(event) => void submitRefund(event)}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>{refundAdvance.displayVoucherNumber}</span>
                <h2>Record recovery</h2>
                <p>
                  {refundAdvance.financialOwnerName ?? "Recipient unavailable"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRefundAdvance(null)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </header>
            <div className="workforce-payment-review__body">
              <div className="workforce-recovery-balance">
                <span>Current outstanding</span>
                <strong>{money(refundAdvance.outstandingAmount)}</strong>
              </div>
              <div className="workforce-payment-review-form">
                <label>
                  <span>Recovery amount</span>
                  <input
                    required
                    type="number"
                    min="0.01"
                    max={refundAdvance.outstandingAmount}
                    step="0.01"
                    value={refundAmount}
                    onChange={(event) => setRefundAmount(event.target.value)}
                  />
                </label>
                <label>
                  <span>Received into account</span>
                  <select
                    required
                    value={refundAccountId}
                    onChange={(event) => setRefundAccountId(event.target.value)}
                  >
                    <option value="">Select account</option>
                    {accounts.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Date</span>
                  <input
                    required
                    type="date"
                    value={refundDate}
                    onChange={(event) => setRefundDate(event.target.value)}
                  />
                </label>
                <label>
                  <span>Method</span>
                  <select
                    value={refundMethod}
                    onChange={(event) => setRefundMethod(event.target.value)}
                  >
                    <option>Recovery</option>
                    <option>Cash</option>
                    <option>Bank Transfer</option>
                  </select>
                </label>
                <label className="is-full">
                  <span>Notes</span>
                  <input
                    value={refundNotes}
                    onChange={(event) => setRefundNotes(event.target.value)}
                    placeholder="Optional notes"
                  />
                </label>
              </div>
              <div className="workforce-recovery-preview">
                <span>Outstanding after recovery</span>
                <strong>
                  {money(
                    Math.max(
                      refundAdvance.outstandingAmount -
                        Number(refundAmount || 0),
                      0,
                    ),
                  )}
                </strong>
              </div>
            </div>
            <footer>
              <div className="workforce-payment-review__actions">
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() => setRefundAdvance(null)}
                >
                  Cancel
                </button>
                <button
                  className="primary-action"
                  disabled={
                    refunding ||
                    Number(refundAmount) <= 0 ||
                    Number(refundAmount) > refundAdvance.outstandingAmount ||
                    !refundAccountId
                  }
                  type="submit"
                >
                  {refunding ? "Posting…" : "Confirm recovery"}
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
                <h2>{selectedAdvance.displayVoucherNumber}</h2>
                <p>
                  {selectedAdvance.financialOwnerName ??
                    "Recipient unavailable"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAdvance(null)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </header>
            <div className="workforce-payment-review__body">
              <dl className="workforce-payment-position">
                <div>
                  <dt>Financial owner</dt>
                  <dd>
                    {selectedAdvance.financialOwnerName ??
                      "Recipient unavailable"}
                  </dd>
                </div>
                <div>
                  <dt>Received by</dt>
                  <dd>
                    {selectedAdvance.receivedByName ??
                      (selectedAdvance.recipientScope === "INDIVIDUAL"
                        ? selectedAdvance.financialOwnerName ?? "Receiver unavailable"
                        : "Receiver unavailable")}
                  </dd>
                </div>
                <div>
                  <dt>Date</dt>
                  <dd>{formatDate(selectedAdvance.voucherDate)}</dd>
                </div>
                <div>
                  <dt>Account</dt>
                  <dd>
                    {selectedAdvance.paymentAccountName ??
                      "Account unavailable"}
                  </dd>
                </div>
                <div>
                  <dt>Original</dt>
                  <dd>{money(selectedAdvance.originalAmount)}</dd>
                </div>
                <div>
                  <dt>Applied</dt>
                  <dd>{money(selectedAdvance.appliedAmount)}</dd>
                </div>
                <div>
                  <dt>Recovered</dt>
                  <dd>{money(selectedAdvance.refundedAmount)}</dd>
                </div>
                <div className="is-total">
                  <dt>Outstanding</dt>
                  <dd>{money(selectedAdvance.outstandingAmount)}</dd>
                </div>
              </dl>
              <section>
                <h3>Description</h3>
                <p>{selectedAdvance.description}</p>
              </section>
              <section>
                <h3>Posting and audit</h3>
                <p>
                  {statusLabel(selectedAdvance.status)} ·{" "}
                  {selectedAdvance.createdByName ?? "Creator unavailable"}
                </p>
                {selectedAdvance.legacy ? (
                  <p>
                    Legacy source: {selectedAdvance.sourceType} ·{" "}
                    {selectedAdvance.reviewRequired
                      ? "Review required"
                      : "Mapped"}
                  </p>
                ) : null}
              </section>
            </div>
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
  const paymentIdempotencyKey = useRef(uuid());
  const [advances, setEligibleAdvances] = useState<LabourAdvancePosition[]>([]);
  const [loadingAdvances, setLoadingAdvances] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoadingAdvances(true);
    void fetchAllLabourPaymentAdvances(token, workspaceId, farmId, seasonId, { status: "OPEN", signal: controller.signal })
      .then((response) => setEligibleAdvances(response.advances.filter((advance) => advance.status === "POSTED" && advance.outstandingAmount > 0 && advance.financialScopeKey === due.financialScopeKey)))
      .catch((caught) => { if (!controller.signal.aborted) onError(caught instanceof Error ? caught.message : "Unable to load eligible advances."); })
      .finally(() => { if (!controller.signal.aborted) setLoadingAdvances(false); });
    return () => controller.abort();
  }, [due.financialScopeKey, farmId, onError, seasonId, token, workspaceId]);
  const advanceIdempotencyKeys = useRef<Record<string, string>>({});
  const [advanceValues, setAdvanceValues] = useState<Record<string, string>>(
    {},
  );
  const [payAmount, setPayAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [method, setMethod] = useState("Cash");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const advanceTotal = advances.reduce(
    (sum, advance) => sum + Number(advanceValues[advance.id] || 0),
    0,
  );
  const advanceInvalid =
    advanceTotal > due.outstandingBalance + 0.005 ||
    advances.some(
      (advance) =>
        Number(advanceValues[advance.id] || 0) >
        advance.outstandingAmount + 0.005,
    );
  const afterAdvances = Math.max(due.outstandingBalance - advanceTotal, 0);
  const cashNow = Number(payAmount || 0);
  const paymentInvalid = cashNow > afterAdvances + 0.005;
  const remaining = Math.max(afterAdvances - cashNow, 0);
  const submit = async () => {
    if (!canManage || saving) return;
    setSaving(true);
    try {
      if (!navigator.onLine)
        throw new Error(
          "Connect to the internet before posting a financial transaction.",
        );
      const applications = advances.flatMap((advance) => {
        const value = Number(advanceValues[advance.id] || 0);
        if (!advanceIdempotencyKeys.current[advance.id])
          advanceIdempotencyKeys.current[advance.id] = uuid();
        return value > 0
          ? [
              {
                advanceVoucherId: advance.id,
                amount: value,
                idempotencyKey: advanceIdempotencyKeys.current[advance.id]!,
              },
            ]
          : [];
      });
      const response = await settleLabourPaymentDue(
        token,
        workspaceId,
        due.id,
        {
          farmId,
          seasonId,
          advanceApplications: applications,
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
      advanceIdempotencyKeys.current = {};
      await onSaved(
        response.result.voucher
          ? `${response.result.voucher.voucherNumber} posted. Remaining due: ${money(response.result.due.outstandingBalance)}.`
          : `Advances applied. Remaining due: ${money(response.result.due.outstandingBalance)}.`,
      );
    } catch (caught) {
      onError(
        caught instanceof Error ? caught.message : "Unable to settle this due.",
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
            : "Payment placed on hold from review",
      });
      await onSaved(
        due.paymentStatus === "ON_HOLD"
          ? "Payment hold removed."
          : "Payment placed on hold.",
      );
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "Unable to update payment hold.",
      );
    }
  };
  const voidDue = async () => {
    const reason = window.prompt(`Reason for voiding ${due.dueNumber}:`);
    if (!reason?.trim()) return;
    try {
      if (!navigator.onLine)
        throw new Error("Connect to the internet before voiding a labour due.");
      await voidLabourDue(token, workspaceId, due.id, farmId, seasonId, {
        idempotencyKey: uuid(),
        reason: reason.trim(),
      });
      await onSaved(`${due.dueNumber} voided.`);
    } catch (caught) {
      onError(
        caught instanceof Error ? caught.message : "Unable to void this due.",
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
        aria-label={`Review ${due.dueNumber}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>
              {due.origin === "SETTLEMENT"
                ? "Settlement due"
                : "Direct labour due"}
            </span>
            <h2>{due.dueNumber}</h2>
            <p>{recipient}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="workforce-payment-review__body">
          <section>
            <h3>Work or settlement summary</h3>
            <dl className="workforce-payment-review-grid">
              <div>
                <dt>Description</dt>
                <dd>{due.description}</dd>
              </div>
              <div>
                <dt>Work period</dt>
                <dd>
                  {due.workFromDate} – {due.workToDate}
                </dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>
                  {due.origin === "SETTLEMENT"
                    ? `${statusLabel(due.settlementBasis ?? "Settlement")} settlement`
                    : "Direct labour due"}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <em
                    className={`workforce-payment-status status-${due.paymentStatus.toLowerCase()}`}
                  >
                    {statusLabel(due.paymentStatus)}
                  </em>
                </dd>
              </div>
            </dl>
          </section>
          <section>
            <h3>Financial position</h3>
            <dl className="workforce-payment-position">
              <div>
                <dt>Original gross due</dt>
                <dd>{money(Number(due.grossAmount))}</dd>
              </div>
              {Number(due.adjustmentAmount) !== 0 ? (
                <div>
                  <dt>Authorized adjustment / leader allowance</dt>
                  <dd>
                    {Number(due.adjustmentAmount) > 0 ? "+ " : "− "}
                    {money(Math.abs(Number(due.adjustmentAmount)))}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Authorized deductions</dt>
                <dd>− {money(Number(due.authorizedDeductions))}</dd>
              </div>
              <div>
                <dt>Advances applied</dt>
                <dd>− {money(due.advancesApplied)}</dd>
              </div>
              <div>
                <dt>Previous payments</dt>
                <dd>− {money(due.previousPayments)}</dd>
              </div>
              <div className="is-total">
                <dt>Outstanding balance</dt>
                <dd>{money(due.outstandingBalance)}</dd>
              </div>
            </dl>
          </section>
          {due.paymentStatus !== "ON_HOLD" && due.outstandingBalance > 0 ? (
            <section>
              <h3>Apply advances</h3>
              {loadingAdvances ? (
                <p className="workforce-payments-inline-note">Loading eligible group advances…</p>
              ) : !advances.length ? (
                <p className="workforce-payments-inline-note">
                  No eligible outstanding advances for this financial scope.
                </p>
              ) : (
                <div className="workforce-payment-advance-options">
                  {advances.map((advance) => (
                    <label key={advance.id}>
                      <span>
                        <strong>{advance.voucherNumber}</strong>
                        <small>
                          Available {money(advance.outstandingAmount)}
                        </small>
                      </span>
                      <input
                        type="number"
                        min="0"
                        max={Math.min(
                          advance.outstandingAmount,
                          due.outstandingBalance,
                        )}
                        step="0.01"
                        value={advanceValues[advance.id] ?? ""}
                        onChange={(event) =>
                          setAdvanceValues((current) => ({
                            ...current,
                            [advance.id]: event.target.value,
                          }))
                        }
                        placeholder="0.00"
                      />
                    </label>
                  ))}
                </div>
              )}
            </section>
          ) : null}
          {due.paymentStatus !== "ON_HOLD" && afterAdvances > 0 ? (
            <section>
              <h3>Payment now</h3>
              <div className="workforce-payment-review-form">
                <label>
                  <span>Amount (SAR)</span>
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
                      Payment cannot exceed the balance after advances.
                    </small>
                  ) : null}
                </label>
                <label>
                  <span>Payment account</span>
                  <select
                    required={cashNow > 0}
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                  >
                    <option value="">Select account</option>
                    {accounts.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Method</span>
                  <select
                    value={method}
                    onChange={(event) => setMethod(event.target.value)}
                  >
                    <option>Cash</option>
                    <option>Bank Transfer</option>
                    <option>Other</option>
                  </select>
                </label>
                <label>
                  <span>Transaction reference</span>
                  <input
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder="Optional"
                  />
                </label>
              </div>
            </section>
          ) : null}
        </div>
        <footer>
          <div className="workforce-payment-review__preview">
            <span>
              Apply advances <b>{money(advanceTotal)}</b>
            </span>
            <span>
              Pay now <b>{money(cashNow)}</b>
            </span>
            <span>
              Remaining <b>{money(remaining)}</b>
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
                Void due
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
                  ? "Remove hold"
                  : "Put on hold"}
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
                ? "Posting…"
                : cashNow > 0
                  ? "Post payment voucher"
                  : "Apply advances"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
