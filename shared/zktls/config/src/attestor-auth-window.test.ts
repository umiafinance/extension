import { describe, expect, it } from "vitest";
import { ZKTLS_ATTESTOR_MAX_AUTH_LIFETIME_S, zktlsAttestorAuthWindow } from "./self-host";

describe("attestor auth window", () => {
  const nowMs = Date.parse("2026-10-07T14:00:00.999Z");

  it("stays inside the attestor's maximum lifetime when every deadline is later", () => {
    const { createdAt, expiresAt } = zktlsAttestorAuthWindow(nowMs, [nowMs + 86_400_000]);
    expect(createdAt).toBe(Math.floor(nowMs / 1000));
    expect(expiresAt - createdAt).toBe(ZKTLS_ATTESTOR_MAX_AUTH_LIFETIME_S);
  });

  it("ends at the earliest deadline", () => {
    const early = nowMs + 61_500;
    expect(zktlsAttestorAuthWindow(nowMs, [nowMs + 600_000, early]).expiresAt).toBe(
      Math.floor(early / 1000),
    );
  });
});
