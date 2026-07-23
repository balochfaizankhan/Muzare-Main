/**
 * Coalesces any number of "data changed" signals raised while processing a batch (e.g. one
 * sync pass over N queued mutations) into at most one dispatch call once the batch is done,
 * instead of dispatching per item — which used to invalidate/refetch financial queries once
 * per queued mutation.
 */
export function createChangeCoalescer(dispatch: () => void) {
  let changed = false;
  return {
    markChanged: () => {
      changed = true;
    },
    flush: () => {
      if (changed) dispatch();
    },
  };
}

export const REFRESH_EVENT_DEBOUNCE_MS = 250;

/**
 * Collapses any number of refresh-event firings within `delayMs` of each other into a single
 * `invalidate()` call, instead of invalidating (and refetching) once per event — protects
 * against bursts from multiple distinct dispatch sites (settlement saves, bulk imports, etc.)
 * arriving close together.
 */
export function createRefreshDebouncer(invalidate: () => void, delayMs: number = REFRESH_EVENT_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger: () => {
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        invalidate();
      }, delayMs);
    },
    cancel: () => {
      if (timer != null) clearTimeout(timer);
      timer = null;
    },
  };
}
