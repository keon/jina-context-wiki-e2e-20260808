"use client";

import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <SignIn routing="hash" fallbackRedirectUrl="/reviews" signUpFallbackRedirectUrl="/reviews" />
  );
}
