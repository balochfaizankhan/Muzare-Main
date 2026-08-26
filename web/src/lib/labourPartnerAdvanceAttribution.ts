import type { LabourFinancialReadModel } from "./api";

const money = (value: number) => Number(value.toFixed(2));

/**
 * Partner advance funding is created when the original advance is paid. Applying
 * that advance to a Labour Due is non-cash and must not change Farm Owes Partner;
 * it only moves the partner-funded advance from outstanding -> applied.
 *
 * The aggregate Group Advance Pool model posts one pool-level application, so the
 * legacy per-voucher `advancePositions[].appliedAmount` fields cannot represent its
 * funding owner. `labourPaymentEntries[].appliedAdvances` is the canonical owner
 * attribution because it follows the persisted application-source lineage back to
 * the original funding voucher/account.
 */
export function reconcilePartnerAdvanceAttribution(
  financials: LabourFinancialReadModel,
): LabourFinancialReadModel {
  const appliedByAccount = new Map<string, number>();

  for (const entry of financials.labourPaymentEntries) {
    for (const part of entry.appliedAdvances) {
      if (!part.accountId) continue;
      appliedByAccount.set(
        part.accountId,
        money((appliedByAccount.get(part.accountId) ?? 0) + Number(part.amount || 0)),
      );
    }
  }

  // Do not invent ownership for an application whose complete source lineage is
  // genuinely unresolved. Known exact source amounts are still safe to surface;
  // the unresolved remainder stays unattributed rather than being guessed.
  const partnerPositions = financials.partnerPositions.map((position) => {
    const attributedApplied = money(appliedByAccount.get(position.accountId) ?? 0);
    const appliedLabourAdvances = Math.max(
      money(Number(position.appliedLabourAdvances || 0)),
      attributedApplied,
    );
    const outstandingLabourAdvances = Math.max(
      money(
        Number(position.labourAdvancesPaid || 0)
          - appliedLabourAdvances
          - Number(position.recoveries || 0),
      ),
      0,
    );

    return {
      ...position,
      appliedLabourAdvances,
      outstandingLabourAdvances,
      // Deliberately preserve farmOwesPartner/ledgerBalance. Applying an advance
      // has zero partner-liability balance effect because the original funding was
      // already recognized when the advance was paid.
    };
  });

  return { ...financials, partnerPositions };
}
