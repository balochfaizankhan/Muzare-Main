import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db/client.js";
import { farms, operationalRecords, seasons } from "./db/schema.js";

const virtualAccountIds = new Set(["local-cash", "local-partner"]);

export type TenantReferences = {
  farmId?: string | null;
  seasonId?: string | null;
  accountId?: unknown;
  ledgerId?: unknown;
  labourerId?: unknown;
  groupId?: unknown;
};

async function hasOperationalReference(workspaceId: string, entityTypes: string[], clientRecordId: string) {
  const [record] = await db.select({ id: operationalRecords.id }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    inArray(operationalRecords.entityType, entityTypes),
    eq(operationalRecords.clientRecordId, clientRecordId),
  )).limit(1);
  return Boolean(record);
}

export async function validateTenantReferences(workspaceId: string, references: TenantReferences): Promise<string | null> {
  if (references.farmId) {
    const [farm] = await db.select({ id: farms.id }).from(farms)
      .where(and(eq(farms.id, references.farmId), eq(farms.workspaceId, workspaceId), eq(farms.active, true)))
      .limit(1);
    if (!farm) return "Farm does not belong to the selected workspace.";
  }
  if (references.seasonId) {
    if (!references.farmId) return "A season requires a farm in the selected workspace.";
    const [season] = await db.select({ id: seasons.id }).from(seasons)
      .innerJoin(farms, and(eq(farms.id, seasons.farmId), eq(farms.workspaceId, workspaceId)))
      .where(and(eq(seasons.id, references.seasonId), eq(seasons.farmId, references.farmId), eq(seasons.status, "active")))
      .limit(1);
    if (!season) return "Season is not active in the selected workspace farm.";
  }
  if (typeof references.accountId === "string" && !virtualAccountIds.has(references.accountId)
    && ![...virtualAccountIds].some((id) => references.farmId && references.accountId === `${references.farmId}:${id}`)
    && ![...virtualAccountIds].some((id) => references.seasonId && references.accountId === `${references.seasonId}:${id}`)
    && !(await hasOperationalReference(workspaceId, ["account"], references.accountId))) {
    return "Account does not belong to the selected workspace.";
  }
  if (typeof references.ledgerId === "string"
    && !(await hasOperationalReference(workspaceId, ["partnerEntry"], references.ledgerId))) {
    return "Ledger entry does not belong to the selected workspace.";
  }
  if (typeof references.labourerId === "string"
    && !(await hasOperationalReference(workspaceId, ["labourer"], references.labourerId))) {
    return "Labour does not belong to the selected workspace.";
  }
  if (typeof references.groupId === "string"
    && !(await hasOperationalReference(workspaceId, ["labourGroup"], references.groupId))) {
    return "Labour group does not belong to the selected workspace.";
  }
  return null;
}

export async function approvalEntityBelongsToWorkspace(workspaceId: string, entityType: string, entityId: string) {
  const recordType = entityType === "expense" ? "voucher" : entityType;
  return hasOperationalReference(workspaceId, [recordType], entityId);
}
