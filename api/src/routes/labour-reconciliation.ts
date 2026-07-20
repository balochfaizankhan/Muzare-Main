import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import {
  accountTransactions,
  accounts,
  labourAccountingEntries,
  labourAdvanceApplications,
  labourCleanupLogs,
  labourCleanupTombstones,
  labourDues,
  labourPaymentAllocations,
  labourPaymentVouchers,
  labourWageSettlementAdvanceAllocations,
  labourWageSettlementCreateRequests,
  operationalRecords,
  userSessions,
} from "../db/schema.js";
import { normalizeLabourEarningPayload } from "../lib/labour-earnings.js";
import { normalizeSettlementPayload } from "../lib/labour-wage-settlements.js";
import { hasModulePermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";
import { hasFarmAccess } from "../workspace-access.js";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CleanupTarget = { entityType: "EARNING" | "SETTLEMENT"; id: string };

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const contextSchema = z.object({ farmId: z.string().uuid(), seasonId: z.string().uuid() });
const listSchema = contextSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).optional(),
  scope: z.string().trim().max(60).optional(),
  status: z.string().trim().max(60).optional(),
  integrity: z.string().trim().max(60).optional(),
  source: z.string().trim().max(80).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
const targetSchema = z.object({ entityType: z.enum(["EARNING", "SETTLEMENT"]), id: z.string().uuid() });
const previewSchema = contextSchema.extend({ targets: z.array(targetSchema).min(1).max(500) });
const selectionSchema = listSchema.extend({
  entityType: z.enum(["EARNING", "SETTLEMENT"]),
  selectionMode: z.enum(["ALL_MATCHING", "SOURCE_ONLY_ELIGIBLE"]).default("ALL_MATCHING"),
});
const executeSchema = previewSchema.extend({
  mode: z.enum(["SOURCE_ONLY", "FULL_CASCADE"]),
  reason: z.string().trim().min(3).max(1000),
  confirmation: z.literal("DELETE LABOUR DATA"),
  financialConfirmation: z.string().optional(),
});

async function requireScope(request: FastifyRequest, reply: FastifyReply, workspaceId: string, farmId: string, seasonId: string, action: "view" | "delete") {
  if (!request.appUser || !request.sessionId) { reply.code(401).send({ message: "A database-backed session is required." }); return false; }
  if (request.appUser.workspaceId !== workspaceId || !hasModulePermission(request.appUser, workspaceId, "wages", action)) {
    reply.code(403).send({ message: action === "delete" ? "Financial-data-cleanup permission is required." : "Workforce payment view permission is required." }); return false;
  }
  if (!hasFarmAccess(request.appUser, workspaceId, farmId)) { reply.code(403).send({ message: "You do not have access to this farm." }); return false; }
  const [session] = await db.select({ farmId: userSessions.activeFarmId, seasonId: userSessions.activeSeasonId }).from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1);
  if (session?.farmId !== farmId || session.seasonId !== seasonId) { reply.code(403).send({ message: "Select this farm and season before reconciling labour data." }); return false; }
  const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
  if (ownershipError) { reply.code(403).send({ message: ownershipError }); return false; }
  return true;
}

function text(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value); }
function number(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function json(value: unknown) { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }

function listResponse(rows: Array<Record<string, unknown>>, page: number, pageSize: number, databaseMs: number) {
  const totalCount = number(rows[0]?.total_count);
  return {
    pageInfo: { page, pageSize, totalCount, hasMore: (page - 1) * pageSize + rows.length < totalCount },
    summary: {
      totalCount,
      totalAmount: number(rows[0]?.total_amount),
      orphanedCount: number(rows[0]?.orphaned_count),
      duplicateCandidateCount: number(rows[0]?.duplicate_count),
      sourceOnlyEligibleCount: number(rows[0]?.source_only_count),
      cascadeRequiredCount: number(rows[0]?.cascade_count),
      blockedCount: number(rows[0]?.blocked_count),
    },
    diagnostics: { queryCount: 1, databaseMs: Number(databaseMs.toFixed(2)) },
  };
}

async function listEarnings(workspaceId: string, query: z.infer<typeof listSchema>) {
  const offset = (query.page - 1) * query.pageSize;
  const search = query.search ? `%${query.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : null;
  const started = performance.now();
  const result = await db.execute(sql`
    WITH people AS (
      SELECT DISTINCT ON (entity_type,client_record_id) entity_type,client_record_id,payload
      FROM operational_records
      WHERE workspace_id=${workspaceId} AND entity_type IN ('labourer','labourGroup')
      ORDER BY entity_type,client_record_id,client_updated_at DESC,updated_at DESC
    ), base AS (
      SELECT e.id,e.client_record_id,e.workspace_id,e.farm_id,e.season_id,e.payload,e.source_type,e.old_android_id,e.created_at,e.client_updated_at,
        COALESCE(NULLIF(e.payload->>'reference',''),NULLIF(e.payload->>'earningNumber',''),NULLIF(e.old_android_id,''),'LE-' || upper(substr(md5(e.client_record_id),1,8))) AS display_reference,
        COALESCE(NULLIF(e.payload->>'earningScope',''),CASE WHEN NULLIF(e.payload->>'labourGroupId','') IS NOT NULL THEN 'group' ELSE 'individual' END) AS recipient_scope,
        COALESCE(NULLIF(e.payload->>'labourGroupName',''),NULLIF(g.payload->>'name',''),NULLIF(e.payload->>'labourerName',''),NULLIF(l.payload->>'name','')) AS recipient_name,
        NULLIF(f.payload->>'name','') AS leader_name,
        COALESCE(NULLIF(e.payload->>'earningDate',''),NULLIF(e.payload->>'date',''),e.created_at::date::text)::date AS work_date,
        CASE WHEN COALESCE(e.payload->>'amount','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (e.payload->>'amount')::numeric ELSE 0 END AS gross_amount,
        COALESCE(NULLIF(e.payload->>'status',''),'pending_settlement') AS earning_status,
        NULLIF(e.payload->>'linkedSettlementId','') AS linked_settlement_id,
        s.id AS settlement_record_id,s.payload AS settlement_payload,
        d.id AS due_id,d.due_number,d.payment_status,d.gross_amount AS due_gross,
        COALESCE(pay.paid_amount,0)::numeric AS paid_amount,COALESCE(pay.voucher_numbers,'[]'::jsonb) AS voucher_numbers,
        count(*) OVER (PARTITION BY COALESCE(e.payload->>'earningScope','individual'),COALESCE(e.payload->>'labourerId',e.payload->>'labourGroupId'),COALESCE(e.payload->>'earningDate',e.payload->>'date'),COALESCE(e.payload->>'amount'),COALESCE(e.payload->>'description')) AS duplicate_matches
      FROM operational_records e
      LEFT JOIN people l ON l.entity_type='labourer' AND l.client_record_id=COALESCE(NULLIF(e.payload->>'labourerId',''),NULLIF(e.payload->>'labourId',''))
      LEFT JOIN people g ON g.entity_type='labourGroup' AND g.client_record_id=NULLIF(e.payload->>'labourGroupId','')
      LEFT JOIN people f ON f.entity_type='labourer' AND f.client_record_id=NULLIF(e.payload->>'foremanId','')
      LEFT JOIN operational_records s ON s.workspace_id=e.workspace_id AND s.entity_type='labourWageSettlement' AND s.client_record_id=NULLIF(e.payload->>'linkedSettlementId','')
      LEFT JOIN labour_dues d ON d.workspace_id=e.workspace_id AND (d.source_record_id=COALESCE(s.id,e.id) OR d.source_client_record_id=COALESCE(s.client_record_id,e.client_record_id))
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(a.amount) FILTER (WHERE a.status='ACTIVE' AND v.status='POSTED'),0)::numeric AS paid_amount,
          coalesce(jsonb_agg(DISTINCT v.voucher_number) FILTER (WHERE v.id IS NOT NULL),'[]'::jsonb) AS voucher_numbers
        FROM labour_payment_allocations a JOIN labour_payment_vouchers v ON v.id=a.voucher_id WHERE a.due_id=d.id
      ) pay ON true
      WHERE e.workspace_id=${workspaceId} AND e.entity_type='labourEarning'
        AND (e.farm_id=${query.farmId}::uuid OR e.farm_id IS NULL) AND (e.season_id=${query.seasonId}::uuid OR e.season_id IS NULL)
    ), positioned AS (
      SELECT *,CASE
        WHEN earning_status='voided' OR NULLIF(payload->>'deletedAt','') IS NOT NULL THEN 'VOIDED'
        WHEN recipient_name IS NULL THEN 'MISSING_RECIPIENT'
        WHEN linked_settlement_id IS NOT NULL AND settlement_record_id IS NULL THEN 'ORPHANED'
        WHEN duplicate_matches>1 THEN 'DUPLICATE_CANDIDATE'
        WHEN paid_amount>0 AND due_id IS NOT NULL THEN 'PAID'
        WHEN settlement_record_id IS NOT NULL THEN 'INCLUDED_IN_SETTLEMENT'
        WHEN earning_status='pending_settlement' THEN 'UNSETTLED'
        ELSE 'REQUIRES_REVIEW' END AS integrity_status,
        (settlement_record_id IS NULL AND due_id IS NULL AND paid_amount=0) AS source_only_eligible,
        (settlement_record_id IS NOT NULL OR due_id IS NOT NULL OR paid_amount>0) AS cascade_required
      FROM base
    ), filtered AS (
      SELECT * FROM positioned WHERE
        (${query.scope ?? null}::text IS NULL OR recipient_scope=${query.scope ?? null})
        AND (${query.status ?? null}::text IS NULL OR earning_status=${query.status ?? null})
        AND (${query.integrity ?? null}::text IS NULL OR integrity_status=${query.integrity ?? null})
        AND (${query.source ?? null}::text IS NULL OR COALESCE(source_type,'CURRENT')=${query.source ?? null})
        AND (${query.from ?? null}::date IS NULL OR work_date>=${query.from ?? null}::date)
        AND (${query.to ?? null}::date IS NULL OR work_date<=${query.to ?? null}::date)
        AND (${search}::text IS NULL OR concat_ws(' ',client_record_id,recipient_name,leader_name,payload->>'description',payload->>'earningType',linked_settlement_id,due_number,voucher_numbers::text) ILIKE ${search} ESCAPE '\\')
    )
    SELECT *,count(*) OVER()::int AS total_count,coalesce(sum(gross_amount) OVER(),0)::numeric AS total_amount,
      count(*) FILTER (WHERE integrity_status='ORPHANED') OVER()::int AS orphaned_count,
      count(*) FILTER (WHERE integrity_status='DUPLICATE_CANDIDATE') OVER()::int AS duplicate_count,
      count(*) FILTER (WHERE source_only_eligible) OVER()::int AS source_only_count,
      count(*) FILTER (WHERE cascade_required) OVER()::int AS cascade_count,0::int AS blocked_count
    FROM filtered ORDER BY work_date DESC,client_updated_at DESC,id DESC LIMIT ${query.pageSize} OFFSET ${offset}
  `);
  const rows = result.rows as Array<Record<string, unknown>>;
  return {
    earnings: rows.map((row) => ({
      id:text(row.client_record_id),recordId:text(row.id),reference:text(row.display_reference),
      sourceModule:row.source_type?`Imported: ${text(row.source_type)}`:"Labour Work Ledger",recipientScope:text(row.recipient_scope),recipientName:row.recipient_name?text(row.recipient_name):null,leaderName:row.leader_name?text(row.leader_name):null,
      description:text(json(row.payload).description)||"Labour earning",workDate:text(row.work_date),workFromDate:text(row.work_date),workToDate:text(row.work_date),grossAmount:number(row.gross_amount),quantity:number(json(row.payload).quantity)||null,rate:number(json(row.payload).rate)||number(json(row.payload).unitRate)||null,
      earningType:text(json(row.payload).earningType)||"other",settlementReference:row.settlement_payload?text(json(row.settlement_payload).settlementNumber):null,settlementId:row.linked_settlement_id?text(row.linked_settlement_id):null,dueReference:row.due_number?text(row.due_number):null,dueId:row.due_id?text(row.due_id):null,voucherReferences:Array.isArray(row.voucher_numbers)?row.voucher_numbers:[],paymentStatus:row.payment_status?text(row.payment_status):"NOT_DUE",voidStatus:text(row.earning_status)==="voided"||Boolean(json(row.payload).deletedAt),
      farmId:row.farm_id?text(row.farm_id):null,seasonId:row.season_id?text(row.season_id):null,createdAt:new Date(String(row.created_at)).toISOString(),classification:row.source_type?"LEGACY":"CURRENT",integrityStatus:text(row.integrity_status),sourceOnlyEligible:Boolean(row.source_only_eligible),cascadeRequired:Boolean(row.cascade_required),blocked:false,
    })),
    ...listResponse(rows,query.page,query.pageSize,performance.now()-started),
  };
}

async function listSettlements(workspaceId: string, query: z.infer<typeof listSchema>) {
  const offset=(query.page-1)*query.pageSize; const search=query.search?`%${query.search.replaceAll("%","\\%").replaceAll("_","\\_")}%`:null; const started=performance.now();
  const result=await db.execute(sql`
    WITH base AS (
      SELECT s.id,s.client_record_id,s.farm_id,s.season_id,s.payload,s.source_type,s.old_android_id,s.created_at,s.client_updated_at,
        COALESCE(NULLIF(s.payload->>'settlementNumber',''),NULLIF(s.payload->>'voucherNumber',''),s.client_record_id) AS settlement_number,
        COALESCE(NULLIF(s.payload->>'settlementMode',''),'individual') AS recipient_scope,
        COALESCE(NULLIF(s.payload->>'groupName',''),NULLIF(s.payload#>>'{includedLabourRows,0,labourName}',''),NULLIF(s.payload->>'foremanName','')) AS recipient_name,
        COALESCE(NULLIF(s.payload->>'fromDate',''),s.created_at::date::text)::date AS from_date,COALESCE(NULLIF(s.payload->>'toDate',''),s.created_at::date::text)::date AS to_date,
        CASE WHEN COALESCE(s.payload->>'grossWages',s.payload->>'totalEarned',s.payload->>'expenseAmount','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN COALESCE(s.payload->>'grossWages',s.payload->>'totalEarned',s.payload->>'expenseAmount')::numeric ELSE 0 END AS gross_amount,
        COALESCE(NULLIF(s.payload->>'status',''),'posted') AS settlement_status,d.id AS due_id,d.due_number,d.payment_status,
        COALESCE(a.applied_amount,0)::numeric AS advances_applied,COALESCE(p.paid_amount,0)::numeric AS payments_made,COALESCE(p.voucher_numbers,'[]'::jsonb) AS voucher_numbers,
        (SELECT count(*) FROM account_transactions atx WHERE atx.reference_id=s.client_record_id AND atx.source_type='labour_wage_settlement')::int AS account_entry_count,
        (SELECT count(*) FROM operational_records e WHERE e.workspace_id=s.workspace_id AND e.entity_type='labourEarning' AND e.payload->>'linkedSettlementId'=s.client_record_id)::int AS earning_count,
        coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(s.payload->'sourceAttendanceIds')='array' THEN s.payload->'sourceAttendanceIds' ELSE '[]'::jsonb END),0)::int AS attendance_count
      FROM operational_records s
      LEFT JOIN labour_dues d ON d.source_record_id=s.id OR (d.workspace_id=s.workspace_id AND d.source_client_record_id=s.client_record_id)
      LEFT JOIN LATERAL (SELECT coalesce(sum(amount) FILTER (WHERE status='ACTIVE'),0)::numeric AS applied_amount FROM labour_advance_applications WHERE due_id=d.id) a ON true
      LEFT JOIN LATERAL (SELECT coalesce(sum(pa.amount) FILTER (WHERE pa.status='ACTIVE' AND v.status='POSTED'),0)::numeric AS paid_amount,coalesce(jsonb_agg(DISTINCT v.voucher_number) FILTER (WHERE v.id IS NOT NULL),'[]'::jsonb) AS voucher_numbers FROM labour_payment_allocations pa JOIN labour_payment_vouchers v ON v.id=pa.voucher_id WHERE pa.due_id=d.id) p ON true
      WHERE s.workspace_id=${workspaceId} AND s.entity_type='labourWageSettlement' AND (s.farm_id=${query.farmId}::uuid OR s.farm_id IS NULL) AND (s.season_id=${query.seasonId}::uuid OR s.season_id IS NULL)
    ), positioned AS (
      SELECT *,greatest(gross_amount-advances_applied-payments_made,0)::numeric AS outstanding_balance,
        CASE WHEN settlement_status IN ('voided','deleted') OR NULLIF(payload->>'deletedAt','') IS NOT NULL THEN 'VOIDED'
          WHEN due_id IS NULL THEN 'ORPHANED' WHEN payment_status IN ('PAID','SETTLED_BY_ADVANCE') THEN 'PAID'
          WHEN payment_status='PARTIALLY_SETTLED' THEN 'PARTIALLY_PAID' ELSE 'ACTIVE' END AS integrity_status,
        (due_id IS NULL AND account_entry_count=0 AND payments_made=0 AND advances_applied=0) AS source_only_eligible,
        (due_id IS NOT NULL OR account_entry_count>0 OR payments_made>0 OR advances_applied>0) AS cascade_required
      FROM base
    ), filtered AS (SELECT * FROM positioned WHERE
      (${query.scope ?? null}::text IS NULL OR recipient_scope=${query.scope ?? null}) AND (${query.status ?? null}::text IS NULL OR settlement_status=${query.status ?? null})
      AND (${query.integrity ?? null}::text IS NULL OR integrity_status=${query.integrity ?? null}) AND (${query.source ?? null}::text IS NULL OR COALESCE(source_type,'CURRENT')=${query.source ?? null})
      AND (${query.from ?? null}::date IS NULL OR to_date>=${query.from ?? null}::date) AND (${query.to ?? null}::date IS NULL OR from_date<=${query.to ?? null}::date)
      AND (${search}::text IS NULL OR concat_ws(' ',settlement_number,recipient_name,due_number,voucher_numbers::text,payload->>'notes') ILIKE ${search} ESCAPE '\\'))
    SELECT *,count(*) OVER()::int AS total_count,coalesce(sum(gross_amount) OVER(),0)::numeric AS total_amount,
      count(*) FILTER (WHERE integrity_status='ORPHANED') OVER()::int AS orphaned_count,0::int AS duplicate_count,
      count(*) FILTER (WHERE source_only_eligible) OVER()::int AS source_only_count,count(*) FILTER (WHERE cascade_required) OVER()::int AS cascade_count,0::int AS blocked_count
    FROM filtered ORDER BY to_date DESC,client_updated_at DESC,id DESC LIMIT ${query.pageSize} OFFSET ${offset}
  `);
  const rows=result.rows as Array<Record<string,unknown>>;
  return {settlements:rows.map((row)=>({id:text(row.client_record_id),recordId:text(row.id),settlementNumber:text(row.settlement_number),settlementType:number(json(row.payload).attendanceWages)>0&&number(json(row.payload).labourWorkWages)>0?"Mixed":number(json(row.payload).attendanceWages)>0?"Attendance":"Labour work",recipientScope:text(row.recipient_scope),recipientName:row.recipient_name?text(row.recipient_name):null,leaderSnapshot:text(json(row.payload).foremanName)||null,fromDate:text(row.from_date),toDate:text(row.to_date),settlementDate:text(json(row.payload).settlementDate)||text(row.to_date),grossAmount:number(row.gross_amount),advancesApplied:number(row.advances_applied),paymentsMade:number(row.payments_made),outstandingBalance:number(row.outstanding_balance),status:text(row.settlement_status),paymentStatus:row.payment_status?text(row.payment_status):"NO_DUE",dueId:row.due_id?text(row.due_id):null,dueReference:row.due_number?text(row.due_number):null,voucherReferences:Array.isArray(row.voucher_numbers)?row.voucher_numbers:[],accountEntryCount:number(row.account_entry_count),sourceAttendanceCount:number(row.attendance_count),sourceEarningCount:number(row.earning_count),farmId:row.farm_id?text(row.farm_id):null,seasonId:row.season_id?text(row.season_id):null,createdAt:new Date(String(row.created_at)).toISOString(),classification:row.source_type?"LEGACY":"CURRENT",integrityStatus:text(row.integrity_status),sourceOnlyEligible:Boolean(row.source_only_eligible),cascadeRequired:Boolean(row.cascade_required),blocked:false})),...listResponse(rows,query.page,query.pageSize,performance.now()-started)};
}

type PreviewDependency={kind:string;count:number;classification:"WILL_DELETE"|"WILL_UNLOCK"|"WILL_REMAIN"|"BLOCKS_DELETION"|"REQUIRES_CASCADE";message:string};
async function buildCleanupPreview(tx:DbTransaction,workspaceId:string,farmId:string,seasonId:string,targets:CleanupTarget[]){
  const targetIds=[...new Set(targets.map((item)=>item.id))];
  const targetPredicates=targets.map((target)=>and(
    eq(operationalRecords.entityType,target.entityType==="EARNING"?"labourEarning":"labourWageSettlement"),
    eq(operationalRecords.clientRecordId,target.id),
  ));
  const records=targetPredicates.length?await tx.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId,workspaceId),
    or(eq(operationalRecords.farmId,farmId),sql`${operationalRecords.farmId} IS NULL`),
    or(eq(operationalRecords.seasonId,seasonId),sql`${operationalRecords.seasonId} IS NULL`),
    or(...targetPredicates),
  )):[];
  const selectedEarnings=records.filter((row)=>row.entityType==="labourEarning");
  const requestedSettlements=records.filter((row)=>row.entityType==="labourWageSettlement");
  const linkedSettlementIds=[...new Set(selectedEarnings.map((row)=>text(row.payload.linkedSettlementId)).filter(Boolean))];
  const linkedSettlements=linkedSettlementIds.length?await tx.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId,workspaceId),eq(operationalRecords.entityType,"labourWageSettlement"),
    or(eq(operationalRecords.farmId,farmId),sql`${operationalRecords.farmId} IS NULL`),
    or(eq(operationalRecords.seasonId,seasonId),sql`${operationalRecords.seasonId} IS NULL`),
    inArray(operationalRecords.clientRecordId,linkedSettlementIds),
  )):[];
  const settlements=[...new Map([...requestedSettlements,...linkedSettlements].map((row)=>[row.id,row])).values()];
  const sourceRows=[...selectedEarnings,...settlements]; const sourceRecordIds=sourceRows.map((row)=>row.id); const sourceClientIds=sourceRows.map((row)=>row.clientRecordId);
  const dues=sourceRecordIds.length?await tx.select().from(labourDues).where(and(
    eq(labourDues.workspaceId,workspaceId),
    or(inArray(labourDues.sourceRecordId,sourceRecordIds),inArray(labourDues.sourceClientRecordId,sourceClientIds)),
  )):[];
  const dueIds=dues.map((row)=>row.id);
  const paymentAllocations=dueIds.length?await tx.select().from(labourPaymentAllocations).where(and(eq(labourPaymentAllocations.workspaceId,workspaceId),inArray(labourPaymentAllocations.dueId,dueIds))):[];
  const advanceApplications=dueIds.length?await tx.select().from(labourAdvanceApplications).where(and(eq(labourAdvanceApplications.workspaceId,workspaceId),inArray(labourAdvanceApplications.dueId,dueIds))):[];
  const dueLinkedVouchers=dueIds.length?await tx.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.workspaceId,workspaceId),inArray(labourPaymentVouchers.linkedDueId,dueIds))):[];
  const directVoucherIds=[...new Set([...paymentAllocations.map((row)=>row.voucherId),...dueLinkedVouchers.map((row)=>row.id)])];
  const directVouchers=directVoucherIds.length?await tx.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.workspaceId,workspaceId),inArray(labourPaymentVouchers.id,directVoucherIds))):[];
  const reversalVouchers=directVoucherIds.length?await tx.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.workspaceId,workspaceId),inArray(labourPaymentVouchers.reversalReference,directVoucherIds))):[];
  const vouchers=[...new Map([...directVouchers,...reversalVouchers].map((row)=>[row.id,row])).values()];
  const voucherIds=vouchers.map((row)=>row.id);
  const allVoucherAllocations=voucherIds.length?await tx.select().from(labourPaymentAllocations).where(inArray(labourPaymentAllocations.voucherId,voucherIds)):[];
  const sharedVoucherIds=[...new Set(allVoucherAllocations.filter((row)=>!dueIds.includes(row.dueId)).map((row)=>row.voucherId))];
  const applicationIds=advanceApplications.map((row)=>row.id);
  const accountingPredicates=[];
  if(dueIds.length) accountingPredicates.push(inArray(labourAccountingEntries.dueId,dueIds));
  if(voucherIds.length) accountingPredicates.push(inArray(labourAccountingEntries.voucherId,voucherIds));
  if(applicationIds.length) accountingPredicates.push(inArray(labourAccountingEntries.advanceApplicationId,applicationIds));
  const accountingEntries=accountingPredicates.length?await tx.select().from(labourAccountingEntries).where(and(eq(labourAccountingEntries.workspaceId,workspaceId),or(...accountingPredicates))):[];
  const referenceIds=[...voucherIds,...settlements.map((row)=>row.clientRecordId)].filter((value)=>z.string().uuid().safeParse(value).success);
  const accountEntries=referenceIds.length?await tx.select().from(accountTransactions).where(and(eq(accountTransactions.farmId,farmId),eq(accountTransactions.seasonId,seasonId),inArray(accountTransactions.referenceId,referenceIds))):[];
  const affectedAccounts=accountEntries.length?await tx.select({id:accounts.id,accountType:accounts.accountType}).from(accounts).where(inArray(accounts.id,[...new Set(accountEntries.map((row)=>row.accountId))])):[];
  const partnerEffects=affectedAccounts.some((row)=>row.accountType==="partner");
  const settlementIds=settlements.map((row)=>row.clientRecordId);
  const linkedLegacyVoucherIds=settlements.map((row)=>text(row.payload.linkedVoucherId)).filter(Boolean);
  const legacyVoucherPredicates=[];
  if(linkedLegacyVoucherIds.length)legacyVoucherPredicates.push(inArray(operationalRecords.clientRecordId,linkedLegacyVoucherIds));
  if(settlementIds.length)legacyVoucherPredicates.push(sql`${operationalRecords.payload}->>'settlementId' = ANY(${settlementIds}::text[])`);
  const legacyVouchers=legacyVoucherPredicates.length?await tx.select().from(operationalRecords).where(and(eq(operationalRecords.workspaceId,workspaceId),eq(operationalRecords.entityType,"voucher"),or(...legacyVoucherPredicates))):[];
  const linkedSourceRows=settlementIds.length?await tx.select().from(operationalRecords).where(and(eq(operationalRecords.workspaceId,workspaceId),inArray(operationalRecords.entityType,["attendance","labourEarning"]),sql`${operationalRecords.payload}->>'linkedSettlementId' = ANY(${settlementIds}::text[])`)):[];
  const oldAllocations=settlements.length?await tx.select().from(labourWageSettlementAdvanceAllocations).where(inArray(labourWageSettlementAdvanceAllocations.settlementRecordId,settlements.map((row)=>row.id))):[];
  const createRequests=settlements.length?await tx.select().from(labourWageSettlementCreateRequests).where(and(eq(labourWageSettlementCreateRequests.workspaceId,workspaceId),inArray(labourWageSettlementCreateRequests.settlementOperationalRecordId,settlements.map((row)=>row.id)))):[];
  const dependencies:PreviewDependency[]=[
    {kind:"Unified dues",count:dues.length,classification:dues.length?"REQUIRES_CASCADE":"WILL_REMAIN",message:dues.length?"Synthetic dues and their recognition entries will be deleted.":"No unified due is linked."},
    {kind:"Payment allocations",count:paymentAllocations.length,classification:paymentAllocations.length?"REQUIRES_CASCADE":"WILL_REMAIN",message:"Allocations belong to the selected due chain."},
    {kind:"Advance applications",count:advanceApplications.length+oldAllocations.length,classification:advanceApplications.length+oldAllocations.length?"WILL_DELETE":"WILL_REMAIN",message:"Applications will be removed; original advance vouchers and cash effects remain."},
    {kind:"Payment vouchers",count:vouchers.length+legacyVouchers.length,classification:sharedVoucherIds.length?"BLOCKS_DELETION":vouchers.length+legacyVouchers.length?"REQUIRES_CASCADE":"WILL_REMAIN",message:sharedVoucherIds.length?"A payment voucher also allocates to an unrelated due.":"Exclusively linked payment vouchers may be deleted in full cascade mode."},
    {kind:"Accounting effects",count:accountingEntries.length+accountEntries.length,classification:accountingEntries.length+accountEntries.length?"REQUIRES_CASCADE":"WILL_REMAIN",message:accountEntries.length?"This deletion will also remove a posted payment and reverse/remove its account impact.":"No posted account movement was found."},
    {kind:"Attendance",count:linkedSourceRows.filter((row)=>row.entityType==="attendance").length,classification:"WILL_UNLOCK",message:"Attendance is preserved and unlocked for future settlement."},
    {kind:"Labour earnings",count:linkedSourceRows.filter((row)=>row.entityType==="labourEarning"&&!targetIds.includes(row.clientRecordId)).length,classification:"WILL_UNLOCK",message:"Unselected earnings are preserved and returned to pending settlement."},
    {kind:"Create/idempotency requests",count:createRequests.length,classification:createRequests.length?"WILL_DELETE":"WILL_REMAIN",message:"Settlement create requests are removed with the selected chain."},
    {kind:"Independent advances",count:new Set(advanceApplications.map((row)=>row.advanceVoucherId)).size,classification:"WILL_REMAIN",message:"Original advance vouchers and their original cash/account effects remain."},
  ];
  const financialEffects=accountEntries.length>0||vouchers.some((row)=>row.status==="POSTED"); const blocked=sharedVoucherIds.length>0;
  return {targets:records.map((row)=>({entityType:row.entityType==="labourEarning"?"EARNING":"SETTLEMENT",id:row.clientRecordId,reference:row.entityType==="labourEarning"?text(row.payload.reference)||`LE-${row.clientRecordId.slice(0,8).toUpperCase()}`:text(row.payload.settlementNumber)||row.clientRecordId,amount:row.entityType==="labourEarning"?number(row.payload.amount):number(row.payload.grossWages||row.payload.totalEarned||row.payload.expenseAmount),status:text(row.payload.status),recipientSnapshot:{labourerId:row.payload.labourerId,labourGroupId:row.payload.labourGroupId,groupName:row.payload.groupName||row.payload.labourGroupName}})),expandedSettlements:settlements.map((row)=>({id:row.clientRecordId,reference:text(row.payload.settlementNumber)||row.clientRecordId})),dependencies,counts:{selected:records.length,settlements:settlements.length,earnings:selectedEarnings.length,dues:dues.length,paymentVouchers:vouchers.length+legacyVouchers.length,paymentAllocations:paymentAllocations.length,advanceApplications:advanceApplications.length+oldAllocations.length,accountEffects:accountEntries.length,accountingEntries:accountingEntries.length,attendanceUnlocks:linkedSourceRows.filter((row)=>row.entityType==="attendance").length,earningUnlocks:linkedSourceRows.filter((row)=>row.entityType==="labourEarning"&&!targetIds.includes(row.clientRecordId)).length},totalFinancialAmount:vouchers.reduce((sum,row)=>sum+number(row.paymentAmount),0),financialEffects,requiresCascade:dues.length+paymentAllocations.length+advanceApplications.length+vouchers.length+legacyVouchers.length+accountEntries.length+accountingEntries.length>0,blocked,blockedReasons:sharedVoucherIds.length?["A linked payment voucher is shared with an unrelated due."]:[],internal:{records,selectedEarnings,settlements,dues,paymentAllocations,advanceApplications,vouchers,legacyVouchers,accountingEntries,accountEntries,partnerEffects,linkedSourceRows,oldAllocations,createRequests}};
}

export async function labourReconciliationRoutes(app:FastifyInstance):Promise<void>{
  app.get("/v1/workspace/:workspaceId/labour-reconciliation/earnings",{preHandler:requireUser},async(request,reply)=>{const params=paramsSchema.safeParse(request.params);const query=listSchema.safeParse(request.query);if(!params.success||!query.success)return reply.code(400).send({message:"A valid Legacy Earnings query is required."});if(!(await requireScope(request,reply,params.data.workspaceId,query.data.farmId,query.data.seasonId,"view")))return;return listEarnings(params.data.workspaceId,query.data);});
  app.get("/v1/workspace/:workspaceId/labour-reconciliation/settlements",{preHandler:requireUser},async(request,reply)=>{const params=paramsSchema.safeParse(request.params);const query=listSchema.safeParse(request.query);if(!params.success||!query.success)return reply.code(400).send({message:"A valid Settlement History query is required."});if(!(await requireScope(request,reply,params.data.workspaceId,query.data.farmId,query.data.seasonId,"view")))return;return listSettlements(params.data.workspaceId,query.data);});
  app.get("/v1/workspace/:workspaceId/labour-reconciliation/cleanup/selection",{preHandler:requireUser},async(request,reply)=>{
    const params=paramsSchema.safeParse(request.params);const query=selectionSchema.safeParse(request.query);
    if(!params.success||!query.success)return reply.code(400).send({message:"A valid cleanup selection query is required."});
    const {workspaceId}=params.data;const input=query.data;
    if(!(await requireScope(request,reply,workspaceId,input.farmId,input.seasonId,"delete")))return;
    const entity=input.entityType==="EARNING"?"labourEarning":"labourWageSettlement";
    const search=input.search?`%${input.search.replaceAll("%","\\%").replaceAll("_","\\_")}%`:null;
    const result=await db.execute(sql`
      SELECT r.client_record_id
      FROM operational_records r
      WHERE r.workspace_id=${workspaceId} AND r.entity_type=${entity}
        AND (r.farm_id=${input.farmId}::uuid OR r.farm_id IS NULL)
        AND (r.season_id=${input.seasonId}::uuid OR r.season_id IS NULL)
        AND (${input.scope??null}::text IS NULL OR COALESCE(r.payload->>'earningScope',r.payload->>'settlementMode',CASE WHEN NULLIF(r.payload->>'labourGroupId','') IS NOT NULL THEN 'group' ELSE 'individual' END)=${input.scope??null})
        AND (${input.status??null}::text IS NULL OR COALESCE(r.payload->>'status',CASE WHEN r.entity_type='labourWageSettlement' THEN 'posted' ELSE 'pending_settlement' END)=${input.status??null})
        AND (${input.source??null}::text IS NULL OR COALESCE(r.source_type,'CURRENT')=${input.source??null})
        AND (${input.integrity??null}::text IS NULL OR ${input.integrity??null} = CASE
          WHEN COALESCE(r.payload->>'status','') IN ('voided','deleted','reversed') OR NULLIF(r.payload->>'deletedAt','') IS NOT NULL THEN 'VOIDED'
          WHEN r.entity_type='labourEarning' AND NULLIF(COALESCE(r.payload->>'labourerId',r.payload->>'labourId',r.payload->>'labourGroupId'),'') IS NULL THEN 'MISSING_RECIPIENT'
          WHEN r.entity_type='labourEarning' AND NULLIF(r.payload->>'linkedSettlementId','') IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM operational_records linked WHERE linked.workspace_id=r.workspace_id AND linked.entity_type='labourWageSettlement' AND linked.client_record_id=r.payload->>'linkedSettlementId'
          ) THEN 'ORPHANED'
          WHEN r.entity_type='labourWageSettlement' AND NOT EXISTS (
            SELECT 1 FROM labour_dues d WHERE d.workspace_id=r.workspace_id AND (d.source_record_id=r.id OR d.source_client_record_id=r.client_record_id)
          ) THEN 'ORPHANED'
          WHEN EXISTS (SELECT 1 FROM labour_dues d WHERE d.workspace_id=r.workspace_id AND (d.source_record_id=r.id OR d.source_client_record_id=r.client_record_id) AND d.payment_status IN ('PAID','SETTLED_BY_ADVANCE')) THEN 'PAID'
          WHEN EXISTS (SELECT 1 FROM labour_dues d WHERE d.workspace_id=r.workspace_id AND (d.source_record_id=r.id OR d.source_client_record_id=r.client_record_id) AND d.payment_status='PARTIALLY_SETTLED') THEN 'PARTIALLY_PAID'
          WHEN r.entity_type='labourEarning' AND NULLIF(r.payload->>'linkedSettlementId','') IS NOT NULL THEN 'INCLUDED_IN_SETTLEMENT'
          WHEN r.entity_type='labourEarning' AND COALESCE(r.payload->>'status','pending_settlement')='pending_settlement' THEN 'UNSETTLED'
          ELSE 'ACTIVE' END)
        AND (${input.from??null}::date IS NULL OR COALESCE(NULLIF(r.payload->>'earningDate',''),NULLIF(r.payload->>'date',''),NULLIF(r.payload->>'toDate',''),r.created_at::date::text)::date>=${input.from??null}::date)
        AND (${input.to??null}::date IS NULL OR COALESCE(NULLIF(r.payload->>'earningDate',''),NULLIF(r.payload->>'date',''),NULLIF(r.payload->>'fromDate',''),r.created_at::date::text)::date<=${input.to??null}::date)
        AND (${search}::text IS NULL OR concat_ws(' ',r.client_record_id,r.old_android_id,r.payload->>'reference',r.payload->>'earningNumber',r.payload->>'settlementNumber',r.payload->>'labourerName',r.payload->>'groupName',r.payload->>'description') ILIKE ${search} ESCAPE '\\')
        AND (${input.selectionMode}='ALL_MATCHING' OR (
          NULLIF(r.payload->>'linkedSettlementId','') IS NULL
          AND NOT EXISTS (SELECT 1 FROM labour_dues d WHERE d.workspace_id=r.workspace_id AND (d.source_record_id=r.id OR d.source_client_record_id=r.client_record_id))
          AND NOT EXISTS (SELECT 1 FROM account_transactions a WHERE a.reference_id=CASE WHEN r.client_record_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN r.client_record_id::uuid ELSE NULL END)
        ))
      ORDER BY r.client_updated_at DESC,r.id DESC LIMIT 5000
    `);
    const ids=(result.rows as Array<{client_record_id:string}>).map((row)=>row.client_record_id);
    return {targets:ids.map((id)=>({entityType:input.entityType,id})),totalResolved:ids.length,truncated:ids.length===5000};
  });
  app.post("/v1/workspace/:workspaceId/labour-reconciliation/cleanup/preview",{preHandler:requireUser},async(request,reply)=>{const params=paramsSchema.safeParse(request.params);const body=previewSchema.safeParse(request.body);if(!params.success||!body.success)return reply.code(400).send({message:"Select labour data to preview."});if(!(await requireScope(request,reply,params.data.workspaceId,body.data.farmId,body.data.seasonId,"delete")))return;const preview=await db.transaction((tx)=>buildCleanupPreview(tx,params.data.workspaceId,body.data.farmId,body.data.seasonId,body.data.targets));const {internal:_,...safe}=preview;return{preview:safe};});
  app.post("/v1/workspace/:workspaceId/labour-reconciliation/cleanup/execute",{preHandler:requireUser},async(request,reply)=>{const params=paramsSchema.safeParse(request.params);const body=executeSchema.safeParse(request.body);if(!params.success||!body.success)return reply.code(400).send({message:"A valid cleanup confirmation is required."});const {workspaceId}=params.data;const input=body.data;if(!(await requireScope(request,reply,workspaceId,input.farmId,input.seasonId,"delete")))return;try{const result=await db.transaction(async(tx)=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${input.farmId}:${input.seasonId}:labour-data-cleanup`}),1)`);
    const preview=await buildCleanupPreview(tx,workspaceId,input.farmId,input.seasonId,input.targets);if(preview.targets.length!==new Set(input.targets.map((item)=>item.id)).size)throw new Error("One or more selected records no longer exist.");if(preview.blocked)throw new Error(preview.blockedReasons.join(" "));if(input.mode==="SOURCE_ONLY"&&preview.requiresCascade)throw new Error("Dependencies exist. Run a full cascade preview before deleting this data.");if(preview.financialEffects&&input.financialConfirmation!=="DELETE FINANCIAL HISTORY")throw new Error("Type DELETE FINANCIAL HISTORY to remove posted financial effects.");
    const batchId=crypto.randomUUID();const now=new Date();const internal=preview.internal;const targetIds=new Set(input.targets.map((item)=>item.id));const dueIds=internal.dues.map((row)=>row.id);const voucherIds=internal.vouchers.map((row)=>row.id);const applicationIds=internal.advanceApplications.map((row)=>row.id);
    if(input.mode==="FULL_CASCADE"){
      if(internal.accountingEntries.length)await tx.delete(labourAccountingEntries).where(inArray(labourAccountingEntries.id,internal.accountingEntries.map((row)=>row.id)));
      if(internal.paymentAllocations.length)await tx.delete(labourPaymentAllocations).where(inArray(labourPaymentAllocations.id,internal.paymentAllocations.map((row)=>row.id)));
      if(applicationIds.length)await tx.delete(labourAdvanceApplications).where(inArray(labourAdvanceApplications.id,applicationIds));
      if(voucherIds.length)await tx.delete(labourPaymentVouchers).where(inArray(labourPaymentVouchers.id,voucherIds));
      if(internal.accountEntries.length)await tx.delete(accountTransactions).where(inArray(accountTransactions.id,internal.accountEntries.map((row)=>row.id)));
      if(dueIds.length)await tx.delete(labourDues).where(inArray(labourDues.id,dueIds));
      if(internal.oldAllocations.length)await tx.delete(labourWageSettlementAdvanceAllocations).where(inArray(labourWageSettlementAdvanceAllocations.id,internal.oldAllocations.map((row)=>row.id)));
      if(internal.createRequests.length)await tx.delete(labourWageSettlementCreateRequests).where(inArray(labourWageSettlementCreateRequests.id,internal.createRequests.map((row)=>row.id)));
      if(internal.legacyVouchers.length)await tx.delete(operationalRecords).where(inArray(operationalRecords.id,internal.legacyVouchers.map((row)=>row.id)));
    }
    for(const row of internal.linkedSourceRows){if(targetIds.has(row.clientRecordId))continue;const next={...row.payload,linkedSettlementId:null,settlementDate:null,updatedAt:now.toISOString(),...(row.entityType==="labourEarning"?{status:"pending_settlement"}: {})};await tx.update(operationalRecords).set({payload:next,clientUpdatedAt:now,updatedAt:now}).where(eq(operationalRecords.id,row.id));}
    const deletedRows=[...new Map([...internal.selectedEarnings,...internal.settlements].filter((row)=>targetIds.has(row.clientRecordId)||row.entityType==="labourWageSettlement").map((row)=>[row.id,row])).values()];
    for(const row of deletedRows){const isEarning=row.entityType==="labourEarning";const normalized=isEarning?normalizeLabourEarningPayload(row.payload):normalizeSettlementPayload(row.payload);const reference=isEarning?text(row.payload.reference)||`LE-${row.clientRecordId.slice(0,8).toUpperCase()}`:text(row.payload.settlementNumber)||row.clientRecordId;const amount=isEarning?number(row.payload.amount):number(row.payload.grossWages||row.payload.totalEarned||row.payload.expenseAmount);await tx.insert(labourCleanupLogs).values({cleanupBatchId:batchId,workspaceId,farmId:row.farmId,seasonId:row.seasonId,entityType:isEarning?"EARNING":"SETTLEMENT",originalEntityId:row.clientRecordId,originalReference:reference,recipientSnapshot:{labourerId:row.payload.labourerId??null,labourGroupId:row.payload.labourGroupId??row.payload.groupId??null,groupName:row.payload.groupName??row.payload.labourGroupName??null},originalAmount:amount.toFixed(2),originalStatus:text(normalized.status),relatedSettlementNumber:isEarning?text(row.payload.linkedSettlementId)||null:text(row.payload.settlementNumber)||null,relatedVoucherNumbers:[...internal.vouchers.map((voucher)=>voucher.voucherNumber),...internal.legacyVouchers.map((voucher)=>text(voucher.payload.voucherNumber)||voucher.clientRecordId)],dependentRecordsRemoved:preview.counts.dues+preview.counts.paymentVouchers+preview.counts.paymentAllocations+preview.counts.advanceApplications+preview.counts.accountEffects+preview.counts.accountingEntries,accountEffectsRemoved:preview.counts.accountEffects>0,partnerEffectsRemoved:internal.partnerEffects,advancesRestored:preview.counts.advanceApplications>0,deletedBy:request.appUser!.id,reason:input.reason,confirmationMode:input.mode,details:{dependencies:preview.dependencies,counts:preview.counts}});await tx.insert(labourCleanupTombstones).values({cleanupBatchId:batchId,workspaceId,farmId:row.farmId,seasonId:row.seasonId,entityType:row.entityType,clientRecordId:row.clientRecordId,deletedBy:request.appUser!.id}).onConflictDoNothing();}
    for(const voucher of internal.legacyVouchers)await tx.insert(labourCleanupTombstones).values({cleanupBatchId:batchId,workspaceId,farmId:voucher.farmId,seasonId:voucher.seasonId,entityType:voucher.entityType,clientRecordId:voucher.clientRecordId,deletedBy:request.appUser!.id}).onConflictDoNothing();
    if(deletedRows.length)await tx.delete(operationalRecords).where(inArray(operationalRecords.id,deletedRows.map((row)=>row.id)));
    return{cleanupBatchId:batchId,deleted:deletedRows.map((row)=>({entityType:row.entityType,id:row.clientRecordId})),counts:preview.counts,accountEffectsRemoved:preview.counts.accountEffects>0,advancesRestored:preview.counts.advanceApplications>0};
  });return{result};}catch(error){return reply.code(409).send({message:error instanceof Error?error.message:"Unable to complete labour data cleanup."});}});
}
