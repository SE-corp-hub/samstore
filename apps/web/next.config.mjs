/** @type {import('next').NextConfig} */
// The browser talks to the API through this web server ("/backend/..."), so phones and
// other PCs only need port 3000 and there is no cross-site request at all.
const apiInternal = process.env.API_INTERNAL_URL ?? "http://localhost:4100";

const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    return [{ source: "/backend/:path*", destination: `${apiInternal}/:path*` }];
  },
};

export default nextConfig;
