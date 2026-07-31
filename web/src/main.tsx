import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import "./i18n";
import "./styles.css";
import "./reports-account-polish.css";
import "./accounts-report-v2.css";
import "./reports-expenditure-drilldown.css";
import "./sales-polish.css";
import "./sales-date-sync.css";
import "./dispatch-records-dialogs.css";
import "./partner-ledger-polish.css";
import "./partner-ledger-select-fix.css";
import "./non-attendance-report-print.css";
import "./sales-date-sync";
import { installSystemTextLocalizationGuard } from "./lib/systemTextLocalization";
import { queryClient } from "./lib/query-client";
import { markStartup, scheduleBackgroundTask } from "./lib/startupPerf";

function RootShell() {
  useEffect(() => {
    markStartup("app-shell-mounted");
    return installSystemTextLocalizationGuard();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

markStartup("react-root-render-start");
void scheduleBackgroundTask(async () => {
  const { registerSW } = await import("virtual:pwa-register");
  registerSW({ immediate: true });
  markStartup("service-worker-registered");
}, { timeoutMs: 3_000 });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootShell />
  </StrictMode>,
);
