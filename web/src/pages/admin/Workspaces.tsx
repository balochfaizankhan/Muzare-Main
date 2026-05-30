import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { createAdminWorkspace, deleteAdminWorkspace, fetchAdminWorkspaces, suspendAdminWorkspace } from "../../lib/api";

export function Workspaces() {
  const { user, token } = useAuth();
  const canManage = user?.platformRole === "platform_admin";
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const query = useQuery({ queryKey: ["admin-workspaces"], queryFn: () => fetchAdminWorkspaces(token!), enabled: Boolean(token) });
  const refresh = () => client.invalidateQueries({ queryKey: ["admin-workspaces"] });
  const create = useMutation({ mutationFn: () => createAdminWorkspace(token!, { name, contactEmail }), onSuccess: () => { setName(""); setContactEmail(""); void refresh(); } });
  const suspend = useMutation({ mutationFn: (id: string) => suspendAdminWorkspace(token!, id), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => deleteAdminWorkspace(token!, id), onSuccess: refresh });
  const submit = (event: FormEvent) => { event.preventDefault(); create.mutate(); };

  return <main className="shell-page">
    <section className="shell-page__intro"><span className="eyebrow">Platform administration</span><h1>Workspaces</h1><p>Create, approve, suspend, delete, and inspect customer workspace metadata.</p><Link className="primary-link" to="/admin/approvals">Review pending requests</Link></section>
    {canManage && <section className="panel"><h2>Create workspace</h2><form className="compact-form form-grid" onSubmit={submit}><input required placeholder="Workspace name" value={name} onChange={(event) => setName(event.target.value)} /><input required type="email" placeholder="Contact email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} /><button type="submit" disabled={create.isPending}>Create</button></form></section>}
    <section className="panel"><h2>Customer workspaces</h2>{query.isError && <p className="error">{query.error.message}</p>}<div className="record-list">{query.data?.workspaces.map((workspace) => <article key={workspace.id}><strong>{workspace.name}</strong><span>{workspace.contactEmail}</span><span>{workspace.status}</span>{canManage && <button onClick={() => suspend.mutate(workspace.id)}>Suspend</button>}{canManage && <button onClick={() => remove.mutate(workspace.id)}>Delete</button>}</article>)}</div></section>
  </main>;
}
