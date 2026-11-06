import assert from "node:assert/strict";
import { test } from "node:test";
import { getCookiesForUrl, shouldIncludeCookie } from "./cookieUtils.js";

const loggingHub = { info() {}, error() {} };
const cookie = (overrides = {}) => ({
  name: "session",
  value: "synthetic-secret",
  domain: "example.com",
  hostOnly: true,
  path: "/account",
  secure: true,
  httpOnly: true,
  ...overrides,
});

const scopeCases = [
  ["host-only cookie on its exact host", {}, "https://example.com/account", true],
  ["host-only cookie on a subdomain", {}, "https://api.example.com/account", false],
  [
    "domain cookie on its apex",
    { domain: ".example.com", hostOnly: false },
    "https://example.com/account",
    true,
  ],
  [
    "domain cookie on a subdomain",
    { domain: ".example.com", hostOnly: false },
    "https://api.example.com/account",
    true,
  ],
  [
    "domain cookie without a leading dot",
    { hostOnly: false },
    "https://api.example.com/account",
    true,
  ],
  [
    "domain suffix without a label boundary",
    { domain: ".example.com", hostOnly: false },
    "https://badexample.com/account",
    false,
  ],
  ["unrelated domain", { hostOnly: false }, "https://other.com/account", false],
  [
    "cookie domain as a hostname prefix",
    { hostOnly: false },
    "https://example.com.other.com/account",
    false,
  ],
  ["exact cookie path with a query", {}, "https://example.com/account?next=/other", true],
  ["child of the cookie path", {}, "https://example.com/account/settings", true],
  ["path prefix without a slash boundary", {}, "https://example.com/accounting", false],
  ["encoded slash is not a path boundary", {}, "https://example.com/account%2Fsettings", false],
  [
    "cookie path ending in a slash",
    { path: "/account/" },
    "https://example.com/account/settings",
    true,
  ],
  [
    "cookie path slash cannot be omitted",
    { path: "/account/" },
    "https://example.com/account",
    false,
  ],
  ["root cookie path", { path: "/" }, "https://example.com/other", true],
  ["secure cookie over HTTP", {}, "http://example.com/account", false],
  ["non-secure cookie over HTTP", { secure: false }, "http://example.com/account", true],
  ["expired cookie", { expirationDate: 1 }, "https://example.com/account", false],
];

for (const [name, overrides, url, expected] of scopeCases) {
  test(name, () => {
    assert.equal(shouldIncludeCookie(cookie(overrides), new URL(url), loggingHub), expected);
  });
}

test("broad cookie queries cannot serialize credentials outside the request's scope", async (t) => {
  const originalChrome = globalThis.chrome;
  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  });

  const cases = [
    ["https://api.example.com/account", cookie()],
    ["https://badexample.com/account", cookie({ domain: ".example.com", hostOnly: false })],
    ["https://example.com/accounting", cookie()],
  ];

  for (const [url, outOfScope] of cases) {
    const inScope = cookie({
      name: "allowed",
      domain: new URL(url).hostname,
      path: "/",
    });
    let returnedCookies = [outOfScope, inScope];
    // The collector queries parent domains all the way up to "com". Such a
    // query can return both cookies, even though only one matches the URL.
    globalThis.chrome = {
      cookies: {
        getAllCookieStores: async () => [{ id: "0" }],
        getAll: async (details) =>
          details.domain === "com" && !details.partitionKey ? returnedCookies : [],
      },
    };

    assert.equal(await getCookiesForUrl(url, loggingHub), "allowed=synthetic-secret", url);
    returnedCookies = [outOfScope];
    assert.equal(await getCookiesForUrl(url, loggingHub), null, url);
  }
});
