/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // /graph became /context when the page moved onto the context engine. Existing
  // links and bookmarks are permanently redirected rather than left to 404.
  async redirects() {
    return [{ source: "/graph", destination: "/context", permanent: true }];
  },
};

export default nextConfig;
