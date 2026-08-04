"use client";

import {
  ClerkProvider,
  SignIn,
  UserButton,
  useAuth,
} from "@clerk/nextjs";
import type { ReactNode } from "react";

/**
 * Jina's authentication boundary.
 *
 * Product code imports this module instead of reaching into Clerk directly. That
 * keeps vendor routing, appearance, and session semantics in one replaceable
 * adapter while the visible application remains made from Jina components.
 */
export function AppAuthProvider({ children }: { readonly children: ReactNode }) {
  return <ClerkProvider>{children}</ClerkProvider>;
}

export function useAppAuth() {
  const { isLoaded, isSignedIn } = useAuth();
  return { ready: isLoaded, signedIn: Boolean(isSignedIn) };
}

export function AppSignIn() {
  return (
    <SignIn
      routing="hash"
      fallbackRedirectUrl="/reviews"
      signUpFallbackRedirectUrl="/reviews"
      appearance={{
        variables: {
          colorBackground: "#212121",
          colorForeground: "#dcdcdc",
          colorMutedForeground: "#8f8f8f",
          colorPrimary: "#ffffff",
          colorPrimaryForeground: "#131313",
          colorInput: "#191919",
          colorInputForeground: "#ffffff",
          colorBorder: "rgba(255, 255, 255, 0.12)",
          borderRadius: "8px",
        },
        elements: {
          rootBox: "auth-clerk-root",
          cardBox: "auth-clerk-box",
          card: "auth-clerk-card",
          header: "auth-clerk-header",
          footer: "auth-clerk-footer",
          socialButtonsBlockButton: "auth-clerk-social",
          formFieldInput: "auth-clerk-input",
          formButtonPrimary: "auth-clerk-primary",
        },
      }}
    />
  );
}

export function AppAccountButton() {
  return (
    <UserButton
      userProfileMode="modal"
      userProfileProps={{ additionalOAuthScopes: { github: ["read:org", "repo"] } }}
      appearance={{
        elements: {
          rootBox: "app-account-root",
          userButtonTrigger: "app-account-trigger",
          avatarBox: "app-account-avatar",
        },
      }}
    />
  );
}
