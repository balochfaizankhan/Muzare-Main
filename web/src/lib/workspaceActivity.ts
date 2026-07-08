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
import { getActiveLabourWageSettlements } from "./labourWageSettlements";
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
import { getVisibleVouchers, loadWorkspaceVouchers } from "./voucherCollections";
import { getVoucherDisplayNumber } from "./vouchers";

export type WorkspaceActivityModule = "attendance" | "labour" | "expenses" | "dispatch" | "sales" | "accounts";

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
};

const money = formatMoney;

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

const getActiveLabourWageSettlementsForActivity = (settlements: LabourWageSettlement[]) =>
  getActiveLabourWageSettlements(settlements);

const getGeneralExpenseVouchers = (vouchers: Voucher[]) => getVisibleVouchers(vouchers, { visibility: "general-expenses" });

export async function loadWorkspaceActivity(): Promise<WorkspaceActivityItem[]> {
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
  const activeAdvances = advances.filter(isActiveOperationalRecord);
  const activePayments = payments.filter(isActiveOperationalRecord);
  const activeSettlements = getActiveLabourWageSettlementsForActivity(settlements);
  const activePartnerEntries = partnerEntries.filter(isActiveOperationalRecord);
  const activeAccounts = accounts.filter(isActiveOperationalRecord);
  const generalExpenseVouchers = getGeneralExpenseVouchers(vouchers);
  const labourerById = new Map(labourers.filter(isActiveOperationalRecord).map((item) => [item.id, item]));
  const accountById = new Map(activeAccounts.map((item) => [item.id, item]));

  const activities: WorkspaceActivityItem[] = [
    ...activeAttendance.map((item: Attendance) => ({
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
    })),
    ...activeAdvances.map((item: Advance) => ({
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
    })),
    ...activePayments.map((item: LabourPayment) => ({
      id: `labour-payment:${item.id}`,
      module: "labour" as const,
      moduleLabel: "Labour",
      path: "/workspace/labour-payments/direct-payments",
      title: "Direct labour payment",
      detail: `${labourerName(labourerById, item.labourerId)}${item.paymentMethod ? ` · ${item.paymentMethod}` : ""}`,
      value: `-${money(item.amount)}`,
      createdAt: resolveActivityTimestamp(item.date, item.createdAt),
      activityDate: item.date,
      icon: Wallet,
      tone: "purple" as const,
    })),
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

  return activities.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function formatWorkspaceActivityDateTime(value: string) {
  return toDateLabel(value);
}
