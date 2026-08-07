import {
  ensureDispatchEntryData,
  ensureExpenseEntryData,
  ensureSalesEntryData,
  invalidateEntryData,
} from "./entryDataQueries";
import { scheduleBackgroundTask } from "./startupPerf";

type EntryKind = "expenses" | "sales" | "dispatch";

const preloaders: Record<EntryKind, () => Promise<unknown>> = {
  expenses: async () => {
    await Promise.all([
      import("../pages/workspace/Expenses"),
      ensureExpenseEntryData(),
    ]);
  },
  sales: async () => {
    await Promise.all([
      import("../pages/workspace/Sales"),
      ensureSalesEntryData(),
    ]);
  },
  dispatch: async () => {
    await Promise.all([
      import("../pages/workspace/Dispatch"),
      ensureDispatchEntryData(),
    ]);
  },
};

const pending = new Map<EntryKind, Promise<unknown>>();

export function preloadEntry(kind: EntryKind) {
  const existing = pending.get(kind);
  if (existing) return existing;

  const task = preloaders[kind]().catch((error) => {
    pending.delete(kind);
    if (import.meta.env.DEV) console.warn(`[Muzare performance] ${kind} preload failed`, error);
  });
  pending.set(kind, task);
  return task;
}

function kindFromElement(target: Element | null): EntryKind | null {
  const anchor = target?.closest<HTMLAnchorElement>("a[href]");
  const href = anchor?.getAttribute("href") ?? "";
  if (href.startsWith("/workspace/expenses")) return "expenses";
  if (href.startsWith("/workspace/sales")) return "sales";
  if (href.startsWith("/workspace/dispatch")) return "dispatch";
  return null;
}

export function installEntryPreloading() {
  const onIntent = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    const kind = kindFromElement(target);
    if (kind) void preloadEntry(kind);
  };

  document.addEventListener("pointerover", onIntent, { passive: true, capture: true });
  document.addEventListener("focusin", onIntent, true);
  document.addEventListener("touchstart", onIntent, { passive: true, capture: true });

  const removeScopeInvalidation = () => {
    pending.clear();
    void invalidateEntryData();
  };
  window.addEventListener("muzare-farm-changed", removeScopeInvalidation);
  window.addEventListener("muzare-season-changed", removeScopeInvalidation);

  const removeLocalInvalidation = () => {
    // Operational mutations can affect dispatch availability, account selectors, or master data.
    // Mark cached entry data stale; active consumers refresh in the background.
    void invalidateEntryData();
  };
  window.addEventListener("muzare-local-data-change", removeLocalInvalidation);
  window.addEventListener("muzare-data-refresh", removeLocalInvalidation);

  void scheduleBackgroundTask(async () => {
    // Preload the most frequently used entry routes after the shell has become interactive.
    await preloadEntry("expenses");
    await Promise.allSettled([preloadEntry("sales"), preloadEntry("dispatch")]);
  }, { timeoutMs: 4_000 });

  return () => {
    document.removeEventListener("pointerover", onIntent, true);
    document.removeEventListener("focusin", onIntent, true);
    document.removeEventListener("touchstart", onIntent, true);
    window.removeEventListener("muzare-farm-changed", removeScopeInvalidation);
    window.removeEventListener("muzare-season-changed", removeScopeInvalidation);
    window.removeEventListener("muzare-local-data-change", removeLocalInvalidation);
    window.removeEventListener("muzare-data-refresh", removeLocalInvalidation);
  };
}
