from pathlib import Path

path = Path("web/src/lib/offline-db.ts")
text = path.read_text()
old = '''export async function workspaceRecords<T extends LocalRecord>(table: EntityTable<T, "id">, options: { includeDeleted?: boolean; includeGeneralFarmRecords?: boolean; includeImportedAcrossSeasons?: boolean } = {}) {
  if (!activeFarmId || !activeSeasonId) return [];
  return table.where("workspaceId").equals(getActiveWorkspaceId())
    .filter((record) => record.farmId === activeFarmId
      && (
        record.seasonId === activeSeasonId
        || (Boolean(options.includeGeneralFarmRecords) && record.seasonId === null)
        || (Boolean(options.includeImportedAcrossSeasons) && (
          isImportedVoucherRecord(record as LocalRecord & Record<string, unknown>)
          || isImportedAccountRecord(record as LocalRecord & Record<string, unknown>)
        ))
      )
      && (Boolean(options.includeDeleted) || isActiveOperationalRecord(record as LocalRecord & Record<string, unknown>))).toArray();
}

export async function workspaceConfigRecords<T extends LocalRecord>(table: EntityTable<T, "id">, options: { includeDeleted?: boolean } = {}) {
  if (!activeFarmId) return [];
  return table.where("workspaceId").equals(getActiveWorkspaceId())
    .filter((record) => record.farmId === activeFarmId
      && (Boolean(options.includeDeleted) || isActiveOperationalRecord(record as LocalRecord & Record<string, unknown>))).toArray();
}
'''
new = '''export async function workspaceRecords<T extends LocalRecord>(table: EntityTable<T, "id">, options: { includeDeleted?: boolean; includeGeneralFarmRecords?: boolean; includeImportedAcrossSeasons?: boolean } = {}) {
  if (!activeFarmId || !activeSeasonId) return [];
  const workspaceId = getActiveWorkspaceId();
  const includeGeneralFarmRecords = Boolean(options.includeGeneralFarmRecords);
  const includeImportedAcrossSeasons = Boolean(options.includeImportedAcrossSeasons);

  // The common path is active-season-only. Start from the existing seasonId index so
  // large workspaces do not scan every locally cached record before filtering. Special
  // general/import reads intentionally start from the existing farmId index because
  // they are allowed to include records outside the active season.
  const collection = !includeGeneralFarmRecords && !includeImportedAcrossSeasons
    ? table.where("seasonId").equals(activeSeasonId)
    : table.where("farmId").equals(activeFarmId);

  return collection.filter((record) => record.workspaceId === workspaceId
    && record.farmId === activeFarmId
    && (
      record.seasonId === activeSeasonId
      || (includeGeneralFarmRecords && record.seasonId === null)
      || (includeImportedAcrossSeasons && (
        isImportedVoucherRecord(record as LocalRecord & Record<string, unknown>)
        || isImportedAccountRecord(record as LocalRecord & Record<string, unknown>)
      ))
    )
    && (Boolean(options.includeDeleted) || isActiveOperationalRecord(record as LocalRecord & Record<string, unknown>))).toArray();
}

export async function workspaceConfigRecords<T extends LocalRecord>(table: EntityTable<T, "id">, options: { includeDeleted?: boolean } = {}) {
  if (!activeFarmId) return [];
  const workspaceId = getActiveWorkspaceId();
  return table.where("farmId").equals(activeFarmId)
    .filter((record) => record.workspaceId === workspaceId
      && record.farmId === activeFarmId
      && (Boolean(options.includeDeleted) || isActiveOperationalRecord(record as LocalRecord & Record<string, unknown>))).toArray();
}
'''

if text.count(old) != 1:
    raise SystemExit("Guard failed: expected helper block exactly once; no changes made.")
path.write_text(text.replace(old, new))
