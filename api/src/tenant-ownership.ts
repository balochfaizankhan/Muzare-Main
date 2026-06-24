import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "./db/client.js";
import { farms, operationalRecords, seasons } from "./db/schema.js";
import { visibleFarmWhere } from "./farm-visibility.js";

const virtualAccountIds = new Set(["local-cash", "local-partner"]);

export type TenantReferences = {
  farmId?: string | null;
  seasonId?: string | null;
  accountId?: unknown;
  partnerAccountId?: unknown;
  fromAccountId?: unknown;
  toAccountId?: unknown;
  ledgerId?: unknown;
  labourerId?: unknown;
  groupId?: unknown;
  vehicleId?: unknown;
  dateTypeIds?: unknown;
};

async function hasOperationalReference(workspaceId: string, entityTypes: string[], clientRecordId: string, farmId?: string | null, seasonId?: string | null) {
  const [record] = await db.select({ id: operationalRecords.id }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    inArray(operationalRecords.entityType, entityTypes),
    eq(operationalRecords.clientRecordId, clientRecordId),
    farmId ? eq(operationalRecords.farmId, farmId) : undefined,
    seasonId ? eq(operationalRecords.seasonId, seasonId) : undefined,
  )).limit(1);
  return Boolean(record);
}

export async function validateTenantReferences(workspaceId: string, references: TenantReferences): Promise<string | null> {
  if (references.farmId) {
    const [farm] = await db.select({ id: farms.id }).from(farms)
      .where(await visibleFarmWhere(workspaceId, { farmId: references.farmId }))
      .limit(1);
    if (!farm) return "Farm does not belong to the selected workspace.";
  }
  if (references.seasonId) {
    if (!references.farmId) return "A season requires a farm in the selected workspace.";
    const [season] = await db.select({ id: seasons.id }).from(seasons)
      .innerJoin(farms, and(eq(farms.id, seasons.farmId), eq(farms.workspaceId, workspaceId)))
      .where(and(eq(seasons.id, references.seasonId), eq(seasons.farmId, references.farmId), eq(seasons.status, "active"), isNull(farms.deletedAt)))
      .limit(1);
    if (!season) return "Season is not active in the selected workspace farm.";
  }
  for (const accountId of [references.accountId, references.partnerAccountId, references.fromAccountId, references.toAccountId]) {
    if (typeof accountId === "string" && !virtualAccountIds.has(accountId)
      && ![...virtualAccountIds].some((id) => references.farmId && accountId === `${references.farmId}:${id}`)
      && ![...virtualAccountIds].some((id) => references.seasonId && accountId === `${references.seasonId}:${id}`)
      && !(await hasOperationalReference(workspaceId, ["account"], accountId, references.farmId, references.seasonId))) {
      return "Account does not belong to the selected workspace.";
    }
  }
  if (typeof references.ledgerId === "string"
    && !(await hasOperationalReference(workspaceId, ["partnerEntry"], references.ledgerId, references.farmId, references.seasonId))) {
    return "Ledger entry does not belong to the selected workspace.";
  }
  if (typeof references.labourerId === "string"
    && !(await hasOperationalReference(workspaceId, ["labourer"], references.labourerId, references.farmId))) {
    return "Labour does not belong to the selected workspace.";
  }
  if (typeof references.groupId === "string"
    && !(await hasOperationalReference(workspaceId, ["labourGroup"], references.groupId, references.farmId))) {
    return "Labour group does not belong to the selected workspace.";
  }
  if (typeof references.vehicleId === "string"
    && !(await hasOperationalReference(workspaceId, ["vehicle"], references.vehicleId, references.farmId, references.seasonId))) {
    return "Vehicle does not belong to the selected workspace farm and season.";
  }
  if (Array.isArray(references.dateTypeIds)) {
    for (const dateTypeId of references.dateTypeIds) {
      if (typeof dateTypeId !== "string"
        || !(await hasOperationalReference(workspaceId, ["dateType"], dateTypeId, references.farmId, references.seasonId))) {
        return "Date type does not belong to the selected workspace farm and season.";
      }
    }
  }
  return null;
}

export async function approvalEntityBelongsToWorkspace(workspaceId: string, entityType: string, entityId: string) {
  const recordType = entityType === "expense" ? "voucher" : entityType;
  return hasOperationalReference(workspaceId, [recordType], entityId);
}
