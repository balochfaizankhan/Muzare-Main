import {
  boolean,
  date,
  foreignKey,
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

export const platformRole = pgEnum("platform_role", ["platform_admin", "platform_support"]);
export const workspaceRole = pgEnum("workspace_role", ["workspace_owner", "workspace_manager", "supervisor", "operator", "viewer"]);
export const userStatus = pgEnum("user_status", ["pending", "approved", "rejected", "suspended"]);
export const approvalEntityType = pgEnum("approval_entity_type", ["expense", "attendance", "sale", "dispatch"]);
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected"]);
export const subscriptionStatus = pgEnum("subscription_status", ["trial", "active", "past_due", "suspended", "cancelled"]);
export const seasonStatus = pgEnum("season_status", ["planned", "active", "closed", "archived"]);
export const attendanceStatus = pgEnum("attendance_status", ["P", "H", "A"]);
export const transactionType = pgEnum("transaction_type", ["credit", "debit"]);
export const transactionSource = pgEnum("transaction_source", [
  "opening",
  "settlement",
  "expense",
  "advance",
  "sale",
]);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    contactEmail: text("contact_email").notNull(),
    contactPhone: text("contact_phone"),
    status: userStatus("status").default("pending").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    ...timestamps,
  },
  (table) => [uniqueIndex("workspaces_slug_uidx").on(table.slug)],
);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  phone: text("phone"),
  platformRole: platformRole("platform_role"),
  status: userStatus("status").default("pending").notNull(),
  active: boolean("active").default(true).notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: uuid("approved_by"),
  ...timestamps,
});

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    role: workspaceRole("role").default("viewer").notNull(),
    active: boolean("active").default(true).notNull(),
    permissions: jsonb("permissions").$type<Record<string, Record<string, boolean>> | null>(),
    ...timestamps,
  },
  (table) => [uniqueIndex("workspace_memberships_workspace_user_uidx").on(table.workspaceId, table.userId)],
);

export const workspaceTeamInvitations = pgTable("workspace_team_invitations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  role: workspaceRole("role").default("viewer").notNull(),
  permissions: jsonb("permissions").$type<Record<string, Record<string, boolean>> | null>(),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").default("pending").notNull(),
  invitedBy: uuid("invited_by").references(() => users.id).notNull(),
  acceptedBy: uuid("accepted_by").references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  ...timestamps,
});

export const userSessions = pgTable("user_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  activeFarmId: uuid("active_farm_id"),
  activeSeasonId: uuid("active_season_id"),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const farms = pgTable(
  "farms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    name: text("name").notNull(),
    location: text("location"),
    owner: text("owner"),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    remarks: text("remarks"),
    active: boolean("active").default(true).notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [uniqueIndex("farms_workspace_id_id_uidx").on(table.workspaceId, table.id)],
);

export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    name: text("name").notNull(),
    cropType: text("crop_type"),
    year: integer("year").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    expectedEndsOn: date("expected_ends_on"),
    actualEndsOn: date("actual_ends_on"),
    status: seasonStatus("status").default("planned").notNull(),
    notes: text("notes"),
    active: boolean("active").default(true).notNull(),
    closed: boolean("closed").default(false).notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("seasons_farm_year_name_uidx").on(table.farmId, table.year, table.name),
    uniqueIndex("seasons_workspace_farm_id_uidx").on(table.workspaceId, table.farmId, table.id),
    foreignKey({
      columns: [table.workspaceId, table.farmId],
      foreignColumns: [farms.workspaceId, farms.id],
      name: "seasons_workspace_farm_fk",
    }),
  ],
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
    farmId: uuid("farm_id").references(() => farms.id),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    isSystem: boolean("is_system").default(false).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("expense_categories_farm_name_uidx").on(table.farmId, table.name)],
);

export const expenseSubcategories = pgTable("expense_subcategories", {
  id: uuid("id").defaultRandom().primaryKey(),
  categoryId: uuid("category_id").references(() => expenseCategories.id, { onDelete: "cascade" }).notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  isSystem: boolean("is_system").default(false).notNull(),
  active: boolean("active").default(true).notNull(),
  ...timestamps,
});

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
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  userId: uuid("user_id").references(() => users.id),
  farmId: uuid("farm_id").references(() => farms.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workspaceApprovalConfigurations = pgTable(
  "workspace_approval_configurations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    entityType: approvalEntityType("entity_type").notNull(),
    requiredRoles: jsonb("required_roles").$type<Array<"supervisor" | "workspace_manager" | "workspace_owner">>().notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("workspace_approval_configurations_scope_uidx").on(table.workspaceId, table.entityType)],
);

export const workspaceApprovals = pgTable("workspace_approvals", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  entityType: approvalEntityType("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  submittedBy: uuid("submitted_by").references(() => users.id).notNull(),
  currentStep: integer("current_step").default(0).notNull(),
  status: approvalStatus("status").default("pending").notNull(),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  ...timestamps,
});

export const subscriptionPlans = pgTable("subscription_plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  monthlyPrice: numeric("monthly_price", { precision: 14, scale: 2 }).notNull(),
  active: boolean("active").default(true).notNull(),
  ...timestamps,
});

export const workspaceSubscriptions = pgTable("workspace_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  planId: uuid("plan_id").references(() => subscriptionPlans.id).notNull(),
  status: subscriptionStatus("status").default("trial").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  ...timestamps,
});

export const billingInvoices = pgTable("billing_invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  subscriptionId: uuid("subscription_id").references(() => workspaceSubscriptions.id),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  status: text("status").default("open").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  ...timestamps,
});

export const operationalRecords = pgTable(
  "operational_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id),
    seasonId: uuid("season_id").references(() => seasons.id),
    clientRecordId: text("client_record_id").notNull(),
    entityType: text("entity_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    recordedBy: uuid("recorded_by").references(() => users.id).notNull(),
    clientUpdatedAt: timestamp("client_updated_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("operational_records_workspace_entity_client_uidx").on(table.workspaceId, table.entityType, table.clientRecordId),
    foreignKey({
      columns: [table.workspaceId, table.farmId],
      foreignColumns: [farms.workspaceId, farms.id],
      name: "operational_records_workspace_farm_fk",
    }),
    foreignKey({
      columns: [table.workspaceId, table.farmId, table.seasonId],
      foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id],
      name: "operational_records_workspace_farm_season_fk",
    }),
  ],
);

export const expenseVoucherSequences = pgTable(
  "expense_voucher_sequences",
  {
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    scopeKey: text("scope_key").notNull(),
    lastNumber: integer("last_number").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("expense_voucher_sequences_scope_uidx").on(table.workspaceId, table.scopeKey)],
);

export const attendanceImportSessions = pgTable("attendance_import_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  farmId: uuid("farm_id").references(() => farms.id).notNull(),
  seasonId: uuid("season_id").references(() => seasons.id).notNull(),
  uploadedBy: uuid("uploaded_by").references(() => users.id).notNull(),
  originalFilename: text("original_filename").notNull(),
  fileHash: text("file_hash").notNull(),
  status: text("status").default("previewed").notNull(),
  parsedPayload: jsonb("parsed_payload").$type<Record<string, unknown>>().notNull(),
  validationSummary: jsonb("validation_summary").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
});

export const expenseImportSessions = pgTable("expense_import_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  farmId: uuid("farm_id").references(() => farms.id).notNull(),
  seasonId: uuid("season_id").references(() => seasons.id).notNull(),
  uploadedBy: uuid("uploaded_by").references(() => users.id).notNull(),
  originalFilename: text("original_filename").notNull(),
  fileHash: text("file_hash").notNull(),
  status: text("status").default("previewed").notNull(),
  parsedPayload: jsonb("parsed_payload").$type<Record<string, unknown>>().notNull(),
  validationSummary: jsonb("validation_summary").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
});

export const farmMaps = pgTable(
  "farm_maps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id),
    mapName: text("map_name").notNull(),
    centerLat: numeric("center_lat", { precision: 10, scale: 7 }).default("0").notNull(),
    centerLng: numeric("center_lng", { precision: 10, scale: 7 }).default("0").notNull(),
    defaultZoom: numeric("default_zoom", { precision: 5, scale: 2 }).default("16").notNull(),
    baseMapProvider: text("base_map_provider").default("maplibre_satellite").notNull(),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({ columns: [table.workspaceId, table.farmId], foreignColumns: [farms.workspaceId, farms.id], name: "farm_maps_workspace_farm_fk" }),
    foreignKey({ columns: [table.workspaceId, table.farmId, table.seasonId], foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id], name: "farm_maps_workspace_farm_season_fk" }),
  ],
);

export const farmMapFeatures = pgTable(
  "farm_map_features",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id),
    featureType: text("feature_type").notNull(),
    featureCode: text("feature_code"),
    featureName: text("feature_name").notNull(),
    geojson: jsonb("geojson").$type<Record<string, unknown>>().notNull(),
    linkedPlotId: uuid("linked_plot_id"),
    linkedIrrigationLineId: uuid("linked_irrigation_line_id"),
    linkedValveId: uuid("linked_valve_id"),
    styleJson: jsonb("style_json").$type<Record<string, unknown> | null>(),
    displayOrder: integer("display_order").default(0).notNull(),
    active: boolean("active").default(true).notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({ columns: [table.workspaceId, table.farmId], foreignColumns: [farms.workspaceId, farms.id], name: "farm_map_features_workspace_farm_fk" }),
    foreignKey({ columns: [table.workspaceId, table.farmId, table.seasonId], foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id], name: "farm_map_features_workspace_farm_season_fk" }),
  ],
);

export const plots = pgTable(
  "plots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id),
    plotCode: text("plot_code").notNull(),
    plotName: text("plot_name"),
    variety: text("variety"),
    treeCount: integer("tree_count"),
    area: numeric("area", { precision: 14, scale: 2 }),
    notes: text("notes"),
    geoFeatureId: uuid("geo_feature_id").references(() => farmMapFeatures.id, { onDelete: "set null" }),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({ columns: [table.workspaceId, table.farmId], foreignColumns: [farms.workspaceId, farms.id], name: "plots_workspace_farm_fk" }),
    foreignKey({ columns: [table.workspaceId, table.farmId, table.seasonId], foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id], name: "plots_workspace_farm_season_fk" }),
    uniqueIndex("plots_workspace_code_uidx").on(table.workspaceId, table.farmId, table.seasonId, table.plotCode),
  ],
);

export const irrigationLines = pgTable(
  "irrigation_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id),
    lineCode: text("line_code").notNull(),
    lineName: text("line_name"),
    description: text("description"),
    geoFeatureId: uuid("geo_feature_id").references(() => farmMapFeatures.id, { onDelete: "set null" }),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({ columns: [table.workspaceId, table.farmId], foreignColumns: [farms.workspaceId, farms.id], name: "irrigation_lines_workspace_farm_fk" }),
    foreignKey({ columns: [table.workspaceId, table.farmId, table.seasonId], foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id], name: "irrigation_lines_workspace_farm_season_fk" }),
    uniqueIndex("irrigation_lines_workspace_code_uidx").on(table.workspaceId, table.farmId, table.seasonId, table.lineCode),
  ],
);

export const valves = pgTable(
  "valves",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id),
    valveCode: text("valve_code").notNull(),
    valveName: text("valve_name"),
    irrigationLineId: uuid("irrigation_line_id").references(() => irrigationLines.id, { onDelete: "set null" }),
    plotId: uuid("plot_id").references(() => plots.id, { onDelete: "set null" }),
    estimatedTreeCount: integer("estimated_tree_count"),
    notes: text("notes"),
    geoFeatureId: uuid("geo_feature_id").references(() => farmMapFeatures.id, { onDelete: "set null" }),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({ columns: [table.workspaceId, table.farmId], foreignColumns: [farms.workspaceId, farms.id], name: "valves_workspace_farm_fk" }),
    foreignKey({ columns: [table.workspaceId, table.farmId, table.seasonId], foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id], name: "valves_workspace_farm_season_fk" }),
    uniqueIndex("valves_workspace_code_uidx").on(table.workspaceId, table.farmId, table.seasonId, table.valveCode),
  ],
);

export const farmProducts = pgTable("farm_products", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  productType: text("product_type").notNull(),
  category: text("category"),
  productName: text("product_name").notNull(),
  unit: text("unit"),
  notes: text("notes"),
  active: boolean("active").default(true).notNull(),
  ...timestamps,
});

export const waterAssets = pgTable(
  "water_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id),
    assetType: text("asset_type").notNull(),
    assetCode: text("asset_code").notNull(),
    assetName: text("asset_name").notNull(),
    linkedFeatureId: uuid("linked_feature_id").references(() => farmMapFeatures.id, { onDelete: "set null" }),
    status: text("status"),
    notes: text("notes"),
    active: boolean("active").default(true).notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({ columns: [table.workspaceId, table.farmId], foreignColumns: [farms.workspaceId, farms.id], name: "water_assets_workspace_farm_fk" }),
    foreignKey({ columns: [table.workspaceId, table.farmId, table.seasonId], foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id], name: "water_assets_workspace_farm_season_fk" }),
  ],
);

export const operationLogs = pgTable(
  "operation_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id).notNull(),
    plotId: uuid("plot_id").references(() => plots.id, { onDelete: "set null" }),
    irrigationLineId: uuid("irrigation_line_id").references(() => irrigationLines.id, { onDelete: "set null" }),
    valveId: uuid("valve_id").references(() => valves.id, { onDelete: "set null" }),
    activityType: text("activity_type").notNull(),
    activityCategory: text("activity_category"),
    productId: uuid("product_id").references(() => farmProducts.id, { onDelete: "set null" }),
    productNameText: text("product_name_text"),
    operationDate: date("operation_date").notNull(),
    startTime: time("start_time"),
    endTime: time("end_time"),
    durationMinutes: integer("duration_minutes"),
    qtyPerTree: numeric("qty_per_tree", { precision: 14, scale: 4 }),
    totalQty: numeric("total_qty", { precision: 14, scale: 4 }),
    unit: text("unit"),
    treeCountCovered: integer("tree_count_covered"),
    performedBy: text("performed_by"),
    labourTeamId: uuid("labour_team_id"),
    remarks: text("remarks"),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({ columns: [table.workspaceId, table.farmId], foreignColumns: [farms.workspaceId, farms.id], name: "operation_logs_workspace_farm_fk" }),
    foreignKey({ columns: [table.workspaceId, table.farmId, table.seasonId], foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id], name: "operation_logs_workspace_farm_season_fk" }),
  ],
);

export const operationDueRules = pgTable(
  "operation_due_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id),
    plotId: uuid("plot_id").references(() => plots.id, { onDelete: "cascade" }),
    activityType: text("activity_type").notNull(),
    activityCategory: text("activity_category"),
    productId: uuid("product_id").references(() => farmProducts.id, { onDelete: "set null" }),
    intervalDays: integer("interval_days").notNull(),
    dueSoonDays: integer("due_soon_days").default(2).notNull(),
    active: boolean("active").default(true).notNull(),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [
    foreignKey({ columns: [table.workspaceId, table.farmId], foreignColumns: [farms.workspaceId, farms.id], name: "operation_due_rules_workspace_farm_fk" }),
    foreignKey({ columns: [table.workspaceId, table.farmId, table.seasonId], foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id], name: "operation_due_rules_workspace_farm_season_fk" }),
  ],
);
