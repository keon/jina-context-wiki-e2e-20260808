"use client";

import { ClerkProvider, SignIn, useClerk, useAuth, useUser } from "@clerk/nextjs";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface DeveloperModeContextValue {
  ready: boolean;
  enabled: boolean;
  saving: boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
}

const DeveloperModeContext = createContext<DeveloperModeContextValue | null>(null);
const DEVELOPER_MODE_STORAGE_KEY = "jina.developer-mode";

/**
 * Jina's authentication boundary.
 *
 * Product code imports this module instead of reaching into Clerk directly. That
 * keeps vendor routing, appearance, and session semantics in one replaceable
 * adapter while the visible application remains made from Jina components.
 */
export function AppAuthProvider({ children }: { readonly children: ReactNode }) {
  return (
    <ClerkProvider>
      <DeveloperModeProvider>{children}</DeveloperModeProvider>
    </ClerkProvider>
  );
}

function DeveloperModeProvider({ children }: { readonly children: ReactNode }) {
  const { user, isLoaded } = useUser();
  const [localEnabled, setLocalEnabled] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user || typeof window === "undefined") return;
    setLocalEnabled(window.localStorage.getItem(DEVELOPER_MODE_STORAGE_KEY) === "true");
  }, [user]);

  const persistedEnabled = user ? user.unsafeMetadata.developerMode === true : localEnabled;

  useEffect(() => {
    setOptimisticEnabled(null);
  }, [persistedEnabled, user?.id]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      setOptimisticEnabled(enabled);
      setSaving(true);
      try {
        if (user) {
          await user.updateMetadata({ unsafeMetadata: { developerMode: enabled } });
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
    [user],
  );

  const value = useMemo<DeveloperModeContextValue>(
    () => ({
      ready: isLoaded,
      enabled: optimisticEnabled ?? persistedEnabled,
      saving,
      setEnabled,
    }),
    [isLoaded, optimisticEnabled, persistedEnabled, saving, setEnabled],
  );

  return <DeveloperModeContext.Provider value={value}>{children}</DeveloperModeContext.Provider>;
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

export function useAppAccount() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
  const displayName = user?.fullName ?? user?.username ?? email ?? "Account";

  return {
    ready: isLoaded,
    displayName,
    email,
    imageUrl: user?.imageUrl,
    signOut: () => signOut({ redirectUrl: "/signin" }),
  };
}

export function useDeveloperMode(): DeveloperModeContextValue {
  const context = useContext(DeveloperModeContext);
  if (!context) throw new Error("useDeveloperMode must be used within AppAuthProvider");
  return context;
}
