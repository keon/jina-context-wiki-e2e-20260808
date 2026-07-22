import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { createGitHubInstallationAccessToken } from "./github-app.js";

test("mints a GitHub App installation token with a verifiable short-lived JWT", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let authorization = "";
  const access = await createGitHubInstallationAccessToken(42, {
    env: {
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_API_URL: "https://github.example/api"
    },
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://github.example/api/app/installations/42/access_tokens");
      assert.equal(init?.method, "POST");
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        token: "installation-token",
        expires_at: "2026-07-22T23:00:00Z",
        permissions: { contents: "read", pull_requests: "read" }
      });
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
    permissions: { contents: "read", pull_requests: "read" }
  });
});

test("fails closed when the installation token response has no credential", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(
    createGitHubInstallationAccessToken(42, {
      env: {
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
      },
      fetchImpl: async () => Response.json({ expires_at: "2026-07-22T23:00:00Z" })
    }),
    /did not include a token/
  );
});
