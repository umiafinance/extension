export function copyUmia(umia) {
  return umia == null ? null : structuredClone(umia);
}

export function freezeUmia(umia) {
  const copy = copyUmia(umia);
  if (!copy || typeof copy !== "object") return copy;
  if (Array.isArray(copy.attestorAuth?.data?.hostWhitelist)) {
    Object.freeze(copy.attestorAuth.data.hostWhitelist);
  }
  if (copy.attestorAuth?.data) Object.freeze(copy.attestorAuth.data);
  if (copy.attestorAuth) Object.freeze(copy.attestorAuth);
  if (copy.network) Object.freeze(copy.network);
  return Object.freeze(copy);
}

export function freezeSessionRoute(route) {
  const copy = structuredClone(route);
  Object.freeze(copy.network);
  return Object.freeze(copy);
}

// Destinations and network live only on the route; the bound umia keeps session credentials.
export function freezeBoundSession({ sessionId, umia, route }) {
  const { sessionToken, attestorAuth, expiresAt } = umia;
  return Object.freeze({
    sessionId,
    umia: freezeUmia({ sessionToken, attestorAuth, expiresAt }),
    route: freezeSessionRoute(route),
  });
}

export function verificationTemplate(request) {
  return {
    sessionId: request.sessionId,
    providerId: request.providerId,
    applicationId: request.applicationId,
    signature: request.signature,
    timestamp: request.timestamp,
    callbackUrl: request.callbackUrl || "",
    context: JSON.stringify(request.context || {}),
    parameters: structuredClone(request.parameters || {}),
    redirectUrl: request.redirectUrl || "",
    acceptAiProviders: !!request.acceptAiProviders,
    sdkVersion: request.sdkVersion,
    jsonProofResponse: !!request.jsonProofResponse,
    umia: copyUmia(request.umia),
  };
}

// `profiles` carries the background's approved endpoint profiles, so offscreen narrows its own copy.
export function takeOffscreenSession(messageData) {
  const { session, profiles, ...claim } = messageData ?? {};
  if (!session?.sessionId || !session?.umia || !session?.route) {
    throw new Error("Bound offscreen session is required");
  }
  const bound = freezeBoundSession(session);
  if (claim.client?.url !== bound.route.attestorUrl) {
    throw new Error("Offscreen attestor destination mismatch");
  }
  return {
    session: bound,
    profiles,
    // A caller cannot smuggle its own attestor authentication into the dial.
    claim: { ...claim, client: { url: bound.route.attestorUrl } },
  };
}
