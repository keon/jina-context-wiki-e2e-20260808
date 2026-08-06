import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // The shared theme ships as source rather than a build artifact so both apps
  // read the same tokens without a build-order dependency.
  transpilePackages: ["@jina/theme"]
};

export default nextConfig;
