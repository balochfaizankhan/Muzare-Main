import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("public signup no longer auto-creates a session or workspace, and routes to the pending-approval screen", () => {
  const signupPage = source("pages/SignupPage.tsx");
  const api = source("lib/api.ts");
  assert.doesNotMatch(signupPage, /completeSession/);
  assert.match(signupPage, /navigate\("\/pending-approval"/);
  assert.match(api, /export const signup = \(input: SignupRequest\) =>/);
  assert.doesNotMatch(api, /status: "approved"; message: string; token: string; user: AppUser/);
});

test("login routes blocked accounts to their dedicated interstitial instead of an inline form error", () => {
  const loginPage = source("pages/LoginPage.tsx");
  assert.match(loginPage, /isAccountBlockedError\(error\)/);
  assert.match(loginPage, /"\/pending-approval"/);
  assert.match(loginPage, /"\/account-rejected"/);
  assert.match(loginPage, /"\/account-suspended"/);
});

test("App.tsx registers the pending/rejected/suspended/onboarding routes and gates them by account status", () => {
  const app = source("App.tsx");
  assert.match(app, /path="\/pending-approval" element=\{<PendingApprovalPage \/>\}/);
  assert.match(app, /path="\/account-rejected" element=\{<AccountRejectedPage \/>\}/);
  assert.match(app, /path="\/account-suspended" element=\{<AccountSuspendedPage \/>\}/);
  assert.match(app, /path="\/onboarding" element=\{<RequireAuth><OnboardingPage \/><\/RequireAuth>\}/);
  assert.match(app, /function blockedRedirect\(user: AppUser\)/);
  assert.match(app, /if \(!user\.workspaceId\) return <Navigate to="\/onboarding" replace \/>;/);
});

test("getHomePath and getAccountStatusPath route non-workspace and blocked users correctly", () => {
  const permissions = source("lib/permissions.ts");
  assert.match(permissions, /if \(!isPlatformUser\(user\) && !user\.workspaceId\) return "\/onboarding";/);
  assert.match(permissions, /pending: "\/pending-approval"/);
  assert.match(permissions, /rejected: "\/account-rejected"/);
  assert.match(permissions, /suspended: "\/account-suspended"/);
});

test("the Registration Requests admin page reads/writes the new admin-registrations endpoints, not the legacy workspace-scoped approvals endpoint", () => {
  const page = source("pages/AdminApprovalsPage.tsx");
  const api = source("lib/api.ts");
  assert.match(page, /fetchRegistrations/);
  assert.match(page, /approveRegistrationRequest/);
  assert.match(page, /rejectRegistrationRequest/);
  assert.match(api, /\/v1\/admin\/registrations/);
  assert.doesNotMatch(api, /\/v1\/admin\/approvals/);
});

test("the onboarding page only creates a workspace for an approved user who does not already have one", () => {
  const onboarding = source("pages/OnboardingPage.tsx");
  assert.match(onboarding, /if \(user\.workspaceId\) return <Navigate to="\/workspace\/dashboard" replace \/>;/);
  assert.match(onboarding, /submitOnboardingWorkspace/);
});
