import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const userRole = pgEnum("user_role", ["admin", "operator", "viewer"]);
export const attendanceStatus = pgEnum("attendance_status", ["P", "H", "A"]);
export const transactionType = pgEnum("transaction_type", ["credit", "debit"]);
export const transactionSource = pgEnum("transaction_source", [
  "opening",
  "settlement",
  "expense",
  "advance",
  "sale",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  role: userRole("role").default("viewer").notNull(),
  active: boolean("active").default(true).notNull(),
  ...timestamps,
});

export const userSessions = pgTable("user_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const farms = pgTable("farms", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  location: text("location"),
  owner: text("owner"),
  remarks: text("remarks"),
  active: boolean("active").default(true).notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  ...timestamps,
});

export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    name: text("name").notNull(),
    year: integer("year").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    active: boolean("active").default(true).notNull(),
    closed: boolean("closed").default(false).notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [uniqueIndex("seasons_farm_year_name_uidx").on(table.farmId, table.year, table.name)],
);

export const labourGroups = pgTable(
  "labour_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("labour_groups_farm_name_uidx").on(table.farmId, table.name)],
);

export const labourers = pgTable("labourers", {
  id: uuid("id").defaultRandom().primaryKey(),
  farmId: uuid("farm_id").references(() => farms.id).notNull(),
  groupId: uuid("group_id").references(() => labourGroups.id),
  name: text("name").notNull(),
  labourType: text("labour_type").default("DAILY_WAGE").notNull(),
  wage: numeric("wage", { precision: 14, scale: 2 }).default("0").notNull(),
  displayOrder: integer("display_order").default(0).notNull(),
  joinedOn: date("joined_on"),
  endedOn: date("ended_on"),
  remarks: text("remarks"),
  active: boolean("active").default(true).notNull(),
  ...timestamps,
});

export const attendanceEntries = pgTable(
  "attendance_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id).notNull(),
    labourerId: uuid("labourer_id").references(() => labourers.id).notNull(),
    attendanceDate: date("attendance_date").notNull(),
    status: attendanceStatus("status").notNull(),
    recordedBy: uuid("recorded_by").references(() => users.id),
    syncVersion: integer("sync_version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("attendance_scope_day_uidx").on(
      table.farmId,
      table.seasonId,
      table.labourerId,
      table.attendanceDate,
    ),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    name: text("name").notNull(),
    accountType: text("account_type").default("partner").notNull(),
    remarks: text("remarks"),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("accounts_farm_name_uidx").on(table.farmId, table.name)],
);

export const advanceRecords = pgTable("advance_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  farmId: uuid("farm_id").references(() => farms.id).notNull(),
  seasonId: uuid("season_id").references(() => seasons.id).notNull(),
  labourerId: uuid("labourer_id").references(() => labourers.id).notNull(),
  accountId: uuid("account_id").references(() => accounts.id),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  advanceDate: date("advance_date").notNull(),
  description: text("description"),
  createdBy: uuid("created_by").references(() => users.id),
  syncVersion: integer("sync_version").default(1).notNull(),
  ...timestamps,
});

export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    number: text("number").notNull(),
    driverName: text("driver_name").notNull(),
    driverPhone: text("driver_phone"),
    active: boolean("active").default(true).notNull(),
  },
  (table) => [uniqueIndex("vehicles_farm_number_uidx").on(table.farmId, table.number)],
);

export const produceTypes = pgTable(
  "produce_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    name: text("name").notNull(),
  },
  (table) => [uniqueIndex("produce_types_farm_name_uidx").on(table.farmId, table.name)],
);

export const dispatches = pgTable("dispatches", {
  id: uuid("id").defaultRandom().primaryKey(),
  farmId: uuid("farm_id").references(() => farms.id).notNull(),
  seasonId: uuid("season_id").references(() => seasons.id).notNull(),
  vehicleId: uuid("vehicle_id").references(() => vehicles.id).notNull(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }).notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  syncVersion: integer("sync_version").default(1).notNull(),
  ...timestamps,
});

export const dispatchItems = pgTable("dispatch_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  dispatchId: uuid("dispatch_id").references(() => dispatches.id, { onDelete: "cascade" }).notNull(),
  produceTypeId: uuid("produce_type_id").references(() => produceTypes.id).notNull(),
  cartonCount: integer("carton_count").notNull(),
});

export const sales = pgTable("sales", {
  id: uuid("id").defaultRandom().primaryKey(),
  farmId: uuid("farm_id").references(() => farms.id).notNull(),
  seasonId: uuid("season_id").references(() => seasons.id).notNull(),
  accountId: uuid("account_id").references(() => accounts.id),
  soldOn: date("sold_on").notNull(),
  buyerName: text("buyer_name").notNull(),
  totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  syncVersion: integer("sync_version").default(1).notNull(),
  ...timestamps,
});

export const saleItems = pgTable("sale_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  saleId: uuid("sale_id").references(() => sales.id, { onDelete: "cascade" }).notNull(),
  dispatchItemId: uuid("dispatch_item_id").references(() => dispatchItems.id).notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
});

export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    name: text("name").notNull(),
  },
  (table) => [uniqueIndex("expense_categories_farm_name_uidx").on(table.farmId, table.name)],
);

export const vouchers = pgTable(
  "vouchers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id).notNull(),
    accountId: uuid("account_id").references(() => accounts.id),
    voucherNumber: text("voucher_number").notNull(),
    voucherDate: date("voucher_date").notNull(),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),
    recordedBy: uuid("recorded_by").references(() => users.id),
    syncVersion: integer("sync_version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("vouchers_farm_number_uidx").on(table.farmId, table.voucherNumber)],
);

export const voucherItems = pgTable("voucher_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  voucherId: uuid("voucher_id").references(() => vouchers.id, { onDelete: "cascade" }).notNull(),
  categoryId: uuid("category_id").references(() => expenseCategories.id),
  description: text("description"),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
});

export const accountTransactions = pgTable("account_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  farmId: uuid("farm_id").references(() => farms.id).notNull(),
  seasonId: uuid("season_id").references(() => seasons.id).notNull(),
  accountId: uuid("account_id").references(() => accounts.id).notNull(),
  source: transactionSource("source").notNull(),
  referenceId: uuid("reference_id"),
  type: transactionType("type").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  transactionDate: date("transaction_date").notNull(),
  remarks: text("remarks"),
  createdBy: uuid("created_by").references(() => users.id),
  syncVersion: integer("sync_version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const notificationPreferences = pgTable("notification_preferences", {
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).primaryKey(),
  enabled: boolean("enabled").default(false).notNull(),
  localTime: time("local_time").default("19:00").notNull(),
  timezone: text("timezone").default("Asia/Riyadh").notNull(),
  pushSubscription: jsonb("push_subscription"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id),
  farmId: uuid("farm_id").references(() => farms.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
