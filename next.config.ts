import type { NextConfig } from "next";

/**
 * Baseline security headers. The nonce-based Content-Security-Policy is set
 * per request by the proxy (src/proxy.ts, src/lib/security/csp.ts).
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
  // Cache Components / Partial Prerendering are OFF: on Cloudflare Workers
  // (OpenNext 1.20) partially prerendered pages hang. Every page here is
  // per-user and rendered on demand anyway. Revisit when the adapter supports it.
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
