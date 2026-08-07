"use client";

import { AppSignIn } from "../../components/auth/app-auth.tsx";

export default function SignInPage() {
  return (
    <main className="auth-page">
      <header className="auth-page__header">
        <span className="auth-page__mark">J</span>
        <div>
          <h1>Sign in to Jina</h1>
          <p>Reviews, context, models, and operations in one workspace.</p>
        </div>
      </header>
      <AppSignIn />
    </main>
  );
}
