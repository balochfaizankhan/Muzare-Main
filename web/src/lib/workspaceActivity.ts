import type { TFunction } from "i18next";
import {
  BookOpenText,
  ClipboardList,
  HandCoins,
  PackageOpen,
  ReceiptText,
  ShoppingBasket,
  UsersRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { getCanonicalExpenseCategory } from "./expenseCategories";
import { formatDate, formatMoney } from "./format";
import { getActiveLabourWageSettlements, getGeneralExpenseVouchers } from "./labourWageSettlements";
import { offlineDb, workspaceRecords } from "./offline-db";
import type {
  Account,
  Advance,
  Attendance,
  Dispatch,
  LabourPayment,
  LabourWageSettlement,
  Labourer,
  PartnerEntry,
  Sale,
  Voucher,
} from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";
import { translateLabourEventType, translateStatus } from "./statusLabels";
import { loadWorkspaceVouchers } from "./voucherCollections";
import { getVoucherDisplayNumber } from "./vouchers";
import type { LabourFinancialReadModel } from "./api";

export type WorkspaceActivityModule = "attendance" | "labour" | "expenses" | "dispatch" | "sales" | "accounts";

export type WorkspaceActivityChild = {
  id: string;
  title: string;
  detail?: string;
  value?: string;
};

export type WorkspaceActivityItem = {
  id: string;
  module: WorkspaceActivityModule;
  moduleLabel: string;
  path: string | null;
  title: string;
  detail: string;
  value: string;
  createdAt: string;
  activityDate: string;
  icon: LucideIcon;
  tone: "green" | "orange" | "blue" | "purple" | "slate";
  children?: WorkspaceActivityChild[];
  expandable?: boolean;
};

type RawWorkspaceActivity = Omit<WorkspaceActivityItem, "children" | "expandable"> & {
  children?: WorkspaceActivityChild[];
  groupWindowMinutes?: number;
};

const money = formatMoney;
const ATTENDANCE_GROUP_WINDOW_MINUTES = 20;
const LABOUR_BATCH_WINDOW_MINUTES = 5;

const formatShortRange = (start: string, end: string) => {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return `${start} – ${end}`;
  const sameYear = startDate.getFullYear() === endDate.getFullYear();
  return sameYear
    ? `${formatDate(startDate, { month: "short", day: "numeric" })} – ${formatDate(endDate, { month: "short", day: "numeric", year: "numeric" })}`
    : `${formatDate(startDate, { month: "short", day: "numeric", year: "numeric" })} – ${formatDate(endDate, { month: "short", day: "numeric", year: "numeric" })}`;
};

const resolveActivityTimestamp = (activityDate: string, createdAt: string) => {
  if (createdAt.includes("T")) return createdAt;
  return `${activityDate}T00:00:00`;
};

const parseTimestamp = (value: string) => {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

const isToday = (value: Date) => {
  const now = new Date();
  return value.getFullYear() === now.getFullYear() && value.getMonth() === now.getMonth() && value.getDate() === now.getDate();
};

const toDateLabel = (t: TFunction, value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (isToday(date)) {
    return t("dashboard.todayAt", { time: formatDate(date, { hour: "numeric", minute: "2-digit" }) });
  }
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return formatDate(date, sameYear
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const labourerName = (t: TFunction, labourerById: Map<string, Labourer>, labourerId: string) => labourerById.get(labourerId)?.name ?? t("workforcePage.labourFallback");

const accountName = (t: TFunction, accountById: Map<string, Account>, accountId?: string | null) => accountId ? (accountById.get(accountId)?.name ?? t("dashboardModule.account")) : t("dashboardModule.account");

const sameTimedBatch = (left: RawWorkspaceActivity, right: RawWorkspaceActivity) =>
  left.module === right.module
  && left.activityDate === right.activityDate
  && left.groupWindowMinutes === right.groupWindowMinutes
  && Math.abs(parseTimestamp(left.createdAt) - parseTimestamp(right.createdAt)) <= (left.groupWindowMinutes ?? 0) * 60_000;

const attendanceSummary = (t: TFunction, group: RawWorkspaceActivity[]) => {
  const counts = new Map<string, number>();
  group.forEach((item) => {
    const key = item.value.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const pieces = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([status, count]) => t("dashboard.statusCount", { count, status: translateStatus(t, status) }));
  return pieces.join(" • ");
};

const uniqueLabourCount = (group: RawWorkspaceActivity[]) => new Set(group.map((item) => item.children?.[0]?.title ?? item.detail)).size;

const groupAttendanceActivities = (t: TFunction, items: RawWorkspaceActivity[]) => {
  const ascending = items.slice().sort((left, right) => parseTimestamp(left.createdAt) - parseTimestamp(right.createdAt));
  const groups: RawWorkspaceActivity[][] = [];
  ascending.forEach((item) => {
    const current = groups.at(-1);
    if (current?.length && sameTimedBatch(current[current.length - 1], item)) {
      current.push(item);
      return;
    }
    groups.push([item]);
  });
  return groups.map((group) => {
    if (group.length === 1) return group[0];
    const latest = group[group.length - 1];
    return {
      ...latest,
      id: `attendance-group:${group[0].id}:${group.length}`,
      title: t("dashboard.attendanceMarkedTitle"),
      detail: t("dashboard.labourCount", { count: group.length }),
      value: attendanceSummary(t, group),
      children: group.map((item) => ({
        id: item.id,
        title: item.children?.[0]?.title ?? item.detail,
        detail: item.value,
      })),
      expandable: true,
    };
  });
};

const groupLabourBatchActivities = (items: RawWorkspaceActivity[], groupedTitle: string, t: TFunction) => {
  const ascending = items.slice().sort((left, right) => parseTimestamp(left.createdAt) - parseTimestamp(right.createdAt));
  const groups: RawWorkspaceActivity[][] = [];
  ascending.forEach((item) => {
    const current = groups.at(-1);
    if (current?.length && sameTimedBatch(current[current.length - 1], item)) {
      current.push(item);
      return;
    }
    groups.push([item]);
  });
  return groups.map((group) => {
    if (group.length === 1) return group[0];
    const latest = group[group.length - 1];
    const total = group.reduce((sum, item) => sum + Number(item.value.replace(/[^\d.-]/g, "")), 0);
    return {
      ...latest,
      id: `${latest.module}-group:${group[0].id}:${group.length}`,
      title: groupedTitle,
      detail: t("dashboard.labourCount", { count: uniqueLabourCount(group) }),
      value: money(-Math.abs(total)),
      children: group.map((item) => ({
        id: item.id,
        title: item.children?.[0]?.title ?? item.detail,
        value: item.value,
      })),
      expandable: true,
    };
  });
};

export async function loadWorkspaceActivity(t: TFunction, canonical?: LabourFinancialReadModel): Promise<WorkspaceActivityItem[]> {
  const [labourers, attendance, dispatches, sales, advances, payments, settlements, partnerEntries, accounts, vouchers] = await Promise.all([
    workspaceRecords(offlineDb.labourers),
    workspaceRecords(offlineDb.attendance),
    workspaceRecords(offlineDb.dispatches),
    workspaceRecords(offlineDb.sales),
    workspaceRecords(offlineDb.advances),
    workspaceRecords(offlineDb.labourPayments),
    workspaceRecords(offlineDb.labourWageSettlements),
    workspaceRecords(offlineDb.partnerEntries),
    workspaceRecords(offlineDb.accounts, { includeImportedAcrossSeasons: true }),
    loadWorkspaceVouchers({ includeGeneralFarmRecords: true, includeImportedAcrossSeasons: true }),
  ]);

  const activeAttendance = attendance.filter(isActiveOperationalRecord);
  const activeDispatches = dispatches.filter(isActiveOperationalRecord);
  const activeSales = sales.filter(isActiveOperationalRecord);
  const replaced = new Set(canonical?.replacedLegacySourceIds ?? []);
  const activeAdvances = advances.filter((item) => isActiveOperationalRecord(item) && !replaced.has(item.id));
  const activePayments = payments.filter((item) => isActiveOperationalRecord(item) && !replaced.has(item.id));
  const activeSettlements = getActiveLabourWageSettlements(settlements);
  const activePartnerEntries = partnerEntries.filter(isActiveOperationalRecord);
  const activeAccounts = accounts.filter(isActiveOperationalRecord);
  const generalExpenseVouchers = getGeneralExpenseVouchers(vouchers, settlements);
  const labourerById = new Map(labourers.filter(isActiveOperationalRecord).map((item) => [item.id, item]));
  const accountById = new Map(activeAccounts.map((item) => [item.id, item]));

  const attendanceActivities = groupAttendanceActivities(t, activeAttendance.map((item: Attendance) => ({
    id: `attendance:${item.id}`,
    module: "attendance" as const,
    moduleLabel: t("dashboardModule.attendance"),
    path: "/workspace/workforce/attendance",
    title: t("dashboard.attendanceMarkedTitle"),
    detail: `${labourerName(t, labourerById, item.labourerId)} · ${formatDate(item.date)}`,
    value: translateStatus(t, item.status),
    createdAt: resolveActivityTimestamp(item.date, item.createdAt),
    activityDate: item.date,
    icon: UsersRound,
    tone: "green" as const,
    groupWindowMinutes: ATTENDANCE_GROUP_WINDOW_MINUTES,
    children: [{
      id: item.id,
      title: labourerName(t, labourerById, item.labourerId),
      detail: translateStatus(t, item.status),
    }],
  })));

  const advanceActivities = groupLabourBatchActivities(activeAdvances.map((item: Advance) => ({
    id: `advance:${item.id}`,
    module: "labour" as const,
    moduleLabel: t("dashboardModule.labour"),
    path: "/workspace/labour-payments/advances",
    title: t("dashboard.labourAdvancePaid"),
    detail: `${labourerName(t, labourerById, item.labourerId)}${item.paymentMethod ? ` · ${translateStatus(t, item.paymentMethod)}` : ""}`,
    value: money(-item.amount),
    createdAt: resolveActivityTimestamp(item.date, item.createdAt),
    activityDate: item.date,
    icon: HandCoins,
    tone: "purple" as const,
    groupWindowMinutes: LABOUR_BATCH_WINDOW_MINUTES,
    children: [{
      id: item.id,
      title: labourerName(t, labourerById, item.labourerId),
      value: money(-item.amount),
    }],
  })), t("dashboard.labourAdvancesPaidGroup"), t);

  const paymentActivities = groupLabourBatchActivities(activePayments.map((item: LabourPayment) => ({
    id: `labour-payment:${item.id}`,
    module: "labour" as const,
    moduleLabel: t("dashboardModule.labour"),
    path: "/workspace/labour-payments/overview",
    title: t("dashboard.labourPaymentPosted"),
    detail: `${labourerName(t, labourerById, item.labourerId)}${item.paymentMethod ? ` · ${translateStatus(t, item.paymentMethod)}` : ""}`,
    value: money(-item.amount),
    createdAt: resolveActivityTimestamp(item.date, item.createdAt),
    activityDate: item.date,
    icon: Wallet,
    tone: "purple" as const,
    groupWindowMinutes: LABOUR_BATCH_WINDOW_MINUTES,
    children: [{
      id: item.id,
      title: labourerName(t, labourerById, item.labourerId),
      value: money(-item.amount),
    }],
  })), t("dashboard.labourPaymentsPostedGroup"), t);

  const individualActivities: WorkspaceActivityItem[] = [
    ...activeSettlements.map((item: LabourWageSettlement) => ({
      id: `settlement:${item.id}`,
      module: "labour" as const,
      moduleLabel: t("dashboardModule.labour"),
      path: "/workspace/labour-payments/settlements",
      title: t("dashboard.wageSettlementPosted"),
      detail: formatShortRange(item.fromDate, item.toDate),
      value: money(item.expenseAmount),
      createdAt: resolveActivityTimestamp(item.settlementDate, item.createdAt),
      activityDate: item.settlementDate,
      icon: ClipboardList,
      tone: "blue" as const,
    })),
    ...generalExpenseVouchers.map((item: Voucher) => ({
      id: `expense:${item.id}`,
      module: "expenses" as const,
      moduleLabel: t("dashboardModule.expenses"),
      path: "/workspace/expenses",
      title: t("dashboard.expenseRecorded"),
      detail: `${getVoucherDisplayNumber(item) || item.voucherNumber} · ${getCanonicalExpenseCategory(item.category)}`,
      value: money(-item.amount),
      createdAt: resolveActivityTimestamp(item.date, item.createdAt),
      activityDate: item.date,
      icon: ReceiptText,
      tone: "orange" as const,
    })),
    ...activeDispatches.map((item: Dispatch) => ({
      id: `dispatch:${item.id}`,
      module: "dispatch" as const,
      moduleLabel: t("dashboardModule.dispatch"),
      path: "/workspace/dispatch",
      title: item.status === "delivered" || item.status === "sold" ? t("dashboard.dispatchCompleted") : t("dashboard.dispatchCreated"),
      detail: item.vehicleNumber ?? item.destination ?? t("dashboardModule.dispatch"),
      value: t("dashboard.cartonsCount", { count: item.items?.reduce((sum, entry) => sum + entry.cartons, 0) ?? item.cartons ?? 0 }),
      createdAt: resolveActivityTimestamp(item.date, item.createdAt),
      activityDate: item.date,
      icon: PackageOpen,
      tone: "blue" as const,
    })),
    ...activeSales.map((item: Sale) => ({
      id: `sale:${item.id}`,
      module: "sales" as const,
      moduleLabel: t("dashboardModule.sales"),
      path: "/workspace/sales",
      title: t("dashboard.saleRecorded"),
      detail: item.buyerName ?? item.produceType,
      value: money(item.amount),
      createdAt: resolveActivityTimestamp(item.date, item.createdAt),
      activityDate: item.date,
      icon: ShoppingBasket,
      tone: "green" as const,
    })),
    ...activePartnerEntries.map((item: PartnerEntry) => ({
      id: `partner-entry:${item.id}`,
      module: "accounts" as const,
      moduleLabel: t("dashboardModule.accounts"),
      path: "/workspace/partner-ledger",
      title: item.type === "settlement" ? t("dashboard.partnerSettlement") : item.type === "withdrawal" ? t("dashboard.partnerWithdrawal") : t("dashboard.partnerContribution"),
      detail: item.partnerName ?? accountName(t, accountById, item.accountId),
      value: item.type === "withdrawal" ? money(-item.amount) : money(item.amount),
      createdAt: resolveActivityTimestamp(item.date, item.createdAt),
      activityDate: item.date,
      icon: BookOpenText,
      tone: "slate" as const,
    })),
  ];

  // Canonical labour activity arrives as structured fields (eventType/status/reference
  // numbers) — never as prebuilt backend sentences — so the whole row re-renders in the
  // active language. The stored due/voucher description is user-editable free text and is
  // deliberately NOT shown here; record pages display it verbatim where it belongs.
  const canonicalActivities: WorkspaceActivityItem[] = (canonical?.activity ?? []).map((item) => {
    const reference = item.dueNumber ?? item.voucherNumber ?? null;
    const detailParts = [reference, item.recipientName].filter((part): part is string => Boolean(part && part.trim()));
    return {
      id: item.id,
      module: "labour" as const,
      moduleLabel: t("dashboardModule.labour"),
      path: "/workspace/labour-payments/vouchers",
      title: translateLabourEventType(t, item.eventType, item.originalEventType),
      detail: detailParts.join(" · ") || translateStatus(t, item.status),
      value: translateStatus(t, item.status),
      createdAt: item.date,
      activityDate: (item.eventDate ?? item.date).slice(0, 10),
      icon: ClipboardList,
      tone: (item.status === "VOIDED" || item.status === "REVERSED" ? "slate" : "purple") as "slate" | "purple",
    };
  });

  return [...canonicalActivities, ...attendanceActivities, ...advanceActivities, ...paymentActivities, ...individualActivities]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function formatWorkspaceActivityDateTime(t: TFunction, value: string) {
  return toDateLabel(t, value);
}
