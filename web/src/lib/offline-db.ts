import Dexie, { type EntityTable } from "dexie";

export type LocalRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  pendingSync?: boolean;
};

export type PendingMutation = LocalRecord & {
  entity: "labourer" | "attendance" | "account" | "advance" | "dispatch" | "sale" | "voucher" | "partnerEntry" | "inventoryEntry";
  operation: "create" | "update" | "delete";
  payload: unknown;
  attempts: number;
  workspaceId: string;
  farmId?: string | null;
  seasonId?: string | null;
};

export type Labourer = LocalRecord & {
  name: string;
  group: string;
  dailyWage: number;
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
  description: string;
  amount: number;
  accountId: string;
};

export type Dispatch = LocalRecord & {
  date: string;
  vehicleNumber: string;
  driverName: string;
  produceType: string;
  cartons: number;
};

export type Sale = LocalRecord & {
  date: string;
  buyerName: string;
  produceType: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  accountId: string;
};

export type PartnerEntry = LocalRecord & {
  date: string;
  partnerName: string;
  type: "contribution" | "withdrawal";
  amount: number;
  notes: string;
  accountId: string;
};

export type Advance = LocalRecord & {
  labourerId: string;
  date: string;
  amount: number;
  notes: string;
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
  accounts: EntityTable<Account, "id">;
  vouchers: EntityTable<Voucher, "id">;
  dispatches: EntityTable<Dispatch, "id">;
  sales: EntityTable<Sale, "id">;
  partnerEntries: EntityTable<PartnerEntry, "id">;
  advances: EntityTable<Advance, "id">;
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

export function makeLocalRecord() {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), createdAt: now, updatedAt: now, pendingSync: false };
}

export async function ensureLocalAccounts() {
  if ((await offlineDb.accounts.count()) > 0) return;
  const createdAt = new Date().toISOString();
  await offlineDb.accounts.bulkPut([
    { id: "local-cash", name: "Cash", type: "cash", createdAt, updatedAt: createdAt, pendingSync: false },
    { id: "local-partner", name: "Partner Capital", type: "partner", createdAt, updatedAt: createdAt, pendingSync: false },
  ]);
}
