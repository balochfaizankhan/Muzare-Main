import { sql } from "drizzle-orm";

const deletedStatuses = ["deleted", "void", "voided", "cancelled"] as const;

export function isDeletedOperationalPayload(payload: Record<string, unknown> | null | undefined) {
  if (!payload) return false;
  if (typeof payload.deletedAt === "string" && payload.deletedAt.trim()) return true;
  if (payload.deleted === true || (typeof payload.deleted === "string" && payload.deleted.trim().toLowerCase() === "true")) return true;
  const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
  return deletedStatuses.includes(status as typeof deletedStatuses[number]);
}

export function activeOperationalPayloadSql(payloadColumn: unknown) {
  return sql`
    coalesce(${payloadColumn}->>'deletedAt', '') = ''
    and coalesce(lower(${payloadColumn}->>'deleted'), 'false') <> 'true'
    and coalesce(lower(${payloadColumn}->>'status'), '') not in ('deleted', 'void', 'voided', 'cancelled')
  `;
}
