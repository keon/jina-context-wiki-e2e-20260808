"use client";

import { useUser } from "@clerk/nextjs";
import type { OrganizationMembershipResource } from "@clerk/nextjs/types";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { useDashboard, useTenant } from "../providers";
import { clerkErrorMessage, useSelectedClerkOrganization } from "../lib/clerk-organization";

export default function OrganizationPage() {
  const { viewer, authLoading } = useDashboard();
  const { selected, ready } = useTenant();
  const { user } = useUser();
  const { isLoaded, membership, organization } = useSelectedClerkOrganization();
  const [members, setMembers] = useState<OrganizationMembershipResource[]>([]);
  const [loading, setLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    if (!organization) {
      setMembers([]);
      return;
    }
    setLoading(true);
    try {
      const response = await organization.getMemberships({ pageSize: 100 });
      setMembers(response.data);
    } catch (loadError) {
      setError(clerkErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [organization]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  const inviteMember = async (event: FormEvent) => {
    event.preventDefault();
    if (!organization || !inviteEmail.trim()) return;
    setSaving("invite");
    setError(null);
    try {
      await organization.inviteMember({ emailAddress: inviteEmail.trim(), role: "org:member" });
      setInviteEmail("");
      await organization.reload();
    } catch (inviteError) {
      setError(clerkErrorMessage(inviteError));
    } finally {
      setSaving(null);
    }
  };

  const updateRole = async (member: OrganizationMembershipResource, role: string) => {
    const userId = member.publicUserData?.userId;
    if (!organization || !userId) return;
    setSaving(member.id);
    setError(null);
    try {
      await organization.updateMember({ userId, role });
      await loadMembers();
    } catch (updateError) {
      setError(clerkErrorMessage(updateError));
    } finally {
      setSaving(null);
    }
  };

  const removeMember = async (member: OrganizationMembershipResource) => {
    const userId = member.publicUserData?.userId;
    if (!organization || !userId) return;
    setSaving(member.id);
    setError(null);
    try {
      await organization.removeMember(userId);
      await loadMembers();
    } catch (removeError) {
      setError(clerkErrorMessage(removeError));
    } finally {
      setSaving(null);
    }
  };

  if (!ready || authLoading || !isLoaded) {
    return (
      <div className="page-placeholder page-placeholder--compact" role="status">
        Loading members…
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="page-placeholder" role="status">
        <strong>No team selected</strong>
        <p>Select a workspace from the sidebar to manage its members.</p>
      </div>
    );
  }

  const isAdmin = selected.role === "admin" && membership?.role === "org:admin";

  return (
    <div className="settings-page members-page">
      <header className="settings-page__intro settings-page__intro--row">
        <div>
          <h1>Members</h1>
          <p>Manage who can access {selected.login} and what they can change.</p>
        </div>
        {organization && isAdmin ? (
          <form className="member-invite" onSubmit={(event) => void inviteMember(event)}>
            <input
              className="input"
              type="email"
              value={inviteEmail}
              placeholder="name@company.com"
              aria-label="Email address"
              onChange={(event) => setInviteEmail(event.target.value)}
            />
            <button className="btn btn--primary" type="submit" disabled={!inviteEmail.trim() || saving !== null}>
              {saving === "invite" ? "Inviting…" : "Invite member"}
            </button>
          </form>
        ) : null}
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
            <h2>Team members</h2>
            <p>{organization ? `${organization.membersCount} total members` : "Your personal workspace"}</p>
          </div>
        </div>
        {organization ? (
          loading ? (
            <div className="settings-card__empty" role="status">
              Loading members…
            </div>
          ) : (
            <div className="member-list">
              {members.map((member) => {
                const isCurrentUser = member.publicUserData?.userId === user?.id;
                const displayName = memberName(member);
                return (
                  <div className="member-row" key={member.id}>
                    <span className="member-avatar" aria-hidden="true">
                      {member.publicUserData?.imageUrl ? (
                        <img src={member.publicUserData.imageUrl} alt="" />
                      ) : (
                        displayName.slice(0, 1).toUpperCase()
                      )}
                    </span>
                    <span className="member-row__identity">
                      <strong>
                        {displayName}
                        {isCurrentUser ? " (you)" : ""}
                      </strong>
                      <small>
                        {member.publicUserData?.identifier ?? member.publicUserData?.userId ?? "Clerk member"}
                      </small>
                    </span>
                    <span className="member-row__joined">Joined {formatDate(member.createdAt)}</span>
                    {isAdmin ? (
                      <div className="member-row__actions">
                        <select
                          className="select select--inline"
                          value={member.role}
                          aria-label={`Role for ${displayName}`}
                          disabled={isCurrentUser || saving !== null}
                          onChange={(event) => void updateRole(member, event.target.value)}
                        >
                          <option value="org:admin">Admin</option>
                          <option value="org:member">Member</option>
                        </select>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={isCurrentUser || saving !== null}
                          onClick={() => void removeMember(member)}
                        >
                          {saving === member.id ? "Working…" : "Remove"}
                        </button>
                      </div>
                    ) : (
                      <span className="badge">{member.roleName}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <div className="member-list">
            <div className="member-row">
              <span className="member-avatar" aria-hidden="true">
                {user?.imageUrl ? <img src={user.imageUrl} alt="" /> : selected.login.slice(0, 1).toUpperCase()}
              </span>
              <span className="member-row__identity">
                <strong>{user?.fullName ?? viewer?.user?.name ?? selected.login} (you)</strong>
                <small>{user?.primaryEmailAddress?.emailAddress ?? viewer?.user?.login}</small>
              </span>
              <span className="badge">Owner</span>
            </div>
          </div>
        )}
      </section>

      <section className="settings-card">
        <div className="settings-card__head">
          <div>
            <h2>Access levels</h2>
            <p>Clerk roles define access to shared team resources.</p>
          </div>
        </div>
        <div className="access-levels">
          <div>
            <strong>Admin</strong>
            <p>Can manage members, integrations, models, billing, and team settings.</p>
          </div>
          <div>
            <strong>Member</strong>
            <p>Can use and inspect team resources without changing admin-controlled settings.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function memberName(member: OrganizationMembershipResource): string {
  const name = [member.publicUserData?.firstName, member.publicUserData?.lastName].filter(Boolean).join(" ");
  return name || member.publicUserData?.identifier || "Team member";
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(value);
}
