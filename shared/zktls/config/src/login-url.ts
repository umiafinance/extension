/** One URL path segment, the only form the extension fetches a provider recipe or session by. */
export const ZKTLS_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,256}$/;

export function isZktlsPathSegment(value: unknown): value is string {
  return typeof value === "string" && ZKTLS_PATH_SEGMENT.test(value);
}

/**
 * The provider login URL the extension will open: absolute HTTPS exactly as written, with no
 * surrounding whitespace, userinfo, backslash or wildcard host. The publisher refuses any recipe
 * it would reject.
 */
export function isServableLoginUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://") || value.trim() !== value) {
    return false;
  }
  try {
    const url = new URL(value);
    return !value.includes("\\") && !url.username && !url.password && !url.hostname.includes("*");
  } catch {
    return false;
  }
}
