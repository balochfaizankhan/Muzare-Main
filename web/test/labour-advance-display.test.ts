import assert from "node:assert/strict";
import test from "node:test";
import { resolveAdvanceCardIdentity, type AdvanceIdentitySource } from "../src/lib/labourAdvanceDisplay.ts";
import type { Labourer } from "../src/lib/offline-db.ts";

const labourer = (overrides: Partial<Labourer> & Pick<Labourer, "id" | "name">): Labourer => ({
  id: overrides.id,
  workspaceId: "workspace-1",
  farmId: "farm-1",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  name: overrides.name,
  group: overrides.group ?? "",
  groupId: overrides.groupId,
  dailyWage: 0,
});

const advance = (overrides: Partial<AdvanceIdentitySource>): AdvanceIdentitySource => ({
  recipientScope: "INDIVIDUAL",
  labourerId: null,
  labourerName: null,
  labourGroupName: null,
  receivedByName: null,
  financialOwnerName: null,
  ...overrides,
});

test("an individual advance always shows the labourer's name as the primary title", () => {
  const identity = resolveAdvanceCardIdentity(
    advance({ recipientScope: "INDIVIDUAL", labourerId: "l1", labourerName: "Saleem Nutkani", financialOwnerName: "Saleem Nutkani" }),
    new Map(),
  );
  assert.equal(identity.title, "Saleem Nutkani");
  assert.equal(identity.isGroupAdvance, false);
});

test("the labourer's own group appears only as secondary metadata, never as the title", () => {
  const labourerById = new Map([["l1", labourer({ id: "l1", name: "Saleem Nutkani", group: "Saleem Group", groupId: "g1" })]]);
  const identity = resolveAdvanceCardIdentity(
    advance({ recipientScope: "INDIVIDUAL", labourerId: "l1", labourerName: "Saleem Nutkani", financialOwnerName: "Saleem Nutkani" }),
    labourerById,
  );
  assert.equal(identity.title, "Saleem Nutkani");
  assert.equal(identity.groupLabel, "Saleem Group");
});

test("a deleted or deactivated labourer's historical name is retained from the resolved snapshot, not hidden", () => {
  // labourerById intentionally does not contain "l1" — simulating a labourer removed from the active roster.
  const identity = resolveAdvanceCardIdentity(
    advance({ recipientScope: "INDIVIDUAL", labourerId: "l1", labourerName: "Saleem Nutkani", financialOwnerName: "Saleem Nutkani" }),
    new Map(),
  );
  assert.equal(identity.title, "Saleem Nutkani");
});

test("a group-level advance with no individual receiver shows 'Group advance' and the group name, never a bare group substitution for an individual", () => {
  const identity = resolveAdvanceCardIdentity(
    advance({ recipientScope: "LABOUR_GROUP", labourGroupName: "Saleem Group", financialOwnerName: "Saleem Group", receivedByName: null }),
    new Map(),
  );
  assert.equal(identity.title, "Group advance");
  assert.equal(identity.isGroupAdvance, true);
  assert.equal(identity.groupLabel, "Saleem Group");
});

test("a group-level advance with a resolvable individual receiver shows that individual as the title, with the group as secondary", () => {
  const identity = resolveAdvanceCardIdentity(
    advance({ recipientScope: "LABOUR_GROUP", labourGroupName: "Saleem Group", financialOwnerName: "Saleem Group", receivedByName: "Younis Khan" }),
    new Map(),
  );
  assert.equal(identity.title, "Younis Khan");
  assert.equal(identity.isGroupAdvance, false);
  assert.equal(identity.groupLabel, "Saleem Group");
});

test("a genuinely invalid legacy record with no recoverable identity shows 'Unknown labour recipient', never a group substitution", () => {
  const individual = resolveAdvanceCardIdentity(
    advance({ recipientScope: "INDIVIDUAL", labourerId: null, labourerName: null, financialOwnerName: "Unresolved recipient" }),
    new Map(),
  );
  assert.equal(individual.title, "Unknown labour recipient");
  assert.equal(individual.isGroupAdvance, false);

  const group = resolveAdvanceCardIdentity(
    advance({ recipientScope: "LABOUR_GROUP", labourGroupName: null, financialOwnerName: "Unresolved recipient", receivedByName: null }),
    new Map(),
  );
  assert.equal(group.title, "Unknown labour recipient");
  assert.equal(group.isGroupAdvance, false);
  assert.equal(group.groupLabel, null);
});
