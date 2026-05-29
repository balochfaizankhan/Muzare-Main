import { useEffect, type PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { AdminApprovalsPage } from "./pages/AdminApprovalsPage";
import { ContextPage } from "./pages/ContextPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { ModulePage, type ModuleKey } from "./pages/ModulePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SignupPage } from "./pages/SignupPage";

function RequireAuth({ children }: PropsWithChildren) {
  const { user, loading } = useAuth();

  if (loading) return <div className="page-loader" aria-label="Loading" />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function RequireAdmin({ children }: PropsWithChildren) {
  const { user, loading } = useAuth();

  if (loading) return <div className="page-loader" aria-label="Loading" />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return children;
}

const moduleRoutes: Array<{ path: string; module: ModuleKey }> = [
  { path: "/workforce", module: "workforce" },
  { path: "/expenses", module: "expenses" },
  { path: "/sales", module: "sales" },
  { path: "/dispatch", module: "dispatch" },
  { path: "/accounts", module: "accounts" },
  { path: "/partner-ledger", module: "partnerLedger" },
];

export default function App() {
  const { i18n } = useTranslation();

  useEffect(() => {
    const language = i18n.resolvedLanguage?.slice(0, 2) ?? "en";
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" || language === "ur" ? "rtl" : "ltr";
  }, [i18n.resolvedLanguage]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
      <Route path="/admin/approvals" element={<RequireAdmin><AdminApprovalsPage /></RequireAdmin>} />
      <Route path="/farms" element={<RequireAuth><ContextPage kind="farms" /></RequireAuth>} />
      <Route path="/seasons" element={<RequireAuth><ContextPage kind="seasons" /></RequireAuth>} />
      {moduleRoutes.map(({ path, module }) => (
        <Route key={path} path={path} element={<RequireAuth><ModulePage module={module} /></RequireAuth>} />
      ))}
      <Route path="*" element={<RequireAuth><NotFoundPage /></RequireAuth>} />
    </Routes>
  );
}
