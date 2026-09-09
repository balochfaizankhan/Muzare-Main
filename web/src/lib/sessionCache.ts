export function readSessionCache<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    window.sessionStorage.removeItem(key);
    return null;
  }
}

export function writeSessionCache<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Session storage is an optional performance cache. Quota/privacy failures
    // must never affect the authoritative server-backed workflow.
  }
}

export function removeSessionCache(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Cache invalidation is best-effort; the next server fetch remains authoritative.
  }
}
