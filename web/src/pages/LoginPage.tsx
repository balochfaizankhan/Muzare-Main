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
      setAuthError(error instanceof Error ? error.message : "Authentication failed.");
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
            <span className="auth-kicker">Approved workspace access</span>
            <h1>Welcome back</h1>
            <p>{t("signIn")}</p>
          </div>
        </div>
        <div className="auth-note">
          <ShieldCheck size={16} />
          <span>Only administrator-approved accounts can enter a workspace.</span>
        </div>
        <form className="login-form" onSubmit={handleSubmit(login)}>
          <label>
            <span>{t("email")}</span>
            <input type="email" autoComplete="email" placeholder="you@farm.com" {...register("email")} />
            {errors.email && <small>Please provide a valid email.</small>}
          </label>
          <label>
            <span>{t("password")}</span>
            <input type="password" autoComplete="current-password" placeholder="Enter your password" {...register("password")} />
          </label>
          {authError && <p className="error">{authError}</p>}
          <button type="submit" disabled={isSubmitting}>
            <LockKeyhole size={17} />
            <span>{isSubmitting ? "Signing in..." : t("login")}</span>
          </button>
        </form>
        <p className="auth-switch">Need a workspace? <Link to="/signup">Request access</Link></p>
      </section>
    </main>
  );
}
