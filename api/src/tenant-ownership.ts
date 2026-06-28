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

export type TenantReferenceValidationError = {
  code: string;
  entity: string;
  entityId: string | null;
  entityName: string | null;
  workspaceId: string;
  farmId: string | null;
  seasonId: string | null;
  expectedWorkspace: string;
  actualWorkspace: string | null;
  message: string;
};

type OperationalReferenceRecord = {
  id: string;
  clientRecordId: string;
  workspaceId: string;
  farmId: string | null;
  seasonId: string | null;
  entityType: string;
  payload: Record<string, unknown>;
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

async function findOperationalReference(entityTypes: string[], clientRecordId: string) {
  const [record] = await db.select({
    id: operationalRecords.id,
    clientRecordId: operationalRecords.clientRecordId,
    workspaceId: operationalRecords.workspaceId,
    farmId: operationalRecords.farmId,
    seasonId: operationalRecords.seasonId,
    entityType: operationalRecords.entityType,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    inArray(operationalRecords.entityType, entityTypes),
    eq(operationalRecords.clientRecordId, clientRecordId),
  )).limit(1);
  return (record ?? null) as OperationalReferenceRecord | null;
}

function payloadName(record: OperationalReferenceRecord | null, candidates: string[]) {
  if (!record) return null;
  for (const key of candidates) {
    const value = record.payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function buildReferenceError({
  code,
  entity,
  entityId,
  entityName,
  workspaceId,
  farmId,
  seasonId,
  expectedWorkspace,
  actualWorkspace,
  message,
}: TenantReferenceValidationError): TenantReferenceValidationError {
  return {
    code,
    entity,
    entityId,
    entityName,
    workspaceId,
    farmId,
    seasonId,
    expectedWorkspace,
    actualWorkspace,
    message,
  };
}

function displayEntityName(entity: string, entityName: string | null, entityId: string) {
  return entityName ? `${entity} '${entityName}'` : `${entity} ${entityId}`;
}

async function validateOperationalEntityReference({
  workspaceId,
  farmId,
  seasonId,
  clientRecordId,
  entity,
  entityTypes,
  nameKeys,
}: {
  workspaceId: string;
  farmId?: string | null;
  seasonId?: string | null;
  clientRecordId: string;
  entity: string;
  entityTypes: string[];
  nameKeys: string[];
}): Promise<TenantReferenceValidationError | null> {
  const exactMatch = await hasOperationalReference(workspaceId, entityTypes, clientRecordId, farmId, seasonId);
  if (exactMatch) return null;
  const referenced = await findOperationalReference(entityTypes, clientRecordId);
  const entityName = payloadName(referenced, nameKeys);
  if (!referenced) {
    return buildReferenceError({
      code: "entity_not_found",
      entity,
      entityId: clientRecordId,
      entityName,
      workspaceId,
      farmId: farmId ?? null,
      seasonId: seasonId ?? null,
      expectedWorkspace: workspaceId,
      actualWorkspace: null,
      message: `${entity[0]!.toUpperCase()}${entity.slice(1)} id ${clientRecordId} does not exist.`,
    });
  }
  if (referenced.payload.deletedAt) {
    return buildReferenceError({
      code: "entity_deleted",
      entity,
      entityId: clientRecordId,
      entityName,
      workspaceId,
      farmId: farmId ?? null,
      seasonId: seasonId ?? null,
      expectedWorkspace: workspaceId,
      actualWorkspace: referenced.workspaceId,
      message: `${displayEntityName(entity, entityName, clientRecordId)} belongs to deleted import data.`,
    });
  }
  if (referenced.workspaceId !== workspaceId) {
    return buildReferenceError({
      code: "entity_workspace_mismatch",
      entity,
      entityId: clientRecordId,
      entityName,
      workspaceId,
      farmId: farmId ?? null,
      seasonId: seasonId ?? null,
      expectedWorkspace: workspaceId,
      actualWorkspace: referenced.workspaceId,
      message: `${displayEntityName(entity, entityName, clientRecordId)} belongs to another workspace.`,
    });
  }
  if (farmId && referenced.farmId !== farmId) {
    return buildReferenceError({
      code: "entity_farm_mismatch",
      entity,
      entityId: clientRecordId,
      entityName,
      workspaceId,
      farmId,
      seasonId: seasonId ?? null,
      expectedWorkspace: workspaceId,
      actualWorkspace: referenced.workspaceId,
      message: `${displayEntityName(entity, entityName, clientRecordId)} belongs to another farm.`,
    });
  }
  if (seasonId && referenced.seasonId !== seasonId) {
    return buildReferenceError({
      code: "entity_season_mismatch",
      entity,
      entityId: clientRecordId,
      entityName,
      workspaceId,
      farmId: farmId ?? null,
      seasonId,
      expectedWorkspace: workspaceId,
      actualWorkspace: referenced.workspaceId,
      message: `${displayEntityName(entity, entityName, clientRecordId)} belongs to another season.`,
    });
  }
  return buildReferenceError({
    code: "entity_scope_mismatch",
    entity,
    entityId: clientRecordId,
    entityName,
    workspaceId,
    farmId: farmId ?? null,
    seasonId: seasonId ?? null,
    expectedWorkspace: workspaceId,
    actualWorkspace: referenced.workspaceId,
    message: `${displayEntityName(entity, entityName, clientRecordId)} does not belong to the selected workspace farm and season.`,
  });
}

export async function validateTenantReferences(workspaceId: string, references: TenantReferences): Promise<string | null> {
  const detailedError = await validateTenantReferencesDetailed(workspaceId, references);
  return detailedError?.message ?? null;
}

export async function validateTenantReferencesDetailed(workspaceId: string, references: TenantReferences): Promise<TenantReferenceValidationError | null> {
  if (references.farmId) {
    const [farm] = await db.select({ id: farms.id }).from(farms)
      .where(await visibleFarmWhere(workspaceId, { farmId: references.farmId }))
      .limit(1);
    if (!farm) {
      const [farmInAnyWorkspace] = await db.select({ id: farms.id, workspaceId: farms.workspaceId, name: farms.name }).from(farms)
        .where(eq(farms.id, references.farmId)).limit(1);
      return buildReferenceError({
        code: farmInAnyWorkspace ? "farm_workspace_mismatch" : "farm_not_found",
        entity: "farm",
        entityId: references.farmId,
        entityName: farmInAnyWorkspace?.name ?? null,
        workspaceId,
        farmId: references.farmId,
        seasonId: references.seasonId ?? null,
        expectedWorkspace: workspaceId,
        actualWorkspace: farmInAnyWorkspace?.workspaceId ?? null,
        message: farmInAnyWorkspace
          ? `Farm '${farmInAnyWorkspace.name}' belongs to another workspace.`
          : `Farm id ${references.farmId} does not exist.`,
      });
    }
  }
  if (references.seasonId) {
    if (!references.farmId) {
      return buildReferenceError({
        code: "season_requires_farm",
        entity: "season",
        entityId: references.seasonId,
        entityName: null,
        workspaceId,
        farmId: null,
        seasonId: references.seasonId,
        expectedWorkspace: workspaceId,
        actualWorkspace: null,
        message: "A season requires a farm in the selected workspace.",
      });
    }
    const [season] = await db.select({ id: seasons.id }).from(seasons)
      .innerJoin(farms, and(eq(farms.id, seasons.farmId), eq(farms.workspaceId, workspaceId)))
      .where(and(eq(seasons.id, references.seasonId), eq(seasons.farmId, references.farmId), eq(seasons.status, "active"), isNull(farms.deletedAt)))
      .limit(1);
    if (!season) {
      const [anySeason] = await db.select({
        id: seasons.id,
        name: seasons.name,
        workspaceId: farms.workspaceId,
        farmId: seasons.farmId,
        status: seasons.status,
      }).from(seasons).innerJoin(farms, eq(farms.id, seasons.farmId)).where(eq(seasons.id, references.seasonId)).limit(1);
      return buildReferenceError({
        code: anySeason ? "season_scope_mismatch" : "season_not_found",
        entity: "season",
        entityId: references.seasonId,
        entityName: anySeason?.name ?? null,
        workspaceId,
        farmId: references.farmId,
        seasonId: references.seasonId,
        expectedWorkspace: workspaceId,
        actualWorkspace: anySeason?.workspaceId ?? null,
        message: anySeason
          ? `Season '${anySeason.name}' is not active in the selected workspace farm.`
          : `Season id ${references.seasonId} does not exist.`,
      });
    }
  }
  for (const accountId of [references.accountId, references.partnerAccountId, references.fromAccountId, references.toAccountId]) {
    if (typeof accountId === "string" && !virtualAccountIds.has(accountId)
      && ![...virtualAccountIds].some((id) => references.farmId && accountId === `${references.farmId}:${id}`)
      && ![...virtualAccountIds].some((id) => references.seasonId && accountId === `${references.seasonId}:${id}`)
      ) {
      const accountError = await validateOperationalEntityReference({
        workspaceId,
        farmId: references.farmId,
        seasonId: references.seasonId,
        clientRecordId: accountId,
        entity: "payment account",
        entityTypes: ["account"],
        nameKeys: ["name"],
      });
      if (accountError) return accountError;
    }
  }
  if (typeof references.ledgerId === "string") {
    const ledgerError = await validateOperationalEntityReference({
      workspaceId,
      farmId: references.farmId,
      seasonId: references.seasonId,
      clientRecordId: references.ledgerId,
      entity: "ledger entry",
      entityTypes: ["partnerEntry"],
      nameKeys: ["partnerName", "fromPartner", "toPartner"],
    });
    if (ledgerError) return ledgerError;
  }
  if (typeof references.labourerId === "string") {
    const labourerError = await validateOperationalEntityReference({
      workspaceId,
      farmId: references.farmId,
      clientRecordId: references.labourerId,
      entity: "labour",
      entityTypes: ["labourer"],
      nameKeys: ["name"],
    });
    if (labourerError) return labourerError;
  }
  if (typeof references.groupId === "string") {
    const groupError = await validateOperationalEntityReference({
      workspaceId,
      farmId: references.farmId,
      clientRecordId: references.groupId,
      entity: "labour group",
      entityTypes: ["labourGroup"],
      nameKeys: ["name"],
    });
    if (groupError) return groupError;
  }
  if (typeof references.vehicleId === "string") {
    const vehicleError = await validateOperationalEntityReference({
      workspaceId,
      farmId: references.farmId,
      seasonId: references.seasonId,
      clientRecordId: references.vehicleId,
      entity: "vehicle",
      entityTypes: ["vehicle"],
      nameKeys: ["number", "name"],
    });
    if (vehicleError) return vehicleError;
  }
  if (Array.isArray(references.dateTypeIds)) {
    for (const dateTypeId of references.dateTypeIds) {
      if (typeof dateTypeId !== "string") {
        return buildReferenceError({
          code: "date_type_not_found",
          entity: "date type",
          entityId: dateTypeId == null ? null : String(dateTypeId),
          entityName: null,
          workspaceId,
          farmId: references.farmId ?? null,
          seasonId: references.seasonId ?? null,
          expectedWorkspace: workspaceId,
          actualWorkspace: null,
          message: `Date type id ${String(dateTypeId)} does not exist.`,
        });
      }
      const dateTypeError = await validateOperationalEntityReference({
        workspaceId,
        farmId: references.farmId,
        seasonId: references.seasonId,
        clientRecordId: dateTypeId,
        entity: "date type",
        entityTypes: ["dateType"],
        nameKeys: ["name"],
      });
      if (dateTypeError) return dateTypeError;
    }
  }
  return null;
}

export async function approvalEntityBelongsToWorkspace(workspaceId: string, entityType: string, entityId: string) {
  const recordType = entityType === "expense" ? "voucher" : entityType;
  return hasOperationalReference(workspaceId, [recordType], entityId);
}
