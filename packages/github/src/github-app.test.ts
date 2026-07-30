import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { createGitHubInstallationAccessToken } from "./github-app.js";

test("mints a GitHub App installation token with a verifiable short-lived JWT", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let authorization = "";
  let requestBody: unknown;
  const access = await createGitHubInstallationAccessToken(42, {
    repository: "octocat/hello-world",
    env: {
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_API_URL: "https://github.example/api"
    },
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://github.example/api/app/installations/42/access_tokens");
      assert.equal(init?.method, "POST");
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        token: "installation-token",
        expires_at: "2026-07-22T23:00:00Z",
        repository_selection: "selected",
        permissions: {
          contents: "read",
          issues: "read",
          pull_requests: "read",
          metadata: "read"
        },
        repositories: [{ id: 1, full_name: "octocat/Hello-World" }]
      });
    }
  });

  assert.deepEqual(requestBody, {
    repositories: ["hello-world"],
    permissions: {
      contents: "read",
      issues: "read",
      pull_requests: "read",
      metadata: "read"
    }
  });
  const jwt = authorization.replace(/^Bearer /, "");
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header && payload && signature);
  const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, "base64url")), true);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    iss: string;
    iat: number;
    exp: number;
  };
  assert.equal(claims.iss, "12345");
  assert.equal(claims.exp - claims.iat, 600);
  assert.deepEqual(access, {
    token: "installation-token",
    expiresAt: "2026-07-22T23:00:00Z",
    permissions: {
      contents: "read",
      issues: "read",
      pull_requests: "read",
      metadata: "read"
    }
  });
});

test("fails closed when the installation token response has no credential", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(
    createGitHubInstallationAccessToken(42, {
      repository: "octocat/hello-world",
      env: {
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
      },
      fetchImpl: async () =>
        Response.json({
          expires_at: "2026-07-22T23:00:00Z",
          repository_selection: "selected",
          permissions: {
            contents: "read",
            issues: "read",
            pull_requests: "read",
            metadata: "read"
          },
          repositories: [{ id: 1, full_name: "octocat/hello-world" }]
        })
    }),
    /did not include a token/
  );
});

test("fails closed when GitHub returns broader permissions or a different repository", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
  await assert.rejects(
    createGitHubInstallationAccessToken(42, {
      repository: "octocat/hello-world",
      env,
      fetchImpl: async () =>
        Response.json({
          token: "installation-token",
          repository_selection: "selected",
          permissions: {
            contents: "write",
            issues: "read",
            pull_requests: "read",
            metadata: "read"
          },
          repositories: [{ id: 1, full_name: "octocat/hello-world" }]
        })
    }),
    /exact read-only permissions/
  );
  await assert.rejects(
    createGitHubInstallationAccessToken(42, {
      repository: "octocat/hello-world",
      env,
      fetchImpl: async () =>
        Response.json({
          token: "installation-token",
          repository_selection: "selected",
          permissions: {
            contents: "read",
            issues: "read",
            pull_requests: "read",
            metadata: "read"
          },
          repositories: [{ id: 2, full_name: "octocat/other" }]
        })
    }),
    /did not match/
  );
});
