import { zodResolver } from "@hookform/resolvers/zod";
import { LockKeyhole, ShieldCheck } from "lucide-react";
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
      <section className="login-card">
        <div className="login-card__header">
          <span className="auth-logo" role="img" aria-label="Muzare" />
          <div>
            <span className="auth-kicker">{t("auth.approvedAccess")}</span>
            <h1>{t("auth.welcomeBack")}</h1>
            <p>{t("signIn")}</p>
          </div>
        </div>
        <div className="auth-note">
          <ShieldCheck size={16} />
          <span>{t("auth.approvedAccountsOnly")}</span>
        </div>
        <form className="login-form" onSubmit={handleSubmit(login)}>
          <label>
            <span>{t("email")}</span>
            <input type="email" autoComplete="email" placeholder={t("auth.emailPlaceholder")} {...register("email")} />
            {errors.email && <small>{t("validation.validEmail")}</small>}
          </label>
          <label>
            <span>{t("password")}</span>
            <input type="password" autoComplete="current-password" placeholder={t("auth.passwordPlaceholder")} {...register("password")} />
          </label>
          {authError && <p className="error">{authError}</p>}
          <button type="submit" disabled={isSubmitting}>
            <LockKeyhole size={17} />
            <span>{isSubmitting ? t("auth.signingIn") : t("login")}</span>
          </button>
        </form>
        <p className="auth-switch">{t("auth.needWorkspace")} <Link to="/signup">{t("auth.requestAccess")}</Link></p>
      </section>
    </main>
  );
}
