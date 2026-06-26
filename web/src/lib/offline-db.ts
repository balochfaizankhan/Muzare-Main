import Dexie, { type EntityTable } from "dexie";

export type LocalRecord = {
  id: string;
  workspaceId: string;
  farmId?: string | null;
  seasonId?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  pendingSync?: boolean;
};

export type PendingMutation = LocalRecord & {
  entity:
    | "labourer"
    | "labourGroup"
    | "attendance"
    | "account"
    | "advance"
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
  status?: "pending" | "syncing" | "failed" | "permission_denied" | "resolved" | "discarded";
  retryable?: boolean;
  lastError?: string;
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
};

export type Attendance = LocalRecord & {
  labourerId: string;
  date: string;
  status: "present" | "half_day" | "absent";
};

export type Account = LocalRecord & {
  name: string;
  type: "cash" | "bank" | "partner";
};

export type Voucher = LocalRecord & {
  voucherNumber: string;
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

export async function workspaceRecords<T extends LocalRecord>(table: EntityTable<T, "id">, options: { includeDeleted?: boolean; includeGeneralFarmRecords?: boolean } = {}) {
  if (!activeFarmId || !activeSeasonId) return [];
  return table.where("workspaceId").equals(getActiveWorkspaceId())
    .filter((record) => record.farmId === activeFarmId
      && (record.seasonId === activeSeasonId || (Boolean(options.includeGeneralFarmRecords) && record.seasonId === null))
      && (Boolean(options.includeDeleted) || !record.deletedAt)).toArray();
}

export function labourSortValue(labourer: Pick<Labourer, "sortOrder" | "androidSortOrder" | "originalIndex" | "createdAt">) {
  if (typeof labourer.sortOrder === "number" && Number.isFinite(labourer.sortOrder)) return labourer.sortOrder;
  if (typeof labourer.androidSortOrder === "number" && Number.isFinite(labourer.androidSortOrder)) return labourer.androidSortOrder;
  if (typeof labourer.originalIndex === "number" && Number.isFinite(labourer.originalIndex)) return labourer.originalIndex;
  const created = Date.parse(labourer.createdAt);
  return Number.isFinite(created) ? created : Number.MAX_SAFE_INTEGER;
}

export function compareLabourers(
  left: Pick<Labourer, "id" | "name" | "sortOrder" | "androidSortOrder" | "originalIndex" | "createdAt">,
  right: Pick<Labourer, "id" | "name" | "sortOrder" | "androidSortOrder" | "originalIndex" | "createdAt">,
) {
  const sortDelta = labourSortValue(left) - labourSortValue(right);
  if (sortDelta !== 0) return sortDelta;
  const createdDelta = left.createdAt.localeCompare(right.createdAt);
  if (createdDelta !== 0) return createdDelta;
  const nameDelta = left.name.localeCompare(right.name);
  if (nameDelta !== 0) return nameDelta;
  return left.id.localeCompare(right.id);
}

export async function clearCachedData() {
  await Promise.all(offlineDb.tables.map((table) => table.clear()));
}

export function makeLocalRecord() {
  const now = new Date().toISOString();
  if (!activeFarmId || !activeSeasonId) throw new Error("Select an active farm and season before entering records.");
  return { id: crypto.randomUUID(), workspaceId: getActiveWorkspaceId(), farmId: activeFarmId, seasonId: activeSeasonId, createdAt: now, updatedAt: now, pendingSync: false };
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
