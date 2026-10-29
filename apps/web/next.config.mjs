/** @type {import('next').NextConfig} */
// The browser talks to the API through this web server ("/backend/..."), so phones and
// other PCs only need port 3000 and there is no cross-site request at all.
const apiInternal = process.env.API_INTERNAL_URL ?? "http://localhost:4100";

const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    // A sleeping beta API takes up to a minute or more to wake. The default 30 s proxy
    // limit answered every call in that window with a plain-text 500 "Internal Server
    // Error" (shown as "Could not load your stores" or "Unexpected token 'I'" on save).
    proxyTimeout: 120_000,
  },
  async rewrites() {
    return [{ source: "/backend/:path*", destination: `${apiInternal}/:path*` }];
  },
};

export default nextConfig;
