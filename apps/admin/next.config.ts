import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Linting runs through the repo-wide flat ESLint config (turbo lint), not
  // through next build.
  eslint: { ignoreDuringBuilds: true }
};

export default nextConfig;
