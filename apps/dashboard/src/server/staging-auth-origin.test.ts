import assert from "node:assert/strict";
import test from "node:test";
import { stagingDevelopmentAuthRedirect } from "./staging-auth-origin";

test("development Clerk sessions move from the custom staging host to Vercel", () => {
  const redirect = stagingDevelopmentAuthRedirect(
    new URL("https://app.staging.usejina.com/onboarding?step=github#connect"),
    "pk_test_example"
  );

  assert.equal(redirect?.toString(), "https://jina-staging-dashboard.vercel.app/onboarding?step=github#connect");
});

test("a production Clerk instance keeps the custom staging host", () => {
  assert.equal(
    stagingDevelopmentAuthRedirect(new URL("https://app.staging.usejina.com/reviews"), "pk_live_example"),
    null
  );
});

test("development keys do not redirect other hosts", () => {
  assert.equal(
    stagingDevelopmentAuthRedirect(new URL("https://jina-staging-dashboard.vercel.app/reviews"), "pk_test_example"),
    null
  );
});
