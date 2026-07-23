import type { Metadata } from "next";
import { PageHeader, Status } from "../../components/ui";
import { parseAdminAllowlist } from "../../lib/admin-auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Access"
};

export default function AccessPage() {
  const allowlist = [...(parseAdminAllowlist(process.env.JINA_ADMIN_ALLOWED_EMAILS) ?? [])].sort();
  const webCredentialConfigured = Boolean(
    process.env.JINA_WEB_AUTH_USERNAME?.trim() && process.env.JINA_WEB_AUTH_PASSWORD?.trim()
  );
  const identities =
    allowlist.length > 0
      ? allowlist.map((email) => ({ identity: email, source: "Google IAP allowlist" }))
      : [{ identity: "Any IAP-authenticated identity", source: "Google IAP" }];
  if (webCredentialConfigured) {
    identities.push({ identity: "Configured web credential", source: "HTTP Basic authentication" });
  }

  return (
    <main>
      <PageHeader title="Access" description="People and identity boundaries that can operate the global Jina admin." />
      <section className="section-heading">
        <h2>Administrators</h2>
        <p>These identities can view every tenant, trigger graph builds, and inspect production health.</p>
      </section>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Identity</th>
              <th>Role</th>
              <th>Authentication</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {identities.map((entry) => (
              <tr key={`${entry.source}:${entry.identity}`}>
                <td>
                  <span className="identity">
                    <span className="identity-avatar">{initials(entry.identity)}</span>
                    {entry.identity}
                  </span>
                </td>
                <td>Administrator</td>
                <td className="muted">{entry.source}</td>
                <td>
                  <Status tone="success">Enabled</Status>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="access-boundary">
        <div>
          <h2>Global admin API credential</h2>
          <p>Dedicated read-only credential used for cross-tenant graph discovery and operational reporting.</p>
        </div>
        <Status tone={process.env.JINA_GLOBAL_ADMIN_TOKEN?.trim() ? "success" : "warning"}>
          {process.env.JINA_GLOBAL_ADMIN_TOKEN?.trim() ? "Configured" : "Not configured"}
        </Status>
      </section>
    </main>
  );
}

function initials(value: string): string {
  if (value.includes("@")) return value.slice(0, 2).toUpperCase();
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
