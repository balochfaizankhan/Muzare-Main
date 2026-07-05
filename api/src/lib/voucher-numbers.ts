import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { expenseVoucherSequences, operationalRecords } from "../db/schema.js";
import { activeOperationalPayloadSql } from "../operational-record-state.js";

type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

function voucherScopeKey(farmId: string, seasonId?: string | null) {
  return seasonId ? `season:${seasonId}` : `farm:${farmId}:general`;
}

export function parseVoucherSequenceNumber(value: string) {
  const match = /^V-(\d+)$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

export function normalizeVoucherNumber(value: string) {
  const parsed = parseVoucherSequenceNumber(value);
  return parsed ? `V-${String(parsed).padStart(4, "0")}` : null;
}

export function duplicateVoucherNumberDetails(workspaceId: string, voucherNumber: string, existingRecordId?: string | null) {
  return {
    code: "duplicate_voucher_number",
    entity: "voucher",
    entityId: existingRecordId ?? null,
    entityName: voucherNumber,
    workspaceId,
    expectedWorkspace: workspaceId,
    actualWorkspace: workspaceId,
  };
}

export function normalExpenseVoucherWhereSql(payloadColumn = operationalRecords.payload) {
  return sql`coalesce(${payloadColumn}->>'voucherPurpose', '') <> 'labour_wage_settlement'
    and coalesce(${payloadColumn}->>'nonCashSettlement', 'false') <> 'true'`;
}

export async function findExistingVoucherByNumber(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  voucherNumber: string,
  excludeRecordId?: string,
) {
  const filters = [
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.entityType, "voucher"),
    activeOperationalPayloadSql(operationalRecords.payload),
    normalExpenseVoucherWhereSql(),
    sql`coalesce(
      case
        when coalesce(${operationalRecords.payload}->>'originalVoucherNumber', '') <> ''
          and coalesce(${operationalRecords.payload}->>'voucherNumberEdited', 'false') <> 'true'
          then ${operationalRecords.payload}->>'originalVoucherNumber'
        else ${operationalRecords.payload}->>'voucherNumber'
      end,
      ''
    ) = ${voucherNumber}`,
  ];
  if (excludeRecordId) {
    filters.push(sql`${operationalRecords.clientRecordId} <> ${excludeRecordId}`);
    filters.push(sql`${operationalRecords.id}::text <> ${excludeRecordId}`);
  }
  const [existingVoucher] = await tx.select({
    id: operationalRecords.id,
    clientRecordId: operationalRecords.clientRecordId,
    workspaceId: operationalRecords.workspaceId,
    farmId: operationalRecords.farmId,
    seasonId: operationalRecords.seasonId,
    sourceType: operationalRecords.sourceType,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(...filters)).limit(1);
  return existingVoucher ?? null;
}

export async function bumpVoucherSequence(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  seasonId: string | null | undefined,
  voucherNumber: string,
) {
  const parsedNumber = parseVoucherSequenceNumber(voucherNumber);
  if (!parsedNumber) throw new Error("Voucher numbers must use the format V-0001.");
  const scopeKey = voucherScopeKey(farmId, seasonId);
  const [current] = await tx.select({
    lastNumber: expenseVoucherSequences.lastNumber,
  }).from(expenseVoucherSequences).where(and(
    eq(expenseVoucherSequences.workspaceId, workspaceId),
    eq(expenseVoucherSequences.scopeKey, scopeKey),
  )).limit(1);
  const nextSequenceNumber = Math.max(current?.lastNumber ?? 0, parsedNumber);
  const now = new Date();
  if (current) {
    await tx.update(expenseVoucherSequences).set({
      lastNumber: nextSequenceNumber,
      updatedAt: now,
    }).where(and(
      eq(expenseVoucherSequences.workspaceId, workspaceId),
      eq(expenseVoucherSequences.scopeKey, scopeKey),
    ));
  } else {
    await tx.insert(expenseVoucherSequences).values({
      workspaceId,
      scopeKey,
      lastNumber: nextSequenceNumber,
      updatedAt: now,
    });
  }
}

export async function reserveVoucherNumber(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  voucherNumber: string,
  excludeClientRecordId?: string,
) {
  const scopeKey = `${workspaceId}:${farmId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${scopeKey}), hashtext(${voucherNumber}))`);
  const existingVoucher = await findExistingVoucherByNumber(tx, workspaceId, farmId, voucherNumber, excludeClientRecordId);
  if (existingVoucher) {
    throw new Error(`Voucher number ${voucherNumber} already exists.`);
  }
}

export async function allocateVoucherNumber(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  seasonId: string | null | undefined,
  requestedVoucherNumber?: string,
) {
  const normalizedRequestedVoucherNumber = requestedVoucherNumber ? normalizeVoucherNumber(requestedVoucherNumber) : null;
  const parsedRequestedNumber = normalizedRequestedVoucherNumber ? parseVoucherSequenceNumber(normalizedRequestedVoucherNumber) : null;
  if (requestedVoucherNumber && !normalizedRequestedVoucherNumber) {
    throw new Error("Voucher numbers must use the format V-0001.");
  }
  const scopeKey = voucherScopeKey(farmId, seasonId);
  const [current] = await tx.select({
    lastNumber: expenseVoucherSequences.lastNumber,
  }).from(expenseVoucherSequences).where(and(
    eq(expenseVoucherSequences.workspaceId, workspaceId),
    eq(expenseVoucherSequences.scopeKey, scopeKey),
  )).limit(1);
  const nextSuggested = (current?.lastNumber ?? 0) + 1;
  const finalNumber = parsedRequestedNumber ?? nextSuggested;
  const voucherNumber = normalizedRequestedVoucherNumber ?? `V-${String(finalNumber).padStart(4, "0")}`;
  await reserveVoucherNumber(tx, workspaceId, farmId, voucherNumber);
  await bumpVoucherSequence(tx, workspaceId, farmId, seasonId, voucherNumber);
  return voucherNumber;
}
