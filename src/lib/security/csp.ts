/**
 * Content-Security-Policy with a per-request nonce (see
 * node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
 * Next.js reads the nonce from the request's CSP header and adds it to its
 * own scripts, so only scripts rendered by this app run.
 *
 * - The browser never talks to Supabase directly (no browser client), so
 *   connect-src stays 'self'.
 * - img-src allows data: for the authenticator QR code.
 * - style-src keeps 'unsafe-inline' for style attributes (no script risk).
 */
export function buildCsp(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/** A fresh, unguessable nonce (128 bits of randomness, base64). */
export function newNonce(): string {
  return btoa(crypto.randomUUID());
}
