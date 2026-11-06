// Only a fixed two-letter country code from the pinned recipe, or none, is accepted,
// so the user's IP is never sent to a geolocation lookup.
export function pinnedGeoLocation(value) {
  const geoLocation = value ?? "";
  if (geoLocation === "" || /^[A-Za-z]{2}$/.test(geoLocation)) return geoLocation;
  throw new Error("CONFIG_REJECTED");
}
