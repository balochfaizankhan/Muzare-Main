type StartupDetail = Record<string, unknown> | string | number | boolean | null | undefined;

const hasPerformanceMarks = typeof performance !== "undefined" && typeof performance.mark === "function";

// Opt-in profiling on a production-like dev build with ?muzarePerf=1.
// Keep timings local to the browser: never transmit session, farm or financial data.
const profilingEnabled = typeof window !== "undefined" &&
  (import.meta.env.DEV || new URLSearchParams(window.location.search).get("muzarePerf") === "1");

export function markStartup(label: string, detail?: StartupDetail) {
  if (!profilingEnabled || !hasPerformanceMarks) return;
  try {
    performance.mark(`muzare:${label}`);
    const start = performance.getEntriesByName("muzare:react-root-render-start", "mark")[0];
    const current = performance.getEntriesByName(`muzare:${label}`, "mark").at(-1);
    if (start && current && label !== "react-root-render-start") {
      console.debug(`[startup] ${label}: ${Math.round(current.startTime - start.startTime)}ms since root render`);
    } else {
      console.debug(`[startup] ${label}`);
    }
  } catch {
    // Diagnostics must never interfere with startup.
  }
  // Structured details can contain tenant information: do not log them in production.
  if (import.meta.env.DEV && detail !== undefined) console.debug("[startup detail]", detail);
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
