import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { activeOperationalPayloadSql } from "../operational-record-state.js";
import { db } from "../db/client.js";
import { auditLogs, farms, operationalRecords, seasons, userSessions } from "../db/schema.js";
import { visibleFarmWhere } from "../farm-visibility.js";
import { canonicalImportedVoucherNumber } from "./import-voucher-numbers.js";

type FarmRow = typeof farms.$inferSelect;
type SeasonRow = typeof seasons.$inferSelect;

const importedEntityTypes = new Set([
  "labourer",
  "labourGroup",
  "attendance",
  "account",
  "advance",
  "labourPayment",
  "productionEntry",
  "vehicle",
  "dateType",
  "dispatch",
  "sale",
  "voucher",
  "partnerEntry",
  "inventoryEntry",
]);

const seasonScopedEntityTypes = new Set([
  "attendance",
  "advance",
  "labourPayment",
  "productionEntry",
  "vehicle",
  "dateType",
  "dispatch",
  "sale",
  "voucher",
  "partnerEntry",
  "inventoryEntry",
]);

function normalizedText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeFarmName(value: unknown) {
  return normalizedText(value).toLowerCase().replace(/\s+/g, " ");
}

function isImportedFarm(row: FarmRow | SeasonRow) {
  return Boolean(row.sourceType || row.oldAndroidId || row.importBatchId || row.sourceFileHash);
}

type DuplicateVoucherPreview = {
  voucherNumber: string;
  recordIds: string[];
  dates: string[];
  amounts: number[];
  accounts: string[];
  statuses: string[];
  imported: boolean[];
  oldExpenseIds: string[];
};

export type WorkspaceImportContextPreview = {
  workspaceId: string;
  canonicalFarm: {
    id: string;
    name: string;
    activeRecordCount: number;
    selectionReason: string;
  } | null;
  canonicalSeason: {
    id: string;
    name: string;
    activeRecordCount: number;
    selectionReason: string;
  } | null;
  oldFarms: Array<{
    id: string;
    name: string;
    active: boolean;
    deletedAt: string | null;
    reasons: string[];
    oldAndroidId: string | null;
    sourceFileHash: string | null;
    importBatchId: string | null;
  }>;
  oldSeasons: Array<{
    id: string;
    farmId: string;
    name: string;
    status: string;
    active: boolean;
    reasons: string[];
    oldAndroidId: string | null;
    sourceFileHash: string | null;
    importBatchId: string | null;
  }>;
  recordsRemapPreview: Array<{ entityType: string; count: number }>;
  voucherNumberMismatchesBefore: number;
  duplicateActiveVoucherNumbersBefore: DuplicateVoucherPreview[];
  duplicateActiveVoucherNumbersProjected: DuplicateVoucherPreview[];
  deletedRecordsExcludedCount: number;
};

export type WorkspaceImportContextRepairResult = WorkspaceImportContextPreview & {
  createdFallbackSeason: boolean;
  repairedOperationalRecords: number;
  repairedByEntity: Array<{ entityType: string; count: number }>;
  voucherNumberMismatchesAfter: number;
  duplicateActiveVoucherNumbersAfter: DuplicateVoucherPreview[];
  farmsArchived: number;
  seasonsArchived: number;
  sessionsUpdated: number;
};

async function loadSessionContext(workspaceId: string, sessionId?: string | null) {
  if (!sessionId) return null;
  const [session] = await db.select({
    activeFarmId: userSessions.activeFarmId,
    activeSeasonId: userSessions.activeSeasonId,
  }).from(userSessions).where(and(
    eq(userSessions.workspaceId, workspaceId),
    eq(userSessions.id, sessionId),
  )).limit(1);
  return session ?? null;
}

async function loadActiveRecordCounts(workspaceId: string) {
  const rows = await db.execute(sql`
    SELECT farm_id, season_id, count(*)::int AS count
    FROM operational_records
    WHERE workspace_id = ${workspaceId}
      AND ${activeOperationalPayloadSql(operationalRecords.payload)}
    GROUP BY farm_id, season_id
  `);
  const farmCounts = new Map<string, number>();
  const seasonCounts = new Map<string, number>();
  for (const row of rows.rows as Array<Record<string, unknown>>) {
    const farmId = normalizedText(row.farm_id);
    const seasonId = normalizedText(row.season_id);
    const count = Number(row.count ?? 0);
    if (farmId) farmCounts.set(farmId, (farmCounts.get(farmId) ?? 0) + count);
    if (seasonId) seasonCounts.set(seasonId, (seasonCounts.get(seasonId) ?? 0) + count);
  }
  return { farmCounts, seasonCounts };
}

function farmCandidateReasons(farm: FarmRow, canonicalFarm: FarmRow | null) {
  const reasons: string[] = [];
  if (farm.deletedAt) reasons.push("deleted");
  if (!farm.active) reasons.push("inactive");
  if (isImportedFarm(farm)) reasons.push("imported");
  if (canonicalFarm && farm.oldAndroidId && canonicalFarm.oldAndroidId && farm.oldAndroidId === canonicalFarm.oldAndroidId) {
    reasons.push("same_old_android_id");
  }
  if (canonicalFarm && normalizeFarmName(farm.name) && normalizeFarmName(farm.name) === normalizeFarmName(canonicalFarm.name)) {
    reasons.push("same_name");
  }
  if (canonicalFarm && farm.sourceFileHash && canonicalFarm.sourceFileHash && farm.sourceFileHash === canonicalFarm.sourceFileHash) {
    reasons.push("same_source_file_hash");
  }
  if (canonicalFarm && farm.importBatchId && canonicalFarm.importBatchId && farm.importBatchId === canonicalFarm.importBatchId) {
    reasons.push("same_import_batch");
  }
  return [...new Set(reasons)];
}

function seasonCandidateReasons(season: SeasonRow, canonicalSeason: SeasonRow | null, candidateFarmIds: Set<string>) {
  const reasons: string[] = [];
  if (candidateFarmIds.has(season.farmId)) reasons.push("farm_is_duplicate");
  if (!season.active) reasons.push("inactive");
  if (season.status === "archived") reasons.push("archived");
  if (isImportedFarm(season)) reasons.push("imported");
  if (canonicalSeason && season.oldAndroidId && canonicalSeason.oldAndroidId && season.oldAndroidId === canonicalSeason.oldAndroidId) {
    reasons.push("same_old_android_id");
  }
  if (canonicalSeason && normalizedText(season.name).toLowerCase() === normalizedText(canonicalSeason.name).toLowerCase()) {
    reasons.push("same_name");
  }
  return [...new Set(reasons)];
}

async function loadActiveVoucherDuplicatesForFarm(workspaceId: string, farmId: string) {
  const rows = await db.select({
    clientRecordId: operationalRecords.clientRecordId,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.entityType, "voucher"),
    activeOperationalPayloadSql(operationalRecords.payload),
  ));
  const groups = new Map<string, DuplicateVoucherPreview>();
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const voucherNumber = normalizedText(payload.voucherNumber);
    if (!voucherNumber) continue;
    const entry = groups.get(voucherNumber) ?? {
      voucherNumber,
      recordIds: [],
      dates: [],
      amounts: [],
      accounts: [],
      statuses: [],
      imported: [],
      oldExpenseIds: [],
    };
    entry.recordIds.push(row.clientRecordId);
    entry.dates.push(normalizedText(payload.date));
    entry.amounts.push(Number(payload.amount ?? 0));
    entry.accounts.push(normalizedText(payload.accountId));
    entry.statuses.push(normalizedText(payload.status) || "active");
    entry.imported.push(Boolean(payload.originalVoucherNumber || payload.legacyVoucherNumber || payload.oldExpenseId));
    entry.oldExpenseIds.push(normalizedText(payload.oldExpenseId));
    groups.set(voucherNumber, entry);
  }
  return [...groups.values()].filter((group) => group.recordIds.length > 1).sort((left, right) => left.voucherNumber.localeCompare(right.voucherNumber));
}

async function loadProjectedVoucherDuplicates(workspaceId: string, canonicalFarmId: string, oldFarmIds: string[], oldSeasonIds: string[]) {
  const rows = await db.select({
    farmId: operationalRecords.farmId,
    seasonId: operationalRecords.seasonId,
    clientRecordId: operationalRecords.clientRecordId,
    entityType: operationalRecords.entityType,
    payload: operationalRecords.payload,
    sourceType: operationalRecords.sourceType,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.entityType, "voucher"),
    activeOperationalPayloadSql(operationalRecords.payload),
    or(
      eq(operationalRecords.farmId, canonicalFarmId),
      oldFarmIds.length ? inArray(operationalRecords.farmId, oldFarmIds) : undefined,
      oldSeasonIds.length ? inArray(operationalRecords.seasonId, oldSeasonIds) : undefined,
    ),
  ));
  const groups = new Map<string, DuplicateVoucherPreview>();
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const voucherNumber = normalizedText(payload.voucherNumber);
    if (!voucherNumber) continue;
    const projectedFarmId = oldFarmIds.includes(row.farmId ?? "") || oldSeasonIds.includes(row.seasonId ?? "") ? canonicalFarmId : row.farmId;
    if (projectedFarmId !== canonicalFarmId) continue;
    const entry = groups.get(voucherNumber) ?? {
      voucherNumber,
      recordIds: [],
      dates: [],
      amounts: [],
      accounts: [],
      statuses: [],
      imported: [],
      oldExpenseIds: [],
    };
    entry.recordIds.push(row.clientRecordId);
    entry.dates.push(normalizedText(payload.date));
    entry.amounts.push(Number(payload.amount ?? 0));
    entry.accounts.push(normalizedText(payload.accountId));
    entry.statuses.push(normalizedText(payload.status) || "active");
    entry.imported.push(Boolean(row.sourceType || payload.originalVoucherNumber || payload.legacyVoucherNumber || payload.oldExpenseId));
    entry.oldExpenseIds.push(normalizedText(payload.oldExpenseId));
    groups.set(voucherNumber, entry);
  }
  return [...groups.values()].filter((group) => group.recordIds.length > 1).sort((left, right) => left.voucherNumber.localeCompare(right.voucherNumber));
}

async function buildPreview(workspaceId: string, sessionId?: string | null): Promise<WorkspaceImportContextPreview> {
  const [farmRows, seasonRows, session, counts, deletedRows, mismatchRows] = await Promise.all([
    db.select().from(farms).where(eq(farms.workspaceId, workspaceId)).orderBy(desc(farms.updatedAt), farms.name),
    db.select().from(seasons).where(eq(seasons.workspaceId, workspaceId)).orderBy(desc(seasons.updatedAt), desc(seasons.startsOn)),
    loadSessionContext(workspaceId, sessionId),
    loadActiveRecordCounts(workspaceId),
    db.select({ count: sql<number>`count(*)::int` }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "voucher"),
      sql`NOT (${activeOperationalPayloadSql(operationalRecords.payload)})`,
    )),
    db.select({
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "voucher"),
      activeOperationalPayloadSql(operationalRecords.payload),
      or(
        eq(operationalRecords.sourceType, "expense"),
        sql`nullif(trim(coalesce(${operationalRecords.payload}->>'originalVoucherNumber', '')), '') IS NOT NULL`,
        sql`nullif(trim(coalesce(${operationalRecords.payload}->>'legacyVoucherNumber', '')), '') IS NOT NULL`
      ),
    )),
  ]);

  const visibleFarms = farmRows.filter((farm) => farm.deletedAt == null && farm.active);
  const canonicalFarm = (() => {
    const sessionFarm = visibleFarms.find((farm) => farm.id === session?.activeFarmId) ?? null;
    if (sessionFarm) return { farm: sessionFarm, reason: "session_active_farm" };
    const sorted = [...visibleFarms].sort((left, right) => {
      const countDelta = (counts.farmCounts.get(right.id) ?? 0) - (counts.farmCounts.get(left.id) ?? 0);
      if (countDelta !== 0) return countDelta;
      return right.updatedAt.getTime() - left.updatedAt.getTime();
    });
    return sorted[0] ? { farm: sorted[0], reason: "most_active_records" } : null;
  })();

  const duplicateFarmRows = farmRows
    .filter((farm) => !canonicalFarm || farm.id !== canonicalFarm.farm.id)
    .map((farm) => ({
      farm,
      reasons: farmCandidateReasons(farm, canonicalFarm?.farm ?? null),
    }))
    .filter((entry) => entry.reasons.length > 0);
  const candidateFarmIds = new Set(duplicateFarmRows.map((entry) => entry.farm.id));

  const canonicalSeason = (() => {
    if (!canonicalFarm) return null;
    const seasonsForFarm = seasonRows.filter((season) => season.farmId === canonicalFarm.farm.id && season.status !== "archived");
    const sessionSeason = seasonsForFarm.find((season) => season.id === session?.activeSeasonId && season.active) ?? null;
    if (sessionSeason) return { season: sessionSeason, reason: "session_active_season" };
    const sorted = [...seasonsForFarm].sort((left, right) => {
      const leftActive = left.active && left.status === "active" ? 1 : 0;
      const rightActive = right.active && right.status === "active" ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      const countDelta = (counts.seasonCounts.get(right.id) ?? 0) - (counts.seasonCounts.get(left.id) ?? 0);
      if (countDelta !== 0) return countDelta;
      return right.updatedAt.getTime() - left.updatedAt.getTime();
    });
    return sorted[0] ? { season: sorted[0], reason: "most_active_records" } : null;
  })();

  const duplicateSeasonRows = seasonRows
    .filter((season) => !canonicalSeason || season.id !== canonicalSeason.season.id)
    .map((season) => ({
      season,
      reasons: seasonCandidateReasons(season, canonicalSeason?.season ?? null, candidateFarmIds),
    }))
    .filter((entry) => entry.reasons.length > 0);
  const candidateSeasonIds = new Set(duplicateSeasonRows.map((entry) => entry.season.id));

  const remapRows = await db.execute(sql`
    SELECT entity_type, count(*)::int AS count
    FROM operational_records r
    WHERE r.workspace_id = ${workspaceId}
      AND ${activeOperationalPayloadSql(operationalRecords.payload)}
      AND coalesce(r.source_type, r.payload->>'source_type') <> ''
      AND (
        ${candidateFarmIds.size ? sql`r.farm_id = ANY(${[...candidateFarmIds]}::uuid[])` : sql`false`}
        OR ${candidateSeasonIds.size ? sql`r.season_id = ANY(${[...candidateSeasonIds]}::uuid[])` : sql`false`}
      )
    GROUP BY entity_type
    ORDER BY entity_type
  `);

  const voucherNumberMismatchesBefore = mismatchRows.filter((row) => {
    const payload = row.payload as Record<string, unknown>;
    const canonicalNumber = canonicalImportedVoucherNumber(payload);
    return canonicalNumber && normalizedText(payload.voucherNumber) !== canonicalNumber && payload.voucherNumberEdited !== true;
  }).length;

  const duplicateActiveVoucherNumbersBefore = canonicalFarm
    ? await loadActiveVoucherDuplicatesForFarm(workspaceId, canonicalFarm.farm.id)
    : [];
  const duplicateActiveVoucherNumbersProjected = canonicalFarm
    ? await loadProjectedVoucherDuplicates(workspaceId, canonicalFarm.farm.id, [...candidateFarmIds], [...candidateSeasonIds])
    : [];

  return {
    workspaceId,
    canonicalFarm: canonicalFarm ? {
      id: canonicalFarm.farm.id,
      name: canonicalFarm.farm.name,
      activeRecordCount: counts.farmCounts.get(canonicalFarm.farm.id) ?? 0,
      selectionReason: canonicalFarm.reason,
    } : null,
    canonicalSeason: canonicalSeason ? {
      id: canonicalSeason.season.id,
      name: canonicalSeason.season.name,
      activeRecordCount: counts.seasonCounts.get(canonicalSeason.season.id) ?? 0,
      selectionReason: canonicalSeason.reason,
    } : null,
    oldFarms: duplicateFarmRows.map(({ farm, reasons }) => ({
      id: farm.id,
      name: farm.name,
      active: farm.active,
      deletedAt: farm.deletedAt?.toISOString() ?? null,
      reasons,
      oldAndroidId: farm.oldAndroidId ?? null,
      sourceFileHash: farm.sourceFileHash ?? null,
      importBatchId: farm.importBatchId ?? null,
    })),
    oldSeasons: duplicateSeasonRows.map(({ season, reasons }) => ({
      id: season.id,
      farmId: season.farmId,
      name: season.name,
      status: season.status,
      active: season.active,
      reasons,
      oldAndroidId: season.oldAndroidId ?? null,
      sourceFileHash: season.sourceFileHash ?? null,
      importBatchId: season.importBatchId ?? null,
    })),
    recordsRemapPreview: (remapRows.rows as Array<Record<string, unknown>>).map((row) => ({
      entityType: String(row.entity_type ?? ""),
      count: Number(row.count ?? 0),
    })),
    voucherNumberMismatchesBefore,
    duplicateActiveVoucherNumbersBefore,
    duplicateActiveVoucherNumbersProjected,
    deletedRecordsExcludedCount: Number((deletedRows[0] as { count?: number } | undefined)?.count ?? 0),
  };
}

export async function previewWorkspaceImportContextRepair(workspaceId: string, sessionId?: string | null) {
  return buildPreview(workspaceId, sessionId);
}

export async function repairWorkspaceImportContext(args: {
  workspaceId: string;
  actorUserId: string;
  backupConfirmed: boolean;
  sessionId?: string | null;
}) {
  if (!args.backupConfirmed) throw new Error("Database backup confirmation is required.");
  const preview = await buildPreview(args.workspaceId, args.sessionId);
  if (!preview.canonicalFarm) {
    return {
      ...preview,
      createdFallbackSeason: false,
      repairedOperationalRecords: 0,
      repairedByEntity: [],
      voucherNumberMismatchesAfter: preview.voucherNumberMismatchesBefore,
      duplicateActiveVoucherNumbersAfter: preview.duplicateActiveVoucherNumbersBefore,
      farmsArchived: 0,
      seasonsArchived: 0,
      sessionsUpdated: 0,
    } satisfies WorkspaceImportContextRepairResult;
  }

  const txResult = await db.transaction(async (tx) => {
    const canonicalFarmId = preview.canonicalFarm!.id;
    let canonicalSeasonId = preview.canonicalSeason?.id ?? null;
    let createdFallbackSeason = false;

    if (!canonicalSeasonId) {
      const now = new Date();
      const year = now.getFullYear();
      const [season] = await tx.insert(seasons).values({
        workspaceId: args.workspaceId,
        farmId: canonicalFarmId,
        name: `Imported Season ${year}`,
        year,
        startsOn: `${year}-01-01`,
        status: "active",
        active: true,
        closed: false,
        notes: "Auto-created during Repair Workspace Import Context.",
        createdBy: args.actorUserId,
      }).returning();
      canonicalSeasonId = season?.id ?? null;
      createdFallbackSeason = true;
    }

    const oldFarmIds = preview.oldFarms.map((farm) => farm.id);
    const oldSeasonIds = preview.oldSeasons.map((season) => season.id);
    const repairRows = oldFarmIds.length || oldSeasonIds.length
      ? await tx.select({
        id: operationalRecords.id,
        clientRecordId: operationalRecords.clientRecordId,
        entityType: operationalRecords.entityType,
        farmId: operationalRecords.farmId,
        seasonId: operationalRecords.seasonId,
        payload: operationalRecords.payload,
      }).from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, args.workspaceId),
        activeOperationalPayloadSql(operationalRecords.payload),
        sql`coalesce(${operationalRecords.sourceType}, ${operationalRecords.payload}->>'source_type') <> ''`,
        or(
          oldFarmIds.length ? inArray(operationalRecords.farmId, oldFarmIds) : undefined,
          oldSeasonIds.length ? inArray(operationalRecords.seasonId, oldSeasonIds) : undefined,
        ),
      ))
      : [];

    const repairedByEntity = new Map<string, number>();
    const now = new Date();
    for (const row of repairRows) {
      if (!importedEntityTypes.has(row.entityType)) continue;
      const payload = { ...(row.payload as Record<string, unknown>) };
      payload.farmId = canonicalFarmId;
      payload.farm_id = canonicalFarmId;
      const shouldWriteSeason = Boolean(
        canonicalSeasonId
        && (
          row.seasonId
          || normalizedText(payload.seasonId)
          || normalizedText(payload.season_id)
          || seasonScopedEntityTypes.has(row.entityType)
        )
      );
      if (shouldWriteSeason && canonicalSeasonId) {
        payload.seasonId = canonicalSeasonId;
        payload.season_id = canonicalSeasonId;
      }
      if (row.entityType === "voucher" && payload.voucherNumberEdited !== true) {
        const canonicalNumber = canonicalImportedVoucherNumber(payload);
        if (canonicalNumber) payload.voucherNumber = canonicalNumber;
      }
      payload.updatedAt = now.toISOString();
      await tx.update(operationalRecords).set({
        farmId: canonicalFarmId,
        seasonId: shouldWriteSeason ? canonicalSeasonId : row.seasonId,
        payload,
        clientUpdatedAt: now,
        updatedAt: now,
      }).where(eq(operationalRecords.id, row.id));
      repairedByEntity.set(row.entityType, (repairedByEntity.get(row.entityType) ?? 0) + 1);
    }

    const archivedFarms = oldFarmIds.length
      ? await tx.update(farms).set({
        active: false,
        updatedAt: now,
      }).where(and(
        eq(farms.workspaceId, args.workspaceId),
        inArray(farms.id, oldFarmIds),
      )).returning({ id: farms.id })
      : [];
    const archivedSeasons = oldSeasonIds.length
      ? await tx.update(seasons).set({
        active: false,
        status: "archived",
        closed: true,
        updatedAt: now,
      }).where(and(
        eq(seasons.workspaceId, args.workspaceId),
        inArray(seasons.id, oldSeasonIds),
      )).returning({ id: seasons.id })
      : [];

    const sessionRows = await tx.update(userSessions).set({
      activeFarmId: canonicalFarmId,
      activeSeasonId: canonicalSeasonId,
    }).where(eq(userSessions.workspaceId, args.workspaceId)).returning({ id: userSessions.id });

    await tx.insert(auditLogs).values({
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: "admin.migration_import.repair_workspace_import_context",
      entityType: "migration_import",
      details: {
        canonicalFarmId,
        canonicalSeasonId,
        oldFarmIds,
        oldSeasonIds,
        repairedByEntity: [...repairedByEntity.entries()].map(([entityType, count]) => ({ entityType, count })),
        voucherNumberMismatchesBefore: preview.voucherNumberMismatchesBefore,
        duplicateActiveVoucherNumbersBefore: preview.duplicateActiveVoucherNumbersProjected.length,
      },
    });

    return {
      createdFallbackSeason,
      repairedOperationalRecords: repairRows.length,
      repairedByEntity: [...repairedByEntity.entries()].map(([entityType, count]) => ({ entityType, count })),
      farmsArchived: archivedFarms.length,
      seasonsArchived: archivedSeasons.length,
      sessionsUpdated: sessionRows.length,
    };
  });
  const afterPreview = await buildPreview(args.workspaceId, args.sessionId);
  return {
    ...afterPreview,
    createdFallbackSeason: txResult.createdFallbackSeason,
    repairedOperationalRecords: txResult.repairedOperationalRecords,
    repairedByEntity: txResult.repairedByEntity,
    voucherNumberMismatchesAfter: afterPreview.voucherNumberMismatchesBefore,
    duplicateActiveVoucherNumbersAfter: afterPreview.duplicateActiveVoucherNumbersProjected,
    farmsArchived: txResult.farmsArchived,
    seasonsArchived: txResult.seasonsArchived,
    sessionsUpdated: txResult.sessionsUpdated,
  } satisfies WorkspaceImportContextRepairResult;
}
