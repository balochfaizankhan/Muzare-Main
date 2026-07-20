import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { ArrowLeft, CalendarCheck, ChevronRight, HandCoins, ReceiptText, WalletCards } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
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
          <section className="labour-payments-mobile-header" aria-label={`${title} overview`}>
            <button className="labour-payments-mobile-header__back" type="button" aria-label="Back to workforce" onClick={backToWorkforce}>
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
          <nav ref={tabsRef} className="workforce-shell-tabs" aria-label={`${title} navigation`}>
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
  const { user } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const [searchParams] = useSearchParams();
  const query = workforceQuery(searchParams);
  const tabs = useMemo(() => {
    const allTabs = [
      { to: `/workspace/labour-payments/overview${query}`, label: "Payments Due", module: "wages" as const },
      { to: `/workspace/labour-payments/direct-due${query}`, label: "New Labour Due", module: "wages" as const },
      { to: `/workspace/labour-payments/wage-rates${query}`, label: "Wage Rates", module: "wages" as const },
      { to: `/workspace/labour-payments/vouchers${query}`, label: "Payment Vouchers", module: "wages" as const },
      { to: `/workspace/labour-payments/advances${query}`, label: "Outstanding Advances", module: "wages" as const },
    ];
    return allTabs.filter((tab) => !user || hasModulePermission(user, tab.module, "view", workspaceId));
  }, [query, user, workspaceId]);
  return (
    <WorkforceShell
      title="Labour Payments"
      description="Review labour dues, apply advances, and post every cash movement through one Labour Payment Voucher register."
      subtitle="Due → Review → Apply advance or pay → Post"
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
  const navigate = useNavigate();
  const back = useAppBack(backTo ?? "/workspace/workforce/labour");
  return (
    <section className={`record-panel${compactRows ? " workforce-reports-panel" : ""}`}>
      <div className={compactRows ? "workforce-reports-header" : "advances-heading"}>
        {compactRows && backTo ? (
          <button type="button" className="workforce-reports-header__back" aria-label="Back to workforce" onClick={back}>
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
  return (
    <WorkforceReportLinks
      title="Workforce Reports"
      description="Choose a workforce report to review"
      compactRows
      backTo="/workspace/workforce/labour"
      links={[
        { to: "/workspace/reports?report=attendance", title: "Attendance", detail: "Register, payable days, and totals", icon: CalendarCheck },
        { to: "/workspace/reports?report=advances", title: "Advances", detail: "Summary and log by labour", icon: HandCoins },
        { to: "/workspace/reports?report=wage-rates", title: "Wage Rates", detail: "Current, expired, and upcoming rates", icon: WalletCards },
      ]}
    />
  );
}

export function LabourPaymentsReportsHub() {
  return (
    <WorkforceReportLinks
        title="Labour Payments Reports"
        description="Keep labour-payment reporting grouped with advances, wage rates, Labour Dues, and payment vouchers."
        links={[
          { to: "/workspace/reports?report=advances", title: "Advance Report", detail: "Track advances, outstanding balances, and recent transactions.", icon: HandCoins },
          { to: "/workspace/reports?report=wage-rates", title: "Wage Rate Report", detail: "Audit active and historical wage-rate assignments.", icon: WalletCards },
          { to: "/workspace/labour-payments/overview", title: "Payments Due", detail: "Review Labour Dues and settlement progress.", icon: ReceiptText },
        ]}
      />
    );
}
