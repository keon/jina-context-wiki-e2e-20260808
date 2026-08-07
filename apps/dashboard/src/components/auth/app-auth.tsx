"use client";

import { ClerkProvider, SignIn, useClerk, useAuth, useUser } from "@clerk/nextjs";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";
import { themeTokens } from "@jina/theme/tokens";
import { apiUrl, loginUrl } from "../../dashboard/lib/api.ts";
import type { ViewerResponse } from "../../dashboard/lib/types.ts";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface DeveloperModeContextValue {
  ready: boolean;
  enabled: boolean;
  saving: boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
}

const DeveloperModeContext = createContext<DeveloperModeContextValue | null>(null);
const DEVELOPER_MODE_STORAGE_KEY = "jina.developer-mode";
const dashboardAuthMode = process.env.NEXT_PUBLIC_JINA_DASHBOARD_AUTH_MODE;
export const dashboardUsesGithubAuth = dashboardAuthMode === "github";
const dashboardUsesHybridAuth = dashboardAuthMode === "hybrid";

interface AppAuthContextValue {
  readonly ready: boolean;
  readonly signedIn: boolean;
  readonly account: {
    readonly displayName: string;
    readonly email?: string;
    readonly imageUrl?: string;
    readonly signOut: () => void | Promise<void>;
  };
}

const AppAuthContext = createContext<AppAuthContextValue | null>(null);

/**
 * Jina's authentication boundary.
 *
 * Product code imports this module instead of reaching into Clerk directly. That
 * keeps vendor routing, appearance, and session semantics in one replaceable
 * adapter while the visible application remains made from Jina components.
 */
export function AppAuthProvider({ children }: { readonly children: ReactNode }) {
  if (dashboardUsesGithubAuth) return <GithubAuthAdapter>{children}</GithubAuthAdapter>;
  return (
    <ClerkProvider>
      {dashboardUsesHybridAuth ? (
        <HybridAuthAdapter>{children}</HybridAuthAdapter>
      ) : (
        <ClerkAuthAdapter>{children}</ClerkAuthAdapter>
      )}
    </ClerkProvider>
  );
}

/**
 * Clerk is primary in hybrid mode, but a browser carrying an unexpired Jina
 * GitHub session remains signed in. This prevents a flag change from becoming
 * a fleet-wide logout while users link their Clerk accounts naturally.
 */
function HybridAuthAdapter({ children }: { readonly children: ReactNode }) {
  const { user, isLoaded } = useUser();
  const { isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const [legacyViewer, setLegacyViewer] = useState<ViewerResponse | null>(null);
  const [legacyReady, setLegacyReady] = useState(false);

  useEffect(() => {
    if (!isLoaded || isSignedIn) {
      setLegacyReady(isLoaded);
      if (isSignedIn) setLegacyViewer(null);
      return;
    }
    const controller = new AbortController();
    setLegacyReady(false);
    void fetch(apiUrl("/dashboard/me"), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => (response.ok ? ((await response.json()) as ViewerResponse) : null))
      .then((viewer) => {
        if (!controller.signal.aborted) setLegacyViewer(viewer);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setLegacyReady(true);
      });
    return () => controller.abort();
  }, [isLoaded, isSignedIn]);

  const clerkEmail = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
  const legacyUser = legacyViewer?.user;
  const auth = useMemo<AppAuthContextValue>(
    () => ({
      ready: isLoaded && (Boolean(isSignedIn) || legacyReady),
      signedIn: Boolean(isSignedIn) || legacyViewer?.authenticated === true,
      account: {
        displayName: isSignedIn
          ? (user?.fullName ?? user?.username ?? clerkEmail ?? "Account")
          : legacyUser?.name?.trim() || legacyUser?.login || "Account",
        ...(isSignedIn && clerkEmail
          ? { email: clerkEmail }
          : legacyUser?.login
            ? { email: `@${legacyUser.login}` }
            : {}),
        ...(isSignedIn && user?.imageUrl
          ? { imageUrl: user.imageUrl }
          : legacyUser?.avatar_url
            ? { imageUrl: legacyUser.avatar_url }
            : {}),
        signOut: async () => {
          await fetch(apiUrl("/auth/logout"), {
            method: "POST",
            credentials: "include"
          }).catch(() => undefined);
          if (isSignedIn) {
            await signOut({ redirectUrl: "/signin" });
          } else {
            window.location.assign("/signin");
          }
        }
      }
    }),
    [clerkEmail, isLoaded, isSignedIn, legacyReady, legacyUser, legacyViewer?.authenticated, signOut, user]
  );

  return (
    <AppAuthContext.Provider value={auth}>
      <DeveloperModeProvider
        ready={auth.ready}
        userEnabled={user?.unsafeMetadata.developerMode === true}
        {...(user
          ? {
              userKey: user.id,
              persistUser: (enabled: boolean) => user.updateMetadata({ unsafeMetadata: { developerMode: enabled } })
            }
          : {})}
      >
        {children}
      </DeveloperModeProvider>
    </AppAuthContext.Provider>
  );
}

function ClerkAuthAdapter({ children }: { readonly children: ReactNode }) {
  const { user, isLoaded } = useUser();
  const { isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
  const auth = useMemo<AppAuthContextValue>(
    () => ({
      ready: isLoaded,
      signedIn: Boolean(isSignedIn),
      account: {
        displayName: user?.fullName ?? user?.username ?? email ?? "Account",
        ...(email ? { email } : {}),
        ...(user?.imageUrl ? { imageUrl: user.imageUrl } : {}),
        signOut: () => signOut({ redirectUrl: "/signin" })
      }
    }),
    [email, isLoaded, isSignedIn, signOut, user?.fullName, user?.imageUrl, user?.username]
  );
  return (
    <AppAuthContext.Provider value={auth}>
      <DeveloperModeProvider
        ready={isLoaded}
        userEnabled={user?.unsafeMetadata.developerMode === true}
        {...(user
          ? {
              userKey: user.id,
              persistUser: (enabled: boolean) => user.updateMetadata({ unsafeMetadata: { developerMode: enabled } })
            }
          : {})}
      >
        {children}
      </DeveloperModeProvider>
    </AppAuthContext.Provider>
  );
}

function GithubAuthAdapter({ children }: { readonly children: ReactNode }) {
  const [viewer, setViewer] = useState<ViewerResponse | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(apiUrl("/dashboard/me"), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as ViewerResponse;
      })
      .then((next) => {
        if (!controller.signal.aborted) setViewer(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setReady(true);
      });
    return () => controller.abort();
  }, []);
  const auth = useMemo<AppAuthContextValue>(() => {
    const user = viewer?.user;
    return {
      ready,
      signedIn: viewer?.authenticated === true,
      account: {
        displayName: user?.name?.trim() || user?.login || "Account",
        ...(user?.login ? { email: `@${user.login}` } : {}),
        ...(user?.avatar_url ? { imageUrl: user.avatar_url } : {}),
        signOut: async () => {
          await fetch(apiUrl("/auth/logout"), {
            method: "POST",
            credentials: "include"
          }).catch(() => undefined);
          window.location.assign("/signin");
        }
      }
    };
  }, [ready, viewer]);
  return (
    <AppAuthContext.Provider value={auth}>
      <DeveloperModeProvider ready={ready}>{children}</DeveloperModeProvider>
    </AppAuthContext.Provider>
  );
}

function DeveloperModeProvider({
  children,
  ready,
  userKey,
  userEnabled = false,
  persistUser
}: {
  readonly children: ReactNode;
  readonly ready: boolean;
  readonly userKey?: string;
  readonly userEnabled?: boolean;
  readonly persistUser?: (enabled: boolean) => Promise<unknown>;
}) {
  const [localEnabled, setLocalEnabled] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (userKey || typeof window === "undefined") return;
    setLocalEnabled(window.localStorage.getItem(DEVELOPER_MODE_STORAGE_KEY) === "true");
  }, [userKey]);

  const persistedEnabled = userKey ? userEnabled : localEnabled;

  useEffect(() => {
    setOptimisticEnabled(null);
  }, [persistedEnabled, userKey]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      setOptimisticEnabled(enabled);
      setSaving(true);
      try {
        if (persistUser) {
          await persistUser(enabled);
        } else {
          window.localStorage.setItem(DEVELOPER_MODE_STORAGE_KEY, String(enabled));
          setLocalEnabled(enabled);
        }
      } catch (error) {
        setOptimisticEnabled(null);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [persistUser]
  );

  const value = useMemo<DeveloperModeContextValue>(
    () => ({
      ready,
      enabled: optimisticEnabled ?? persistedEnabled,
      saving,
      setEnabled
    }),
    [ready, optimisticEnabled, persistedEnabled, saving, setEnabled]
  );

  return <DeveloperModeContext.Provider value={value}>{children}</DeveloperModeContext.Provider>;
}

export function useAppAuth() {
  const context = useContext(AppAuthContext);
  if (!context) throw new Error("useAppAuth must be used within AppAuthProvider");
  return { ready: context.ready, signedIn: context.signedIn };
}

export function AppSignIn() {
  if (dashboardUsesGithubAuth) {
    return (
      <button className="btn btn--primary" type="button" onClick={() => window.location.assign(loginUrl())}>
        Continue with GitHub
      </button>
    );
  }
  return (
    <SignIn
      routing="hash"
      fallbackRedirectUrl="/reviews"
      signUpFallbackRedirectUrl="/reviews"
      appearance={{
        // Clerk derives hover and disabled shades from these, so it needs real
        // values rather than var() references it cannot compute against. They
        // come from the theme package so this stays one palette with the rest
        // of the app instead of a second one that drifts.
        variables: {
          colorBackground: themeTokens.surface,
          colorForeground: themeTokens.ink,
          colorMutedForeground: themeTokens.inkSubtle,
          colorPrimary: themeTokens.accent,
          colorPrimaryForeground: themeTokens.accentFg,
          colorInput: themeTokens.surfaceInset,
          colorInputForeground: themeTokens.inkStrong,
          colorBorder: themeTokens.line,
          borderRadius: themeTokens.radius
        },
        elements: {
          rootBox: "auth-clerk-root",
          cardBox: "auth-clerk-box",
          card: "auth-clerk-card",
          header: "auth-clerk-header",
          footer: "auth-clerk-footer",
          socialButtonsBlockButton: "auth-clerk-social",
          formFieldInput: "auth-clerk-input",
          formButtonPrimary: "auth-clerk-primary"
        }
      }}
    />
  );
}

export function useAppAccount() {
  const context = useContext(AppAuthContext);
  if (!context) throw new Error("useAppAccount must be used within AppAuthProvider");
  return {
    ready: context.ready,
    ...context.account
  };
}

export function useDeveloperMode(): DeveloperModeContextValue {
  const context = useContext(DeveloperModeContext);
  if (!context) throw new Error("useDeveloperMode must be used within AppAuthProvider");
  return context;
}

/* ------------------------------------------------------ organization access --- */

/**
 * Clerk's resource interfaces are not re-exported from `@clerk/nextjs`, and pulling
 * in `@clerk/types` would put the vendor's vocabulary into the app's dependency
 * list. Deriving the three shapes this adapter touches from the client keeps every
 * Clerk type inside this file, where the rest of the vendor coupling already lives.
 */
type ClerkOrganization = Awaited<ReturnType<ReturnType<typeof useClerk>["getOrganization"]>>;
type ClerkMembership = Awaited<ReturnType<ClerkOrganization["getMemberships"]>>["data"][number];
type ClerkInvitation = Awaited<ReturnType<ClerkOrganization["getInvitations"]>>["data"][number];

/** The roles a workspace can be invited into. These are Clerk's two default role keys. */
export const APP_ORGANIZATION_ROLES = [
  { value: "org:admin", label: "Admin" },
  { value: "org:member", label: "Member" }
] as const;

export type AppOrganizationRole = (typeof APP_ORGANIZATION_ROLES)[number]["value"];

/** How many members / invitations one page of the directory holds. */
const APP_ORGANIZATION_PAGE_SIZE = 10;

/**
 * The app's own failure vocabulary. Clerk's error codes stop here: callers branch on
 * `code` and render `message`, so no product code has to know what a Clerk error
 * looks like — and no failure can be flattened into "something went wrong".
 */
type AppAuthErrorCode =
  | "already_member"
  | "already_invited"
  | "email_invalid"
  | "email_missing"
  | "email_blocked"
  | "forbidden"
  | "seat_limit"
  | "organization_unavailable"
  | "unknown";

export interface AppAuthError {
  readonly code: AppAuthErrorCode;
  /** Copy that can be rendered as-is. Unmapped Clerk codes keep Clerk's own long message. */
  readonly message: string;
  /** Set when the failure belongs to one control, so a form can describe that input with it. */
  readonly field: "emailAddress" | null;
}

/**
 * Clerk error code -> Jina copy. Anything absent from this table still reaches the
 * user through Clerk's `longMessage` (see `describeAuthError`), so an unmapped code
 * degrades to a less specific real message rather than to silence.
 */
const CLERK_ERROR_COPY: Readonly<Record<string, AppAuthError>> = {
  already_a_member_in_organization: {
    code: "already_member",
    message: "That person is already a member of this workspace.",
    field: "emailAddress"
  },
  form_identifier_exists: {
    code: "already_member",
    message: "That email address already belongs to a member of this workspace.",
    field: "emailAddress"
  },
  duplicate_record: {
    code: "already_invited",
    message: "An invitation to that address is already pending. Revoke it before sending another.",
    field: "emailAddress"
  },
  organization_invitation_already_exists: {
    code: "already_invited",
    message: "An invitation to that address is already pending. Revoke it before sending another.",
    field: "emailAddress"
  },
  form_param_format_invalid: {
    code: "email_invalid",
    message: "That is not a valid email address.",
    field: "emailAddress"
  },
  form_param_type_invalid: {
    code: "email_invalid",
    message: "That is not a valid email address.",
    field: "emailAddress"
  },
  form_param_value_invalid: {
    code: "email_invalid",
    message: "That is not a valid email address.",
    field: "emailAddress"
  },
  form_param_nil: {
    code: "email_missing",
    message: "Enter an email address to invite.",
    field: "emailAddress"
  },
  form_email_address_blocked: {
    code: "email_blocked",
    message: "Sign-ups from that email address are blocked for this instance.",
    field: "emailAddress"
  },
  not_allowed_access: {
    code: "forbidden",
    message: "Your account is not allowed to change this workspace's membership.",
    field: null
  },
  authorization_invalid: {
    code: "forbidden",
    message: "Your account is not allowed to change this workspace's membership.",
    field: null
  },
  organization_minimum_permissions_needed: {
    code: "forbidden",
    message: "Only workspace admins can invite or remove members.",
    field: null
  },
  organization_membership_quota_exceeded: {
    code: "seat_limit",
    message: "This workspace has reached its member limit. Remove a member or raise the limit first.",
    field: null
  },
  insufficient_seats_contact_support: {
    code: "seat_limit",
    message: "This workspace has no seats left for another member.",
    field: null
  },
  insufficient_seats_change_plan: {
    code: "seat_limit",
    message: "This workspace has no seats left for another member. Changing plan adds more.",
    field: null
  },
  organization_not_found_or_unauthorized: {
    code: "organization_unavailable",
    message: "This workspace's directory is not readable with your account.",
    field: null
  },
  resource_not_found: {
    code: "organization_unavailable",
    message: "This workspace has no directory in Clerk.",
    field: null
  }
};

const ORGANIZATION_UNAVAILABLE: AppAuthError = {
  code: "organization_unavailable",
  message: "This workspace's directory is not loaded, so membership cannot be changed right now.",
  field: null
};

/** Clerk types `ClerkAPIError.meta` as `any`; read the one field we use safely. */
function clerkParamName(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const { paramName } = meta as { paramName?: unknown };
  return typeof paramName === "string" ? paramName : null;
}

/**
 * Translate any thrown value into the app's failure vocabulary. Clerk raises a
 * structured `ClerkAPIResponseError` carrying one or more `{ code, longMessage }`
 * entries; everything else (a network failure, a programming error) still arrives
 * here with its own message rather than being replaced by a generic one.
 */
function describeAuthError(cause: unknown): AppAuthError {
  if (isClerkAPIResponseError(cause)) {
    for (const apiError of cause.errors) {
      const mapped = CLERK_ERROR_COPY[apiError.code];
      if (mapped) return mapped;
    }
    const first = cause.errors[0];
    if (first) {
      return {
        code: "unknown",
        message: first.longMessage ?? first.message,
        field: clerkParamName(first.meta) === "email_address" ? "emailAddress" : null
      };
    }
    return { code: "unknown", message: cause.message, field: null };
  }
  if (cause instanceof Error) {
    return { code: "unknown", message: cause.message, field: null };
  }
  return { code: "unknown", message: "The membership directory returned an unexpected failure.", field: null };
}

interface AppOrganizationMember {
  readonly id: string;
  /** Display name, falling back to whatever identifier Clerk knows the person by. */
  readonly name: string;
  readonly identifier: string | null;
  readonly role: string;
  readonly roleLabel: string;
  /** ISO timestamp so the app formats dates with its own helpers; null when unknown. */
  readonly joinedAt: string | null;
}

interface AppOrganizationInvitation {
  readonly id: string;
  readonly emailAddress: string;
  readonly roleLabel: string;
  readonly invitedAt: string | null;
}

/**
 * One page of a directory list. `loading`, `error` and `items` are deliberately
 * independent: an empty `items` only means "none" when `loading` is false and
 * `error` is null, so a failed or pending read can never be drawn as an empty list.
 */
export interface AppOrganizationList<T> {
  readonly items: readonly T[];
  /** Total across every page, as counted by Clerk — the denominator for "showing N of M". */
  readonly total: number;
  readonly loading: boolean;
  readonly error: AppAuthError | null;
  readonly page: number;
  readonly pageCount: number;
  readonly pageSize: number;
  readonly fetchPage: (page: number) => void;
}

type AppOrganizationStatus = "loading" | "ready" | "unavailable";

export interface AppOrganizationDirectory {
  readonly status: AppOrganizationStatus;
  /** Why `status` is "unavailable", when the directory said why. */
  readonly error: AppAuthError | null;
  readonly name: string | null;
  readonly members: AppOrganizationList<AppOrganizationMember>;
  readonly invitations: AppOrganizationList<AppOrganizationInvitation>;
  /** Resolves to null on success, or to the mapped failure — it never throws. */
  readonly invite: (input: {
    readonly emailAddress: string;
    readonly role: AppOrganizationRole;
  }) => Promise<AppAuthError | null>;
  /** Resolves to null on success, or to the mapped failure — it never throws. */
  readonly revokeInvitation: (invitationId: string) => Promise<AppAuthError | null>;
  readonly refresh: () => void;
}

interface ClerkPage<T> {
  data: T[];
  total_count: number;
}

interface PageParams {
  initialPage: number;
  pageSize: number;
}

// Module scope keeps these referentially stable, so the read effects below fire on a
// genuine change of organization, page or reload token and not on every render.
const readMembers = (organization: ClerkOrganization, params: PageParams): Promise<ClerkPage<ClerkMembership>> =>
  organization.getMemberships(params);

const readInvitations = (organization: ClerkOrganization, params: PageParams): Promise<ClerkPage<ClerkInvitation>> =>
  organization.getInvitations({ ...params, status: ["pending"] });

function isoOrNull(value: Date | null | undefined): string | null {
  if (!value) return null;
  const time = value.getTime();
  return Number.isNaN(time) ? null : value.toISOString();
}

function organizationRoleLabel(role: string, roleName: string | undefined): string {
  const known = APP_ORGANIZATION_ROLES.find((option) => option.value === role);
  if (known) return known.label;
  const named = roleName?.trim();
  return named ? named : role;
}

function mapMember(membership: ClerkMembership): AppOrganizationMember {
  const user = membership.publicUserData;
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  const username = user?.username?.trim();
  const identifier = user?.identifier?.trim();
  return {
    id: membership.id,
    name: fullName || username || identifier || "Unnamed member",
    identifier: identifier ? identifier : null,
    role: membership.role,
    roleLabel: organizationRoleLabel(membership.role, membership.roleName),
    joinedAt: isoOrNull(membership.createdAt)
  };
}

function mapInvitation(invitation: ClerkInvitation): AppOrganizationInvitation {
  return {
    id: invitation.id,
    emailAddress: invitation.emailAddress,
    roleLabel: organizationRoleLabel(invitation.role, invitation.roleName),
    invitedAt: isoOrNull(invitation.createdAt)
  };
}

interface CollectionState<TResource, TItem> {
  items: readonly TItem[];
  resources: readonly TResource[];
  total: number;
  loading: boolean;
  error: AppAuthError | null;
}

/**
 * One paginated directory read. Every state transition replaces the whole tuple, so
 * `items` is never left over from a previous organization, page, or successful read
 * once a newer one is in flight or has failed.
 */
function useOrganizationCollection<TResource extends { id: string }, TItem>(
  organization: ClerkOrganization | null,
  enabled: boolean,
  pageSize: number,
  read: (organization: ClerkOrganization, params: PageParams) => Promise<ClerkPage<TResource>>,
  map: (resource: TResource) => TItem,
  reloadToken: number
): { list: AppOrganizationList<TItem>; resources: readonly TResource[] } {
  const organizationId = organization?.id ?? null;
  // The requested page is stored with the organization it was requested for, so a
  // workspace switch starts at page one without an extra render and refetch.
  const [pageRequest, setPageRequest] = useState<{ id: string | null; page: number }>({ id: null, page: 1 });
  const page = pageRequest.id === organizationId ? pageRequest.page : 1;
  const [state, setState] = useState<CollectionState<TResource, TItem>>({
    items: [],
    resources: [],
    total: 0,
    loading: true,
    error: null
  });

  useEffect(() => {
    if (!organization || !enabled) {
      setState({ items: [], resources: [], total: 0, loading: false, error: null });
      return;
    }
    let active = true;
    setState({ items: [], resources: [], total: 0, loading: true, error: null });
    read(organization, { initialPage: page, pageSize })
      .then((response) => {
        if (!active) return;
        setState({
          items: response.data.map(map),
          resources: response.data,
          total: response.total_count,
          loading: false,
          error: null
        });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        // A failed read is not an empty directory: `items` stays empty and `error`
        // carries the reason, so the caller can say which of the two happened.
        setState({ items: [], resources: [], total: 0, loading: false, error: describeAuthError(cause) });
      });
    return () => {
      active = false;
    };
  }, [organization, enabled, page, pageSize, read, map, reloadToken]);

  const fetchPage = useCallback(
    (next: number) => setPageRequest({ id: organizationId, page: Math.max(1, next) }),
    [organizationId]
  );

  const { items, total, loading, error, resources } = state;
  const list = useMemo<AppOrganizationList<TItem>>(
    () => ({
      items,
      total,
      loading,
      error,
      page,
      pageCount: total > 0 ? Math.ceil(total / pageSize) : 0,
      pageSize,
      fetchPage
    }),
    [items, total, loading, error, page, pageSize, fetchPage]
  );

  return { list, resources };
}

type Resolution =
  | { id: string; organization: ClerkOrganization; error: null }
  | { id: string; organization: null; error: AppAuthError };

/**
 * The membership directory for one workspace.
 *
 * `organizationId` is the workspace's own Clerk organization id rather than whatever
 * organization the Clerk session happens to have active — the dashboard's workspace
 * switcher is Jina's, and reading the active organization instead would show one
 * workspace's members under another workspace's name.
 *
 * `withInvitations` is false for non-admins: reading pending invitations needs the
 * manage-members permission, so asking for them as a member would turn a normal
 * read-only view into a permission error.
 *
 * Clerk still enforces every permission server-side. The gates a caller puts on
 * these functions are a courtesy; a rejected write comes back as an `AppAuthError`.
 */
export function useAppOrganization({
  organizationId,
  withInvitations = false,
  pageSize = APP_ORGANIZATION_PAGE_SIZE
}: {
  readonly organizationId: string | null;
  readonly withInvitations?: boolean;
  readonly pageSize?: number;
}): AppOrganizationDirectory {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const [reload, setReload] = useState({ organization: 0, members: 0, invitations: 0 });
  const [resolution, setResolution] = useState<Resolution | null>(null);

  // Read the resolution through the id it was captured for: a workspace switch drops
  // the previous organization in the same render, never one render later.
  const current = resolution && resolution.id === organizationId ? resolution : null;
  const organization = current?.organization ?? null;
  const organizationError = current?.error ?? null;

  const reloadOrganization = reload.organization;
  useEffect(() => {
    if (!organizationId || !isLoaded) return;
    let active = true;
    clerk
      .getOrganization(organizationId)
      .then((resolved) => {
        if (!active) return;
        if (resolved.id !== organizationId) {
          // Never render one workspace's directory under another workspace's name.
          setResolution({ id: organizationId, organization: null, error: ORGANIZATION_UNAVAILABLE });
          return;
        }
        setResolution({ id: organizationId, organization: resolved, error: null });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setResolution({ id: organizationId, organization: null, error: describeAuthError(cause) });
      });
    return () => {
      active = false;
    };
  }, [clerk, isLoaded, organizationId, reloadOrganization]);

  const { list: members } = useOrganizationCollection(
    organization,
    true,
    pageSize,
    readMembers,
    mapMember,
    reload.members
  );
  const { list: invitations, resources: invitationResources } = useOrganizationCollection(
    organization,
    withInvitations,
    pageSize,
    readInvitations,
    mapInvitation,
    reload.invitations
  );

  const refresh = useCallback(
    () =>
      setReload((current_) => ({
        organization: current_.organization + 1,
        members: current_.members + 1,
        invitations: current_.invitations + 1
      })),
    []
  );
  const reloadInvitations = useCallback(
    () => setReload((current_) => ({ ...current_, invitations: current_.invitations + 1 })),
    []
  );

  const invite = useCallback(
    async ({
      emailAddress,
      role
    }: {
      readonly emailAddress: string;
      readonly role: AppOrganizationRole;
    }): Promise<AppAuthError | null> => {
      if (!organization) return ORGANIZATION_UNAVAILABLE;
      try {
        await organization.inviteMember({ emailAddress, role });
      } catch (cause) {
        return describeAuthError(cause);
      }
      reloadInvitations();
      return null;
    },
    [organization, reloadInvitations]
  );

  const revokeInvitation = useCallback(
    async (invitationId: string): Promise<AppAuthError | null> => {
      const invitation = invitationResources.find((candidate) => candidate.id === invitationId);
      if (!invitation) {
        return {
          code: "unknown",
          message: "That invitation is no longer listed. Reload the invitations to see the current ones.",
          field: null
        };
      }
      try {
        await invitation.revoke();
      } catch (cause) {
        return describeAuthError(cause);
      }
      reloadInvitations();
      return null;
    },
    [invitationResources, reloadInvitations]
  );

  const status: AppOrganizationStatus = !organizationId
    ? "unavailable"
    : organization
      ? "ready"
      : organizationError
        ? "unavailable"
        : "loading";

  return {
    status,
    error: organizationError,
    name: organization?.name ?? null,
    members,
    invitations,
    invite,
    revokeInvitation,
    refresh
  };
}
