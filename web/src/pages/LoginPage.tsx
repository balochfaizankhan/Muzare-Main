import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Building2, Eye, EyeOff, Layers3, LockKeyhole, Mail, ShieldCheck, Sprout, TrendingUp } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router-dom";
import { z } from "zod";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { useAuth } from "../auth/AuthProvider";
import { getHomePath } from "../lib/permissions";

const schema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

type LoginFields = z.infer<typeof schema>;

export function LoginPage() {
  const { t } = useTranslation();
  const { user, login: signIn } = useAuth();
  const [authError, setAuthError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { isSubmitting, errors },
  } = useForm<LoginFields>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  if (user) return <Navigate to={getHomePath(user)} replace />;

  const login = async (fields: LoginFields) => {
    setAuthError(null);
    try {
      await signIn(fields.email, fields.password);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : t("errors.authFailed"));
    }
  };

  return (
    <main className="login-page">
      <div className="login-language">
        <LanguageSwitch />
      </div>

      <section className="login-hero" aria-label={t("auth.heroLabel")}>
        <div className="login-brand-lockup">
          <span className="auth-logo" role="img" aria-label="Muzare" />
          <div>
            <strong>Muzare</strong>
            <span>مزارع</span>
          </div>
        </div>

        <div className="login-hero__copy">
          <span className="auth-kicker">{t("auth.approvedAccess")}</span>
          <h1>{t("auth.heroTitle")}</h1>
          <p>{t("auth.heroDescription")}</p>
        </div>

        <div className="login-features">
          <article>
            <span><Layers3 size={18} /></span>
            <div><strong>{t("auth.centralizedOperations")}</strong><p>{t("auth.centralizedOperationsText")}</p></div>
          </article>
          <article>
            <span><ShieldCheck size={18} /></span>
            <div><strong>{t("auth.secureAccess")}</strong><p>{t("auth.secureAccessText")}</p></div>
          </article>
          <article>
            <span><TrendingUp size={18} /></span>
            <div><strong>{t("auth.realTimeVisibility")}</strong><p>{t("auth.realTimeVisibilityText")}</p></div>
          </article>
        </div>

        <div className="login-landscape" aria-hidden="true">
          <div className="login-sun" />
          <div className="login-hills login-hills--far" />
          <div className="login-hills login-hills--near" />
          <div className="login-palms">
            <span /><span /><span />
          </div>
          <div className="login-field-rows" />
        </div>
      </section>

      <section className="login-panel" aria-label={t("auth.loginPanel")}>
        <section className="login-card">
          <div className="login-card__header">
            <span className="auth-logo" role="img" aria-label="Muzare" />
            <div>
              <h2>{t("auth.welcomeBack")}</h2>
              <p>{t("auth.signInToWorkspace")}</p>
            </div>
          </div>
          <div className="auth-note">
          <ShieldCheck size={16} />
          <span>{t("auth.approvedAccountsOnly")}</span>
          </div>
          <form className="login-form" onSubmit={handleSubmit(login)}>
            <label className="login-field">
              <span>{t("email")}</span>
              <div className="login-input-wrap">
                <Mail size={18} />
                <input type="email" autoComplete="email" placeholder={t("auth.emailPlaceholder")} {...register("email")} />
              </div>
              {errors.email && <small>{t("validation.validEmail")}</small>}
            </label>
            <label className="login-field">
              <span>{t("password")}</span>
              <div className="login-input-wrap">
                <LockKeyhole size={18} />
                <input type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder={t("auth.passwordPlaceholder")} {...register("password")} />
                <button type="button" className="password-toggle" aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")} onClick={() => setShowPassword((value) => !value)}>
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
            <div className="login-form__links"><a href="mailto:support@muzare.com?subject=Muzare password support">{t("auth.forgotPassword")}</a></div>
            {authError && <p className="error">{authError}</p>}
            <button type="submit" disabled={isSubmitting}>
              <LockKeyhole size={17} />
              <span>{isSubmitting ? t("auth.signingIn") : t("login")}</span>
              <ArrowRight size={17} />
            </button>
          </form>
          <div className="auth-divider"><span>{t("auth.or")}</span></div>
          <Link className="login-secondary" to="/signup"><ShieldCheck size={17} />{t("auth.requestWorkspaceAccess")}</Link>
          <p className="auth-switch">{t("auth.needHelp")} <a href="mailto:support@muzare.com">{t("auth.contactSupport")}</a></p>
        </section>
        <div className="login-trust-strip">
          <span><Sprout size={15} />{t("auth.agricultureReady")}</span>
          <span><Building2 size={15} />{t("auth.enterpriseControl")}</span>
        </div>
      </section>
    </main>
  );
}
