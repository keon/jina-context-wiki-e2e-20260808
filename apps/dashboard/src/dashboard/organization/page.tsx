"use client";

import Link from "next/link";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  APP_ORGANIZATION_ROLES,
  useAppOrganization,
  type AppAuthError,
  type AppOrganizationDirectory,
  type AppOrganizationList,
  type AppOrganizationRole
} from "../../components/auth/app-auth";
import { Badge, EmptyState, List, Panel, Row } from "../components/ui";
import { formatRelative } from "../lib/presentation";
import { isTenantWritable } from "../lib/tenants";
import { useDashboard, useTenant } from "../providers";

export default function OrganizationPage() {
  const { viewer, authLoading } = useDashboard();
  const { selected, ready, tenants } = useTenant();

  const isOrganization = selected?.type === "Organization";
  // Address the workspace's own Clerk organization rather than whichever organization
  // the Clerk session has active: the switcher above is Jina's, and the two are not
  // the same selection. A workspace with no Clerk organization behind it resolves to
  // null here and is reported as such instead of borrowing another workspace's list.
  const clerkOrganizationId = useMemo(() => {
    if (!selected || selected.type !== "Organization") return null;
    return tenants.find((tenant) => tenant.tenant_id === selected.tenantId)?.clerk_organization_id ?? null;
  }, [selected, tenants]);

  // The same admin gate the rest of the app uses for writes. It decides what is drawn;
  // Clerk decides what is allowed, and a refusal is surfaced verbatim below.
  const canManage = isOrganization && isTenantWritable(selected);

  const directory = useAppOrganization({
    organizationId: clerkOrganizationId,
    withInvitations: canManage
  });

  if (!ready || authLoading) {
    return (
      <>
        <h1 className="sr-only">Members &amp; Access</h1>
        <div className="page-placeholder page-placeholder--compact" role="status">
          Loading workspace access…
        </div>
      </>
    );
  }

  if (!selected) {
    return (
      <div className="page-placeholder" role="status">
        <h1 className="sr-only">Members &amp; Access</h1>
        <span className="page-placeholder__icon" aria-hidden="true">
          <AccessIcon />
        </span>
        <strong>No workspace selected</strong>
        <p>Select a workspace from the sidebar to inspect its access boundary.</p>
      </div>
    );
  }

  return (
    <div className="organization-page">
      <h1 className="sr-only">Members &amp; Access</h1>
      <Panel
        title="Workspace"
        actions={<Badge>{selected.type === "Organization" ? "Organization" : "Personal"}</Badge>}
      >
        <dl className="organization-summary">
          <div>
            <dt>Name</dt>
            <dd>{selected.login}</dd>
          </div>
          <div>
            <dt>Your access</dt>
            <dd>{selected.role === "admin" ? "Administrator" : "Member"}</dd>
          </div>
          <div>
            <dt>Signed in as</dt>
            <dd>{viewer?.user?.login ?? "Account"}</dd>
          </div>
          <div>
            <dt>Available workspaces</dt>
            <dd>{tenants.length}</dd>
          </div>
        </dl>
      </Panel>

      {isOrganization ? (
        <>
          <MembersPanel directory={directory} linked={clerkOrganizationId !== null} />
          {clerkOrganizationId !== null ? (
            <>
              <InvitePanel key={clerkOrganizationId} directory={directory} canManage={canManage} />
              {canManage ? <InvitationsPanel directory={directory} /> : null}
            </>
          ) : null}
        </>
      ) : (
        <Panel title="Members">
          <EmptyState compact>
            A personal workspace has no organization behind it, so there is nobody to list and nobody to invite.
            Create or switch to an organization workspace to share access.
          </EmptyState>
        </Panel>
      )}

      <Panel title="Access boundary">
        <div className="organization-access">
          <span className="page-placeholder__icon" aria-hidden="true">
            <AccessIcon />
          </span>
          <div>
            <strong>{selected.type === "Organization" ? "Organization membership" : "Personal workspace"}</strong>
            <p>
              {selected.type === "Organization"
                ? "Jina follows the organization memberships attached to your signed-in account. Admins can configure shared integrations, models, and billing; members receive read-only access to protected settings."
                : "This workspace belongs to your account. Its integrations, models, usage, and billing stay separate from every organization workspace."}
            </p>
          </div>
          <Link className="btn btn--sm" href="/integrations">
            Manage integrations
          </Link>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ members --- */

function MembersPanel({ directory, linked }: { directory: AppOrganizationDirectory; linked: boolean }) {
  const { members } = directory;

  return (
    <Panel title="Members" count={linked ? (settledCount(directory, members) ?? undefined) : undefined}>
      {!linked ? (
        <EmptyState compact>
          This workspace is not linked to an organization directory, so its members cannot be listed or invited here.
        </EmptyState>
      ) : (
        <>
          <DirectoryBody
            directory={directory}
            list={members}
            loadingLabel="Loading members…"
            emptyLabel="This organization has no members yet."
          >
            {(items) => (
              <List>
                {items.map((member) => (
                  <Row
                    key={member.id}
                    title={member.name}
                    meta={memberMeta(member.identifier, member.joinedAt)}
                    trailing={<Badge tone={member.role === "org:admin" ? "info" : ""}>{member.roleLabel}</Badge>}
                  />
                ))}
              </List>
            )}
          </DirectoryBody>
          <DirectoryPager list={members} noun="members" />
        </>
      )}
    </Panel>
  );
}

/** The total, but only once it is a fact: null while the read is pending or failed. */
function settledCount<T>(directory: AppOrganizationDirectory, list: AppOrganizationList<T>): number | null {
  if (directory.status !== "ready" || list.loading || list.error) return null;
  return list.total;
}

function memberMeta(identifier: string | null, joinedAt: string | null): string {
  const parts = [identifier, joinedAt ? `Joined ${formatRelative(joinedAt)}` : null].filter(
    (part): part is string => Boolean(part)
  );
  return parts.length > 0 ? parts.join(" · ") : "No contact details on record";
}

/* -------------------------------------------------------------- invitations --- */

function InvitationsPanel({ directory }: { directory: AppOrganizationDirectory }) {
  const { invitations } = directory;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<AppAuthError | null>(null);

  const revoke = async (invitationId: string) => {
    setBusyId(invitationId);
    setFailure(null);
    // `revokeInvitation` resolves to the mapped failure instead of throwing, so a
    // refusal — including one the admin gate above thought it had prevented —
    // always ends up on screen.
    const error = await directory.revokeInvitation(invitationId);
    setBusyId(null);
    setFailure(error);
  };

  return (
    <Panel title="Pending invitations" count={settledCount(directory, invitations) ?? undefined}>
      <DirectoryBody
        directory={directory}
        list={invitations}
        loadingLabel="Loading invitations…"
        emptyLabel="No invitations are waiting to be accepted."
      >
        {(items) => (
          <List>
            {items.map((invitation) => (
              <Row
                key={invitation.id}
                title={invitation.emailAddress}
                meta={invitation.invitedAt ? `Invited ${formatRelative(invitation.invitedAt)}` : "Invited"}
                trailing={
                  <>
                    <Badge>{invitation.roleLabel}</Badge>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void revoke(invitation.id)}
                      disabled={busyId !== null}
                    >
                      {busyId === invitation.id ? "Revoking…" : "Revoke"}
                    </button>
                  </>
                }
              />
            ))}
          </List>
        )}
      </DirectoryBody>
      {failure ? (
        <p className="organization-directory__failure" role="alert">
          {failure.message}
        </p>
      ) : null}
      <DirectoryPager list={invitations} noun="invitations" />
    </Panel>
  );
}

/* ------------------------------------------------------------------- invite --- */

interface InviteMessage {
  readonly tone: "ok" | "bad";
  readonly text: string;
  readonly field: "emailAddress" | null;
}

function InvitePanel({
  directory,
  canManage
}: {
  directory: AppOrganizationDirectory;
  canManage: boolean;
}) {
  return (
    <Panel title="Invite a member">
      {directory.status === "unavailable" ? (
        <p className="organization-directory__failure" role="alert">
          {directory.error?.message ?? "This workspace's directory is unavailable, so invitations cannot be sent."}
        </p>
      ) : !canManage ? (
        <p className="tenant-gate-note organization-directory__gate">Managed by org admins.</p>
      ) : (
        <InviteForm directory={directory} />
      )}
    </Panel>
  );
}

function InviteForm({ directory }: { directory: AppOrganizationDirectory }) {
  const emailId = useId();
  const roleId = useId();
  const hintId = useId();
  const messageId = useId();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AppOrganizationRole>("org:member");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<InviteMessage | null>(null);

  const pending = directory.status !== "ready";
  const disabled = pending || submitting;
  const fieldInvalid = message?.tone === "bad" && message.field === "emailAddress";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    const emailAddress = email.trim();
    if (!emailAddress) {
      setMessage({ tone: "bad", text: "Enter an email address to invite.", field: "emailAddress" });
      return;
    }
    setSubmitting(true);
    setMessage({ tone: "ok", text: `Sending an invitation to ${emailAddress}…`, field: null });
    // `invite` resolves to the mapped failure rather than throwing: Clerk enforces
    // membership permissions server-side, so a refusal can arrive even though the
    // admin gate rendered this form, and it is shown rather than assumed away.
    const failure = await directory.invite({ emailAddress, role });
    setSubmitting(false);
    if (failure) {
      setMessage({ tone: "bad", text: failure.message, field: failure.field });
      return;
    }
    setEmail("");
    setMessage({ tone: "ok", text: `Invitation sent to ${emailAddress}.`, field: null });
    directory.invitations.fetchPage(1);
  };

  const describedBy = fieldInvalid ? `${hintId} ${messageId}` : hintId;

  return (
    <form className="organization-invite" onSubmit={(event) => void submit(event)} noValidate>
      <div className="form-field">
        <label className="form-field__label" htmlFor={emailId}>
          Email address
        </label>
        <input
          id={emailId}
          className="input"
          type="email"
          autoComplete="email"
          placeholder="teammate@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={fieldInvalid}
        />
      </div>
      <div className="form-field">
        <label className="form-field__label" htmlFor={roleId}>
          Role
        </label>
        <select
          id={roleId}
          className="select"
          value={role}
          disabled={disabled}
          onChange={(event) => {
            const next = APP_ORGANIZATION_ROLES.find((option) => option.value === event.target.value);
            if (next) setRole(next.value);
          }}
        >
          {APP_ORGANIZATION_ROLES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn btn--primary organization-invite__submit" disabled={disabled}>
        {submitting ? "Sending…" : "Send invitation"}
      </button>
      <div className="organization-invite__foot">
        <p id={hintId} className="organization-invite__hint">
          {pending
            ? "Loading this workspace's directory…"
            : "Admins can configure shared settings; members get read-only access to them."}
        </p>
        {/* Always mounted, and never `display: none`, so the announcement fires on the
            first submit rather than on the one after it. */}
        <p
          id={messageId}
          className={`organization-invite__message${
            message?.tone === "bad" ? " organization-invite__message--bad" : ""
          }`}
          role="status"
          aria-live="polite"
        >
          {message?.text ?? ""}
        </p>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------ list plumbing --- */

/**
 * The answers a directory read can give, kept apart on purpose: the workspace's
 * directory itself is still resolving, it could not be resolved, the page is still
 * loading, the page failed, or the page genuinely holds nothing. An empty list is
 * drawn only in that last case — a failure is never dressed up as "none".
 */
function DirectoryBody<T>({
  directory,
  list,
  loadingLabel,
  emptyLabel,
  children
}: {
  directory: AppOrganizationDirectory;
  list: AppOrganizationList<T>;
  loadingLabel: string;
  emptyLabel: string;
  children: (items: readonly T[]) => ReactNode;
}) {
  if (directory.status === "loading" || list.loading) {
    return (
      <EmptyState compact role="status">
        {loadingLabel}
      </EmptyState>
    );
  }
  const failure = directory.status === "unavailable" ? directory.error : list.error;
  if (directory.status === "unavailable" || failure) {
    return (
      <div className="organization-directory__error" role="alert">
        <p>{failure?.message ?? "This workspace's directory could not be read."}</p>
        <button type="button" className="btn btn--sm" onClick={directory.refresh}>
          Try again
        </button>
      </div>
    );
  }
  if (list.items.length === 0) {
    return (
      <EmptyState compact>
        {list.page > 1 ? `Nothing on this page — ${list.total} in total.` : emptyLabel}
      </EmptyState>
    );
  }
  return <>{children(list.items)}</>;
}

/** Bounded list affordance: which slice is on screen, and how to reach the rest. */
function DirectoryPager<T>({ list, noun }: { list: AppOrganizationList<T>; noun: string }) {
  // Kept on screen while the viewer is past page one even if the list has since
  // shrunk to a single page, so a page that emptied under them is not a dead end.
  if (list.loading || list.error || (list.pageCount <= 1 && list.page <= 1)) return null;
  const first = (list.page - 1) * list.pageSize + 1;
  const last = first + list.items.length - 1;
  return (
    <div className="organization-pager">
      <span className="organization-pager__count">
        {list.items.length > 0
          ? `Showing ${first}–${last} of ${list.total} ${noun}`
          : `${list.total} ${noun} in total`}
      </span>
      <div className="organization-pager__controls">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => list.fetchPage(list.page - 1)}
          disabled={list.page <= 1}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => list.fetchPage(list.page + 1)}
          disabled={list.page >= list.pageCount}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function AccessIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 19c.5-3.3 2.7-5 6.5-5s6 1.7 6.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
