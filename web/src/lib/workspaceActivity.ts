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
import { formatMoney } from "./format";
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

const capitalize = (value: string) => value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const formatShortRange = (start: string, end: string) => {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return `${start} – ${end}`;
  const sameYear = startDate.getFullYear() === endDate.getFullYear();
  const shortFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const longFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  return sameYear ? `${shortFormatter.format(startDate)} – ${longFormatter.format(endDate)}` : `${longFormatter.format(startDate)} – ${longFormatter.format(endDate)}`;
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

const toDateLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (isToday(date)) {
    return `Today, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString([], sameYear
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const labourerName = (labourerById: Map<string, Labourer>, labourerId: string) => labourerById.get(labourerId)?.name ?? "Labour";

const accountName = (accountById: Map<string, Account>, accountId?: string | null) => accountId ? (accountById.get(accountId)?.name ?? "Account") : "Account";

const sameTimedBatch = (left: RawWorkspaceActivity, right: RawWorkspaceActivity) =>
  left.module === right.module
  && left.activityDate === right.activityDate
  && left.groupWindowMinutes === right.groupWindowMinutes
  && Math.abs(parseTimestamp(left.createdAt) - parseTimestamp(right.createdAt)) <= (left.groupWindowMinutes ?? 0) * 60_000;

const attendanceSummary = (group: RawWorkspaceActivity[]) => {
  const counts = new Map<string, number>();
  group.forEach((item) => {
    const key = item.value.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const pieces = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([label, count]) => `${count} ${label}`);
  return pieces.join(" • ");
};

const uniqueLabourCount = (group: RawWorkspaceActivity[]) => new Set(group.map((item) => item.children?.[0]?.title ?? item.detail)).size;

const groupAttendanceActivities = (items: RawWorkspaceActivity[]) => {
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
      title: "Attendance marked",
      detail: `${group.length} labour`,
      value: attendanceSummary(group),
      children: group.map((item) => ({
        id: item.id,
        title: item.children?.[0]?.title ?? item.detail,
        detail: item.value,
      })),
      expandable: true,
    };
  });
};

const groupLabourBatchActivities = (items: RawWorkspaceActivity[], groupedTitle: string) => {
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
      detail: `${uniqueLabourCount(group)} labour`,
      value: `-${money(Math.abs(total))}`,
      children: group.map((item) => ({
        id: item.id,
        title: item.children?.[0]?.title ?? item.detail,
        value: item.value,
      })),
      expandable: true,
    };
  });
};

export async function loadWorkspaceActivity(canonical?: LabourFinancialReadModel): Promise<WorkspaceActivityItem[]> {
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

  const attendanceActivities = groupAttendanceActivities(activeAttendance.map((item: Attendance) => ({
    id: `attendance:${item.id}`,
    module: "attendance" as const,
    moduleLabel: "Attendance",
    path: "/workspace/workforce/attendance",
    title: "Attendance marked",
    detail: `${labourerName(labourerById, item.labourerId)} · ${item.date}`,
    value: capitalize(item.status),
    createdAt: resolveActivityTimestamp(item.date, item.createdAt),
    activityDate: item.date,
    icon: UsersRound,
    tone: "green" as const,
    groupWindowMinutes: ATTENDANCE_GROUP_WINDOW_MINUTES,
    children: [{
      id: item.id,
      title: labourerName(labourerById, item.labourerId),
      detail: capitalize(item.status),
    }],
  })));

  const advanceActivities = groupLabourBatchActivities(activeAdvances.map((item: Advance) => ({
    id: `advance:${item.id}`,
    module: "labour" as const,
    moduleLabel: "Labour",
    path: "/workspace/labour-payments/advances",
    title: "Labour advance paid",
    detail: `${labourerName(labourerById, item.labourerId)}${item.paymentMethod ? ` · ${item.paymentMethod}` : ""}`,
    value: `-${money(item.amount)}`,
    createdAt: resolveActivityTimestamp(item.date, item.createdAt),
    activityDate: item.date,
    icon: HandCoins,
    tone: "purple" as const,
    groupWindowMinutes: LABOUR_BATCH_WINDOW_MINUTES,
    children: [{
      id: item.id,
      title: labourerName(labourerById, item.labourerId),
      value: `-${money(item.amount)}`,
    }],
  })), "Labour advances paid");

  const paymentActivities = groupLabourBatchActivities(activePayments.map((item: LabourPayment) => ({
    id: `labour-payment:${item.id}`,
    module: "labour" as const,
    moduleLabel: "Labour",
    path: "/workspace/labour-payments/overview",
    title: "Labour payment posted",
    detail: `${labourerName(labourerById, item.labourerId)}${item.paymentMethod ? ` · ${item.paymentMethod}` : ""}`,
    value: `-${money(item.amount)}`,
    createdAt: resolveActivityTimestamp(item.date, item.createdAt),
    activityDate: item.date,
    icon: Wallet,
    tone: "purple" as const,
    groupWindowMinutes: LABOUR_BATCH_WINDOW_MINUTES,
    children: [{
      id: item.id,
      title: labourerName(labourerById, item.labourerId),
      value: `-${money(item.amount)}`,
    }],
  })), "Labour payments posted");

  const individualActivities: WorkspaceActivityItem[] = [
    ...activeSettlements.map((item: LabourWageSettlement) => ({
      id: `settlement:${item.id}`,
      module: "labour" as const,
      moduleLabel: "Labour",
      path: "/workspace/labour-payments/settlements",
      title: "Wage settlement posted",
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
      moduleLabel: "Expenses",
      path: "/workspace/expenses",
      title: "Expense recorded",
      detail: `${getVoucherDisplayNumber(item) || item.voucherNumber} · ${getCanonicalExpenseCategory(item.category)}`,
      value: `-${money(item.amount)}`,
      createdAt: resolveActivityTimestamp(item.date, item.createdAt),
      activityDate: item.date,
      icon: ReceiptText,
      tone: "orange" as const,
    })),
    ...activeDispatches.map((item: Dispatch) => ({
      id: `dispatch:${item.id}`,
      module: "dispatch" as const,
      moduleLabel: "Dispatch",
      path: "/workspace/dispatch",
      title: item.status === "delivered" || item.status === "sold" ? "Dispatch completed" : "Dispatch created",
      detail: item.vehicleNumber ?? item.destination ?? "Dispatch",
      value: `${item.items?.reduce((sum, entry) => sum + entry.cartons, 0) ?? item.cartons ?? 0} cartons`,
      createdAt: resolveActivityTimestamp(item.date, item.createdAt),
      activityDate: item.date,
      icon: PackageOpen,
      tone: "blue" as const,
    })),
    ...activeSales.map((item: Sale) => ({
      id: `sale:${item.id}`,
      module: "sales" as const,
      moduleLabel: "Sales",
      path: "/workspace/sales",
      title: "Sale recorded",
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
      moduleLabel: "Accounts",
      path: "/workspace/partner-ledger",
      title: item.type === "settlement" ? "Partner settlement posted" : `${capitalize(item.type)} recorded`,
      detail: item.partnerName ?? accountName(accountById, item.accountId),
      value: `${item.type === "withdrawal" ? "-" : ""}${money(item.amount)}`,
      createdAt: resolveActivityTimestamp(item.date, item.createdAt),
      activityDate: item.date,
      icon: BookOpenText,
      tone: "slate" as const,
    })),
  ];

  const canonicalActivities: WorkspaceActivityItem[] = (canonical?.activity ?? []).map((item) => ({
    id: item.id,
    module: "labour",
    moduleLabel: "Labour",
    path: "/workspace/labour-payments/vouchers",
    title: item.title,
    detail: `${item.detail} · ${capitalize(item.status)}`,
    value: capitalize(item.status),
    createdAt: item.date,
    activityDate: item.date.slice(0, 10),
    icon: ClipboardList,
    tone: item.status === "VOIDED" || item.status === "REVERSED" ? "slate" : "purple",
  }));

  return [...canonicalActivities, ...attendanceActivities, ...advanceActivities, ...paymentActivities, ...individualActivities]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function formatWorkspaceActivityDateTime(value: string) {
  return toDateLabel(value);
}
