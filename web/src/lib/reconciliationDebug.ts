const trimEnvValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const readHost = (): string => {
  if (typeof window === "undefined") return "";
  return window.location.hostname;
};

export const getReconciliationDebugRuntime = () => {
  const hostname = readHost();
  const appEnv = trimEnvValue(import.meta.env.VITE_APP_ENV as string | undefined);
  const enableFlag = trimEnvValue(import.meta.env.VITE_ENABLE_RECONCILIATION_DEBUG as string | undefined);
  const hostnameEnabled = hostname.includes("muzare-main-dev.onrender.com");
  const envEnabled = ["dev", "development", "staging"].includes((appEnv ?? "").toLowerCase());
  const flagEnabled = ["1", "true", "yes", "on"].includes((enableFlag ?? "").toLowerCase());
  const isDebugEnabled = hostnameEnabled || envEnabled || flagEnabled;
  const disabledReason = isDebugEnabled
    ? null
    : "Reconciliation debug panel disabled because VITE_ENABLE_RECONCILIATION_DEBUG is not true and hostname is not recognized as dev.";

  return {
    hostname,
    appEnv: appEnv ?? "",
    enableFlag: enableFlag ?? "",
    hostnameEnabled,
    envEnabled,
    flagEnabled,
    isDebugEnabled,
    disabledReason,
  };
};
