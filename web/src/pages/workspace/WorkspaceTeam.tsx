import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Copy, RotateCcw, Trash2, UserPlus } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import { SubpageHeader } from "../../components/SubpageHeader";
import { config } from "../../config";
import {
  cancelWorkspaceInvitation,
  fetchWorkspaceMemberActivity,
  fetchWorkspaceTeam,
  type FarmAccessMode,
  inviteWorkspaceMember,
  removeWorkspaceMember,
  updateWorkspaceMember,
  type WorkspaceModule,
  type WorkspaceModuleAction,
  type WorkspaceModulePermissions,
  type WorkspaceRole,
  type WorkspaceTeamMember,
} from "../../lib/api";
import { roleModulePermissions } from "../../lib/permissions";

const modules: WorkspaceModule[] = ["dashboard", "workforce", "attendance", "advances", "expenses", "sales", "dispatch", "inventory", "accounts", "reports", "settings", "team"];
const actions: WorkspaceModuleAction[] = ["view", "create", "edit", "delete", "approve", "export"];
const roles: WorkspaceRole[] = ["workspace_owner", "workspace_manager", "supervisor", "accountant", "operator", "viewer"];
const blankInvite = { email: "", phone: "", role: "viewer" as WorkspaceRole, farmAccessMode: "all" as FarmAccessMode, farmIds: [] as string[] };

function cloneDefaults(role: WorkspaceRole): WorkspaceModulePermissions {
  return Object.fromEntries(modules.map((module) => [module, { ...roleModulePermissions[role][module] }]));
}

export function WorkspaceTeam() {
  const { t } = useTranslation();
  const { token, user } = useAuth();
  const client = useQueryClient();
  const workspaceId = user?.workspaceId ?? "";
  const isOwner = user?.memberships.some((membership) => membership.workspaceId === workspaceId && membership.active && membership.role === "workspace_owner") ?? false;
  const [invite, setInvite] = useState(blankInvite);
  const [shareToken, setShareToken] = useState("");
  const [inviteMessage, setInviteMessage] = useState("");
  const [editing, setEditing] = useState<WorkspaceTeamMember | null>(null);
  const [activityMember, setActivityMember] = useState<WorkspaceTeamMember | null>(null);
  const [permissions, setPermissions] = useState<WorkspaceModulePermissions>({});
  const team = useQuery({ queryKey: ["workspace-team", workspaceId], queryFn: () => fetchWorkspaceTeam(token!, workspaceId), enabled: Boolean(token && workspaceId) });
  const activity = useQuery({ queryKey: ["workspace-team-activity", workspaceId, activityMember?.id], queryFn: () => fetchWorkspaceMemberActivity(token!, workspaceId, activityMember!.id), enabled: Boolean(token && workspaceId && activityMember) });
  const refresh = () => client.invalidateQueries({ queryKey: ["workspace-team", workspaceId] });
  const inviteMember = useMutation({
    mutationFn: () => inviteWorkspaceMember(token!, workspaceId, invite),
    onSuccess: async (result) => {
      setShareToken(result.invitationUrl ?? result.invitationToken ?? "");
      setInviteMessage(result.membershipUpdated
        ? t("workspaceTeam.memberUpdated")
        : result.alreadyHasAccess
          ? t("workspaceTeam.alreadyHasAccess")
          : result.emailSent
          ? t("workspaceTeam.emailSent")
          : (result.warning ?? ""));
      setInvite(blankInvite);
      await refresh();
    },
  });
  const saveMember = useMutation({
    mutationFn: () => updateWorkspaceMember(token!, workspaceId, editing!.id, {
      role: editing!.role,
      active: editing!.active,
      permissions,
      farmAccessMode: editing!.role === "workspace_owner" ? "all" : editing!.farmAccessMode,
      farmIds: editing!.role === "workspace_owner" ? [] : editing!.farmIds,
    }),
    onSuccess: async () => { setEditing(null); await refresh(); },
  });
  const remove = useMutation({ mutationFn: (id: string) => removeWorkspaceMember(token!, workspaceId, id), onSuccess: refresh });
  const cancelInvite = useMutation({ mutationFn: (id: string) => cancelWorkspaceInvitation(token!, workspaceId, id), onSuccess: refresh });
  const invitationLink = useMemo(() => {
    if (!shareToken) return "";
    return shareToken.startsWith("http") ? shareToken : `${window.location.origin}/accept-invitation?token=${encodeURIComponent(shareToken)}`;
  }, [shareToken]);
  const visibleModules = useMemo(
    () => modules.filter((module) => config.featureInventory || module !== "inventory"),
    [],
  );
  const startEdit = (member: WorkspaceTeamMember) => {
    setEditing({ ...member });
    setPermissions(member.permissions ?? cloneDefaults(member.role));
  };
  const toggleFarm = (farmId: string, selected: string[], onChange: (next: string[]) => void) => {
    onChange(selected.includes(farmId) ? selected.filter((item) => item !== farmId) : [...selected, farmId]);
  };
  const submitInvite = (event: FormEvent) => { event.preventDefault(); inviteMember.mutate(); };
  const toggle = (module: WorkspaceModule, action: WorkspaceModuleAction) => setPermissions((current) => ({
    ...current,
    [module]: { ...current[module], [action]: !(current[module]?.[action] ?? roleModulePermissions[editing!.role][module][action]) },
  }));

  return <div className="dashboard-page">
    <SubpageHeader title={t("workspaceTeam.title")} />
    <main className="subpage module-workspace">
      <section className="workspace-intro"><div><h2>{t("workspaceTeam.heading")}</h2><p>{t("workspaceTeam.description")}</p></div></section>
      {isOwner && <section className="record-panel"><h2>{t("workspaceTeam.invite")}</h2>
        <form className="module-form team-invite-form" onSubmit={submitInvite}>
          <input required type="email" placeholder={t("workspaceTeam.email")} value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} />
          <input placeholder={t("workspaceTeam.phone")} value={invite.phone} onChange={(event) => setInvite({ ...invite, phone: event.target.value })} />
          <select value={invite.role} onChange={(event) => setInvite({ ...invite, role: event.target.value as WorkspaceRole })}>{roles.map((role) => <option value={role} key={role}>{t(`workspaceTeam.roles.${role}`)}</option>)}</select>
          <select value={invite.farmAccessMode} onChange={(event) => setInvite({ ...invite, farmAccessMode: event.target.value as FarmAccessMode, farmIds: event.target.value === "assigned" ? invite.farmIds : [] })}>
            <option value="all">{t("workspaceTeam.allFarms")}</option>
            <option value="assigned">{t("workspaceTeam.assignedFarmsOnly")}</option>
          </select>
          {invite.farmAccessMode === "assigned" && <div className="team-farm-assignment-list">
            {team.data?.availableFarms.map((farm) => <label key={farm.id} className="compact-checkbox">
              <input type="checkbox" checked={invite.farmIds.includes(farm.id)} onChange={() => toggleFarm(farm.id, invite.farmIds, (farmIds) => setInvite({ ...invite, farmIds }))} />
              {farm.name}
            </label>)}
          </div>}
          <button disabled={inviteMember.isPending} type="submit"><UserPlus size={16} />{t("workspaceTeam.sendInvite")}</button>
        </form>
        {inviteMember.isError && <p className="error">{inviteMember.error.message}</p>}
        {!inviteMember.isError && inviteMessage && <p>{inviteMessage}</p>}
        {invitationLink && <div className="invite-share"><p>{t("workspaceTeam.shareLink")}</p><code>{invitationLink}</code><button type="button" onClick={() => void navigator.clipboard.writeText(invitationLink)}><Copy size={15} />{t("workspaceTeam.copy")}</button></div>}
      </section>}
      {team.isLoading && <p>{t("workspaceTeam.loading")}</p>}
      {team.isError && <p className="error">{team.error.message}</p>}
      {team.data && <section className="record-panel"><h2>{t("workspaceTeam.members")}</h2><div className="team-list">
        {team.data.members.map((member) => <article className="team-card" key={member.id}>
          <div>
            <strong>{member.displayName || member.name || member.email || t("workspaceTeam.unnamedMember")}</strong>
            <span>{member.email}{member.phone ? ` | ${member.phone}` : ""}</span>
            <small>
              {t(`workspaceTeam.roles.${member.role}`)} | {member.hasWorkspaceAccess ? t("common.active") : (member.userStatus === "suspended" ? t("common.suspended") : t("common.inactive"))}
            </small>
            <small>{member.farmAccessMode === "assigned" ? t("workspaceTeam.assignedFarmCount", { count: member.farmIds.length }) : t("workspaceTeam.allFarms")}</small>
          </div>
          {isOwner && <div className="team-card__actions"><button type="button" onClick={() => setActivityMember(member)}><Activity size={15} />{t("workspaceTeam.activity")}</button><button type="button" onClick={() => startEdit(member)}>{t("workspaceTeam.permissions")}</button><button className="danger-button" type="button" onClick={() => window.confirm(t("workspaceTeam.confirmRemove")) && remove.mutate(member.id)}><Trash2 size={15} />{t("workspaceTeam.remove")}</button></div>}
        </article>)}
      </div></section>}
      {team.data?.invitations.length ? <section className="record-panel"><h2>{t("workspaceTeam.pendingInvites")}</h2>{team.data.invitations.map((item) => <article className="team-card" key={item.id}><div><strong>{item.email}</strong><span>{t(`workspaceTeam.roles.${item.role}`)}</span></div>{isOwner && <button type="button" onClick={() => cancelInvite.mutate(item.id)}>{t("workspaceTeam.cancelInvite")}</button>}</article>)}</section> : null}
      {editing && <div className="worker-dialog-backdrop"><section className="worker-action-dialog permission-dialog" role="dialog" aria-modal="true" aria-label={t("workspaceTeam.editMember")}><header><div><h2>{t("workspaceTeam.editMember")}</h2><p>{editing.email}</p></div><button type="button" onClick={() => setEditing(null)}>×</button></header><div className="worker-action-dialog__body permission-dialog__body">
        <div className="permission-dialog__meta">
          <label>{t("workspaceTeam.role")}<select value={editing.role} onChange={(event) => { const role = event.target.value as WorkspaceRole; setEditing({ ...editing, role, farmAccessMode: role === "workspace_owner" ? "all" : editing.farmAccessMode, farmIds: role === "workspace_owner" ? [] : editing.farmIds }); setPermissions(cloneDefaults(role)); }}>{roles.map((role) => <option value={role} key={role}>{t(`workspaceTeam.roles.${role}`)}</option>)}</select></label>
          <label>{t("workspaceTeam.farmAccess")}<select value={editing.role === "workspace_owner" ? "all" : editing.farmAccessMode} disabled={editing.role === "workspace_owner"} onChange={(event) => setEditing({ ...editing, farmAccessMode: event.target.value as FarmAccessMode, farmIds: event.target.value === "assigned" ? editing.farmIds : [] })}>
            <option value="all">{t("workspaceTeam.allFarms")}</option>
            <option value="assigned">{t("workspaceTeam.assignedFarmsOnly")}</option>
          </select></label>
          <label className="compact-checkbox"><input type="checkbox" checked={editing.active} onChange={(event) => setEditing({ ...editing, active: event.target.checked })} />{t("workspaceTeam.activeMember")}</label>
        </div>
        {editing.role !== "workspace_owner" && editing.farmAccessMode === "assigned" && <div className="team-farm-assignment-list">
          {team.data?.availableFarms.map((farm) => <label key={farm.id} className="compact-checkbox">
            <input type="checkbox" checked={editing.farmIds.includes(farm.id)} onChange={() => toggleFarm(farm.id, editing.farmIds, (farmIds) => setEditing({ ...editing, farmIds }))} />
            {farm.name}
          </label>)}
        </div>}
        <div className="permission-matrix">{visibleModules.map((module) => <section key={module}><strong>{t(`workspaceTeam.modules.${module}`)}</strong>{actions.map((action) => <label key={action}><input type="checkbox" checked={permissions[module]?.[action] ?? roleModulePermissions[editing.role][module][action]} onChange={() => toggle(module, action)} />{t(`workspaceTeam.actions.${action}`)}</label>)}</section>)}</div>
      </div><footer><button className="secondary-button" type="button" onClick={() => setPermissions(cloneDefaults(editing.role))}><RotateCcw size={15} />{t("workspaceTeam.reset")}</button><div className="permission-dialog__footer-actions"><button className="secondary-button" type="button" onClick={() => setEditing(null)}>{t("common.close")}</button><button type="button" disabled={saveMember.isPending} onClick={() => saveMember.mutate()}>{t("workspaceTeam.save")}</button></div></footer></section></div>}
      {activityMember && <div className="worker-dialog-backdrop"><section className="worker-action-dialog permission-dialog"><header><div><h2>{t("workspaceTeam.activity")}</h2><p>{activityMember.name || activityMember.email}</p></div><button type="button" onClick={() => setActivityMember(null)}>×</button></header><div className="worker-action-dialog__body">
        {activity.isLoading && <p>{t("workspaceTeam.loadingActivity")}</p>}
        {activity.isError && <p className="error">{activity.error.message}</p>}
        {activity.data?.activity.map((item) => <article className="team-activity" key={item.id}><strong>{item.action}</strong><span>{item.entityType}</span><small>{new Date(item.createdAt).toLocaleString()}</small></article>)}
        {activity.data?.activity.length === 0 && <p>{t("workspaceTeam.noActivity")}</p>}
      </div><footer><button className="secondary-button" type="button" onClick={() => setActivityMember(null)}>{t("common.close")}</button></footer></section></div>}
    </main>
  </div>;
}
