import { Component, type ErrorInfo, type PropsWithChildren } from "react";

const RECOVERY_KEY = "muzare:stale-asset-recovery-at";
const RECOVERY_WINDOW_MS = 30_000;
const STABLE_CLEAR_MS = 10_000;

function messageFrom(reason: unknown) {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason ?? "");
  }
}

function looksLikeStaleAssetError(reason: unknown) {
  const message = messageFrom(reason).toLowerCase();
  return message.includes("failed to fetch dynamically imported module")
    || message.includes("error loading dynamically imported module")
    || message.includes("importing a module script failed")
    || message.includes("chunkloaderror")
    || message.includes("loading chunk")
    || message.includes("failed to load module script");
}

async function updateServiceWorkerBeforeReload() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.race([
      Promise.allSettled(registrations.map((registration) => registration.update())),
      new Promise((resolve) => window.setTimeout(resolve, 1_200)),
    ]);
  } catch {
    // Reload still gives the browser a chance to pick up the current application shell.
  }
}

export function recoverFromStaleAsset(reason: unknown, force = false) {
  if (!force && !looksLikeStaleAssetError(reason)) return false;

  const now = Date.now();
  let previous = 0;
  try {
    previous = Number(window.sessionStorage.getItem(RECOVERY_KEY) ?? 0);
  } catch {
    previous = 0;
  }

  if (previous && now - previous < RECOVERY_WINDOW_MS) return false;

  try {
    window.sessionStorage.setItem(RECOVERY_KEY, String(now));
  } catch {
    // Session storage can be unavailable in strict/private browsing modes.
  }

  void (async () => {
    await updateServiceWorkerBeforeReload();
    window.location.reload();
  })();
  return true;
}

export function installStartupRecovery() {
  const onPreloadError = (event: Event) => {
    event.preventDefault();
    const reason = (event as CustomEvent<unknown>).detail ?? "vite:preloadError";
    recoverFromStaleAsset(reason, true);
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (recoverFromStaleAsset(event.reason)) event.preventDefault();
  };

  const onWindowError = (event: ErrorEvent) => {
    recoverFromStaleAsset(event.error ?? event.message);
  };

  window.addEventListener("vite:preloadError", onPreloadError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  window.addEventListener("error", onWindowError);

  // A page that remains alive for this long has escaped the stale-build loop, so a future
  // deployment is allowed one fresh recovery attempt in the same browser tab.
  window.setTimeout(() => {
    try {
      window.sessionStorage.removeItem(RECOVERY_KEY);
    } catch {
      // Nothing to clean up.
    }
  }, STABLE_CLEAR_MS);

  return () => {
    window.removeEventListener("vite:preloadError", onPreloadError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    window.removeEventListener("error", onWindowError);
  };
}

type RecoveryState = {
  error: Error | null;
  recovering: boolean;
};

export class StartupRecoveryBoundary extends Component<PropsWithChildren, RecoveryState> {
  state: RecoveryState = { error: null, recovering: false };

  static getDerivedStateFromError(error: Error): RecoveryState {
    return { error, recovering: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const recovering = recoverFromStaleAsset(error);
    if (recovering) {
      this.setState({ recovering: true });
      return;
    }
    console.error("[muzare] unrecoverable startup/render error", error, info.componentStack);
  }

  render() {
    const { error, recovering } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app-startup-screen" role="alert">
        <div className="app-startup-screen__copy">
          <strong>{recovering ? "Updating Muzare…" : "Muzare couldn't load this page."}</strong>
          <p>
            {recovering
              ? "Refreshing the app to load the latest version."
              : `Build ${__GIT_COMMIT_HASH__}. Reload to try again.`}
          </p>
          {!recovering ? (
            <button type="button" className="primary-button" onClick={() => window.location.reload()}>
              Reload app
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}
