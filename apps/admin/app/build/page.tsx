import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "../../components/ui";
import { createGraphBuild } from "./actions";

export const metadata: Metadata = {
  title: "Build graph"
};

export default async function BuildGraphPage({
  searchParams
}: {
  readonly searchParams: Promise<{
    readonly tenant?: string;
    readonly repository?: string;
    readonly ref?: string;
    readonly installation?: string;
  }>;
}) {
  const defaults = await searchParams;
  return (
    <main>
      <PageHeader title="Build graph" description="Start one graph generation for a GitHub repository and ref." />
      <form action={createGraphBuild} className="build-form">
        <label>
          <span>Tenant ID</span>
          <input name="tenantId" defaultValue={defaults.tenant} required autoComplete="off" />
          <small>The original-Jina tenant UUID that owns this GitHub installation.</small>
        </label>
        <label>
          <span>Repository</span>
          <input
            name="repository"
            defaultValue={defaults.repository}
            required
            placeholder="owner/repository"
            autoComplete="off"
          />
        </label>
        <label>
          <span>Ref</span>
          <input name="ref" defaultValue={defaults.ref ?? "main"} required autoComplete="off" />
        </label>
        <label>
          <span>GitHub installation ID</span>
          <input
            name="githubInstallationId"
            defaultValue={defaults.installation}
            required
            inputMode="numeric"
            pattern="[0-9]+"
            autoComplete="off"
          />
          <small>The worker mints a short-lived installation token from this ID.</small>
        </label>
        <div className="form-actions">
          <Link href="/" className="secondary-button">
            Cancel
          </Link>
          <button type="submit" className="primary-button">
            Build graph
          </button>
        </div>
      </form>
    </main>
  );
}
