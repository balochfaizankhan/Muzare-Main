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
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

const importTrackingColumns = {
  sourceType: text("source_type"),
  oldAndroidId: text("old_android_id"),
  importBatchId: uuid("import_batch_id"),
  sourceFileHash: text("source_file_hash"),
};

export const platformRole = pgEnum("platform_role", ["platform_admin", "platform_support"]);
export const workspaceRole = pgEnum("workspace_role", ["workspace_owner", "workspace_manager", "supervisor", "accountant", "operator", "viewer"]);
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
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  platformRole: platformRole("platform_role"),
  status: userStatus("status").default("pending").notNull(),
  active: boolean("active").default(true).notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: uuid("approved_by"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectedBy: uuid("rejected_by"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedBy: uuid("suspended_by"),
  internalReviewNote: text("internal_review_note"),
  registrationSource: text("registration_source").default("self_service").notNull(),
  registrationLanguage: text("registration_language"),
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
    farmAccessMode: text("farm_access_mode").default("all").notNull(),
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
  farmAccessMode: text("farm_access_mode").default("all").notNull(),
  farmIds: jsonb("farm_ids").$type<string[] | null>(),
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
    ...importTrackingColumns,
    active: boolean("active").default(true).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => users.id),
    deletionApprovedAt: timestamp("deletion_approved_at", { withTimezone: true }),
    deletionApprovedBy: uuid("deletion_approved_by").references(() => users.id),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [uniqueIndex("farms_workspace_id_id_uidx").on(table.workspaceId, table.id)],
);

export const workspaceMemberFarms = pgTable(
  "workspace_member_farms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    membershipId: uuid("membership_id").references(() => workspaceMemberships.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id, { onDelete: "cascade" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workspace_member_farms_membership_farm_uidx").on(table.membershipId, table.farmId),
  ],
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
    ...importTrackingColumns,
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
    ...importTrackingColumns,
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
  ...importTrackingColumns,
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
    ...importTrackingColumns,
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
    ...importTrackingColumns,
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
  ...importTrackingColumns,
  syncVersion: integer("sync_version").default(1).notNull(),
  ...timestamps,
});

export const labourWageSettlementAdvanceAllocations = pgTable(
  "labour_wage_settlement_advance_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id).notNull(),
    settlementRecordId: uuid("settlement_record_id").references(() => operationalRecords.id, { onDelete: "cascade" }).notNull(),
    advanceRecordId: uuid("advance_record_id").references(() => operationalRecords.id, { onDelete: "cascade" }).notNull(),
    absorbedAmount: numeric("absorbed_amount", { precision: 14, scale: 2 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("labour_wage_settlement_advance_allocations_unique_uidx").on(table.settlementRecordId, table.advanceRecordId),
    uniqueIndex("labour_wage_settlement_advance_allocations_advance_uidx").on(table.advanceRecordId, table.settlementRecordId),
  ],
);

export const labourWageSettlementCreateRequests = pgTable(
  "labour_wage_settlement_create_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id).notNull(),
    clientRequestId: uuid("client_request_id").notNull(),
    operationType: text("operation_type").default("labour_wage_settlement_create").notNull(),
    state: text("state").notNull(),
    stage: text("stage"),
    settlementOperationalRecordId: uuid("settlement_operational_record_id"),
    settlementClientRecordId: text("settlement_client_record_id"),
    settlementNumber: text("settlement_number"),
    errorCode: text("error_code"),
    safeToRetry: boolean("safe_to_retry").default(false).notNull(),
    message: text("message"),
    correlationId: text("correlation_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("labour_wage_settlement_create_requests_client_uidx").on(table.workspaceId, table.clientRequestId, table.operationType),
  ],
);

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
  ...importTrackingColumns,
  syncVersion: integer("sync_version").default(1).notNull(),
  ...timestamps,
});

export const dispatchItems = pgTable("dispatch_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  dispatchId: uuid("dispatch_id").references(() => dispatches.id, { onDelete: "cascade" }).notNull(),
  produceTypeId: uuid("produce_type_id").references(() => produceTypes.id).notNull(),
  cartonCount: integer("carton_count").notNull(),
  ...importTrackingColumns,
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
  ...importTrackingColumns,
  syncVersion: integer("sync_version").default(1).notNull(),
  ...timestamps,
});

export const saleItems = pgTable("sale_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  saleId: uuid("sale_id").references(() => sales.id, { onDelete: "cascade" }).notNull(),
  dispatchItemId: uuid("dispatch_item_id").references(() => dispatchItems.id).notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
  ...importTrackingColumns,
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
    ...importTrackingColumns,
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
  ...importTrackingColumns,
});

export const expenseAttachments = pgTable(
  "expense_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id),
    seasonId: uuid("season_id").references(() => seasons.id),
    expenseId: uuid("expense_id").notNull(),
    fileName: text("file_name").notNull(),
    fileType: text("file_type").notNull(),
    fileSize: integer("file_size").notNull(),
    storageKey: text("storage_key").notNull(),
    fileUrl: text("file_url"),
    originalFileKey: text("original_file_key"),
    croppedFileKey: text("cropped_file_key"),
    cropMetadata: jsonb("crop_metadata").$type<Record<string, unknown> | null>(),
    ocrStatus: text("ocr_status").default("not_started").notNull(),
    ocrProvider: text("ocr_provider"),
    ocrRawText: text("ocr_raw_text"),
    ocrParsedJson: jsonb("ocr_parsed_json").$type<Record<string, unknown> | null>(),
    ocrConfidence: text("ocr_confidence"),
    userCorrectedJson: jsonb("user_corrected_json").$type<Record<string, unknown> | null>(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    uploadedBy: uuid("uploaded_by").references(() => users.id).notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.farmId],
      foreignColumns: [farms.workspaceId, farms.id],
      name: "expense_attachments_workspace_farm_fk",
    }),
    foreignKey({
      columns: [table.workspaceId, table.farmId, table.seasonId],
      foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id],
      name: "expense_attachments_workspace_farm_season_fk",
    }),
  ],
);

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
  ...importTrackingColumns,
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
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  details: jsonb("details"),
  beforeJson: jsonb("before_json").$type<Record<string, unknown> | null>(),
  afterJson: jsonb("after_json").$type<Record<string, unknown> | null>(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const farmDeletionRequests = pgTable("farm_deletion_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  farmId: uuid("farm_id").references(() => farms.id).notNull(),
  requestedBy: uuid("requested_by").references(() => users.id).notNull(),
  reason: text("reason"),
  recordCountsJson: jsonb("record_counts_json").$type<Record<string, number>>().default({}).notNull(),
  status: text("status").default("pending").notNull(),
  reviewedBy: uuid("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNotes: text("review_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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
    ...importTrackingColumns,
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

export const labourDues = pgTable(
  "labour_dues",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id).notNull(),
    dueNumber: text("due_number").notNull(),
    origin: text("origin").notNull(),
    settlementBasis: text("settlement_basis"),
    sourceRecordId: uuid("source_record_id").references(() => operationalRecords.id),
    sourceClientRecordId: text("source_client_record_id"),
    recipientScope: text("recipient_scope").notNull(),
    financialScopeKey: text("financial_scope_key").notNull(),
    labourerId: text("labourer_id"),
    labourGroupId: text("labour_group_id"),
    contractorReference: text("contractor_reference"),
    crewReference: text("crew_reference"),
    recipientSnapshot: jsonb("recipient_snapshot").$type<Record<string, unknown>>().default({}).notNull(),
    description: text("description").notNull(),
    workFromDate: date("work_from_date").notNull(),
    workToDate: date("work_to_date").notNull(),
    grossAmount: numeric("gross_amount", { precision: 14, scale: 2 }).notNull(),
    adjustmentAmount: numeric("adjustment_amount", { precision: 14, scale: 2 }).default("0").notNull(),
    authorizedDeductions: numeric("authorized_deductions", { precision: 14, scale: 2 }).default("0").notNull(),
    calculationStatus: text("calculation_status").default("APPROVED").notNull(),
    paymentStatus: text("payment_status").default("UNPAID").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
    holdReason: text("hold_reason"),
    voidReason: text("void_reason"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id),
    legacy: boolean("legacy").default(false).notNull(),
    reconciliationStatus: text("reconciliation_status").default("RECONCILED").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    createdBy: uuid("created_by").references(() => users.id).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("labour_dues_workspace_farm_number_uidx").on(table.workspaceId, table.farmId, table.dueNumber),
    unique("labour_dues_source_record_key").on(table.sourceRecordId),
    uniqueIndex("labour_dues_idempotency_uidx").on(table.workspaceId, table.idempotencyKey),
    foreignKey({
      columns: [table.workspaceId, table.farmId],
      foreignColumns: [farms.workspaceId, farms.id],
      name: "labour_dues_workspace_farm_fk",
    }),
    foreignKey({
      columns: [table.workspaceId, table.farmId, table.seasonId],
      foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id],
      name: "labour_dues_workspace_farm_season_fk",
    }),
  ],
);

export const labourDueMemberSnapshots = pgTable(
  "labour_due_member_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    dueId: uuid("due_id").references(() => labourDues.id, { onDelete: "cascade" }).notNull(),
    labourerId: text("labourer_id").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().default({}).notNull(),
    calculatedAmount: numeric("calculated_amount", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("labour_due_member_snapshots_due_labourer_uidx").on(table.dueId, table.labourerId),
  ],
);

export const labourDueAttendanceSources = pgTable(
  "labour_due_attendance_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id, { onDelete: "cascade" }).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id, { onDelete: "cascade" }).notNull(),
    dueId: uuid("due_id").references(() => labourDues.id, { onDelete: "cascade" }).notNull(),
    attendanceRecordId: uuid("attendance_record_id").references(() => operationalRecords.id, { onDelete: "restrict" }).notNull(),
    attendanceClientRecordId: text("attendance_client_record_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("labour_due_attendance_sources_record_uidx").on(table.workspaceId, table.attendanceRecordId),
    uniqueIndex("labour_due_attendance_sources_client_uidx").on(table.workspaceId, table.attendanceClientRecordId),
  ],
);

export const labourPaymentVouchers = pgTable(
  "labour_payment_vouchers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id).notNull(),
    voucherNumber: text("voucher_number").notNull(),
    voucherDate: date("voucher_date").notNull(),
    nature: text("nature").notNull(),
    status: text("status").default("DRAFT").notNull(),
    recipientScope: text("recipient_scope").notNull(),
    financialScopeKey: text("financial_scope_key").notNull(),
    labourerId: text("labourer_id"),
    labourGroupId: text("labour_group_id"),
    recipientSnapshot: jsonb("recipient_snapshot").$type<Record<string, unknown>>().default({}).notNull(),
    description: text("description").notNull(),
    paymentAmount: numeric("payment_amount", { precision: 14, scale: 2 }).notNull(),
    paymentAccountId: uuid("payment_account_id").references(() => accounts.id),
    paymentMethod: text("payment_method"),
    transactionReference: text("transaction_reference"),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    linkedDueId: uuid("linked_due_id").references(() => labourDues.id),
    legacySourceRecordId: uuid("legacy_source_record_id").references(() => operationalRecords.id),
    accountTransactionId: uuid("account_transaction_id").references(() => accountTransactions.id),
    idempotencyKey: uuid("idempotency_key").notNull(),
    createdBy: uuid("created_by").references(() => users.id).notNull(),
    postedBy: uuid("posted_by").references(() => users.id),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    reversalReference: uuid("reversal_reference"),
    relatedAdvanceVoucherId: uuid("related_advance_voucher_id"),
    legacy: boolean("legacy").default(false).notNull(),
    reconciliationStatus: text("reconciliation_status").default("RECONCILED").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("labour_payment_vouchers_workspace_farm_number_uidx").on(table.workspaceId, table.farmId, table.voucherNumber),
    uniqueIndex("labour_payment_vouchers_idempotency_uidx").on(table.workspaceId, table.idempotencyKey),
    unique("labour_payment_vouchers_legacy_source_nature_key").on(table.legacySourceRecordId, table.nature),
    foreignKey({
      columns: [table.workspaceId, table.farmId, table.seasonId],
      foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id],
      name: "labour_payment_vouchers_workspace_farm_season_fk",
    }),
  ],
);

export const labourPaymentAllocations = pgTable(
  "labour_payment_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    voucherId: uuid("voucher_id").references(() => labourPaymentVouchers.id, { onDelete: "cascade" }).notNull(),
    dueId: uuid("due_id").references(() => labourDues.id, { onDelete: "cascade" }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    status: text("status").default("ACTIVE").notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [unique("labour_payment_allocations_voucher_due_key").on(table.voucherId, table.dueId)],
);

export const labourAdvanceApplications = pgTable(
  "labour_advance_applications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    // Nullable: a canonical pooled application (see validate_labour_advance_application)
    // has no single source advance voucher, since it draws from the due's aggregate
    // eligible outstanding pool rather than one specific historical voucher.
    advanceVoucherId: uuid("advance_voucher_id").references(() => labourPaymentVouchers.id, { onDelete: "cascade" }),
    dueId: uuid("due_id").references(() => labourDues.id, { onDelete: "cascade" }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    status: text("status").default("ACTIVE").notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [unique("labour_advance_applications_workspace_idempotency_key").on(table.workspaceId, table.idempotencyKey)],
);

export const labourAccountingEntries = pgTable(
  "labour_accounting_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id).notNull(),
    entryKey: text("entry_key").notNull(),
    eventType: text("event_type").notNull(),
    ledgerCode: text("ledger_code").notNull(),
    dueId: uuid("due_id").references(() => labourDues.id),
    voucherId: uuid("voucher_id").references(() => labourPaymentVouchers.id),
    advanceApplicationId: uuid("advance_application_id").references(() => labourAdvanceApplications.id),
    debit: numeric("debit", { precision: 14, scale: 2 }).default("0").notNull(),
    credit: numeric("credit", { precision: 14, scale: 2 }).default("0").notNull(),
    status: text("status").default("POSTED").notNull(),
    reversalOf: uuid("reversal_of"),
    postedBy: uuid("posted_by").references(() => users.id).notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("labour_accounting_entries_workspace_entry_key").on(table.workspaceId, table.entryKey),
    uniqueIndex("labour_accounting_entries_one_reversal_uidx").on(table.reversalOf).where(sql`${table.reversalOf} is not null`),
    foreignKey({ columns: [table.workspaceId, table.farmId, table.seasonId], foreignColumns: [seasons.workspaceId, seasons.farmId, seasons.id], name: "labour_accounting_entries_context_fk" }),
  ],
);

export const labourCleanupLogs = pgTable("labour_cleanup_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  cleanupBatchId: uuid("cleanup_batch_id").notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  farmId: uuid("farm_id").references(() => farms.id),
  seasonId: uuid("season_id").references(() => seasons.id),
  entityType: text("entity_type").notNull(),
  originalEntityId: text("original_entity_id").notNull(),
  originalReference: text("original_reference").notNull(),
  recipientSnapshot: jsonb("recipient_snapshot").$type<Record<string, unknown>>().default({}).notNull(),
  originalAmount: numeric("original_amount", { precision: 14, scale: 2 }).default("0").notNull(),
  originalStatus: text("original_status").notNull(),
  relatedSettlementNumber: text("related_settlement_number"),
  relatedVoucherNumbers: jsonb("related_voucher_numbers").$type<string[]>().default([]).notNull(),
  dependentRecordsRemoved: integer("dependent_records_removed").default(0).notNull(),
  accountEffectsRemoved: boolean("account_effects_removed").default(false).notNull(),
  partnerEffectsRemoved: boolean("partner_effects_removed").default(false).notNull(),
  advancesRestored: boolean("advances_restored").default(false).notNull(),
  deletedBy: uuid("deleted_by").references(() => users.id).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).defaultNow().notNull(),
  reason: text("reason").notNull(),
  confirmationMode: text("confirmation_mode").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
});

export const labourCleanupTombstones = pgTable(
  "labour_cleanup_tombstones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cleanupBatchId: uuid("cleanup_batch_id").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    farmId: uuid("farm_id").references(() => farms.id),
    seasonId: uuid("season_id").references(() => seasons.id),
    entityType: text("entity_type").notNull(),
    clientRecordId: text("client_record_id").notNull(),
    deletedBy: uuid("deleted_by").references(() => users.id).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("labour_cleanup_tombstones_workspace_entity_record_key").on(table.workspaceId, table.entityType, table.clientRecordId)],
);

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    source: text("source").notNull(),
    exportVersion: text("export_version"),
    fileName: text("file_name"),
    fileHash: text("file_hash").notNull(),
    status: text("status").default("running").notNull(),
    startedBy: uuid("started_by").references(() => users.id).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>(),
    summaryJson: jsonb("summary_json").$type<Record<string, unknown>>(),
    errorJson: jsonb("error_json").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("import_batches_workspace_file_hash_uidx").on(table.workspaceId, table.fileHash),
  ],
);

export const importFailures = pgTable(
  "import_failures",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id, { onDelete: "cascade" }).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    step: text("step").notNull(),
    sourceRow: text("source_row"),
    errorMessage: text("error_message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("import_failures_batch_step_row_uidx").on(table.importBatchId, table.step, table.sourceRow),
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
