"use client";

import { useUser } from "@clerk/nextjs";
import type { OrganizationMembershipResource } from "@clerk/nextjs/types";
import { useEffect, useMemo, useState } from "react";
import { useTenant } from "../providers";

/**
 * Resolves Jina's selected tenant to the matching Clerk organization without
 * changing Clerk's active-organization session claim. Product data remains
 * scoped by TenantProvider while organization settings use Clerk resources.
 */
export function useSelectedClerkOrganization() {
  const { selected } = useTenant();
  const { user, isLoaded } = useUser();
  const [loadedLookup, setLoadedLookup] = useState<{
    organizationId: string;
    membership: OrganizationMembershipResource | null;
  } | null>(null);
  const clerkOrganizationId = selected?.clerkOrganizationId;
  const embeddedMembership = useMemo(
    () =>
      clerkOrganizationId
        ? (user?.organizationMemberships.find((candidate) => candidate.organization.id === clerkOrganizationId) ?? null)
        : null,
    [clerkOrganizationId, user?.organizationMemberships],
  );

  useEffect(() => {
    if (!isLoaded || !clerkOrganizationId || embeddedMembership || !user) return;
    let active = true;
    void user
      .getOrganizationMemberships({ pageSize: 100 })
      .then((response) => {
        if (!active) return;
        setLoadedLookup({
          organizationId: clerkOrganizationId,
          membership: response.data.find((candidate) => candidate.organization.id === clerkOrganizationId) ?? null,
        });
      })
      .catch(() => {
        if (active) setLoadedLookup({ organizationId: clerkOrganizationId, membership: null });
      });
    return () => {
      active = false;
    };
  }, [clerkOrganizationId, embeddedMembership, isLoaded, user]);

  const loadedMembership =
    loadedLookup && loadedLookup.organizationId === clerkOrganizationId ? loadedLookup.membership : null;
  const membership = embeddedMembership ?? loadedMembership;
  const lookupComplete =
    !clerkOrganizationId || !user || Boolean(embeddedMembership) || loadedLookup?.organizationId === clerkOrganizationId;

  return {
    isLoaded: isLoaded && lookupComplete,
    membership,
    organization: membership?.organization ?? null,
  };
}

export function clerkErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const errors = (error as { errors?: { longMessage?: string; message?: string }[] }).errors;
    const message = errors?.[0]?.longMessage ?? errors?.[0]?.message;
    if (message) return message;
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
