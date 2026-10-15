import { normalizeOrigin } from "../src/callerOrigin.js";

export function manifestForProfiles(template, profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error("extension requires canonical caller profiles");
  }
  if (template.externally_connectable?.matches?.length !== 0) {
    throw new Error("extension template must not contain a caller trust union");
  }
  const names = new Set();
  const matches = new Set();
  for (const profile of profiles) {
    const origin = new URL(profile.callerOrigin);
    if (
      !profile.profile ||
      names.has(profile.profile) ||
      origin.protocol !== "https:" ||
      origin.origin !== profile.callerOrigin ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    ) {
      throw new Error("approved extension caller origin is not canonical HTTPS");
    }
    names.add(profile.profile);
    matches.add(`${normalizeOrigin(profile.callerOrigin)}/*`);
  }
  return {
    ...template,
    externally_connectable: { matches: [...matches].sort() },
  };
}
