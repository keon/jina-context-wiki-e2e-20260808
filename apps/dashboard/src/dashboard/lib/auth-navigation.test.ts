import assert from "node:assert/strict";
import test from "node:test";
import { clerkAuthRedirect } from "./auth-navigation";

test("Clerk alone controls sign-in navigation", () => {
  assert.equal(clerkAuthRedirect({ isLoaded: false, isSignedIn: false, isSigninPage: false }), null);
  assert.equal(clerkAuthRedirect({ isLoaded: true, isSignedIn: false, isSigninPage: false }), "/signin");
  assert.equal(clerkAuthRedirect({ isLoaded: true, isSignedIn: false, isSigninPage: true }), null);
  assert.equal(clerkAuthRedirect({ isLoaded: true, isSignedIn: true, isSigninPage: true }), "/reviews");
  assert.equal(clerkAuthRedirect({ isLoaded: true, isSignedIn: true, isSigninPage: false }), null);
});
