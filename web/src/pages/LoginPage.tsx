import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";
import { z } from "zod";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { useAuth } from "../auth/AuthProvider";

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

  if (user) return <Navigate to="/" replace />;

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
        <Brand />
        <p className="login-subtitle">{t("signIn")}</p>
        <form className="login-form" onSubmit={handleSubmit(login)}>
          <label>
            <span>{t("email")}</span>
            <input type="email" autoComplete="email" {...register("email")} />
            {errors.email && <small>Please provide a valid email.</small>}
          </label>
          <label>
            <span>{t("password")}</span>
            <input type="password" autoComplete="current-password" {...register("password")} />
          </label>
          {authError && <p className="error">{authError}</p>}
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "..." : t("login")}
          </button>
        </form>
      </section>
    </main>
  );
}
