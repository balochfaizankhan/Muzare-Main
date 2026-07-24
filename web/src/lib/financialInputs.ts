import type { Advance, LabourWageSettlement, Voucher } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";
import { getCashAffectingVouchers, getGeneralExpenseVouchers } from "./labourWageSettlements";

/**
 * Shared financial input-derivation layer.
 *
 * Every financial surface (Dashboard, Accounts Report, Reports, Partner Ledger, labour
 * summaries) needs the same three preparatory steps before it can compute a balance:
 *   1. know which legacy records the canonical server read model has already superseded,
 *   2. drop those superseded mirrors so a record is never counted twice, and
 *   3. split the surviving vouchers into the general-expense and cash-affecting collections.
 *
 * These primitives were previously re-inlined in each screen and had drifted apart. They are
 * consolidated here as pure functions so callers pass their own already-active inputs and get
 * identical results — no business rule is changed, only the location of the shared logic.
 */

/** Build the set of legacy source ids the canonical read model has superseded. */
export function buildReplacedSourceIdSet(replacedLegacySourceIds?: readonly string[] | null): Set<string> {
  return new Set(replacedLegacySourceIds ?? []);
}

/** Drop legacy records whose canonical equivalents are already represented server-side. */
export function excludeReplacedRecords<T extends { id: string }>(
  records: readonly T[],
  replaced: ReadonlySet<string>,
): T[] {
  return records.filter((record) => !replaced.has(record.id));
}

/**
 * Active (non-deleted/voided) records with canonical-superseded mirrors removed.
 * The single derivation behind every "active + deduped" collection used by the balance paths.
 */
export function selectActiveDedupedRecords<T extends { id: string }>(
  records: readonly T[],
  replaced: ReadonlySet<string>,
): T[] {
  return records.filter((record) =>
    isActiveOperationalRecord(record as Parameters<typeof isActiveOperationalRecord>[0]) && !replaced.has(record.id));
}

/** Active advances with canonical-superseded mirrors removed (typed convenience over the generic). */
export function selectActiveDedupedAdvances(
  advances: readonly Advance[],
  replaced: ReadonlySet<string>,
): Advance[] {
  return selectActiveDedupedRecords(advances, replaced);
}

export type DedupedExpenseVouchers = {
  legacyOnlyVouchers: Voucher[];
  generalExpenseVouchers: Voucher[];
  cashAffectingVouchers: Voucher[];
};

/**
 * From an already-active voucher list, drop canonical-superseded mirrors and derive the
 * general-expense and cash-affecting voucher collections the balance/report engines consume.
 *
 * `settlements` is forwarded to getGeneralExpenseVouchers for its settlement-voucher exclusion;
 * callers pass whatever settlement list they already use so behaviour is preserved exactly.
 */
export function selectDedupedExpenseVouchers(
  activeVouchers: readonly Voucher[],
  settlements: readonly LabourWageSettlement[] = [],
  replaced: ReadonlySet<string> = new Set(),
): DedupedExpenseVouchers {
  const legacyOnlyVouchers = activeVouchers.filter((voucher) => !replaced.has(voucher.id));
  return {
    legacyOnlyVouchers,
    generalExpenseVouchers: getGeneralExpenseVouchers(legacyOnlyVouchers, settlements),
    cashAffectingVouchers: getCashAffectingVouchers(legacyOnlyVouchers, settlements),
  };
}
