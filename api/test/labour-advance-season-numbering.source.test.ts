import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const source = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
test("labour advance voucher sequence and lock are scoped to season", async () => {
  const lib = await source("api/src/lib/labour-payments.ts");
  const fn = lib.split("export async function allocateLabourAdvanceVoucherNumber")[1].split("export async function allocateLabourAdvanceAdjustmentNumber")[0];
  assert.match(fn, /seasonId: string/);
  assert.match(fn, /eq\(labourPaymentVouchers\.seasonId, seasonId\)/);
  assert.match(fn, /\$\{seasonId\}:labour-advance-voucher-number/);
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /allocateLabourAdvanceVoucherNumber\(\s*tx,\s*workspaceId,\s*input\.farmId,\s*input\.seasonId/);
});
test("unique index migration preserves historical vouchers", async () => {
  const sql = await source("database/migrations/0048_labour_voucher_season_number_uniqueness.sql");
  assert.match(sql, /workspace_id, farm_id, season_id, voucher_number/);
  assert.doesNotMatch(sql, /UPDATE labour_payment_vouchers|DELETE FROM labour_payment_vouchers/);
  const migrations = await source("api/src/db/migrations.ts");
  assert.match(migrations, /0048_labour_voucher_season_number_uniqueness/);
});
