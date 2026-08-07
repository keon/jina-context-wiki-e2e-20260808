import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AppAuthProvider } from "../../components/auth/app-auth";
import { setClerkOrganization, setClerkUser } from "../../testing/stubs/clerk";
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
  setClerkOrganization(null);
  resetProviderStubs();
  setRoute("/");
});

test("a new user starts with organization setup and cannot choose a personal workspace", async () => {
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
    tenants: [{ tenant_id: "tenant-acme", login: "Acme", type: "Organization", role: "admin", clerk_organization_id: "org_acme" }],
    selected: { tenantId: "tenant-acme", login: "Acme", type: "Organization", role: "admin", clerkOrganizationId: "org_acme" },
  });

  render(<AppAuthProvider><OnboardingPage /></AppAuthProvider>);

  await screen.findByRole("heading", { name: "Choose your organization" });
  assert.equal(screen.queryByRole("button", { name: /Personal/ }), null);
  assert.match(screen.getByText("1 / 7").textContent ?? "", /1 \/ 7/);
  fireEvent.click(screen.getByRole("button", { name: /Acme/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue →" }));
  await screen.findByRole("heading", { name: "What do you want Jina to help with first?" });
  assert.match(screen.getByText("2 / 7").textContent ?? "", /2 \/ 7/);
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

test("a newly active Clerk organization resumes mirror setup after a reload", async () => {
  setRoute("/onboarding");
  setClerkUser(signedInUser);
  setDashboardState({
    authLoading: false,
    viewer: {
      authenticated: true,
      auth: { mode: "clerk", enabled: true },
      organizations: [],
      teams: [],
      projects: [],
      user: { id: 42, login: "ada", name: "Ada" },
    },
  });
  setTenantState({ ready: true, tenants: [], selected: null });

  const view = render(<AppAuthProvider><OnboardingPage /></AppAuthProvider>);

  await screen.findByRole("heading", { name: "Choose your organization" });
  assert.equal(screen.getByLabelText<HTMLInputElement>("Organization name").value, "");
  setClerkOrganization({ id: "org_pending", name: "Pending Acme" });
  view.rerender(<AppAuthProvider><OnboardingPage /></AppAuthProvider>);
  await waitFor(() =>
    assert.equal(screen.getByLabelText<HTMLInputElement>("Organization name").value, "Pending Acme"),
  );
  assert.ok(screen.getByRole("button", { name: "Retry workspace sync →" }));
});
