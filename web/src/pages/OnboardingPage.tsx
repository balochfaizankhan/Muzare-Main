import { zodResolver } from "@hookform/resolvers/zod";
import { Building2, Sprout } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";
import { z } from "zod";
import { useAuth } from "../auth/AuthProvider";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { submitOnboardingWorkspace } from "../lib/api";
import { isPlatformUser } from "../lib/permissions";

const schema = z.object({
  name: z.string().min(2, "A workspace name is required."),
  contactPhone: z.string().optional(),
});

type OnboardingFields = z.infer<typeof schema>;

export function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, token, updateUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<OnboardingFields>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", contactPhone: "" },
  });

  if (!user) return <Navigate to="/login" replace />;
  if (isPlatformUser(user)) return <Navigate to="/admin/dashboard" replace />;
  if (user.workspaceId) return <Navigate to="/workspace/dashboard" replace />;

  const submit = async (fields: OnboardingFields) => {
    setError(null);
    const result = await submitOnboardingWorkspace(token!, fields).catch((caught) => {
      setError(caught instanceof Error ? caught.message : t("onboardingPage.submitFailed"));
      return null;
    });
    if (!result) return;
    updateUser(result.user);
    navigate("/workspace/dashboard", { replace: true });
  };

  return (
    <main className="onboarding-page">
      <div className="login-language">
        <LanguageSwitch />
      </div>
      <section className="onboarding-shell onboarding-shell--single">
        <section className="onboarding-panel">
          <div className="onboarding-heading">
            <Sprout size={22} />
            <div>
              <h1>{t("onboardingPage.welcomeTitle")}</h1>
              <p>{t("onboardingPage.welcomeDescription")}</p>
            </div>
          </div>
          <form className="module-form onboarding-form" onSubmit={handleSubmit(submit)}>
            <label>
              <span>{t("onboardingPage.workspaceName")}</span>
              <input placeholder={t("onboardingPage.workspaceNamePlaceholder")} {...register("name")} />
              {errors.name && <small>{t("onboardingPage.validation.nameRequired")}</small>}
            </label>
            <label>
              <span>{t("workspaceTeam.phone")}</span>
              <input placeholder={t("authSignup.phonePlaceholder")} {...register("contactPhone")} />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={isSubmitting}>
              <Building2 size={16} />
              {isSubmitting ? t("onboardingPage.submitting") : t("onboardingPage.createWorkspace")}
            </button>
          </form>
        </section>
      </section>
    </main>
  );
}
