import { fileURLToPath } from "node:url";

/**
 * Baseline response headers for an authenticated, multi-tenant dashboard.
 *
 * `frame-ancestors` is expressed as CSP rather than a script/style policy on
 * purpose: framing is the exposure that applies to every route here, while a
 * full script-src policy has to account for Next's inline bootstrap and Clerk's
 * injected frames, and is not safe to land without rendering the app against
 * it. Adding that is tracked separately.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" }
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  poweredByHeader: false,
  // The shared theme ships as source rather than a build artifact so both apps
  // read the same tokens without a build-order dependency.
  transpilePackages: ["@jina/theme"],
  headers: () => Promise.resolve([{ source: "/:path*", headers: securityHeaders }])
};

export default nextConfig;
