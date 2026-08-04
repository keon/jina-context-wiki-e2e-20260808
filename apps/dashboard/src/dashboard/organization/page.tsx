"use client";

import Link from "next/link";
import { useDashboard, useTenant } from "../providers";

export default function OrganizationPage() {
  const { viewer, authLoading } = useDashboard();
  const { selected, ready, tenants } = useTenant();

  if (!ready || authLoading) {
    return <><h1 className="sr-only">Members &amp; Access</h1><div className="page-placeholder page-placeholder--compact" role="status">Loading workspace access…</div></>;
  }

  if (!selected) {
    return (
      <div className="page-placeholder" role="status">
        <h1 className="sr-only">Members &amp; Access</h1>
        <span className="page-placeholder__icon" aria-hidden="true"><AccessIcon /></span>
        <strong>No workspace selected</strong>
        <p>Select a workspace from the sidebar to inspect its access boundary.</p>
      </div>
    );
  }

  return (
    <div className="organization-page">
      <h1 className="sr-only">Members &amp; Access</h1>
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Workspace</span>
          <span className="badge">{selected.type === "Organization" ? "Organization" : "Personal"}</span>
        </div>
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
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Access boundary</span>
        </div>
        <div className="organization-access">
          <span className="page-placeholder__icon" aria-hidden="true"><AccessIcon /></span>
          <div>
            <strong>{selected.type === "Organization" ? "Organization membership" : "Personal workspace"}</strong>
            <p>
              {selected.type === "Organization"
                ? "Jina follows the organization memberships attached to your signed-in account. Admins can configure shared integrations, models, and billing; members receive read-only access to protected settings."
                : "This workspace belongs to your account. Its integrations, models, usage, and billing stay separate from every organization workspace."}
            </p>
          </div>
          <Link className="btn btn--sm" href="/integrations">Manage integrations</Link>
        </div>
      </section>
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
