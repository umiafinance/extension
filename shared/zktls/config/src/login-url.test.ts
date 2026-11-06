import { describe, expect, it } from "vitest";
import { isServableLoginUrl, isZktlsPathSegment } from "./login-url";
import { ZKTLS_LOGIN_URL_GOLDEN, ZKTLS_PATH_SEGMENT_GOLDEN } from "./login-url.golden";

describe("zkTLS login URL and path segment grammar", () => {
  it.each(ZKTLS_LOGIN_URL_GOLDEN)("login URL %j -> %s", (value, accepted) => {
    expect(isServableLoginUrl(value)).toBe(accepted);
  });

  it.each(ZKTLS_PATH_SEGMENT_GOLDEN)("path segment %j -> %s", (value, accepted) => {
    expect(isZktlsPathSegment(value)).toBe(accepted);
  });
});
