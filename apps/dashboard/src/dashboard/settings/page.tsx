"use client";

import { useSession, useUser } from "@clerk/nextjs";
import type { SessionWithActivitiesResource } from "@clerk/nextjs/types";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { useDeveloperMode } from "../../components/auth/app-auth";
import { useDashboard } from "../providers";
import { clerkErrorMessage } from "../lib/clerk-organization";

export default function SettingsPage() {
  const { viewer } = useDashboard();
  const { user, isLoaded, isSignedIn } = useUser();
  const { session } = useSession();
  const developerMode = useDeveloperMode();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionWithActivitiesResource[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setFirstName(user?.firstName ?? "");
    setLastName(user?.lastName ?? "");
  }, [user?.firstName, user?.id, user?.lastName]);

  const loadSessions = useCallback(async () => {
    if (!user) return;
    setSessionsLoading(true);
    try {
      setSessions(await user.getSessions());
    } catch (loadError) {
      setError(clerkErrorMessage(loadError));
    } finally {
      setSessionsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    setSaving("profile");
    setError(null);
    setNotice(null);
    try {
      await user.update({ firstName: firstName.trim(), lastName: lastName.trim() });
      setNotice("Profile updated.");
    } catch (saveError) {
      setError(clerkErrorMessage(saveError));
    } finally {
      setSaving(null);
    }
  };

  const uploadAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !user) return;
    setSaving("avatar");
    setError(null);
    try {
      await user.setProfileImage({ file });
      await user.reload();
      setNotice("Profile photo updated.");
    } catch (uploadError) {
      setError(clerkErrorMessage(uploadError));
    } finally {
      setSaving(null);
    }
  };

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || newPassword.length < 8 || newPassword !== confirmPassword) return;
    setSaving("password");
    setError(null);
    setNotice(null);
    try {
      await user.updatePassword({
        ...(user.passwordEnabled && currentPassword ? { currentPassword } : {}),
        newPassword,
        signOutOfOtherSessions: true,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordOpen(false);
      setNotice("Password updated. Other sessions were signed out.");
      setSessions((current) => current.filter((candidate) => candidate.id === session?.id));
    } catch (passwordError) {
      setError(clerkErrorMessage(passwordError));
    } finally {
      setSaving(null);
    }
  };

  const createPasskey = async () => {
    if (!user) return;
    setSaving("passkey");
    setError(null);
    try {
      await user.createPasskey();
      await user.reload();
      setNotice("Passkey added.");
    } catch (passkeyError) {
      setError(clerkErrorMessage(passkeyError));
    } finally {
      setSaving(null);
    }
  };

  const deletePasskey = async (passkeyId: string) => {
    const passkey = user?.passkeys.find((candidate) => candidate.id === passkeyId);
    if (!passkey || !user) return;
    setSaving(passkeyId);
    setError(null);
    try {
      await passkey.delete();
      await user.reload();
      setNotice("Passkey removed.");
    } catch (passkeyError) {
      setError(clerkErrorMessage(passkeyError));
    } finally {
      setSaving(null);
    }
  };

  const revokeSession = async (target: SessionWithActivitiesResource) => {
    setSaving(target.id);
    setError(null);
    try {
      await target.revoke();
      setSessions((current) => current.filter((candidate) => candidate.id !== target.id));
      setNotice("Session signed out.");
    } catch (sessionError) {
      setError(clerkErrorMessage(sessionError));
    } finally {
      setSaving(null);
    }
  };

  const toggleDeveloperMode = async () => {
    setError(null);
    try {
      await developerMode.setEnabled(!developerMode.enabled);
      setNotice(`Developer Mode ${developerMode.enabled ? "disabled" : "enabled"}.`);
    } catch (toggleError) {
      setError(clerkErrorMessage(toggleError));
    }
  };

  if (!isLoaded) {
    return (
      <div className="page-placeholder page-placeholder--compact" role="status">
        Loading user settings…
      </div>
    );
  }

  if (!isSignedIn || !user) {
    return (
      <div className="page-placeholder page-placeholder--compact">
        <strong>User settings unavailable</strong>
        <p>Sign in with Clerk to manage your profile and security settings.</p>
      </div>
    );
  }

  const profileChanged = firstName.trim() !== (user.firstName ?? "") || lastName.trim() !== (user.lastName ?? "");
  const primaryEmail = user.primaryEmailAddress?.emailAddress ?? "No primary email";

  return (
    <div className="settings-page user-settings-page">
      <header className="settings-page__intro">
        <div>
          <h1>User Settings</h1>
          <p>Manage your profile, preferences, sign-in methods, and active sessions.</p>
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
      {notice ? (
        <div className="notice notice--ok" role="status">
          <span>{notice}</span>
          <button type="button" className="btn btn--sm" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <section className="settings-card">
        <div className="settings-card__head">
          <div>
            <h2>Profile</h2>
            <p>Your personal identity across Jina teams.</p>
          </div>
        </div>
        <div className="team-profile">
          <div className="team-avatar team-avatar--large" aria-hidden="true">
            <img src={user.imageUrl} alt="" />
          </div>
          <div className="team-profile__avatar-actions">
            <strong>Profile photo</strong>
            <span>{primaryEmail}</span>
            <label className="btn btn--sm">
              {saving === "avatar" ? "Uploading…" : "Change photo"}
              <input
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                disabled={saving !== null}
                onChange={(event) => void uploadAvatar(event)}
              />
            </label>
          </div>
        </div>
        <form className="settings-form settings-form--two-col" onSubmit={(event) => void saveProfile(event)}>
          <label className="settings-field">
            <span>First name</span>
            <input className="input" value={firstName} onChange={(event) => setFirstName(event.target.value)} />
          </label>
          <label className="settings-field">
            <span>Last name</span>
            <input className="input" value={lastName} onChange={(event) => setLastName(event.target.value)} />
          </label>
          <label className="settings-field settings-field--full">
            <span>Primary email</span>
            <input className="input" value={primaryEmail} readOnly disabled />
          </label>
          <div className="settings-form__actions settings-field--full">
            <button className="btn btn--primary" type="submit" disabled={!profileChanged || saving !== null}>
              {saving === "profile" ? "Saving…" : "Save profile"}
            </button>
          </div>
        </form>
      </section>

      <section className="settings-card">
        <div className="settings-card__head">
          <div>
            <h2>Preferences</h2>
            <p>Customize how Jina works for your account.</p>
          </div>
        </div>
        <div className="preference-row">
          <span>
            <strong>Developer Mode</strong>
            <small>Show Task Board, Tasks, and Run History navigation.</small>
          </span>
          <button
            type="button"
            className={`switch${developerMode.enabled ? " switch--on" : ""}`}
            role="switch"
            aria-checked={developerMode.enabled}
            aria-label="Developer Mode"
            disabled={!developerMode.ready || developerMode.saving}
            onClick={() => void toggleDeveloperMode()}
          >
            <span />
          </button>
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-card__head">
          <div>
            <h2>Security</h2>
            <p>Security status is provided directly by Clerk.</p>
          </div>
        </div>
        <div className="security-summary">
          <SecurityStat
            label="Password"
            value={user.passwordEnabled ? "Configured" : "Not configured"}
            ok={user.passwordEnabled}
          />
          <SecurityStat
            label="Two-step verification"
            value={user.twoFactorEnabled ? "Enabled" : "Not enabled"}
            ok={user.twoFactorEnabled}
          />
          <SecurityStat label="Passkeys" value={`${user.passkeys.length} configured`} ok={user.passkeys.length > 0} />
          <SecurityStat
            label="Connected accounts"
            value={`${user.externalAccounts.length} connected`}
            ok={user.externalAccounts.length > 0}
          />
        </div>
        <div className="security-actions">
          <div className="security-action">
            <span>
              <strong>Password</strong>
              <small>
                {user.passwordEnabled
                  ? "Change your password and sign out other sessions."
                  : "Add a password as another sign-in method."}
              </small>
            </span>
            <button type="button" className="btn btn--sm" onClick={() => setPasswordOpen((open) => !open)}>
              {user.passwordEnabled ? "Change password" : "Add password"}
            </button>
          </div>
          {passwordOpen ? (
            <form className="security-inline-form" onSubmit={(event) => void savePassword(event)}>
              {user.passwordEnabled ? (
                <label className="settings-field">
                  <span>Current password</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                </label>
              ) : null}
              <label className="settings-field">
                <span>New password</span>
                <input
                  className="input"
                  type="password"
                  minLength={8}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Confirm new password</span>
                <input
                  className="input"
                  type="password"
                  minLength={8}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
              <div className="settings-form__actions settings-field--full">
                <button type="button" className="btn" onClick={() => setPasswordOpen(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={newPassword.length < 8 || newPassword !== confirmPassword || saving !== null}
                >
                  {saving === "password" ? "Saving…" : "Update password"}
                </button>
              </div>
            </form>
          ) : null}

          <div className="security-action">
            <span>
              <strong>Passkeys</strong>
              <small>Use your device lock, fingerprint, or security key to sign in.</small>
            </span>
            <button
              type="button"
              className="btn btn--sm"
              disabled={saving !== null}
              onClick={() => void createPasskey()}
            >
              {saving === "passkey" ? "Adding…" : "Add passkey"}
            </button>
          </div>
          {user.passkeys.map((passkey) => (
            <div className="security-subrow" key={passkey.id}>
              <span>
                <strong>{passkey.name ?? "Passkey"}</strong>
                <small>
                  Added {formatDate(passkey.createdAt)}
                  {passkey.lastUsedAt ? ` · Last used ${formatDate(passkey.lastUsedAt)}` : ""}
                </small>
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={saving !== null}
                onClick={() => void deletePasskey(passkey.id)}
              >
                {saving === passkey.id ? "Removing…" : "Remove"}
              </button>
            </div>
          ))}

          <div className="security-action security-action--stack">
            <span>
              <strong>Sign-in methods</strong>
              <small>Email addresses and connected identity providers.</small>
            </span>
            <div className="identity-methods">
              {user.emailAddresses.map((email) => (
                <span className="identity-method" key={email.id}>
                  <span>{email.emailAddress}</span>
                  <small>
                    {email.id === user.primaryEmailAddressId ? "Primary" : "Email"} ·{" "}
                    {email.verification.status === "verified" ? "Verified" : "Unverified"}
                  </small>
                </span>
              ))}
              {user.externalAccounts.map((account) => (
                <span className="identity-method" key={account.id}>
                  <span>{account.providerTitle()}</span>
                  <small>{account.accountIdentifier()}</small>
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-card__head">
          <div>
            <h2>Active sessions</h2>
            <p>Devices currently signed in to your Clerk account.</p>
          </div>
        </div>
        {sessionsLoading ? (
          <div className="settings-card__empty">Loading sessions…</div>
        ) : (
          <div className="session-list">
            {sessions.map((activeSession) => {
              const current = activeSession.id === session?.id;
              const activity = activeSession.latestActivity;
              return (
                <div className="session-row" key={activeSession.id}>
                  <span className="session-row__device" aria-hidden="true">
                    {activity.isMobile ? "M" : "D"}
                  </span>
                  <span className="session-row__identity">
                    <strong>
                      {activity.browserName ?? activity.deviceType ?? "Unknown device"}
                      {current ? " (this device)" : ""}
                    </strong>
                    <small>
                      {[activity.city, activity.country, activity.ipAddress].filter(Boolean).join(" · ") ||
                        "Location unavailable"}
                    </small>
                  </span>
                  <span className="session-row__time">Active {formatDateTime(activeSession.lastActiveAt)}</span>
                  {!current ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={saving !== null}
                      onClick={() => void revokeSession(activeSession)}
                    >
                      {saving === activeSession.id ? "Signing out…" : "Sign out"}
                    </button>
                  ) : (
                    <span className="badge badge--ok">Current</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="settings-card">
        <div className="settings-card__head">
          <div>
            <h2>Account metadata</h2>
            <p>Identifiers and timestamps used by Jina and Clerk.</p>
          </div>
        </div>
        <dl className="settings-metadata">
          <Metadata label="Jina user ID" value={viewer?.user?.internal_id ?? "Unavailable"} />
          <Metadata label="Clerk user ID" value={user.id} />
          <Metadata label="GitHub account" value={viewer?.user?.login ?? "Unavailable"} />
          <Metadata label="GitHub user ID" value={viewer?.user?.id ? String(viewer.user.id) : "Unavailable"} />
          <Metadata label="Account created" value={formatDateTime(user.createdAt)} />
          <Metadata label="Last sign in" value={formatDateTime(user.lastSignInAt)} />
        </dl>
        <details className="metadata-details">
          <summary>Clerk metadata</summary>
          <div className="metadata-json-grid">
            <div>
              <strong>Public metadata</strong>
              <pre>{JSON.stringify(user.publicMetadata, null, 2)}</pre>
            </div>
            <div>
              <strong>User-editable metadata</strong>
              <pre>{JSON.stringify(user.unsafeMetadata, null, 2)}</pre>
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}

function SecurityStat({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="security-stat">
      <span className={`security-stat__dot${ok ? " security-stat__dot--ok" : ""}`} aria-hidden="true" />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
    </div>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatDate(value: Date | null): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(value)
    : "Never";
}

function formatDateTime(value: Date | null): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value)
    : "Never";
}
