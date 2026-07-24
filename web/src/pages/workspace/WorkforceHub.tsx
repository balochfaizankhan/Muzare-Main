import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { ArrowLeft, CalendarCheck, ChevronRight, HandCoins, ReceiptText, WalletCards } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import { SubpageHeader } from "../../components/SubpageHeader";
import { useAppBack } from "../../hooks/useAppBack";
import { hasModulePermission } from "../../lib/permissions";

function workforceQuery(searchParams: URLSearchParams) {
  const labourId = searchParams.get("labourId");
  return labourId ? `?labourId=${encodeURIComponent(labourId)}` : "";
}

function WorkforceShell({
  title,
  description,
  subtitle,
  tabs,
  compactMobileHeader = false,
  children,
}: {
  title: string;
  description: string;
  subtitle?: string;
  tabs: Array<{ to: string; label: string }>;
  compactMobileHeader?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const backToWorkforce = useAppBack("/workspace/workforce/labour");
  const tabsRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const activeTab = tabsRef.current?.querySelector<HTMLElement>(".workforce-shell-tab.is-active");
    activeTab?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [location.pathname, location.search, title]);
  return (
    <div className="dashboard-page">
      {!compactMobileHeader ? <SubpageHeader title={title} /> : null}
      <main className={`subpage module-workspace workforce-shell-main${compactMobileHeader ? " workforce-shell-main--labour-payments" : ""}`}>
        {compactMobileHeader ? (
          <section className="labour-payments-mobile-header" aria-label={t("workforceHubPage.overviewAria", { title })}>
            <button className="labour-payments-mobile-header__back" type="button" aria-label={t("workforceHubPage.backToWorkforce")} onClick={backToWorkforce}>
              <ArrowLeft size={18} />
            </button>
            <div className="labour-payments-mobile-header__copy">
              <strong>{title}</strong>
              <p>{subtitle ?? description}</p>
            </div>
          </section>
        ) : (
          <section className="workspace-intro workforce-shell-intro">
            <div>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
          </section>
        )}
        <section className="record-panel workforce-shell-panel">
          <nav ref={tabsRef} className="workforce-shell-tabs" aria-label={t("workforceHubPage.navigationAria", { title })}>
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) => `workforce-shell-tab${isActive ? " is-active" : ""}`}
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
        </section>
        <div className="workforce-shell-content">
          {children}
        </div>
      </main>
    </div>
  );
}

export function WorkforceSectionLayout() {
  return <Outlet />;
}

export function LabourPaymentsSectionLayout() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const [searchParams] = useSearchParams();
  const query = workforceQuery(searchParams);
  const tabs = useMemo(() => {
    const allTabs = [
      { to: `/workspace/labour-payments/overview${query}`, label: t("workforceHubPage.paymentsDueTab"), module: "wages" as const },
      { to: `/workspace/labour-payments/direct-due${query}`, label: t("workforceHubPage.newLabourDueTab"), module: "wages" as const },
      { to: `/workspace/labour-payments/wage-rates${query}`, label: t("layout.wages"), module: "wages" as const },
      { to: `/workspace/labour-payments/vouchers${query}`, label: t("workforceHubPage.paymentVouchersTab"), module: "wages" as const },
      { to: `/workspace/labour-payments/advances${query}`, label: t("layout.advances"), module: "wages" as const },
    ];
    return allTabs.filter((tab) => !user || hasModulePermission(user, tab.module, "view", workspaceId));
  }, [query, user, workspaceId, t]);
  return (
    <WorkforceShell
      title={t("layout.labourPayments")}
      description={t("workforceHubPage.labourPaymentsDescription")}
      subtitle={t("workforceHubPage.labourPaymentsSubtitle")}
      tabs={tabs}
      compactMobileHeader
    >
      <Outlet />
    </WorkforceShell>
  );
}

function WorkforceReportLinks({
  title,
  description,
  links,
  compactRows = false,
  backTo,
}: {
  title: string;
  description: string;
  links: Array<{ to: string; title: string; detail: string; icon: typeof CalendarCheck }>;
  compactRows?: boolean;
  backTo?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const back = useAppBack(backTo ?? "/workspace/workforce/labour");
  return (
    <section className={`record-panel${compactRows ? " workforce-reports-panel" : ""}`}>
      <div className={compactRows ? "workforce-reports-header" : "advances-heading"}>
        {compactRows && backTo ? (
          <button type="button" className="workforce-reports-header__back" aria-label={t("workforceHubPage.backToWorkforce")} onClick={back}>
            <ArrowLeft size={18} />
          </button>
        ) : null}
        <div className={compactRows ? "workforce-reports-header__copy" : undefined}>
          <h2>{title}</h2>
          <span>{description}</span>
        </div>
      </div>
      <div className={compactRows ? "workforce-report-list" : "labour-payments-quick-grid"}>
        {links.map((link) => (
          <button key={link.to} type="button" className={compactRows ? "workforce-report-row" : "labour-payments-quick-card"} onClick={() => navigate(link.to)}>
            <div className={compactRows ? "workforce-report-row__icon" : undefined}><link.icon size={18} /></div>
            <div className={compactRows ? "workforce-report-row__copy" : undefined}>
              <strong>{link.title}</strong>
              <span>{link.detail}</span>
            </div>
            {compactRows ? <ChevronRight size={16} className="workforce-report-row__chevron" /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

export function WorkforceReportsHub() {
  const { t } = useTranslation();
  return (
    <WorkforceReportLinks
      title={t("workforceHubPage.workforceReportsTitle")}
      description={t("workforceHubPage.workforceReportsDescription")}
      compactRows
      backTo="/workspace/workforce/labour"
      links={[
        { to: "/workspace/reports?report=attendance", title: t("layout.attendance"), detail: t("workforceHubPage.attendanceReportDetail"), icon: CalendarCheck },
        { to: "/workspace/reports?report=advances", title: t("layout.advances"), detail: t("workforceHubPage.advancesReportDetail"), icon: HandCoins },
        { to: "/workspace/reports?report=wage-rates", title: t("layout.wages"), detail: t("workforceHubPage.wageRatesReportDetail"), icon: WalletCards },
      ]}
    />
  );
}

export function LabourPaymentsReportsHub() {
  const { t } = useTranslation();
  return (
    <WorkforceReportLinks
        title={t("workforceHubPage.labourPaymentsReportsTitle")}
        description={t("workforceHubPage.labourPaymentsReportsDescription")}
        links={[
          { to: "/workspace/reports?report=advances", title: t("workforcePage.advanceReport"), detail: t("workforceHubPage.advanceReportDetail"), icon: HandCoins },
          { to: "/workspace/reports?report=wage-rates", title: t("wageRatesPage.reportTitle"), detail: t("workforceHubPage.wageRateReportDetail"), icon: WalletCards },
          { to: "/workspace/labour-payments/overview", title: t("workforceHubPage.paymentsDueTab"), detail: t("workforceHubPage.paymentsDueReportDetail"), icon: ReceiptText },
        ]}
      />
    );
}
