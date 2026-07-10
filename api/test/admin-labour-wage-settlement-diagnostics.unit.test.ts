import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AuthenticatedUser } from "../src/auth.js";
import { buildLabourWageSettlementDiagnostics } from "../src/lib/labour-wage-settlement-diagnostics.js";
import { canAccessDiagnostics } from "../src/routes/admin-labour-wage-settlement-diagnostics.js";

const workspaceId = randomUUID();
const settlementId = randomUUID();
const clientRequestId = randomUUID();
const accountId = randomUUID();
const legacyAlias = `android:legacy:account:${randomUUID()}`;

function baseInput(overrides: Partial<Parameters<typeof buildLabourWageSettlementDiagnostics>[0]> = {}) {
  return {
    lookup: {
      workspaceId,
      settlementNumber: "LW-0006",
      settlementId,
      clientRequestId,
    },
    settlementRecord: null,
    lifecycleRecord: null,
    paymentAccounts: [],
    operationalAccountRecords: [],
    accountTransactions: [],
    allocations: [],
    attendanceLinks: [],
    labourEarnings: [],
    ...overrides,
  } as Parameters<typeof buildLabourWageSettlementDiagnostics>[0];
}

test("admin diagnostics authorization accepts platform admins and workspace owners only", () => {
  const admin: AuthenticatedUser = { id: randomUUID(), workspaceId: null, workspaceName: null, email: "admin@example.test", displayName: "Admin", role: "platform_admin", platformRole: "platform_admin", memberships: [], status: "approved" };
  const owner: AuthenticatedUser = { ...admin, workspaceId, platformRole: null, role: "workspace_owner", memberships: [{ workspaceId, role: "workspace_owner", active: true, permissions: null, farmAccessMode: "all", farmIds: [], membershipId: randomUUID(), workspaceName: "Settlement Workspace", createdAt: null, updatedAt: null }] };
  const manager: AuthenticatedUser = { ...admin, workspaceId, platformRole: null, role: "workspace_manager", memberships: [{ workspaceId, role: "workspace_manager", active: true, permissions: null, farmAccessMode: "all", farmIds: [], membershipId: randomUUID(), workspaceName: "Settlement Workspace", createdAt: null, updatedAt: null }] };
  const crossWorkspaceOwner: AuthenticatedUser = { ...admin, platformRole: null, workspaceId: randomUUID(), role: "workspace_owner", memberships: [{ workspaceId: randomUUID(), role: "workspace_owner", active: true, permissions: null, farmAccessMode: "all", farmIds: [], membershipId: randomUUID(), workspaceName: "Settlement Workspace", createdAt: null, updatedAt: null }] };

  assert.equal(canAccessDiagnostics(admin, workspaceId), true);
  assert.equal(canAccessDiagnostics(owner, workspaceId), true);
  assert.equal(canAccessDiagnostics(manager, workspaceId), false);
  assert.equal(canAccessDiagnostics(crossWorkspaceOwner, workspaceId), false);
});

test("fully committed settlements classify as complete with accounting complete", () => {
  const input = baseInput({
    settlementRecord: {
      id: settlementId,
      clientRecordId: settlementId,
      farmId: randomUUID(),
      seasonId: randomUUID(),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      clientUpdatedAt: new Date("2026-07-01T00:00:00.000Z"),
      payload: {
        settlementNumber: "LW-0006",
        status: "posted",
        linkedAccountId: accountId,
        paymentAccountId: accountId,
        paymentAccountCanonicalId: accountId,
        paymentAccountName: "Younis Khan",
        paymentAccountType: "partner",
        fromDate: "2026-06-01",
        toDate: "2026-06-30",
        settlementDate: "2026-07-01",
        paidAmount: 150,
        advanceAdjustedNow: 150,
        grossWages: 150,
      },
    },
    paymentAccounts: [{ id: accountId, name: "Younis Khan", accountType: "partner", active: true }],
    accountTransactions: [{ referenceId: settlementId, accountId, source: "settlement", sourceType: "labour_wage_settlement", type: "debit" }],
  });
  const diagnostics = buildLabourWageSettlementDiagnostics(input);
  assert.equal(diagnostics.accounting.status, "COMPLETE");
  assert.equal(diagnostics.classification.settlementState, "FULLY_COMMITTED");
  assert.equal(diagnostics.classification.safeToRetryCreate, false);
});

test("committed settlements with missing accounting classify as repair required", () => {
  const input = baseInput({
    settlementRecord: {
      id: settlementId,
      clientRecordId: settlementId,
      farmId: randomUUID(),
      seasonId: randomUUID(),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      clientUpdatedAt: new Date("2026-07-01T00:00:00.000Z"),
      payload: {
        settlementNumber: "LW-0006",
        status: "posted",
        linkedAccountId: accountId,
        paymentAccountId: accountId,
        paymentAccountCanonicalId: accountId,
        paymentAccountName: "Younis Khan",
        paymentAccountType: "partner",
        fromDate: "2026-06-01",
        toDate: "2026-06-30",
        settlementDate: "2026-07-01",
        paidAmount: 150,
        advanceAdjustedNow: 150,
        grossWages: 150,
      },
    },
    paymentAccounts: [{ id: accountId, name: "Younis Khan", accountType: "partner", active: true }],
    attendanceLinks: [{ id: randomUUID() }],
  });
  const diagnostics = buildLabourWageSettlementDiagnostics(input);
  assert.equal(diagnostics.accounting.status, "MISSING");
  assert.equal(diagnostics.classification.settlementState, "COMMITTED_ACCOUNTING_MISSING");
  assert.equal(diagnostics.classification.safeToRetryCreate, false);
});

test("rolled back lifecycle rows classify as rolled back when no settlement exists", () => {
  const input = baseInput({
    lifecycleRecord: {
      clientRequestId,
      state: "rolled_back",
      stage: "rolled_back",
      errorCode: "SETTLEMENT_POSTING_FAILED",
      message: "Settlement could not be created. No changes were saved.",
      safeToRetry: true,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      completedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  });
  const diagnostics = buildLabourWageSettlementDiagnostics(input);
  assert.equal(diagnostics.classification.settlementState, "ROLLED_BACK");
  assert.equal(diagnostics.classification.safeToRetryCreate, true);
  assert.equal(diagnostics.accounting.status, "FAILED");
});

test("partial state is detected when settlement exists without the supporting links", () => {
  const input = baseInput({
    lifecycleRecord: {
      clientRequestId,
      state: "failed",
      stage: "posting_accounting",
      errorCode: "SETTLEMENT_POSTING_FAILED",
      message: "Settlement could not be created. No changes were saved.",
      safeToRetry: true,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      completedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
    settlementRecord: {
      id: settlementId,
      clientRecordId: settlementId,
      farmId: randomUUID(),
      seasonId: randomUUID(),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      clientUpdatedAt: new Date("2026-07-01T00:00:00.000Z"),
      payload: {
        settlementNumber: "LW-0006",
        status: "posted",
        paymentAccountName: "Younis Khan",
        fromDate: "2026-06-01",
        toDate: "2026-06-30",
        settlementDate: "2026-07-01",
        paidAmount: 150,
        advanceAdjustedNow: 150,
        grossWages: 150,
      },
    },
  });
  const diagnostics = buildLabourWageSettlementDiagnostics(input);
  assert.equal(diagnostics.classification.settlementState, "PARTIAL_OR_INCONSISTENT");
  assert.equal(diagnostics.classification.safeToRetryCreate, false);
});

test("name-only matches stay diagnostic hints and do not become authoritative resolutions", () => {
  const input = baseInput({
    settlementRecord: {
      id: settlementId,
      clientRecordId: settlementId,
      farmId: randomUUID(),
      seasonId: randomUUID(),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      clientUpdatedAt: new Date("2026-07-01T00:00:00.000Z"),
      payload: {
        settlementNumber: "LW-0006",
        status: "posted",
        paymentAccountName: "Younis Khan",
        fromDate: "2026-06-01",
        toDate: "2026-06-30",
        settlementDate: "2026-07-01",
        paidAmount: 150,
        advanceAdjustedNow: 150,
        grossWages: 150,
      },
    },
    paymentAccounts: [{ id: accountId, name: "Younis Khan", accountType: "partner", active: true }],
  });
  const diagnostics = buildLabourWageSettlementDiagnostics(input);
  assert.equal(diagnostics.paymentAccountResolution.resolvedCanonicalId, null);
  assert.equal(diagnostics.paymentAccountResolution.nameOnlyCandidates.length > 0, true);
});

test("legacy and canonical identifier mismatches are reported", () => {
  const liveAccountId = randomUUID();
  const input = baseInput({
    settlementRecord: {
      id: settlementId,
      clientRecordId: settlementId,
      farmId: randomUUID(),
      seasonId: randomUUID(),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      clientUpdatedAt: new Date("2026-07-01T00:00:00.000Z"),
      payload: {
        settlementNumber: "LW-0006",
        status: "posted",
        linkedAccountId: legacyAlias,
        paymentAccountId: legacyAlias,
        paymentAccountCanonicalId: legacyAlias,
        paymentAccountLegacyId: legacyAlias,
        paymentAccountName: "Younis Khan",
        paymentAccountType: "partner",
        fromDate: "2026-06-01",
        toDate: "2026-06-30",
        settlementDate: "2026-07-01",
        paidAmount: 150,
        advanceAdjustedNow: 150,
        grossWages: 150,
      },
    },
    paymentAccounts: [{ id: liveAccountId, name: "Younis Khan", oldAndroidId: legacyAlias, accountType: "partner", active: true }],
  });
  const diagnostics = buildLabourWageSettlementDiagnostics(input);
  assert.equal(diagnostics.paymentAccountResolution.resolvedCanonicalId, liveAccountId);
  assert.equal(diagnostics.accounting.identifierMismatch, true);
});

test("archived accounts are reported as inactive and require repair", () => {
  const archivedAccountId = randomUUID();
  const input = baseInput({
    settlementRecord: {
      id: settlementId,
      clientRecordId: settlementId,
      farmId: randomUUID(),
      seasonId: randomUUID(),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      clientUpdatedAt: new Date("2026-07-01T00:00:00.000Z"),
      payload: {
        settlementNumber: "LW-0006",
        status: "posted",
        linkedAccountId: archivedAccountId,
        paymentAccountId: archivedAccountId,
        paymentAccountCanonicalId: archivedAccountId,
        paymentAccountLegacyId: legacyAlias,
        paymentAccountName: "Younis Khan",
        paymentAccountType: "partner",
        fromDate: "2026-06-01",
        toDate: "2026-06-30",
        settlementDate: "2026-07-01",
        paidAmount: 150,
        advanceAdjustedNow: 150,
        grossWages: 150,
      },
    },
    paymentAccounts: [{ id: archivedAccountId, name: "Younis Khan", oldAndroidId: legacyAlias, accountType: "partner", active: false }],
  });
  const diagnostics = buildLabourWageSettlementDiagnostics(input);
  assert.equal(diagnostics.paymentAccountResolution.archived, true);
  assert.equal(diagnostics.paymentAccountResolution.active, false);
  assert.equal(diagnostics.accounting.status, "REPAIR_REQUIRED");
});
