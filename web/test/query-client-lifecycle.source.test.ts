import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/lib/query-client.ts", import.meta.url), "utf8");

test("shared query client is tuned for cache-first mobile revalidation", () => {
  assert.match(source, /staleTime: 2 \* 60_000/);
  assert.match(source, /gcTime: 30 \* 60_000/);
  assert.match(source, /refetchOnWindowFocus: false/);
  assert.match(source, /refetchOnReconnect: true/);
  assert.match(source, /navigator\.onLine && failureCount < 2/);
});
