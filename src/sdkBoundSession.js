export function initializeBoundSessionBackground(sdk, capabilityVersion, resolveSessionRoute) {
  if (capabilityVersion !== 1) {
    throw new Error("private SDK bound-session route contract is unavailable");
  }
  return sdk.initializeBackground({ resolveSessionRoute });
}
