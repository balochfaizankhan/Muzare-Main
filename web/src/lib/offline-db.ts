import Dexie, { type EntityTable } from "dexie";

type LocalRecord = {
  id: string;
  createdAt: string;
};

export type PendingMutation = LocalRecord & {
  entity: "labourer" | "attendance" | "account" | "advance" | "dispatch" | "sale" | "voucher" | "partnerEntry";
  operation: "create" | "update" | "delete";
  payload: unknown;
  attempts: number;
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

export const offlineDb = new Dexie("muzare-offline") as Dexie & {
  pendingMutations: EntityTable<PendingMutation, "id">;
  labourers: EntityTable<Labourer, "id">;
  attendance: EntityTable<Attendance, "id">;
  accounts: EntityTable<Account, "id">;
  vouchers: EntityTable<Voucher, "id">;
  dispatches: EntityTable<Dispatch, "id">;
  sales: EntityTable<Sale, "id">;
  partnerEntries: EntityTable<PartnerEntry, "id">;
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

export function makeLocalRecord() {
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
}

export async function queueMutation(entity: PendingMutation["entity"], payload: unknown) {
  await offlineDb.pendingMutations.add({
    ...makeLocalRecord(),
    entity,
    operation: "create",
    payload,
    attempts: 0,
  });
}

export async function ensureLocalAccounts() {
  if ((await offlineDb.accounts.count()) > 0) return;
  const createdAt = new Date().toISOString();
  await offlineDb.accounts.bulkPut([
    { id: "local-cash", name: "Cash", type: "cash", createdAt },
    { id: "local-partner", name: "Partner Capital", type: "partner", createdAt },
  ]);
}
