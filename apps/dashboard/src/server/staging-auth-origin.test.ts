import assert from "node:assert/strict";
import test from "node:test";
import {
  STAGING_CUSTOM_ORIGIN,
  STAGING_VERCEL_ORIGIN,
  requestHostname,
  stagingClerkAuthOptions
} from "./staging-auth-origin";

test("development Clerk treats the custom staging host as a satellite", () => {
  assert.deepEqual(stagingClerkAuthOptions("app.staging.usejina.com", "pk_test_example"), {
    allowedRedirectOrigins: [STAGING_CUSTOM_ORIGIN, STAGING_VERCEL_ORIGIN],
    isSatellite: true,
    domain: "app.staging.usejina.com",
    signInUrl: "https://jina-staging-dashboard.vercel.app/signin",
    signUpUrl: "https://jina-staging-dashboard.vercel.app/signin",
    satelliteAutoSync: true
  });
});

test("the Vercel primary accepts redirects back to the custom staging host", () => {
  assert.deepEqual(stagingClerkAuthOptions("jina-staging-dashboard.vercel.app", "pk_test_example"), {
    allowedRedirectOrigins: [STAGING_CUSTOM_ORIGIN, STAGING_VERCEL_ORIGIN]
  });
});

test("production Clerk does not need the development satellite configuration", () => {
  assert.equal(stagingClerkAuthOptions("app.staging.usejina.com", "pk_live_example"), null);
});

test("development keys do not alter local or unrecognized hosts", () => {
  assert.equal(stagingClerkAuthOptions("localhost", "pk_test_example"), null);
});

test("requestHostname prefers the first forwarded host and removes its port", () => {
  assert.equal(
    requestHostname("app.staging.usejina.com:443, internal.vercel.app", "internal.vercel.app"),
    "app.staging.usejina.com"
  );
  assert.equal(requestHostname(null, "LOCALHOST:3000"), "localhost");
});
