import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AppAuthProvider } from "../../components/auth/app-auth";
import { setClerkUser } from "../../testing/stubs/clerk";
import { resetProviderStubs, setDashboardState, setTenantState } from "../../testing/stubs/dashboard-providers";
import { setRoute } from "../../testing/stubs/next-navigation";
import OnboardingPage from "./page";

const signedInUser = {
  id: "user_1",
  fullName: "Ada Lovelace",
  username: "ada",
  imageUrl: "",
  primaryEmailAddress: { emailAddress: "ada@example.com" },
  emailAddresses: [{ emailAddress: "ada@example.com" }],
  unsafeMetadata: {},
  externalAccounts: [{ provider: "github" }],
  updateMetadata: () => Promise.resolve(),
  reload: () => Promise.resolve(),
};

afterEach(() => {
  cleanup();
  setClerkUser(null);
  resetProviderStubs();
  setRoute("/");
});

test("a new personal user advances from workspace choice to product intent", async () => {
  setRoute("/onboarding");
  setClerkUser(signedInUser);
  setDashboardState({
    authLoading: false,
    viewer: {
      auth: { mode: "clerk", enabled: true },
      authenticated: true,
      organizations: [],
      teams: [],
      projects: [],
      user: { id: 1, login: "ada" },
    },
  });
  setTenantState({
    ready: true,
    tenants: [{ tenant_id: "tenant-personal", login: "ada", type: "User", role: "admin" }],
    selected: { tenantId: "tenant-personal", login: "ada", type: "User", role: "admin" },
  });

  render(<AppAuthProvider><OnboardingPage /></AppAuthProvider>);

  await screen.findByRole("heading", { name: "Who are you setting Jina up for?" });
  fireEvent.click(screen.getByRole("button", { name: /Personal/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue →" }));
  await screen.findByRole("heading", { name: "What do you want Jina to help with first?" });
  assert.match(screen.getByText("2 / 6").textContent ?? "", /2 \/ 6/);
});

test("a signed-in account without GitHub gets a recoverable preflight", async () => {
  setRoute("/onboarding");
  setClerkUser({ ...signedInUser, externalAccounts: [] });
  setDashboardState({
    authLoading: false,
    viewer: {
      auth: { mode: "clerk", enabled: true },
      authenticated: true,
      organizations: [],
      teams: [],
      projects: [],
      user: { id: 1, login: "ada" },
    },
  });

  render(<AppAuthProvider><OnboardingPage /></AppAuthProvider>);

  await waitFor(() => assert.ok(screen.getByRole("heading", { name: "Connect GitHub to Jina" })));
  assert.ok(screen.getByRole("button", { name: "Open account settings" }));
  assert.ok(screen.getByRole("button", { name: "Retry" }));
});
