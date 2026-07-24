import i18n from "../i18n";
import type { LabourAdvancePosition } from "./api";
import type { Labourer } from "./offline-db";

const UNRESOLVED_SENTINELS = new Set(["Unresolved recipient", "Recipient unavailable"]);

// Localized fallback titles for cards with no resolvable recipient. English stays the source of
// truth for the backend sentinel wording; these keys mirror it per language (see backendSentinel
// in src/i18n.ts).
const unknownRecipientTitle = () => i18n.t("backendSentinel.unknownLabourRecipient");
const groupAdvanceTitle = () => i18n.t("backendSentinel.groupAdvance");

const cleanName = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed && !UNRESOLVED_SENTINELS.has(trimmed) ? trimmed : null;
};

export type AdvanceCardIdentity = {
  /** The primary card title: an individual's name, or "Group advance" / "Unknown labour recipient". */
  title: string;
  /** True only for a genuine group-level advance with no individual recipient to name. */
  isGroupAdvance: boolean;
  /** Secondary group context — the group an individual belongs to, or the group name for a group-only advance. */
  groupLabel: string | null;
};

export type AdvanceIdentitySource = Pick<
  LabourAdvancePosition,
  "recipientScope" | "labourerId" | "labourerName" | "labourGroupName" | "receivedByName" | "financialOwnerName"
>;

/**
 * Resolves what a labour advance card should show as its primary identity, per priority:
 * 1. the recipient snapshot/name the server already resolved (labourerName / receivedByName / financialOwnerName),
 * 2. the labourer's own group membership (for secondary "Group: X" context, not as a fallback title),
 * 3. "Group advance" only for a genuinely group-level record with no individual, else "Unknown labour recipient".
 * A group name must never substitute for an unresolved individual recipient.
 */
export function resolveAdvanceCardIdentity(
  advance: AdvanceIdentitySource,
  labourerById: Map<string, Labourer>,
): AdvanceCardIdentity {
  if (advance.recipientScope === "INDIVIDUAL") {
    const name = cleanName(advance.labourerName) ?? cleanName(advance.financialOwnerName);
    const ownGroupName = advance.labourerId ? labourerById.get(advance.labourerId)?.group : undefined;
    return {
      title: name ?? unknownRecipientTitle(),
      isGroupAdvance: false,
      groupLabel: cleanName(ownGroupName),
    };
  }
  if (advance.recipientScope === "LABOUR_GROUP") {
    const individual = cleanName(advance.receivedByName);
    const groupLabel = cleanName(advance.labourGroupName) ?? cleanName(advance.financialOwnerName);
    if (individual) return { title: individual, isGroupAdvance: false, groupLabel };
    if (groupLabel) return { title: groupAdvanceTitle(), isGroupAdvance: true, groupLabel };
    return { title: unknownRecipientTitle(), isGroupAdvance: false, groupLabel: null };
  }
  const name = cleanName(advance.financialOwnerName);
  return { title: name ?? unknownRecipientTitle(), isGroupAdvance: false, groupLabel: null };
}
