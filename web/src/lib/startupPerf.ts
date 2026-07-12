type StartupDetail = Record<string, unknown> | string | number | boolean | null | undefined;

const hasPerformanceMarks = typeof performance !== "undefined" && typeof performance.mark === "function";

export function markStartup(label: string, detail?: StartupDetail) {
  if (!import.meta.env.DEV || !hasPerformanceMarks) return;
  try {
    performance.mark(`muzare:${label}`);
  } catch {
    // Ignore duplicate marks or unsupported environments.
  }
  if (detail !== undefined) {
    console.debug(`[startup] ${label}`, detail);
  } else {
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
