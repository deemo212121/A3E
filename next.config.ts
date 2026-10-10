import type { NextConfig } from "next";

/**
 * Baseline security headers. A nonce-based Content-Security-Policy is planned
 * for a later phase (it requires per-request rendering; see
 * node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Uploads go through Server Actions, one file per request. Files are capped
    // at 10 MB (src/lib/intake/files.ts); allow for multipart overhead. The
    // proxy buffers request bodies, so its limit must match.
    serverActions: { bodySizeLimit: "11mb" },
    proxyClientMaxBodySize: "11mb",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
