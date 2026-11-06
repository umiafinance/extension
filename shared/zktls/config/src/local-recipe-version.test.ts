import { describe, expect, it } from "vitest";
import {
  resolveZktlsRegistryPin,
  ZKTLS_LOCAL_RECIPE_VERSION,
  ZKTLS_UPSTREAM_RELEASE_VERSION,
  zktlsLocalRecipeRevision,
} from "./self-host";

describe("local recipe version grammar", () => {
  it("reads the revision of a derivation from the given Reclaim version", () => {
    expect(zktlsLocalRecipeRevision("1.2.0-umia.1", "1.2.0")).toBe(1);
    expect(zktlsLocalRecipeRevision("1.2.0-umia.999999", "1.2.0")).toBe(999_999);
  });

  it.each([
    ["1.2.0", "the exact pin itself"],
    ["1.2.0-umia.0", "revision zero"],
    ["1.2.0-umia.01", "a non-canonical revision"],
    ["1.2.0-umia.1000000", "a revision beyond the bound"],
    ["1.2.0-umia.1a", "trailing text"],
    ["1.2.1-umia.1", "another Reclaim version"],
    ["1.2.0-beta-umia.1", "a prerelease base"],
  ])("refuses %s (%s)", (version) => {
    expect(zktlsLocalRecipeRevision(version, "1.2.0")).toBeNull();
  });
});

it("derives only from the bases the release grammar admits", () => {
  const base = (pattern: RegExp) => pattern.source.replace(/^\^\(?|\)?(-umia.*)?\$$/g, "");
  expect(base(ZKTLS_LOCAL_RECIPE_VERSION)).toBe(base(ZKTLS_UPSTREAM_RELEASE_VERSION));
});

describe("resolveZktlsRegistryPin", () => {
  const pin = { id: "github", version: "1.2.0" };
  const row = (version: string, source: "reclaim" | "local" = "local", id = "github") => ({
    id,
    version,
    source,
  });

  it("runs the exact pin when it is saved", () => {
    expect(resolveZktlsRegistryPin([row("1.2.0-umia.3"), row("1.2.0", "reclaim")], pin)).toBe(
      "1.2.0",
    );
  });

  it("falls back to the newest local derivation of that pin", () => {
    expect(
      resolveZktlsRegistryPin(
        [row("1.2.0-umia.2"), row("1.2.0-umia.10"), row("1.2.0-umia.9")],
        pin,
      ),
    ).toBe("1.2.0-umia.10");
  });

  it.each([
    ["another base", [row("1.2.1-umia.1")]],
    ["another provider", [row("1.2.0-umia.1", "local", "google")]],
    ["a reclaim row shaped like a derivation", [row("1.2.0-umia.1", "reclaim")]],
    ["an empty registry", []],
  ])("resolves nothing from %s", (_, saved) => {
    expect(resolveZktlsRegistryPin(saved, pin)).toBeNull();
  });
});
