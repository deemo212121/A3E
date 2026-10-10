const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/** Reuses a well-formed upstream request id, or generates a new one. */
export function resolveRequestId(headerValue: string | null | undefined): string {
  if (headerValue && REQUEST_ID_PATTERN.test(headerValue)) return headerValue;
  return crypto.randomUUID();
}
