/**
 * Session cookie hardening. The app never reads the Supabase session in the
 * browser (there is no browser Supabase client by design), so the session
 * cookies are HttpOnly: a script injected into a page cannot read them.
 * SameSite=Lax blocks cross-site form posts from carrying the session;
 * Secure keeps them off plain HTTP in production.
 */
export interface CookieOptionsLike {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: boolean | "lax" | "strict" | "none";
  [key: string]: unknown;
}

export function hardenSessionCookie<T extends CookieOptionsLike>(
  options: T | undefined,
  production = process.env.NODE_ENV === "production",
): T & { httpOnly: true; sameSite: "lax"; secure: boolean } {
  return {
    ...((options ?? {}) as T),
    httpOnly: true,
    sameSite: "lax",
    secure: production || options?.secure === true,
  };
}
