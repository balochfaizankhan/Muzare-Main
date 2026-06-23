import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditLogs, farms, operationalRecords, seasons, userSessions } from "../db/schema.js";

type FarmRow = typeof farms.$inferSelect;
type SeasonRow = typeof seasons.$inferSelect;

export type WorkspaceContextState = {
  farms: FarmRow[];
  seasons: SeasonRow[];
  activeFarmId: string | null;
  activeSeasonId: string | null;
  needsRepair: boolean;
  contextWarning: string | null;
};

function pickFarm(records: FarmRow[], preferredId: string | null | undefined) {
  return (preferredId ? records.find((farm) => farm.id === preferredId) : null) ?? records[0] ?? null;
}

function pickSeason(records: SeasonRow[], preferredId: string | null | undefined) {
  return (preferredId ? records.find((season) => season.id === preferredId && season.status === "active") : null)
    ?? records.find((season) => season.status === "active")
    ?? records.find((season) => season.status !== "archived")
    ?? null;
}

async function validFarms(workspaceId: string) {
  const activeRecords = await db.select()
    .from(farms)
    .where(and(eq(farms.workspaceId, workspaceId), eq(farms.active, true), isNull(farms.deletedAt)))
    .orderBy(farms.name);
  if (activeRecords.length) return activeRecords;
  return db.select()
    .from(farms)
    .where(and(eq(farms.workspaceId, workspaceId), isNull(farms.deletedAt)))
    .orderBy(farms.name);
}

async function farmSeasons(workspaceId: string, farmId: string) {
  return db.select()
    .from(seasons)
    .where(and(eq(seasons.workspaceId, workspaceId), eq(seasons.farmId, farmId)))
    .orderBy(desc(seasons.startsOn));
}

export async function resolveWorkspaceContext(workspaceId: string, sessionId?: string | null): Promise<WorkspaceContextState> {
  const records = await validFarms(workspaceId);
  const [session] = sessionId
    ? await db.select({ activeFarmId: userSessions.activeFarmId, activeSeasonId: userSessions.activeSeasonId })
      .from(userSessions)
      .where(eq(userSessions.id, sessionId))
      .limit(1)
    : [];
  const selectedFarm = pickFarm(records, session?.activeFarmId);
  const farmId = selectedFarm?.id ?? null;
  const seasonsForFarm = farmId ? await farmSeasons(workspaceId, farmId) : [];
  const selectedSeason = pickSeason(seasonsForFarm, session?.activeSeasonId);
  const seasonId = selectedSeason?.id ?? null;
  const invalidFarm = Boolean(session?.activeFarmId && session.activeFarmId !== farmId);
  const invalidSeason = Boolean(session?.activeSeasonId && session.activeSeasonId !== seasonId);

  if (sessionId && (invalidFarm || invalidSeason)) {
    await db.update(userSessions).set({
      activeFarmId: farmId,
      activeSeasonId: seasonId,
    }).where(eq(userSessions.id, sessionId));
  } else if (sessionId && !session?.activeFarmId && farmId) {
    await db.update(userSessions).set({
      activeFarmId: farmId,
      activeSeasonId: seasonId,
    }).where(eq(userSessions.id, sessionId));
  }

  const needsRepair = Boolean(farmId && seasonsForFarm.length > 0 && !seasonId)
    || Boolean(!farmId && records.length > 0)
    || invalidFarm
    || invalidSeason;
  const contextWarning = !records.length
    ? "No active farm is available for this workspace."
    : !farmId
      ? "Workspace context needs repair. Select or repair an active farm."
      : !seasonId
        ? "Workspace context needs repair. No usable season is selected for the active farm."
        : (invalidFarm || invalidSeason)
          ? "Workspace context was repaired automatically."
          : null;

  return {
    farms: records,
    seasons: seasonsForFarm,
    activeFarmId: farmId,
    activeSeasonId: seasonId,
    needsRepair,
    contextWarning,
  };
}

export type WorkspaceRepairResult = {
  repairedRecords: number;
  activeFarmId: string | null;
  activeSeasonId: string | null;
  activeFarmName: string | null;
  activeSeasonName: string | null;
  contextWarning: string | null;
  message: string;
};

export async function repairWorkspaceContext(workspaceId: string, actorUserId: string, sessionId?: string | null): Promise<WorkspaceRepairResult> {
  return db.transaction(async (tx) => {
    const activeFarms = await tx.select()
      .from(farms)
      .where(and(eq(farms.workspaceId, workspaceId), eq(farms.active, true), isNull(farms.deletedAt)))
      .orderBy(farms.name);
    const fallbackFarms = activeFarms.length ? activeFarms : await tx.select()
      .from(farms)
      .where(and(eq(farms.workspaceId, workspaceId), isNull(farms.deletedAt)))
      .orderBy(farms.name);
    const targetFarm = fallbackFarms[0] ?? null;
    if (!targetFarm) {
      return {
        repairedRecords: 0,
        activeFarmId: null,
        activeSeasonId: null,
        activeFarmName: null,
        activeSeasonName: null,
        contextWarning: "No farm exists in this workspace yet.",
        message: "No farm could be selected. Create or restore a farm first.",
      };
    }

    const existingSeasons = await tx.select()
      .from(seasons)
      .where(and(eq(seasons.workspaceId, workspaceId), eq(seasons.farmId, targetFarm.id)))
      .orderBy(desc(seasons.startsOn));

    let targetSeason = pickSeason(existingSeasons, null);
    const importYear = new Date().getFullYear();
    if (!targetSeason) {
      const [createdSeason] = await tx.insert(seasons).values({
        workspaceId,
        farmId: targetFarm.id,
        name: `Imported Season ${importYear}`,
        year: importYear,
        startsOn: `${importYear}-01-01`,
        status: "active",
        active: true,
        closed: false,
        notes: "Auto-created during workspace context repair.",
        createdBy: actorUserId,
      }).returning();
      targetSeason = createdSeason ?? null;
    } else if (targetSeason.status !== "active" || targetSeason.active !== true) {
      await tx.update(seasons).set({
        status: "planned",
        active: false,
        updatedAt: new Date(),
      }).where(and(eq(seasons.workspaceId, workspaceId), eq(seasons.farmId, targetFarm.id), eq(seasons.status, "active"), ne(seasons.id, targetSeason.id)));
      const [promotedSeason] = await tx.update(seasons).set({
        status: "active",
        active: true,
        closed: false,
        updatedAt: new Date(),
      }).where(eq(seasons.id, targetSeason.id)).returning();
      targetSeason = promotedSeason ?? targetSeason;
    }

    const brokenCountResult = await tx.execute(sql`
      SELECT count(*)::int AS count
      FROM operational_records r
      WHERE r.workspace_id = ${workspaceId}
        AND coalesce(r.source_type, r.payload->>'source_type') IS NOT NULL
        AND (
          r.farm_id IS NULL
          OR r.season_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM farms f
            WHERE f.id = r.farm_id
              AND f.workspace_id = r.workspace_id
              AND f.deleted_at IS NULL
          )
          OR NOT EXISTS (
            SELECT 1 FROM seasons s
            WHERE s.id = r.season_id
              AND s.workspace_id = r.workspace_id
              AND s.farm_id = ${targetFarm.id}
              AND s.status <> 'archived'
          )
        )
    `);
    const repairedRecords = Number((brokenCountResult.rows[0] as Record<string, unknown> | undefined)?.count ?? 0);

    if (targetSeason) {
      await tx.execute(sql`
        UPDATE operational_records r
        SET farm_id = ${targetFarm.id},
            season_id = ${targetSeason.id},
            updated_at = now()
        WHERE r.workspace_id = ${workspaceId}
          AND coalesce(r.source_type, r.payload->>'source_type') IS NOT NULL
          AND (
            r.farm_id IS NULL
            OR r.season_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM farms f
              WHERE f.id = r.farm_id
                AND f.workspace_id = r.workspace_id
                AND f.deleted_at IS NULL
            )
            OR NOT EXISTS (
              SELECT 1 FROM seasons s
              WHERE s.id = r.season_id
                AND s.workspace_id = r.workspace_id
                AND s.farm_id = r.farm_id
                AND s.status <> 'archived'
            )
          )
      `);
    }

    if (sessionId) {
      await tx.update(userSessions).set({
        activeFarmId: targetFarm.id,
        activeSeasonId: targetSeason?.id ?? null,
      }).where(eq(userSessions.id, sessionId));
    }

    await tx.update(userSessions).set({
      activeFarmId: sql`CASE
        WHEN ${targetFarm.id} IS NOT NULL
         AND (
           active_farm_id IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM farms f
             WHERE f.id = user_sessions.active_farm_id
               AND f.workspace_id = user_sessions.workspace_id
               AND f.deleted_at IS NULL
               AND f.active = true
           )
         )
        THEN ${targetFarm.id}
        ELSE active_farm_id
      END`,
      activeSeasonId: targetSeason?.id
        ? sql`CASE
          WHEN active_season_id IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM seasons s
             WHERE s.id = user_sessions.active_season_id
               AND s.workspace_id = user_sessions.workspace_id
               AND s.farm_id = coalesce(user_sessions.active_farm_id, ${targetFarm.id})
               AND s.status <> 'archived'
           )
          THEN ${targetSeason.id}
          ELSE active_season_id
        END`
        : sql`NULL`,
    }).where(eq(userSessions.workspaceId, workspaceId));

    await tx.insert(auditLogs).values({
      workspaceId,
      userId: actorUserId,
      actorUserId,
      farmId: targetFarm.id,
      action: "workspace.context.repaired",
      entityType: "workspace_context",
      details: {
        activeFarmId: targetFarm.id,
        activeSeasonId: targetSeason?.id ?? null,
        repairedRecords,
      },
    });

    return {
      repairedRecords,
      activeFarmId: targetFarm.id,
      activeSeasonId: targetSeason?.id ?? null,
      activeFarmName: targetFarm.name,
      activeSeasonName: targetSeason?.name ?? null,
      contextWarning: targetSeason ? null : "A valid season could not be selected automatically.",
      message: targetSeason
        ? "Workspace context repaired successfully."
        : "Farm context repaired, but no usable season could be selected automatically.",
    };
  });
}

export function asPayloadRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

