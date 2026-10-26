import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@horizons/shared"],
  async rewrites() {
    // 本地开发：把 /api 代理到 wrangler dev；生产由 Cloudflare Route 直达 api worker
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8787/api/:path*",
      },
    ];
  },
};

export default nextConfig;
