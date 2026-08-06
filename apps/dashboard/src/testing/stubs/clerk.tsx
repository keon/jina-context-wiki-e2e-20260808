import type { ReactNode } from "react";

/**
 * Stands in for `@clerk/nextjs`. The real package needs a publishable key and a
 * network round trip before any of its hooks resolve, so a component tree that
 * merely sits underneath the auth boundary could not be rendered at all. The
 * double reports a loaded, signed-out session; tests that need a signed-in one
 * call `setClerkUser`.
 */

interface StubUser {
  readonly id: string;
  readonly fullName: string | null;
  readonly username: string | null;
  readonly imageUrl: string;
  readonly primaryEmailAddress: { readonly emailAddress: string } | null;
  readonly emailAddresses: readonly { readonly emailAddress: string }[];
}

let user: StubUser | null = null;

export function setClerkUser(next: StubUser | null): void {
  user = next;
}

export function ClerkProvider({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}

export function SignIn() {
  return <div data-testid="clerk-sign-in" />;
}

export function useAuth() {
  return { isLoaded: true, isSignedIn: user !== null, userId: user?.id ?? null };
}

export function useUser() {
  return { isLoaded: true, isSignedIn: user !== null, user };
}

export function useClerk() {
  return {
    openUserProfile: () => undefined,
    signOut: () => Promise.resolve(),
    getOrganization: () => Promise.resolve(null)
  };
}
