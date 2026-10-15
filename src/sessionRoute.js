import { senderOrigin } from "./callerOrigin.js";

function freezeCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopy));
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeCopy(item)])),
    );
  }
  return value;
}

export function createSessionRouteResolver({
  catalogue,
  resolveActivatedSessionRoute,
  now = Date.now,
}) {
  if (!catalogue || typeof resolveActivatedSessionRoute !== "function") {
    throw new Error("trusted activation catalogue and shared route resolver are required");
  }
  return async function resolveSessionRoute({ sender, sessionId, candidate }) {
    const callerOrigin = senderOrigin(sender);
    if (!callerOrigin || typeof sessionId !== "string" || !sessionId || sessionId.length > 256) {
      return null;
    }
    let record;
    try {
      record = resolveActivatedSessionRoute(catalogue, callerOrigin, candidate, new Date(now()));
    } catch {
      // Canonical route rejection must reach the SDK as a missing route, without exposing input.
      return null;
    }
    if (!record) return null;
    return freezeCopy({ profile: record.profile, authority: record.authority });
  };
}
