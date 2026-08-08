import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fireEvent } from "@testing-library/react";
import { AppAuthProvider } from "../components/auth/app-auth.tsx";
import { renderComponent } from "../testing/render.tsx";
import { clerkSignOutCallCount, resetClerkStub, setClerkUser } from "../testing/stubs/clerk.tsx";
import {
  reloadViewerCallCount,
  retryDiscoveryCallCount,
  setDashboardState,
  setTenantState,
} from "../testing/stubs/dashboard-providers.tsx";
import { WORKSPACE_SESSION_ERROR_MESSAGE } from "./lib/tenant-access-error.ts";
import { Shell } from "./shell.tsx";

afterEach(resetClerkStub);

test("an active Clerk sign-in plus an initial API 401 renders recovery instead of permanent loading", () => {
  setClerkUser({
    id: "user_test",
    fullName: "Test User",
    username: "test-user",
    imageUrl: "",
    primaryEmailAddress: { emailAddress: "test@example.com" },
    emailAddresses: [{ emailAddress: "test@example.com" }],
    unsafeMetadata: {},
    updateMetadata: async () => undefined,
  });
  setDashboardState({
    viewer: {
      auth: { mode: "clerk", enabled: true },
      authenticated: false,
      organizations: [],
      teams: [],
      projects: [],
    },
    authLoading: false,
    authRequired: true,
    sessionError: WORKSPACE_SESSION_ERROR_MESSAGE,
  });
  setTenantState({ accessError: null });

  const rendered = renderComponent(
    <AppAuthProvider>
      <Shell>
        <div>Permanent loading placeholder</div>
      </Shell>
    </AppAuthProvider>,
  );
  const content = rendered.container.textContent ?? "";

  assert.match(content, /We couldn’t load your workspaces/);
  assert.match(content, /Clerk sign-in is active/);
  assert.match(content, /Try again/);
  assert.match(content, /Sign out/);
  assert.doesNotMatch(content, /Permanent loading placeholder/);

  fireEvent.click(rendered.getByRole("button", { name: "Try again" }));
  assert.equal(reloadViewerCallCount(), 1);
  fireEvent.click(rendered.getByRole("button", { name: "Sign out" }));
  assert.equal(clerkSignOutCallCount(), 1);
});

test("a tenant discovery error retries workspace discovery rather than the viewer session", () => {
  setClerkUser({
    id: "user_test",
    fullName: "Test User",
    username: "test-user",
    imageUrl: "",
    primaryEmailAddress: { emailAddress: "test@example.com" },
    emailAddresses: [{ emailAddress: "test@example.com" }],
    unsafeMetadata: {},
    updateMetadata: async () => undefined,
  });
  setDashboardState({
    viewer: {
      auth: { mode: "clerk", enabled: true },
      authenticated: true,
      user: { id: 42, login: "test-user" },
      organizations: [],
      teams: [],
      projects: [],
    },
    authLoading: false,
    authRequired: false,
    sessionError: null,
  });
  setTenantState({
    accessError: "Jina could not load your workspaces right now.",
  });

  const rendered = renderComponent(
    <AppAuthProvider>
      <Shell>
        <div>Protected workspace content</div>
      </Shell>
    </AppAuthProvider>,
  );

  fireEvent.click(rendered.getByRole("button", { name: "Try again" }));
  assert.equal(retryDiscoveryCallCount(), 1);
  assert.equal(reloadViewerCallCount(), 0);
});
