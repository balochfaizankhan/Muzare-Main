import { zodResolver } from "@hookform/resolvers/zod";
import { Building2, ClipboardCheck, LockKeyhole, MailCheck, ShieldCheck, Sprout } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";
import { useAuth } from "../auth/AuthProvider";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { getHomePath } from "../lib/permissions";
import { signup } from "../lib/api";

const schema = z.object({
  ownerName: z.string().min(2, "Your name is required."),
  email: z.email("Use a valid email."),
  phone: z.string().optional(),
  password: z.string().min(8, "Use at least 8 characters."),
});

type SignupFields = z.infer<typeof schema>;

export function SignupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { completeSession } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupFields>({
    resolver: zodResolver(schema),
    defaultValues: { ownerName: "", email: "", phone: "", password: "" },
  });

  const submit = async (fields: SignupFields) => {
    setError(null);
    const result = await signup(fields).catch((caught) => {
      setError(caught instanceof Error ? caught.message : t("authSignup.submitFailed"));
      return null;
    });
    if (!result) return;
    await completeSession(result.token, result.user);
    navigate(getHomePath(result.user), { replace: true });
  };

  return (
    <main className="onboarding-page">
      <div className="login-language">
        <LanguageSwitch />
      </div>
      <section className="onboarding-shell">
        <div className="onboarding-story">
          <div className="onboarding-story__copy">
            <span className="auth-kicker">{t("authSignup.kicker")}</span>
            <h1>{t("authSignup.title")}</h1>
            <p>{t("authSignup.description")}</p>
          </div>
          <div className="journey-steps" aria-label={t("authSignup.journeyLabel")}>
            <article>
              <Building2 size={18} />
              <div>
                <strong>{t("authSignup.steps.createWorkspace.title")}</strong>
                <span>{t("authSignup.steps.createWorkspace.description")}</span>
              </div>
            </article>
            <article>
              <ShieldCheck size={18} />
              <div>
                <strong>{t("authSignup.steps.adminApproval.title")}</strong>
                <span>{t("authSignup.steps.adminApproval.description")}</span>
              </div>
            </article>
            <article>
              <Sprout size={18} />
              <div>
                <strong>{t("authSignup.steps.startClean.title")}</strong>
                <span>{t("authSignup.steps.startClean.description")}</span>
              </div>
            </article>
          </div>
        </div>

        <section className="onboarding-panel">
          <>
            <div className="onboarding-heading">
              <ClipboardCheck size={22} />
              <div>
                <h1>{t("authSignup.requestWorkspace")}</h1>
                <p>{t("authSignup.requestWorkspaceDescription")}</p>
              </div>
            </div>
            <div className="auth-note auth-note--signup">
              <MailCheck size={16} />
              <span>{t("authSignup.emailHint")}</span>
            </div>
            <form className="module-form onboarding-form" onSubmit={handleSubmit(submit)}>
              <label>
                <span>{t("authSignup.ownerName")}</span>
                <input placeholder={t("authSignup.ownerNamePlaceholder")} {...register("ownerName")} />
                {errors.ownerName && <small>{t("authSignup.validation.ownerNameRequired")}</small>}
              </label>
              <label>
                <span>{t("email")}</span>
                <input type="email" autoComplete="email" placeholder={t("auth.emailPlaceholder")} {...register("email")} />
                {errors.email && <small>{t("validation.validEmail")}</small>}
              </label>
              <label>
                <span>{t("workspaceTeam.phone")}</span>
                <input placeholder={t("authSignup.phonePlaceholder")} {...register("phone")} />
              </label>
              <label>
                <span>{t("password")}</span>
                <input type="password" autoComplete="new-password" {...register("password")} />
                {errors.password && <small>{t("authSignup.validation.passwordMin")}</small>}
              </label>
              <div className="password-hint">
                <LockKeyhole size={15} />
                <span>{t("authSignup.passwordHint")}</span>
              </div>
              {error && <p className="error">{error}</p>}
              <button type="submit" disabled={isSubmitting}>{isSubmitting ? t("authSignup.submitting") : t("authSignup.submitForApproval")}</button>
            </form>
            <p className="auth-switch">{t("authSignup.alreadyApproved")} <Link to="/login">{t("signIn")}</Link></p>
          </>
        </section>
      </section>
    </main>
  );
}
