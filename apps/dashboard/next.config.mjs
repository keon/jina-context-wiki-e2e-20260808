import { fileURLToPath } from "node:url";

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // The repository lints with its own flat typescript-eslint config.
  eslint: { ignoreDuringBuilds: true }
};

export default nextConfig;
