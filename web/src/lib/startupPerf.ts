const hasPerformanceMarks = typeof performance !== "undefined" && typeof performance.mark === "function";
const startupOrigin = hasPerformanceMarks ? performance.now() : 0;
const marks = new Map<string, number>();
const enabled = import.meta.env.DEV || (
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("muzarePerf") === "1"
);

export type StartupTiming = { label: string; elapsedMs: number };

export function getStartupTimings(): StartupTiming[] {
  return [...marks.entries()].map(([label, timestamp]) => ({
    label,
    elapsedMs: Math.round((timestamp - startupOrigin) * 10) / 10,
  }));
}

export function markStartup(label: string, _detail?: unknown) {
  // Preserve existing call sites; diagnostic details are intentionally never stored or logged.
  if (!enabled || !hasPerformanceMarks) return;
  try {
    const timestamp = performance.now();
    marks.set(label, timestamp);
    performance.mark(`muzare:${label}`);
  } catch {
    // Performance diagnostics must never interrupt startup.
  }
  if (import.meta.env.DEV) {
    console.debug(`[startup] ${label}`);
  }
}

type BackgroundTaskOptions = {
  timeoutMs?: number;
};

export function scheduleBackgroundTask(task: () => void | Promise<void>, options: BackgroundTaskOptions = {}) {
  const run = () => Promise.resolve().then(task);
  if (typeof window === "undefined") return run();
  const timeoutMs = options.timeoutMs ?? 1_000;
  if (typeof window.requestIdleCallback === "function") {
    return new Promise<void>((resolve, reject) => {
      window.requestIdleCallback(() => {
        run().then(resolve).catch(reject);
      }, { timeout: timeoutMs });
    });
  }
  return new Promise<void>((resolve, reject) => {
    window.setTimeout(() => {
      run().then(resolve).catch(reject);
    }, timeoutMs);
  });
}
