import assert from "node:assert/strict";
import { test } from "node:test";

import {
  githubInstallationUrl,
  normalizeGithubConnections,
  parseGithubInstallationCallback,
} from "./github-installation";

test("GitHub installation URL carries the selected writable Jina tenant", () => {
  assert.equal(
    githubInstallationUrl("https://github.com/apps/jina/installations/new?foo=bar", {
      tenantId: "tenant-123",
      login: "Acme",
      type: "Organization",
      role: "admin",
    }),
    "https://github.com/apps/jina/installations/new?foo=bar&state=tenant-123",
  );
  assert.equal(
    githubInstallationUrl(
      "https://github.com/apps/jina/installations/new",
      { tenantId: "tenant-123", login: "Acme", type: "Organization", role: "admin" },
      "onboarding",
    ),
    "https://github.com/apps/jina/installations/new?state=jina%3Av1%3Aonboarding%3Atenant-123",
  );
});

test("GitHub installation URL does not target a tenant a member cannot administer", () => {
  assert.equal(
    githubInstallationUrl("https://github.com/apps/jina/installations/new", {
      tenantId: "tenant-123",
      login: "Acme",
      type: "Organization",
      role: "member",
    }),
    "https://github.com/apps/jina/installations/new",
  );
});

test("GitHub setup callback parser requires an installation and tenant", () => {
  assert.deepEqual(
    parseGithubInstallationCallback("?installation_id=42&setup_action=install&state=tenant-123"),
    { installationId: 42, tenantId: "tenant-123" },
  );
  assert.equal(parseGithubInstallationCallback("?installation_id=nope&state=tenant-123"), undefined);
  assert.equal(parseGithubInstallationCallback("?installation_id=42"), undefined);
  assert.deepEqual(
    parseGithubInstallationCallback("?installation_id=42&state=jina%3Av1%3Aonboarding%3Atenant-123"),
    { installationId: 42, tenantId: "tenant-123", returnTo: "onboarding" },
  );
  assert.equal(
    parseGithubInstallationCallback("?installation_id=42&state=jina%3Av1%3Aonboarding%3A"),
    undefined,
  );
});

test("normalizeGithubConnections validates and maps the API projection", () => {
  assert.deepEqual(
    normalizeGithubConnections({
      installations: [
        {
          installation_id: 42,
          login: "acme",
          type: "Organization",
          repository_count: 3,
          status: "active",
        },
      ],
    }),
    [{
      installationId: 42,
      login: "acme",
      type: "Organization",
      repositoryCount: 3,
      status: "active",
    }],
  );
  assert.throws(() => normalizeGithubConnections({ installations: [{}] }), /Invalid GitHub installation/);
  assert.throws(() => normalizeGithubConnections([]), /Invalid GitHub installations response/);
});
