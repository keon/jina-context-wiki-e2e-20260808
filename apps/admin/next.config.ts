import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // The shared theme and component package both ship as source rather than a
  // build artifact, so the two apps read the same tokens and render the same
  // primitives without a build-order dependency. `@jina/ui` also needs to be
  // transpiled for its co-located CSS Modules to be compiled and hashed.
  transpilePackages: ["@jina/theme", "@jina/ui"]
};

export default nextConfig;
