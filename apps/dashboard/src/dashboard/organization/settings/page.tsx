"use client";

import { useUser } from "@clerk/nextjs";
import type { OrganizationMembershipResource } from "@clerk/nextjs/types";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useDashboard, useTenant } from "../../providers";
import { apiUrl } from "../../lib/api";
import { clerkErrorMessage, useSelectedClerkOrganization } from "../../lib/clerk-organization";

type OrganizationMember = OrganizationMembershipResource;

type PendingAction = "transfer" | "leave" | "delete" | null;

export default function OrganizationSettingsPage() {
  const { reloadViewer } = useDashboard();
  const { selected, ready, updateTenant } = useTenant();
  const { user } = useUser();
  const { isLoaded, membership, organization } = useSelectedClerkOrganization();
  const [name, setName] = useState("");
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [transferUserId, setTransferUserId] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(organization?.name ?? selected?.login ?? "");
    setPendingAction(null);
    setDeleteConfirmation("");
  }, [organization?.id, organization?.name, selected?.login, selected?.tenantId]);

  useEffect(() => {
    if (!organization) {
      setMembers([]);
      return;
    }
    let active = true;
    setMembersLoading(true);
    organization
      .getMemberships({ pageSize: 100 })
      .then((response) => {
        if (active) setMembers(response.data);
      })
      .catch((loadError: unknown) => {
        if (active) setError(clerkErrorMessage(loadError));
      })
      .finally(() => {
        if (active) setMembersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [organization]);

  const transferCandidates = useMemo(
    () => members.filter((candidate) => candidate.publicUserData?.userId !== user?.id),
    [members, user?.id],
  );
  const isOrganization = selected?.type === "Organization";
  const isAdmin = selected?.role === "admin" && membership?.role === "org:admin";
  const avatarUrl = organization?.imageUrl ?? (selected?.type === "User" ? user?.imageUrl : undefined);

  const syncJinaMemberships = async () => {
    await fetch(apiUrl("/dashboard/session/refresh"), {
      method: "POST",
      cache: "no-store",
      credentials: "include",
    });
    reloadViewer();
  };

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    if (!organization || !selected || !name.trim() || name.trim() === organization.name) return;
    setSaving("name");
    setError(null);
    try {
      const updated = await organization.update({ name: name.trim() });
      await syncJinaMemberships();
      updateTenant({
        tenant_id: selected.tenantId,
        login: updated.name,
        type: selected.type,
        role: selected.role,
        ...(selected.clerkOrganizationId ? { clerk_organization_id: selected.clerkOrganizationId } : {}),
      });
      setName(updated.name);
    } catch (saveError) {
      setError(clerkErrorMessage(saveError));
    } finally {
      setSaving(null);
    }
  };

  const uploadAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !organization) return;
    setSaving("avatar");
    setError(null);
    try {
      await organization.setLogo({ file });
      await organization.reload();
    } catch (uploadError) {
      setError(clerkErrorMessage(uploadError));
    } finally {
      setSaving(null);
    }
  };

  const transferTeam = async () => {
    if (!organization || !user || !transferUserId) return;
    setSaving("transfer");
    setError(null);
    try {
      await organization.updateMember({ userId: transferUserId, role: "org:admin" });
      await organization.updateMember({ userId: user.id, role: "org:member" });
      await syncJinaMemberships();
      window.location.assign("/reviews");
    } catch (transferError) {
      setError(clerkErrorMessage(transferError));
      setSaving(null);
    }
  };

  const leaveTeam = async () => {
    if (!membership) return;
    setSaving("leave");
    setError(null);
    try {
      await membership.destroy();
      await syncJinaMemberships();
      window.location.assign("/reviews");
    } catch (leaveError) {
      setError(clerkErrorMessage(leaveError));
      setSaving(null);
    }
  };

  const deleteTeam = async () => {
    if (!organization || deleteConfirmation !== organization.name) return;
    setSaving("delete");
    setError(null);
    try {
      await organization.destroy();
      await syncJinaMemberships();
      window.location.assign("/reviews");
    } catch (deleteError) {
      setError(clerkErrorMessage(deleteError));
      setSaving(null);
    }
  };

  if (!ready || !isLoaded) {
    return (
      <div className="page-placeholder page-placeholder--compact" role="status">
        Loading team settings…
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="page-placeholder">
        <strong>No team selected</strong>
        <p>Select a workspace before opening Org Settings.</p>
      </div>
    );
  }

  return (
    <div className="settings-page organization-settings-page">
      <header className="settings-page__intro">
        <div>
          <h1>General</h1>
          <p>Manage the identity and ownership of this team.</p>
        </div>
      </header>

      {error ? (
        <div className="notice notice--bad" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn--sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <section className="settings-card">
        <div className="settings-card__head">
          <div>
            <h2>Team profile</h2>
            <p>This name and avatar identify the team throughout Jina.</p>
          </div>
        </div>
        <div className="team-profile">
          <div className="team-avatar team-avatar--large" aria-hidden="true">
            {avatarUrl ? <img src={avatarUrl} alt="" /> : selected.login.slice(0, 1).toUpperCase()}
          </div>
          <div className="team-profile__avatar-actions">
            <strong>Team avatar</strong>
            <span>Square JPG, PNG, GIF, or WebP. Up to 10 MB.</span>
            <label className={`btn btn--sm${!organization || !isAdmin ? " btn--disabled" : ""}`}>
              {saving === "avatar" ? "Uploading…" : "Change avatar"}
              <input
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                disabled={!organization || !isAdmin || saving !== null}
                onChange={(event) => void uploadAvatar(event)}
              />
            </label>
          </div>
        </div>
        <form className="settings-form" onSubmit={(event) => void saveName(event)}>
          <label className="settings-field">
            <span>Team name</span>
            <input
              className="input"
              value={name}
              maxLength={80}
              disabled={!organization || !isAdmin || saving !== null}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="settings-form__actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={
                !organization || !isAdmin || !name.trim() || name.trim() === organization.name || saving !== null
              }
            >
              {saving === "name" ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </section>

      <section className="settings-card">
        <div className="settings-card__head">
          <div>
            <h2>Team details</h2>
            <p>Stable identifiers used by Jina and Clerk.</p>
          </div>
        </div>
        <dl className="settings-metadata">
          <div>
            <dt>Team ID</dt>
            <dd>{selected.tenantId}</dd>
          </div>
          <div>
            <dt>Team name</dt>
            <dd>{organization?.name ?? selected.login}</dd>
          </div>
          <div>
            <dt>Team type</dt>
            <dd>{isOrganization ? "Organization" : "Personal workspace"}</dd>
          </div>
          <div>
            <dt>Clerk organization ID</dt>
            <dd>{organization?.id ?? "Not applicable"}</dd>
          </div>
        </dl>
      </section>

      <section className="settings-card settings-card--danger">
        <div className="settings-card__head">
          <div>
            <h2>Team ownership</h2>
            <p>These actions change who controls or can access this team.</p>
          </div>
        </div>
        {!organization ? (
          <p className="settings-card__note">
            Personal workspaces are attached to their user account and cannot be transferred, left, or deleted
            separately.
          </p>
        ) : (
          <div className="danger-actions">
            <DangerAction
              title="Transfer team"
              description="Make another member an admin and change your role to member."
              actionLabel="Transfer"
              disabled={!isAdmin || transferCandidates.length === 0 || membersLoading}
              open={pendingAction === "transfer"}
              onOpen={() => setPendingAction("transfer")}
            >
              <label className="settings-field">
                <span>New team admin</span>
                <select
                  className="select"
                  value={transferUserId}
                  onChange={(event) => setTransferUserId(event.target.value)}
                >
                  <option value="">Select a member</option>
                  {transferCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.publicUserData?.userId}>
                      {memberLabel(candidate)}
                    </option>
                  ))}
                </select>
              </label>
              <ConfirmActions
                busy={saving === "transfer"}
                disabled={!transferUserId}
                confirmLabel="Transfer team"
                onCancel={() => setPendingAction(null)}
                onConfirm={() => void transferTeam()}
              />
            </DangerAction>

            <DangerAction
              title="Leave team"
              description="Remove your account from this team. You will immediately lose access."
              actionLabel="Leave"
              disabled={!membership || members.length <= 1}
              open={pendingAction === "leave"}
              onOpen={() => setPendingAction("leave")}
            >
              <p className="danger-action__confirmation">Are you sure you want to leave {organization.name}?</p>
              <ConfirmActions
                busy={saving === "leave"}
                confirmLabel="Leave team"
                onCancel={() => setPendingAction(null)}
                onConfirm={() => void leaveTeam()}
              />
            </DangerAction>

            <DangerAction
              title="Delete team"
              description="Permanently delete this team, its memberships, and its Clerk organization."
              actionLabel="Delete"
              disabled={!isAdmin}
              open={pendingAction === "delete"}
              onOpen={() => setPendingAction("delete")}
            >
              <label className="settings-field">
                <span>Type {organization.name} to confirm</span>
                <input
                  className="input"
                  value={deleteConfirmation}
                  autoComplete="off"
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                />
              </label>
              <ConfirmActions
                busy={saving === "delete"}
                disabled={deleteConfirmation !== organization.name}
                confirmLabel="Delete team"
                onCancel={() => setPendingAction(null)}
                onConfirm={() => void deleteTeam()}
              />
            </DangerAction>
          </div>
        )}
      </section>
    </div>
  );
}

function memberLabel(member: OrganizationMember): string {
  const firstName = member.publicUserData?.firstName ?? "";
  const lastName = member.publicUserData?.lastName ?? "";
  return [firstName, lastName].filter(Boolean).join(" ") || member.publicUserData?.identifier || "Team member";
}

function DangerAction({
  title,
  description,
  actionLabel,
  disabled,
  open,
  onOpen,
  children,
}: {
  title: string;
  description: string;
  actionLabel: string;
  disabled?: boolean;
  open: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`danger-action${open ? " danger-action--open" : ""}`}>
      <div className="danger-action__summary">
        <span>
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
        <button type="button" className="btn btn--danger" disabled={disabled} onClick={onOpen}>
          {actionLabel}
        </button>
      </div>
      {open ? <div className="danger-action__body">{children}</div> : null}
    </div>
  );
}

function ConfirmActions({
  busy,
  disabled,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  disabled?: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="danger-action__buttons">
      <button type="button" className="btn" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="btn btn--danger" disabled={busy || disabled} onClick={onConfirm}>
        {busy ? "Working…" : confirmLabel}
      </button>
    </div>
  );
}
