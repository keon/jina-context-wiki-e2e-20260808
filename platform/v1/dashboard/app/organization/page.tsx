"use client";

import { OrganizationProfile, useOrganization } from "@clerk/nextjs";

export default function OrganizationPage() {
  const { organization, isLoaded } = useOrganization();

  if (!isLoaded) {
    return <div className="empty">Loading organization…</div>;
  }

  if (!organization) {
    return (
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Members & Access</span>
        </div>
        <div className="empty">
          Select or create an organization from the workspace switcher to manage members, invitations, roles, and access.
        </div>
      </section>
    );
  }

  return (
    <div className="clerk-organization-profile">
      <OrganizationProfile routing="hash" />
    </div>
  );
}
