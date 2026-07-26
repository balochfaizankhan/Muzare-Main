import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, KeyRound, ShieldCheck, UserX, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import { config } from "../../config";
import { fetchAdminUser, fetchAdminUsers, repairInvitedDefaultWorkspaces, updateAdminUserStatus } from "../../lib/api";
import { formatDate, formatNumber } from "../../lib/format";
import { translateStatus } from "../../lib/statusLabels";
import { translateRole } from "../../lib/systemTranslations";

type PasswordResetTarget = {
  id: string;
  email: string;
  displayName: string | null;
};

const passwordResetCopy = {
  en: {
    action: "Reset password",
    title: "Reset user password",
    description: "Set a new password for this user. Their existing sessions will be signed out, and an active user can immediately sign in with the new password.",
    statusNote: "The user's account status and workspace access will not change.",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    passwordPlaceholder: "Enter at least 8 characters",
    confirmPlaceholder: "Enter the password again",
    showPassword: "Show password",
    hidePassword: "Hide password",
    cancel: "Cancel",
    submit: "Reset password",
    resetting: "Resetting...",
    lengthError: "The new password must be between 8 and 128 characters.",
    mismatchError: "The two passwords do not match.",
    failed: "Unable to reset this user's password.",
    success: "Password reset for {{email}}. The user can now sign in with the new password.",
  },
  ar: {
    action: "إعادة تعيين كلمة المرور",
    title: "إعادة تعيين كلمة مرور المستخدم",
    description: "عيّن كلمة مرور جديدة لهذا المستخدم. سيتم تسجيل خروجه من جميع الجلسات الحالية، ويمكن للمستخدم النشط تسجيل الدخول فورًا بكلمة المرور الجديدة.",
    statusNote: "لن تتغير حالة حساب المستخدم أو صلاحيات مساحة العمل.",
    newPassword: "كلمة المرور الجديدة",
    confirmPassword: "تأكيد كلمة المرور الجديدة",
    passwordPlaceholder: "أدخل 8 أحرف على الأقل",
    confirmPlaceholder: "أدخل كلمة المرور مرة أخرى",
    showPassword: "إظهار كلمة المرور",
    hidePassword: "إخفاء كلمة المرور",
    cancel: "إلغاء",
    submit: "إعادة تعيين كلمة المرور",
    resetting: "جارٍ إعادة التعيين...",
    lengthError: "يجب أن تتكون كلمة المرور الجديدة من 8 إلى 128 حرفًا.",
    mismatchError: "كلمتا المرور غير متطابقتين.",
    failed: "تعذر إعادة تعيين كلمة مرور هذا المستخدم.",
    success: "تمت إعادة تعيين كلمة مرور {{email}}. يمكن للمستخدم الآن تسجيل الدخول بكلمة المرور الجديدة.",
  },
  ur: {
    action: "پاس ورڈ ری سیٹ کریں",
    title: "صارف کا پاس ورڈ ری سیٹ کریں",
    description: "اس صارف کے لیے نیا پاس ورڈ مقرر کریں۔ اس کے تمام موجودہ سیشن ختم ہو جائیں گے، اور فعال صارف نئے پاس ورڈ سے فوراً لاگ اِن کر سکے گا۔",
    statusNote: "صارف کے اکاؤنٹ کی حیثیت اور ورک اسپیس رسائی تبدیل نہیں ہوگی۔",
    newPassword: "نیا پاس ورڈ",
    confirmPassword: "نئے پاس ورڈ کی تصدیق",
    passwordPlaceholder: "کم از کم 8 حروف درج کریں",
    confirmPlaceholder: "پاس ورڈ دوبارہ درج کریں",
    showPassword: "پاس ورڈ دکھائیں",
    hidePassword: "پاس ورڈ چھپائیں",
    cancel: "منسوخ کریں",
    submit: "پاس ورڈ ری سیٹ کریں",
    resetting: "ری سیٹ ہو رہا ہے...",
    lengthError: "نیا پاس ورڈ 8 سے 128 حروف کے درمیان ہونا چاہیے۔",
    mismatchError: "دونوں پاس ورڈ ایک جیسے نہیں ہیں۔",
    failed: "اس صارف کا پاس ورڈ ری سیٹ نہیں ہو سکا۔",
    success: "{{email}} کا پاس ورڈ ری سیٹ ہو گیا۔ صارف اب نئے پاس ورڈ سے لاگ اِن کر سکتا ہے۔",
  },
} as const;

export function Users() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage?.slice(0, 2) as keyof typeof passwordResetCopy | undefined;
  const resetCopy = language ? passwordResetCopy[language] ?? passwordResetCopy.en : passwordResetCopy.en;
  // Platform-level roles ("platform_admin") live outside the workspace role dictionary, so try
  // the adminRoles bundle first and fall back to the shared workspace-role translator.
  const platformRoleLabel = (role: string) => t(`adminRoles.${role}`, { defaultValue: translateRole(role) });
  const { user, token } = useAuth();
  const canManage = user?.platformRole === "platform_admin";
  const client = useQueryClient();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [passwordResetTarget, setPasswordResetTarget] = useState<PasswordResetTarget | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordValidationError, setPasswordValidationError] = useState<string | null>(null);
  const [passwordResetNotice, setPasswordResetNotice] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => fetchAdminUsers(token!),
    enabled: Boolean(token),
  });
  const detail = useQuery({
    queryKey: ["admin-user", selectedUserId],
    queryFn: () => fetchAdminUser(token!, selectedUserId!),
    enabled: Boolean(token && selectedUserId),
  });
  const changeStatus = useMutation({
    mutationFn: ({ userId, active }: { userId: string; active: boolean }) => updateAdminUserStatus(token!, userId, { active }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin-users"] }),
        client.invalidateQueries({ queryKey: ["admin-user", selectedUserId] }),
        client.invalidateQueries({ queryKey: ["admin-overview"] }),
      ]);
    },
  });
  const repairInvitedDefaults = useMutation({
    mutationFn: () => repairInvitedDefaultWorkspaces(token!),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin-users"] }),
        client.invalidateQueries({ queryKey: ["admin-user", selectedUserId] }),
        client.invalidateQueries({ queryKey: ["admin-overview"] }),
      ]);
    },
  });
  const resetPassword = useMutation({
    mutationFn: async ({ userId, password }: { userId: string; password: string; email: string }) => {
      const response = await fetch(`${config.apiUrl.replace(/\/+$/, "")}/v1/admin/users/${encodeURIComponent(userId)}/reset-password`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(payload?.message ?? resetCopy.failed);
      }
    },
    onSuccess: (_data, variables) => {
      setPasswordResetNotice(resetCopy.success.replace("{{email}}", variables.email));
      setPasswordResetTarget(null);
      setNewPassword("");
      setConfirmPassword("");
      setPasswordValidationError(null);
    },
  });

  const openPasswordReset = (target: PasswordResetTarget) => {
    resetPassword.reset();
    setPasswordResetNotice(null);
    setPasswordValidationError(null);
    setNewPassword("");
    setConfirmPassword("");
    setShowNewPassword(false);
    setShowConfirmPassword(false);
    setPasswordResetTarget(target);
  };

  const closePasswordReset = () => {
    if (resetPassword.isPending) return;
    setPasswordResetTarget(null);
    setNewPassword("");
    setConfirmPassword("");
    setPasswordValidationError(null);
    resetPassword.reset();
  };

  const submitPasswordReset = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!passwordResetTarget) return;
    if (newPassword.length < 8 || newPassword.length > 128) {
      setPasswordValidationError(resetCopy.lengthError);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordValidationError(resetCopy.mismatchError);
      return;
    }
    setPasswordValidationError(null);
    resetPassword.mutate({ userId: passwordResetTarget.id, password: newPassword, email: passwordResetTarget.email });
  };

  const users = query.data?.users ?? [];
  const activeUsers = users.filter((item) => item.active).length;

  return <main className="shell-page">
    <section className="shell-page__intro">
      <span className="eyebrow">{t("layout.platformAdministrationEyebrow")}</span>
      <h1>{t("adminUsers.title")}</h1>
      <p>{t("adminUsers.description")}</p>
    </section>

    <section className="admin-metric-grid">
      <article><ShieldCheck size={19} /><span>{t("adminUsers.metrics.totalUsers")}</span><strong>{formatNumber(users.length)}</strong></article>
      <article><ShieldCheck size={19} /><span>{t("adminUsers.metrics.activeUsers")}</span><strong>{formatNumber(activeUsers)}</strong></article>
      <article><UserX size={19} /><span>{t("adminUsers.metrics.inactiveUsers")}</span><strong>{formatNumber(users.length - activeUsers)}</strong></article>
    </section>

    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{t("adminUsers.platformUsers")}</h2>
          <p>{t("adminUsers.platformUsersDescription")}</p>
        </div>
        {canManage && (
          <button type="button" className="secondary-button" onClick={() => repairInvitedDefaults.mutate()} disabled={repairInvitedDefaults.isPending}>
            {repairInvitedDefaults.isPending ? t("adminUsers.repairingInvitedDefaults") : t("adminUsers.repairInvitedDefaults")}
          </button>
        )}
      </div>
      {passwordResetNotice && <p className="success">{passwordResetNotice}</p>}
      {repairInvitedDefaults.isSuccess && <p className="success">{t("adminUsers.repairedInvitedDefaults", { count: repairInvitedDefaults.data.repairedCount })}</p>}
      {repairInvitedDefaults.isError && <p className="error">{repairInvitedDefaults.error.message}</p>}

      {query.isError && <p className="error">{query.error.message}</p>}
      {!users.length ? <div className="admin-empty-panel"><h2>{t("adminUsers.emptyTitle")}</h2><p>{t("adminUsers.emptyDescription")}</p></div> : <div className="admin-table-card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("adminUsers.columns.user")}</th>
              <th>{t("adminUsers.columns.role")}</th>
              <th>{t("adminUsers.columns.workspaces")}</th>
              <th>{t("common.status")}</th>
              <th>{t("adminUsers.columns.created")}</th>
              <th>{t("adminUsers.columns.lastLogin")}</th>
              <th>{t("reportsPage.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((item) => <tr key={item.id}>
              <td>
                <strong>{item.displayName ?? item.email}</strong>
                <span>{item.email}</span>
              </td>
              <td>{item.platformRole ? platformRoleLabel(item.platformRole) : t("adminUsers.workspaceUser")}</td>
              <td>{formatNumber(item.workspaceCount)}</td>
              <td><span className={`status-badge status-badge--${item.active ? "approved" : "suspended"}`}>{item.active ? t("common.active") : translateStatus(t, item.status)}</span></td>
              <td>{formatDate(item.createdAt, { dateStyle: "medium" })}</td>
              <td>{item.lastLoginAt ? formatDate(item.lastLoginAt, { dateStyle: "medium", timeStyle: "short" }) : t("adminUsers.never")}</td>
              <td>
                <div className="record-list__actions admin-row-actions">
                  <button type="button" onClick={() => setSelectedUserId(item.id)}><Eye size={15} />{t("common.view")}</button>
                  {canManage && <button type="button" onClick={() => openPasswordReset(item)}><KeyRound size={15} />{resetCopy.action}</button>}
                  {canManage && item.active && <button type="button" className="danger-button" onClick={() => changeStatus.mutate({ userId: item.id, active: false })}>{t("adminUsers.deactivate")}</button>}
                  {canManage && !item.active && <button type="button" onClick={() => changeStatus.mutate({ userId: item.id, active: true })}>{t("adminUsers.activate")}</button>}
                </div>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </section>

    {selectedUserId && <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => setSelectedUserId(null)}>
      <section className="worker-action-dialog admin-detail-dialog" role="dialog" aria-modal="true" aria-label={t("adminUsers.userDetails")} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>{detail.data?.user?.displayName ?? detail.data?.user?.email ?? t("adminUsers.userDetails")}</h2>
            <p>{detail.data?.user?.email ?? t("adminUsers.loadingUserProfile")}</p>
          </div>
          <button type="button" onClick={() => setSelectedUserId(null)}><X size={18} /></button>
        </header>
        <div className="worker-action-form admin-detail-body">
          {detail.isError && <p className="error">{detail.error.message}</p>}
          {detail.data?.user && <>
            <section className="admin-detail-section">
              <dl className="worker-stats admin-detail-stats">
                <div><dt>{t("common.status")}</dt><dd><span className={`status-badge status-badge--${detail.data.user.active ? "approved" : "suspended"}`}>{detail.data.user.active ? t("common.active") : translateStatus(t, detail.data.user.status)}</span></dd></div>
                <div><dt>{t("adminUsers.columns.role")}</dt><dd>{detail.data.user.platformRole ? platformRoleLabel(detail.data.user.platformRole) : "-"}</dd></div>
                <div><dt>{t("workspaceTeam.phone")}</dt><dd>{detail.data.user.phone ?? "-"}</dd></div>
                <div><dt>{t("adminUsers.columns.created")}</dt><dd>{formatDate(detail.data.user.createdAt, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
                <div><dt>{t("adminUsers.columns.lastLogin")}</dt><dd>{detail.data.user.lastLoginAt ? formatDate(detail.data.user.lastLoginAt, { dateStyle: "medium", timeStyle: "short" }) : t("adminUsers.never")}</dd></div>
              </dl>
            </section>

            <section className="admin-detail-section">
              <h3>{t("adminUsers.workspaceMemberships")}</h3>
              {!detail.data.user.workspaces.length ? <p className="activity-empty">{t("adminUsers.noWorkspaceMemberships")}</p> : <div className="admin-activity-list">
                {detail.data.user.workspaces.map((workspace) => <article key={workspace.id}>
                  <div>
                    <strong>{workspace.workspaceName}</strong>
                    <span>{translateRole(workspace.role)}</span>
                  </div>
                  <small>{workspace.active ? t("adminUsers.activeMembership") : t("adminUsers.inactiveMembership")}</small>
                </article>)}
              </div>}
            </section>
          </>}
        </div>
      </section>
    </div>}

    {passwordResetTarget && <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={closePasswordReset}>
      <section className="worker-action-dialog admin-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-password-reset-title" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="admin-password-reset-title">{resetCopy.title}</h2>
            <p>{passwordResetTarget.displayName ?? passwordResetTarget.email}</p>
          </div>
          <button type="button" onClick={closePasswordReset} disabled={resetPassword.isPending} aria-label={t("common.close")}><X size={18} /></button>
        </header>
        <form className="worker-action-form admin-detail-body" onSubmit={submitPasswordReset}>
          <p>{resetCopy.description}</p>
          <p className="auth-note"><ShieldCheck size={16} /><span>{resetCopy.statusNote}</span></p>

          <label className="login-field">
            <span>{resetCopy.newPassword}</span>
            <div className="login-input-wrap">
              <KeyRound size={18} />
              <input
                type={showNewPassword ? "text" : "password"}
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder={resetCopy.passwordPlaceholder}
                minLength={8}
                maxLength={128}
                required
                autoFocus
              />
              <button type="button" className="password-toggle" aria-label={showNewPassword ? resetCopy.hidePassword : resetCopy.showPassword} onClick={() => setShowNewPassword((value) => !value)}>
                {showNewPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>

          <label className="login-field">
            <span>{resetCopy.confirmPassword}</span>
            <div className="login-input-wrap">
              <KeyRound size={18} />
              <input
                type={showConfirmPassword ? "text" : "password"}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder={resetCopy.confirmPlaceholder}
                minLength={8}
                maxLength={128}
                required
              />
              <button type="button" className="password-toggle" aria-label={showConfirmPassword ? resetCopy.hidePassword : resetCopy.showPassword} onClick={() => setShowConfirmPassword((value) => !value)}>
                {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>

          {passwordValidationError && <p className="error">{passwordValidationError}</p>}
          {resetPassword.isError && <p className="error">{resetPassword.error.message}</p>}

          <div className="record-list__actions admin-row-actions">
            <button type="button" className="secondary-button" onClick={closePasswordReset} disabled={resetPassword.isPending}>{resetCopy.cancel}</button>
            <button type="submit" disabled={resetPassword.isPending || !newPassword || !confirmPassword}>
              <KeyRound size={16} />
              {resetPassword.isPending ? resetCopy.resetting : resetCopy.submit}
            </button>
          </div>
        </form>
      </section>
    </div>}
  </main>;
}
