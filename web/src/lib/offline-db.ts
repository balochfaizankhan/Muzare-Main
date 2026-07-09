import Dexie, { type EntityTable } from "dexie";
import { isActiveOperationalRecord, isImportedAccountRecord, isImportedVoucherRecord } from "./operationalRecords";

export type LocalRecord = {
  id: string;
  workspaceId: string;
  farmId?: string | null;
  seasonId?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  isArchived?: boolean;
  archiveBatchId?: string | null;
  archivedAt?: string | null;
  archivedBy?: string | null;
  archiveReason?: string | null;
  isLocked?: boolean;
  lockedAt?: string | null;
  lockedBy?: string | null;
  lockReason?: string | null;
  pendingSync?: boolean;
};

export type PendingMutation = LocalRecord & {
  entity:
    | "labourer"
    | "labourGroup"
    | "attendance"
    | "account"
    | "advance"
    | "labourEarning"
    | "labourWageSettlement"
    | "wageRate"
    | "labourPayment"
    | "productionEntry"
    | "vehicle"
    | "dateType"
    | "dispatch"
    | "sale"
    | "voucher"
    | "partnerEntry"
    | "inventoryEntry";
  operation: "create" | "update" | "delete";
  payload: unknown;
  attempts: number;
  nextAttemptAt?: string;
  clientMutationId?: string;
  status?: "pending" | "syncing" | "failed" | "permission_denied" | "stale_context" | "resolved" | "discarded";
  retryable?: boolean;
  lastError?: string;
  errorStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: unknown;
  lastAttemptedAt?: string;
  resolvedAt?: string;
  workspaceId: string;
  farmId?: string | null;
  seasonId?: string | null;
};

export type Labourer = LocalRecord & {
  name: string;
  sortOrder?: number;
  androidSortOrder?: number;
  originalIndex?: number;
  oldLabourId?: string;
  oldAndroidId?: string;
  group: string;
  groupId?: string;
  dailyWage: number;
  dailyRate?: number;
  labourType?: string;
  paymentType?: "daily_wage" | "production_based" | "contract_lump_sum" | "monthly_salary" | "other";
  productionUnit?: "carton" | "crate" | "tree" | "task" | "custom";
  customProductionUnit?: string;
  productionUnitRate?: number;
  minimumGuarantee?: number;
  contractTitle?: string;
  contractAmount?: number;
  contractStartDate?: string;
  contractExpectedEndDate?: string;
  contractTerms?: string;
  monthlySalary?: number;
  paymentDay?: number;
  otherPaymentDescription?: string;
  otherPaymentRate?: number;
  active?: boolean;
  joinedOn?: string;
  endedOn?: string;
  phone?: string;
  mobile?: string;
  notes?: string;
  firstAttendanceDate?: string;
  lastAttendanceDate?: string;
  inactiveDate?: string;
  leftDate?: string;
};

export type Attendance = LocalRecord & {
  labourerId: string;
  date: string;
  status: "present" | "half_day" | "absent";
};

export type Account = LocalRecord & {
  name: string;
  type: "cash" | "bank" | "partner";
  oldAndroidId?: string;
  sourceType?: string;
};

export type Voucher = LocalRecord & {
  voucherNumber: string;
  originalVoucherNumber?: string;
  legacyVoucherNumber?: string;
  voucherNumberEdited?: boolean;
  allowVoucherNumberEdit?: boolean;
  settlementId?: string;
  settlementNumber?: string;
  voucherPurpose?: string;
  nonCashSettlement?: boolean;
  date: string;
  category: string;
  categoryId: string;
  subcategory: string;
  subcategoryId: string;
  description: string;
  amount: number;
  accountId: string;
  notes?: string;
  createdBy?: string;
  updatedBy?: string;
  items?: VoucherItem[];
};

export type VoucherItem = {
  id: string;
  category: string;
  categoryName?: string;
  categoryId: string;
  subcategory?: string;
  subcategoryName?: string;
  subcategoryId?: string;
  amount: number;
  description: string;
  remarks?: string;
  oldExpenseItemId?: string | number;
};

export type Dispatch = LocalRecord & {
  date: string;
  vehicleId?: string;
  serialNumber?: string;
  destination?: string;
  notes?: string;
  remarks?: string;
  dispatchNumber?: string;
  deliveryDate?: string;
  status?: "pending" | "dispatched" | "delivered" | "sold";
  plotName?: string;
  items?: DispatchItem[];
  vehicleNumber?: string;
  driverName?: string;
  produceType?: string;
  cartons?: number;
  unit?: string;
};

export type DispatchItem = {
  id: string;
  dateTypeId: string;
  dateTypeName?: string;
  cartons: number;
};

export type Vehicle = LocalRecord & {
  number: string;
  driverName?: string;
  driverPhone?: string;
  notes?: string;
  active: boolean;
};

export type DateType = LocalRecord & {
  name: string;
  notes?: string;
  active: boolean;
};

export type Sale = LocalRecord & {
  saleType?: "dispatch_sale" | "farm_direct_sale";
  date: string;
  buyerName?: string;
  invoiceNumber?: string;
  produceType: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  accountId?: string;
  dispatchId?: string;
  dispatchItemId?: string;
  dispatchDate?: string;
  deliveryDate?: string;
  paymentDate?: string;
  paymentStatus?: "paid" | "partial" | "unpaid";
  paymentReceived?: number;
  vehicleId?: string;
  vehicleNumber?: string;
  dateTypeId?: string;
  dateTypeName?: string;
  plotName?: string;
  remarks?: string;
  unit?: string;
};

export type PartnerEntry = LocalRecord & {
  date: string;
  partnerName?: string;
  partnerAccountId?: string;
  type: "contribution" | "withdrawal" | "settlement" | "adjustment";
  amount: number;
  notes: string;
  accountId?: string;
  adjustmentDirection?: "increase" | "decrease";
  fromPartner?: string;
  toPartner?: string;
  fromAccountId?: string;
  toAccountId?: string;
  unresolvedSettlement?: boolean;
  deletionReason?: string;
};

export type Advance = LocalRecord & {
  labourerId: string;
  date: string;
  amount: number;
  accountId?: string;
  sourceAccountName?: string;
  paymentMethod?: string;
  notes: string;
};

export type WageRate = LocalRecord & {
  labourerId: string;
  labourId?: string;
  rateType: "daily" | "half_day" | "monthly" | "custom";
  dailyRate: number;
  halfDayRate: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
  active: boolean;
  createdBy?: string;
};

export type LabourWageSettlement = LocalRecord & {
  settlementNumber: string;
  linkedVoucherId: string;
  linkedVoucherNumber: string;
  linkedAccountId: string;
  settlementMode?: "individual" | "group";
  foremanId?: string | null;
  groupId?: string | null;
  includedLabourIds?: string[];
  fromDate: string;
  toDate: string;
  settlementDate: string;
  attendanceWages: number;
  labourWorkWages?: number;
  pendingLabourEarnings: number;
  grossWages?: number;
  totalEarned: number;
  availableAdvanceBalanceBeforeSettlement?: number;
  advancesPaid: number;
  advanceAdjustedNow?: number;
  settledAdvanceAmount: number;
  remainingAdvanceCarryForward?: number;
  expenseAmount: number;
  carryForwardAdvance: number;
  manualAdjustment?: number;
  manualAdjustmentNote?: string | null;
  netPayableBeforePayment?: number;
  paidAmount?: number;
  balanceAfterPayment?: number;
  payableBalance: number;
  paymentAccountId?: string | null;
  settlementVoucherId?: string | null;
  sourceAttendanceIds?: string[];
  sourceLabourWorkIds?: string[];
  advanceAdjustmentAllocations?: Array<{
    settlementId: string;
    advanceId: string;
    adjustedAmount: number;
    workspaceId: string;
    farmId: string;
    seasonId: string;
  }>;
  notes?: string;
  status: "posted" | "voided" | "deleted";
  accountingStatus?: "draft" | "posted" | "accounting_missing" | "voided" | "deleted";
  accountingMessage?: string | null;
  createdBy?: string;
  deletedBy?: string | null;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
};

export type LabourEarning = LocalRecord & {
  labourerId: string;
  earningDate: string;
  amount: number;
  earningType: "lump_sum" | "task" | "bonus" | "incentive" | "adjustment" | "other";
  description: string;
  notes?: string;
  status: "pending_settlement" | "settled" | "voided";
  linkedSettlementId?: string | null;
  linkedVoucherId?: string | null;
  settlementDate?: string | null;
  createdBy?: string;
  updatedBy?: string;
};

export type LabourGroup = LocalRecord & {
  name: string;
  active?: boolean;
};

export type ProductionEntry = LocalRecord & {
  labourerId: string;
  date: string;
  units: number;
  productionUnit: string;
  unitRate: number;
  amount: number;
  notes?: string;
};

export type LabourPayment = LocalRecord & {
  labourerId: string;
  date: string;
  amount: number;
  paymentMethod?: string;
  notes?: string;
};

export type InventoryEntry = LocalRecord & {
  date: string;
  itemName: string;
  quantity: number;
  notes: string;
};

export const offlineDb = new Dexie("muzare-offline") as Dexie & {
  pendingMutations: EntityTable<PendingMutation, "id">;
  labourers: EntityTable<Labourer, "id">;
  attendance: EntityTable<Attendance, "id">;
  labourGroups: EntityTable<LabourGroup, "id">;
  accounts: EntityTable<Account, "id">;
  vouchers: EntityTable<Voucher, "id">;
  vehicles: EntityTable<Vehicle, "id">;
  dateTypes: EntityTable<DateType, "id">;
  dispatches: EntityTable<Dispatch, "id">;
  sales: EntityTable<Sale, "id">;
  partnerEntries: EntityTable<PartnerEntry, "id">;
  advances: EntityTable<Advance, "id">;
  labourEarnings: EntityTable<LabourEarning, "id">;
  labourWageSettlements: EntityTable<LabourWageSettlement, "id">;
  wageRates: EntityTable<WageRate, "id">;
  productionEntries: EntityTable<ProductionEntry, "id">;
  labourPayments: EntityTable<LabourPayment, "id">;
  inventoryEntries: EntityTable<InventoryEntry, "id">;
};

offlineDb.version(1).stores({
  pendingMutations: "id, entity, operation, createdAt",
});

offlineDb.version(2).stores({
  pendingMutations: "id, entity, operation, createdAt",
  labourers: "id, name, createdAt",
  attendance: "id, labourerId, date, status, createdAt",
  accounts: "id, name, type, createdAt",
  vouchers: "id, date, category, accountId, createdAt",
  dispatches: "id, date, vehicleNumber, produceType, createdAt",
  sales: "id, date, buyerName, accountId, createdAt",
  partnerEntries: "id, date, partnerName, accountId, createdAt",
});

offlineDb.version(3).stores({
  pendingMutations: "id, entity, operation, workspaceId, createdAt",
  labourers: "id, name, createdAt, updatedAt, pendingSync",
  attendance: "id, labourerId, date, status, createdAt, updatedAt, pendingSync",
  accounts: "id, name, type, createdAt, updatedAt, pendingSync",
  vouchers: "id, date, category, accountId, createdAt, updatedAt, pendingSync",
  dispatches: "id, date, vehicleNumber, produceType, createdAt, updatedAt, pendingSync",
  sales: "id, date, buyerName, accountId, createdAt, updatedAt, pendingSync",
  partnerEntries: "id, date, partnerName, accountId, createdAt, updatedAt, pendingSync",
  advances: "id, date, labourerId, createdAt, updatedAt, pendingSync",
  inventoryEntries: "id, date, itemName, createdAt, updatedAt, pendingSync",
});

offlineDb.version(4).stores({
  pendingMutations: "id, workspaceId, entity, operation, createdAt",
  labourers: "id, workspaceId, name, createdAt, updatedAt, pendingSync",
  attendance: "id, workspaceId, labourerId, date, status, createdAt, updatedAt, pendingSync",
  accounts: "id, workspaceId, name, type, createdAt, updatedAt, pendingSync",
  vouchers: "id, workspaceId, date, category, accountId, createdAt, updatedAt, pendingSync",
  dispatches: "id, workspaceId, date, vehicleNumber, produceType, createdAt, updatedAt, pendingSync",
  sales: "id, workspaceId, date, buyerName, accountId, createdAt, updatedAt, pendingSync",
  partnerEntries: "id, workspaceId, date, partnerName, accountId, createdAt, updatedAt, pendingSync",
  advances: "id, workspaceId, date, labourerId, createdAt, updatedAt, pendingSync",
  inventoryEntries: "id, workspaceId, date, itemName, createdAt, updatedAt, pendingSync",
}).upgrade(async (transaction) => {
  for (const tableName of [
    "pendingMutations", "labourers", "attendance", "accounts", "vouchers",
    "dispatches", "sales", "partnerEntries", "advances", "inventoryEntries",
  ]) {
    await transaction.table(tableName).clear();
  }
});

offlineDb.version(5).stores({
  pendingMutations: "id, workspaceId, farmId, entity, operation, createdAt",
  labourers: "id, workspaceId, farmId, name, createdAt, updatedAt, pendingSync",
  attendance: "id, workspaceId, farmId, labourerId, date, status, createdAt, updatedAt, pendingSync",
  accounts: "id, workspaceId, farmId, name, type, createdAt, updatedAt, pendingSync",
  vouchers: "id, workspaceId, farmId, date, category, accountId, createdAt, updatedAt, pendingSync",
  dispatches: "id, workspaceId, farmId, date, vehicleNumber, produceType, createdAt, updatedAt, pendingSync",
  sales: "id, workspaceId, farmId, date, buyerName, accountId, createdAt, updatedAt, pendingSync",
  partnerEntries: "id, workspaceId, farmId, date, partnerName, accountId, createdAt, updatedAt, pendingSync",
  advances: "id, workspaceId, farmId, date, labourerId, createdAt, updatedAt, pendingSync",
  inventoryEntries: "id, workspaceId, farmId, date, itemName, createdAt, updatedAt, pendingSync",
}).upgrade(async (transaction) => {
  for (const tableName of [
    "pendingMutations", "labourers", "attendance", "accounts", "vouchers",
    "dispatches", "sales", "partnerEntries", "advances", "inventoryEntries",
  ]) {
    await transaction.table(tableName).clear();
  }
});

offlineDb.version(6).stores({
  pendingMutations: "id, workspaceId, farmId, seasonId, entity, operation, createdAt",
  labourers: "id, workspaceId, farmId, seasonId, name, createdAt, updatedAt, pendingSync",
  attendance: "id, workspaceId, farmId, seasonId, labourerId, date, status, createdAt, updatedAt, pendingSync",
  accounts: "id, workspaceId, farmId, seasonId, name, type, createdAt, updatedAt, pendingSync",
  vouchers: "id, workspaceId, farmId, seasonId, date, category, accountId, createdAt, updatedAt, pendingSync",
  dispatches: "id, workspaceId, farmId, seasonId, date, vehicleNumber, produceType, createdAt, updatedAt, pendingSync",
  sales: "id, workspaceId, farmId, seasonId, date, buyerName, accountId, createdAt, updatedAt, pendingSync",
  partnerEntries: "id, workspaceId, farmId, seasonId, date, partnerName, accountId, createdAt, updatedAt, pendingSync",
  advances: "id, workspaceId, farmId, seasonId, date, labourerId, createdAt, updatedAt, pendingSync",
  inventoryEntries: "id, workspaceId, farmId, seasonId, date, itemName, createdAt, updatedAt, pendingSync",
}).upgrade(async (transaction) => {
  for (const tableName of [
    "pendingMutations", "labourers", "attendance", "accounts", "vouchers",
    "dispatches", "sales", "partnerEntries", "advances", "inventoryEntries",
  ]) {
    await transaction.table(tableName).clear();
  }
});

offlineDb.version(7).stores({
  pendingMutations: "id, workspaceId, farmId, seasonId, entity, operation, createdAt",
  labourers: "id, workspaceId, farmId, seasonId, name, groupId, createdAt, updatedAt, pendingSync",
  labourGroups: "id, workspaceId, farmId, seasonId, name, active, createdAt, updatedAt, pendingSync",
  attendance: "id, workspaceId, farmId, seasonId, labourerId, date, status, createdAt, updatedAt, pendingSync",
  accounts: "id, workspaceId, farmId, seasonId, name, type, createdAt, updatedAt, pendingSync",
  vouchers: "id, workspaceId, farmId, seasonId, date, category, accountId, createdAt, updatedAt, pendingSync",
  dispatches: "id, workspaceId, farmId, seasonId, date, vehicleNumber, produceType, createdAt, updatedAt, pendingSync",
  sales: "id, workspaceId, farmId, seasonId, date, buyerName, accountId, createdAt, updatedAt, pendingSync",
  partnerEntries: "id, workspaceId, farmId, seasonId, date, partnerName, accountId, createdAt, updatedAt, pendingSync",
  advances: "id, workspaceId, farmId, seasonId, date, labourerId, createdAt, updatedAt, pendingSync",
  productionEntries: "id, workspaceId, farmId, seasonId, labourerId, date, productionUnit, createdAt, updatedAt, pendingSync",
  labourPayments: "id, workspaceId, farmId, seasonId, labourerId, date, createdAt, updatedAt, pendingSync",
  inventoryEntries: "id, workspaceId, farmId, seasonId, date, itemName, createdAt, updatedAt, pendingSync",
}).upgrade(async (transaction) => {
  for (const tableName of [
    "pendingMutations", "labourers", "labourGroups", "attendance", "accounts", "vouchers",
    "dispatches", "sales", "partnerEntries", "advances", "productionEntries", "labourPayments", "inventoryEntries",
  ]) {
    await transaction.table(tableName).clear();
  }
});

offlineDb.version(8).stores({
  pendingMutations: "id, workspaceId, farmId, seasonId, entity, operation, createdAt",
  labourers: "id, workspaceId, farmId, seasonId, name, groupId, createdAt, updatedAt, pendingSync",
  labourGroups: "id, workspaceId, farmId, seasonId, name, active, createdAt, updatedAt, pendingSync",
  attendance: "id, workspaceId, farmId, seasonId, labourerId, date, status, createdAt, updatedAt, pendingSync",
  accounts: "id, workspaceId, farmId, seasonId, name, type, createdAt, updatedAt, pendingSync",
  vouchers: "id, workspaceId, farmId, seasonId, date, category, accountId, createdAt, updatedAt, pendingSync",
  vehicles: "id, workspaceId, farmId, seasonId, number, active, createdAt, updatedAt, pendingSync",
  dateTypes: "id, workspaceId, farmId, seasonId, name, active, createdAt, updatedAt, pendingSync",
  dispatches: "id, workspaceId, farmId, seasonId, date, vehicleId, createdAt, updatedAt, pendingSync",
  sales: "id, workspaceId, farmId, seasonId, date, buyerName, accountId, createdAt, updatedAt, pendingSync",
  partnerEntries: "id, workspaceId, farmId, seasonId, date, partnerName, accountId, createdAt, updatedAt, pendingSync",
  advances: "id, workspaceId, farmId, seasonId, date, labourerId, createdAt, updatedAt, pendingSync",
  productionEntries: "id, workspaceId, farmId, seasonId, labourerId, date, productionUnit, createdAt, updatedAt, pendingSync",
  labourPayments: "id, workspaceId, farmId, seasonId, labourerId, date, createdAt, updatedAt, pendingSync",
  inventoryEntries: "id, workspaceId, farmId, seasonId, date, itemName, createdAt, updatedAt, pendingSync",
});

offlineDb.version(9).stores({
  pendingMutations: "id, workspaceId, farmId, seasonId, entity, operation, createdAt",
  labourers: "id, workspaceId, farmId, seasonId, name, groupId, createdAt, updatedAt, pendingSync",
  labourGroups: "id, workspaceId, farmId, seasonId, name, active, createdAt, updatedAt, pendingSync",
  attendance: "id, workspaceId, farmId, seasonId, labourerId, date, status, createdAt, updatedAt, pendingSync",
  accounts: "id, workspaceId, farmId, seasonId, name, type, createdAt, updatedAt, pendingSync",
  vouchers: "id, workspaceId, farmId, seasonId, date, category, accountId, createdAt, updatedAt, pendingSync",
  vehicles: "id, workspaceId, farmId, seasonId, number, active, createdAt, updatedAt, pendingSync",
  dateTypes: "id, workspaceId, farmId, seasonId, name, active, createdAt, updatedAt, pendingSync",
  dispatches: "id, workspaceId, farmId, seasonId, date, vehicleId, createdAt, updatedAt, pendingSync",
  sales: "id, workspaceId, farmId, seasonId, date, buyerName, accountId, createdAt, updatedAt, pendingSync",
  partnerEntries: "id, workspaceId, farmId, seasonId, date, partnerName, accountId, createdAt, updatedAt, pendingSync",
  advances: "id, workspaceId, farmId, seasonId, date, labourerId, createdAt, updatedAt, pendingSync",
  labourWageSettlements: "id, workspaceId, farmId, seasonId, settlementDate, fromDate, toDate, settlementNumber, status, createdAt, updatedAt, pendingSync",
  wageRates: "id, workspaceId, farmId, seasonId, labourerId, effectiveFrom, effectiveTo, active, createdAt, updatedAt, pendingSync",
  productionEntries: "id, workspaceId, farmId, seasonId, labourerId, date, productionUnit, createdAt, updatedAt, pendingSync",
  labourPayments: "id, workspaceId, farmId, seasonId, labourerId, date, createdAt, updatedAt, pendingSync",
  inventoryEntries: "id, workspaceId, farmId, seasonId, date, itemName, createdAt, updatedAt, pendingSync",
});

offlineDb.version(10).stores({
  pendingMutations: "id, workspaceId, farmId, seasonId, entity, operation, createdAt",
  labourers: "id, workspaceId, farmId, seasonId, name, groupId, createdAt, updatedAt, pendingSync",
  labourGroups: "id, workspaceId, farmId, seasonId, name, active, createdAt, updatedAt, pendingSync",
  attendance: "id, workspaceId, farmId, seasonId, labourerId, date, status, createdAt, updatedAt, pendingSync",
  accounts: "id, workspaceId, farmId, seasonId, name, type, createdAt, updatedAt, pendingSync",
  vouchers: "id, workspaceId, farmId, seasonId, date, category, accountId, createdAt, updatedAt, pendingSync",
  vehicles: "id, workspaceId, farmId, seasonId, number, active, createdAt, updatedAt, pendingSync",
  dateTypes: "id, workspaceId, farmId, seasonId, name, active, createdAt, updatedAt, pendingSync",
  dispatches: "id, workspaceId, farmId, seasonId, date, vehicleId, createdAt, updatedAt, pendingSync",
  sales: "id, workspaceId, farmId, seasonId, date, buyerName, accountId, createdAt, updatedAt, pendingSync",
  partnerEntries: "id, workspaceId, farmId, seasonId, date, partnerName, accountId, createdAt, updatedAt, pendingSync",
  advances: "id, workspaceId, farmId, seasonId, date, labourerId, createdAt, updatedAt, pendingSync",
  labourEarnings: "id, workspaceId, farmId, seasonId, labourerId, earningDate, earningType, status, createdAt, updatedAt, pendingSync",
  labourWageSettlements: "id, workspaceId, farmId, seasonId, settlementDate, fromDate, toDate, settlementNumber, status, createdAt, updatedAt, pendingSync",
  wageRates: "id, workspaceId, farmId, seasonId, labourerId, effectiveFrom, effectiveTo, active, createdAt, updatedAt, pendingSync",
  productionEntries: "id, workspaceId, farmId, seasonId, labourerId, date, productionUnit, createdAt, updatedAt, pendingSync",
  labourPayments: "id, workspaceId, farmId, seasonId, labourerId, date, createdAt, updatedAt, pendingSync",
  inventoryEntries: "id, workspaceId, farmId, seasonId, date, itemName, createdAt, updatedAt, pendingSync",
});

offlineDb.version(11).stores({
  pendingMutations: "id, workspaceId, farmId, seasonId, entity, operation, createdAt",
  labourers: "id, workspaceId, farmId, seasonId, name, groupId, createdAt, updatedAt, pendingSync",
  labourGroups: "id, workspaceId, farmId, seasonId, name, active, createdAt, updatedAt, pendingSync",
  attendance: "id, workspaceId, farmId, seasonId, labourerId, date, status, createdAt, updatedAt, pendingSync",
  accounts: "id, workspaceId, farmId, seasonId, name, type, createdAt, updatedAt, pendingSync",
  vouchers: "id, workspaceId, farmId, seasonId, date, category, accountId, createdAt, updatedAt, pendingSync",
  vehicles: "id, workspaceId, farmId, seasonId, number, active, createdAt, updatedAt, pendingSync",
  dateTypes: "id, workspaceId, farmId, seasonId, name, active, createdAt, updatedAt, pendingSync",
  dispatches: "id, workspaceId, farmId, seasonId, date, vehicleId, createdAt, updatedAt, pendingSync",
  sales: "id, workspaceId, farmId, seasonId, date, buyerName, accountId, createdAt, updatedAt, pendingSync",
  partnerEntries: "id, workspaceId, farmId, seasonId, date, partnerName, accountId, createdAt, updatedAt, pendingSync",
  advances: "id, workspaceId, farmId, seasonId, date, labourerId, createdAt, updatedAt, pendingSync",
  labourEarnings: "id, workspaceId, farmId, seasonId, labourerId, earningDate, earningType, status, createdAt, updatedAt, pendingSync",
  labourWageSettlements: "id, workspaceId, farmId, seasonId, settlementDate, fromDate, toDate, settlementNumber, status, createdAt, updatedAt, pendingSync",
  wageRates: "id, workspaceId, farmId, seasonId, labourerId, effectiveFrom, effectiveTo, active, createdAt, updatedAt, pendingSync",
  productionEntries: "id, workspaceId, farmId, seasonId, labourerId, date, productionUnit, createdAt, updatedAt, pendingSync",
  labourPayments: "id, workspaceId, farmId, seasonId, labourerId, date, createdAt, updatedAt, pendingSync",
  inventoryEntries: "id, workspaceId, farmId, seasonId, date, itemName, createdAt, updatedAt, pendingSync",
});

let activeWorkspaceId: string | null = null;
let activeFarmId: string | null = null;
let activeSeasonId: string | null = null;

export function setActiveWorkspaceId(workspaceId: string | null) {
  activeWorkspaceId = workspaceId;
}

export function getActiveWorkspaceId() {
  if (!activeWorkspaceId) throw new Error("Select a workspace before accessing cached data.");
  return activeWorkspaceId;
}

export function setActiveFarmId(farmId: string | null) {
  activeFarmId = farmId;
}

export function getActiveFarmId() {
  return activeFarmId;
}

export function setActiveSeasonId(seasonId: string | null) {
  activeSeasonId = seasonId;
}

export function getActiveSeasonId() {
  return activeSeasonId;
}

export async function workspaceRecords<T extends LocalRecord>(table: EntityTable<T, "id">, options: { includeDeleted?: boolean; includeGeneralFarmRecords?: boolean; includeImportedAcrossSeasons?: boolean } = {}) {
  if (!activeFarmId || !activeSeasonId) return [];
  return table.where("workspaceId").equals(getActiveWorkspaceId())
    .filter((record) => record.farmId === activeFarmId
      && (
        record.seasonId === activeSeasonId
        || (Boolean(options.includeGeneralFarmRecords) && record.seasonId === null)
        || (Boolean(options.includeImportedAcrossSeasons) && (
          isImportedVoucherRecord(record as LocalRecord & Record<string, unknown>)
          || isImportedAccountRecord(record as LocalRecord & Record<string, unknown>)
        ))
      )
      && (Boolean(options.includeDeleted) || isActiveOperationalRecord(record as LocalRecord & Record<string, unknown>))).toArray();
}

export async function workspaceConfigRecords<T extends LocalRecord>(table: EntityTable<T, "id">, options: { includeDeleted?: boolean } = {}) {
  if (!activeFarmId) return [];
  return table.where("workspaceId").equals(getActiveWorkspaceId())
    .filter((record) => record.farmId === activeFarmId
      && (Boolean(options.includeDeleted) || isActiveOperationalRecord(record as LocalRecord & Record<string, unknown>))).toArray();
}

export function labourSortValue(labourer: Pick<Labourer, "sortOrder" | "androidSortOrder" | "originalIndex" | "createdAt">) {
  if (typeof labourer.sortOrder === "number" && Number.isFinite(labourer.sortOrder)) return labourer.sortOrder;
  if (typeof labourer.androidSortOrder === "number" && Number.isFinite(labourer.androidSortOrder)) return labourer.androidSortOrder;
  if (typeof labourer.originalIndex === "number" && Number.isFinite(labourer.originalIndex)) return labourer.originalIndex;
  const created = Date.parse(labourer.createdAt);
  return Number.isFinite(created) ? created : Number.MAX_SAFE_INTEGER;
}

export function compareLabourers(
  left: Pick<Labourer, "id" | "name" | "sortOrder" | "androidSortOrder" | "originalIndex" | "createdAt" | "active" | "endedOn" | "isArchived">,
  right: Pick<Labourer, "id" | "name" | "sortOrder" | "androidSortOrder" | "originalIndex" | "createdAt" | "active" | "endedOn" | "isArchived">,
) {
  const statusRank = (worker: Pick<Labourer, "active" | "endedOn" | "isArchived">) => {
    if (worker.active === false || Boolean(worker.endedOn) || worker.isArchived) return 1;
    return 0;
  };
  const statusDelta = statusRank(left) - statusRank(right);
  if (statusDelta !== 0) return statusDelta;
  const leftSort = typeof left.sortOrder === "number" ? left.sortOrder
    : typeof left.androidSortOrder === "number" ? left.androidSortOrder
      : typeof left.originalIndex === "number" ? left.originalIndex
        : Date.parse(left.createdAt);
  const rightSort = typeof right.sortOrder === "number" ? right.sortOrder
    : typeof right.androidSortOrder === "number" ? right.androidSortOrder
      : typeof right.originalIndex === "number" ? right.originalIndex
        : Date.parse(right.createdAt);
  const sortDelta = leftSort - rightSort;
  if (sortDelta !== 0) return sortDelta;
  const createdDelta = left.createdAt.localeCompare(right.createdAt);
  if (createdDelta !== 0) return createdDelta;
  return left.id.localeCompare(right.id);
}

export async function clearCachedData() {
  await Promise.all(offlineDb.tables.map((table) => table.clear()));
}

export function makeLocalRecord(id?: string) {
  const now = new Date().toISOString();
  if (!activeFarmId || !activeSeasonId) throw new Error("Select an active farm and season before entering records.");
  return { id: id ?? crypto.randomUUID(), workspaceId: getActiveWorkspaceId(), farmId: activeFarmId, seasonId: activeSeasonId, createdAt: now, updatedAt: now, pendingSync: false };
}

export function makeConfigRecord(id?: string) {
  const now = new Date().toISOString();
  if (!activeFarmId) throw new Error("Select an active farm before entering records.");
  return { id: id ?? crypto.randomUUID(), workspaceId: getActiveWorkspaceId(), farmId: activeFarmId, seasonId: null, createdAt: now, updatedAt: now, pendingSync: false };
}

export async function ensureLocalAccounts() {
  const workspaceId = getActiveWorkspaceId();
  if (!activeFarmId || !activeSeasonId) return;
  if ((await offlineDb.accounts.where("workspaceId").equals(workspaceId).filter((record) => record.farmId === activeFarmId && record.seasonId === activeSeasonId).count()) > 0) return;
  const createdAt = new Date().toISOString();
  await offlineDb.accounts.bulkPut([
    { id: `${activeSeasonId}:local-cash`, workspaceId, farmId: activeFarmId, seasonId: activeSeasonId, name: "Cash", type: "cash", createdAt, updatedAt: createdAt, pendingSync: false },
    { id: `${activeSeasonId}:local-partner`, workspaceId, farmId: activeFarmId, seasonId: activeSeasonId, name: "Partner Capital", type: "partner", createdAt, updatedAt: createdAt, pendingSync: false },
  ]);
}
