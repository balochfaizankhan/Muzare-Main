export type AccountIdentityLike = {
  id: string;
  name: string;
  oldAndroidId?: string | null;
  sourceType?: string | null;
  accountType?: string | null;
  active?: boolean | null;
};

export type AccountMatchSource = "canonical" | "alias" | "name_fallback" | "unmatched";

export type AccountIdentityResolution = {
  canonicalAccountId: string | null;
  matchedBy: AccountMatchSource;
  matchedAccount: AccountIdentityLike | null;
  needsAccountMappingRepair: boolean;
};

export type AccountIdentityLookup = {
  byId: Map<string, AccountIdentityLike>;
  aliasToId: Map<string, string>;
  nameToAccounts: Map<string, AccountIdentityLike[]>;
};

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function trimText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeLegacyAndroidAccountId(value: string | null | undefined) {
  const trimmed = trimText(value);
  if (!trimmed) return null;
  const androidMatch = /^android:[^:]+:(?:account|partner):(.+)$/i.exec(trimmed);
  if (androidMatch?.[1]?.trim()) return androidMatch[1].trim();
  return trimmed;
}

export function buildAccountIdentityLookup(accounts: AccountIdentityLike[]): AccountIdentityLookup {
  const byId = new Map<string, AccountIdentityLike>();
  const aliasToId = new Map<string, string>();
  const nameToAccounts = new Map<string, AccountIdentityLike[]>();

  for (const account of accounts) {
    byId.set(account.id, account);
    const alias = normalizeLegacyAndroidAccountId(account.oldAndroidId ?? null);
    if (alias) aliasToId.set(alias, account.id);
    if (account.oldAndroidId && account.oldAndroidId.trim()) aliasToId.set(account.oldAndroidId.trim(), account.id);

    const normalizedName = normalize(account.name);
    const bucket = nameToAccounts.get(normalizedName) ?? [];
    bucket.push(account);
    nameToAccounts.set(normalizedName, bucket);
  }

  return { byId, aliasToId, nameToAccounts };
}

export function resolveCanonicalAccountId(
  value: string | null | undefined,
  accounts: AccountIdentityLike[] | AccountIdentityLookup,
) {
  const lookup = Array.isArray(accounts) ? buildAccountIdentityLookup(accounts) : accounts;
  const trimmed = trimText(value);
  if (!trimmed) return null;
  if (lookup.byId.has(trimmed)) return lookup.byId.get(trimmed)!.id;
  const alias = normalizeLegacyAndroidAccountId(trimmed);
  if (alias && lookup.aliasToId.has(alias)) return lookup.aliasToId.get(alias)!;
  return null;
}

export function resolveAccountIdentity(
  value: string | null | undefined,
  accounts: AccountIdentityLike[] | AccountIdentityLookup,
  fallbackName?: string | null,
): AccountIdentityResolution {
  const lookup = Array.isArray(accounts) ? buildAccountIdentityLookup(accounts) : accounts;
  const trimmed = trimText(value);
  if (trimmed) {
    if (lookup.byId.has(trimmed)) {
      return {
        canonicalAccountId: lookup.byId.get(trimmed)!.id,
        matchedBy: "canonical",
        matchedAccount: lookup.byId.get(trimmed) ?? null,
        needsAccountMappingRepair: false,
      };
    }
    const alias = normalizeLegacyAndroidAccountId(trimmed);
    if (alias && lookup.aliasToId.has(alias)) {
      const canonicalAccountId = lookup.aliasToId.get(alias)!;
      return {
        canonicalAccountId,
        matchedBy: "alias",
        matchedAccount: lookup.byId.get(canonicalAccountId) ?? null,
        needsAccountMappingRepair: false,
      };
    }
  }

  const fallback = normalize(fallbackName);
  if (fallback) {
    const matches = lookup.nameToAccounts.get(fallback) ?? [];
    if (matches.length === 1) {
      return {
        canonicalAccountId: matches[0]!.id,
        matchedBy: "name_fallback",
        matchedAccount: matches[0]!,
        needsAccountMappingRepair: true,
      };
    }
  }

  return {
    canonicalAccountId: null,
    matchedBy: "unmatched",
    matchedAccount: null,
    needsAccountMappingRepair: Boolean(trimmed || fallback),
  };
}
