import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createChangeCoalescer, createRefreshDebouncer } from "../src/lib/eventCoalescing";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("canonical labour financials debounce refresh events through the shared eventCoalescing helper", () => {
  const hook = source("hooks/useCanonicalLabourFinancials.ts");
  assert.match(hook, /import \{ createRefreshDebouncer \} from "\.\.\/lib\/eventCoalescing";/);
  assert.match(hook, /const debouncer = createRefreshDebouncer\(\(\) => \{/);
  assert.match(hook, /void queryClient\.invalidateQueries\(\{ queryKey: \["canonical-labour-financials", token, workspaceId, farmId, seasonId\], exact: true \}\);/);
  assert.match(hook, /window\.addEventListener\("muzare-data-refresh", debouncer\.trigger\);/);
  assert.match(hook, /window\.addEventListener\("muzare-local-data-change", debouncer\.trigger\);/);
  assert.match(hook, /debouncer\.cancel\(\);/);
});

test("syncPendingRecords is wired through the shared createChangeCoalescer helper (not a private copy of it)", () => {
  const sync = source("services/syncService.ts");
  assert.match(sync, /import \{ createChangeCoalescer \} from "\.\.\/lib\/eventCoalescing";/);
  const start = sync.indexOf("export async function syncPendingRecords");
  const end = sync.indexOf("\nfunction normalizeRecord");
  assert.ok(start > -1 && end > start);
  const body = sync.slice(start, end);
  assert.match(body, /const changeCoalescer = createChangeCoalescer\(\(\) => window\.dispatchEvent\(new Event\("muzare-local-data-change"\)\)\);/);
  // Only the coalescer's own dispatch call may reference the event directly; every mutation
  // branch inside the loop must call markChanged() instead of dispatching per item.
  assert.equal((body.match(/window\.dispatchEvent\(new Event\("muzare-local-data-change"\)\)/g) ?? []).length, 1, "only createChangeCoalescer's dispatch callback may reference the event — no per-mutation dispatch should remain");
  assert.equal((body.match(/changeCoalescer\.markChanged\(\);/g) ?? []).length, 6, "every success/failure branch in the loop should mark the coalescer changed instead of dispatching directly");
  assert.match(body, /changeCoalescer\.flush\(\);\r?\n {2}syncing = false;/);
});

// createChangeCoalescer and createRefreshDebouncer (web/src/lib/eventCoalescing.ts) are the
// exact, exported, framework-agnostic helpers syncPendingRecords and useCanonicalLabourFinancials
// import above. These tests call the real functions directly — no Dexie, no fetch, no DOM,
// no import.meta.env — so they prove the actual behavior, not a re-implementation of it.

test("sync-event coalescing: zero successful mutations emit zero events", () => {
  let dispatched = 0;
  const coalescer = createChangeCoalescer(() => { dispatched += 1; });
  coalescer.flush();
  assert.equal(dispatched, 0);
});

test("sync-event coalescing: one successful mutation emits one event", () => {
  let dispatched = 0;
  const coalescer = createChangeCoalescer(() => { dispatched += 1; });
  coalescer.markChanged();
  coalescer.flush();
  assert.equal(dispatched, 1);
});

test("sync-event coalescing: ten successful mutations in one pass emit exactly one event", () => {
  let dispatched = 0;
  const coalescer = createChangeCoalescer(() => { dispatched += 1; });
  for (let i = 0; i < 10; i += 1) coalescer.markChanged();
  coalescer.flush();
  assert.equal(dispatched, 1);
});

test("sync-event coalescing: a fully failed pass (no markChanged calls) emits zero events", () => {
  let dispatched = 0;
  const coalescer = createChangeCoalescer(() => { dispatched += 1; });
  // Simulates every mutation in the pass hitting a branch that never calls markChanged().
  coalescer.flush();
  assert.equal(dispatched, 0);
});

test("sync-event coalescing: an unchanged stuck queue does not emit another event on every repeated tick", () => {
  let dispatched = 0;
  const dispatch = () => { dispatched += 1; };
  // Each simulated 30s tick creates its own coalescer, exactly as each syncPendingRecords()
  // call does — a queue that never successfully changes anything must never dispatch.
  for (let tick = 0; tick < 5; tick += 1) {
    const coalescer = createChangeCoalescer(dispatch);
    coalescer.flush();
  }
  assert.equal(dispatched, 0);
});

test("frontend debounce: one trigger causes exactly one invalidation after the delay", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let invalidations = 0;
  const debouncer = createRefreshDebouncer(() => { invalidations += 1; }, 250);
  debouncer.trigger();
  assert.equal(invalidations, 0, "must not invalidate synchronously");
  t.mock.timers.tick(249);
  assert.equal(invalidations, 0, "must not invalidate before the delay elapses");
  t.mock.timers.tick(1);
  assert.equal(invalidations, 1, "must invalidate exactly once after the delay elapses");
});

test("frontend debounce: multiple triggers within the debounce window cause exactly one invalidation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let invalidations = 0;
  const debouncer = createRefreshDebouncer(() => { invalidations += 1; }, 250);
  debouncer.trigger();
  t.mock.timers.tick(100);
  debouncer.trigger();
  t.mock.timers.tick(100);
  debouncer.trigger();
  t.mock.timers.tick(100);
  // 300ms of elapsed ticks total, but each trigger() reset the 250ms window, so nothing
  // should have fired yet — proving bursts collapse instead of firing once per event.
  assert.equal(invalidations, 0, "a burst of triggers must keep resetting the timer, not accumulate firings");
  t.mock.timers.tick(250);
  assert.equal(invalidations, 1, "the burst must resolve to exactly one invalidation once it goes quiet");
});

test("frontend debounce: cancel (simulating unmount) prevents a pending invalidation from ever firing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let invalidations = 0;
  const debouncer = createRefreshDebouncer(() => { invalidations += 1; }, 250);
  debouncer.trigger();
  debouncer.cancel();
  t.mock.timers.tick(1_000);
  assert.equal(invalidations, 0, "cancelling the debouncer must clear the pending timer so it never invalidates");
});
