export function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
    return `https://${url.hostname}:${url.port || "443"}`;
  } catch {
    return null;
  }
}

export function senderOrigin(sender) {
  if (sender?.frameId !== 0) return null;
  const origin = normalizeOrigin(sender.origin ?? sender.url);
  if (!origin || (sender.origin && sender.url && normalizeOrigin(sender.url) !== origin))
    return null;
  return new URL(sender.origin ?? sender.url).origin;
}

export function isAllowedExternalCaller(sender, allowedOrigins) {
  const origin = senderOrigin(sender);
  return (
    origin != null &&
    [...allowedOrigins].some((allowed) => normalizeOrigin(allowed) === normalizeOrigin(origin))
  );
}

export function exactExternalCallerPattern(sender, allowedOrigins) {
  if (!isAllowedExternalCaller(sender, allowedOrigins)) return null;
  return `${normalizeOrigin(senderOrigin(sender))}/*`;
}
