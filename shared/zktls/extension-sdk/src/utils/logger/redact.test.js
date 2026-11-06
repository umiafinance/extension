/**
 * Log payloads are redacted so the session `signature` and the provider
 * `parameters` (the user's actual private data) never appear in a log line.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { redact } from "./redact.js";

describe("redact", () => {
  it("removes the session signature but records that it was present", () => {
    const out = redact({ sessionId: "s1", signature: "0xdeadbeef" });
    assert.equal(out.sessionId, "s1");
    assert.ok(!JSON.stringify(out).includes("0xdeadbeef"));
    assert.equal(out.signature, "<redacted:10 chars>");
  });

  it("keeps parameter names but drops parameter values", () => {
    const out = redact({ parameters: { accountNumber: "1234567890", email: "a@b.com" } });
    const json = JSON.stringify(out);
    assert.ok(!json.includes("1234567890"));
    assert.ok(!json.includes("a@b.com"));
    // Names are the diagnostic question ("did the script get the param?"),
    // values are the user's data.
    assert.ok(json.includes("accountNumber"));
    assert.ok(json.includes("email"));
  });

  it("matches sensitive keys case-insensitively and as substrings", () => {
    const out = redact({
      appSecret: "s",
      AUTHORIZATION: "Bearer x",
      apiKey: "k",
      cookieHeader: "a=b",
      nested: { privateKey: "p" },
    });
    const json = JSON.stringify(out);
    for (const leaked of ["Bearer x", "a=b"]) {
      assert.ok(!json.includes(leaked), `${leaked} leaked`);
    }
    assert.equal(out.nested.privateKey, "<redacted:1 chars>");
  });

  it("recurses into arrays and leaves innocuous data intact", () => {
    const out = redact({
      requestData: [
        { url: "https://x/y", method: "GET", signature: "sig" },
        { url: "https://x/z", method: "POST" },
      ],
    });
    assert.equal(out.requestData[0].url, "https://x/y");
    assert.equal(out.requestData[0].signature, "<redacted:3 chars>");
    assert.equal(out.requestData[1].method, "POST");
  });

  it("terminates on cyclic objects instead of blowing the stack", () => {
    const cyclic = { name: "a" };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => redact(cyclic));
    assert.ok(JSON.stringify(redact(cyclic)).includes("max-depth"));
  });

  it("passes primitives through untouched", () => {
    assert.equal(redact("plain"), "plain");
    assert.equal(redact(7), 7);
    assert.equal(redact(null), null);
  });
});

describe("response content", () => {
  it("drops raw page content but keeps its length", () => {
    // RedactionResolveError.element carries the region a failed selector was
    // looking at — the user's authenticated page. The console needs it, the
    // endpoint must not have it, and the length is what makes the log useful.
    const out = redact({ element: "<strong>private-account-name</strong>" });
    assert.equal(out.element, "<redacted:37 chars>");
  });

  it("leaves a provider-authored request body alone", () => {
    // params.body is provider config, not user data. Redacting it would remove
    // a genuinely useful diagnostic.
    const out = redact({ body: '{"query":"{{param}}"}' });
    assert.equal(out.body, '{"query":"{{param}}"}');
  });
});

describe("attestor-shaped values", () => {
  it("blanks claimData wholesale rather than walking into it", () => {
    // claimData.context holds extractedParameters — the plaintext value being
    // proven. Descending key-by-key would expose every field the attestor adds
    // later until someone remembered to list it, so the whole thing is opaque.
    const out = redact({
      identifier: "0xabc",
      claimData: {
        parameters: JSON.stringify({ paramValues: { username: "exampleuser" } }),
        context: JSON.stringify({ extractedParameters: { username: "exampleuser" } }),
      },
    });
    assert.equal(out.claimData, "[REDACTED]");
    assert.equal(out.identifier, "0xabc", "the identifier is not user data");
  });

  it("redacts user-data keys whose value is a STRING, not just an object", () => {
    // The attestor serialises these, so a string value must be redacted too.
    const out = redact({
      parameters: JSON.stringify({ paramValues: { username: "exampleuser" } }),
      publicData: "scraped-display-name",
      paramValues: { username: "exampleuser" },
    });
    assert.ok(!JSON.stringify(out).includes("exampleuser"));
    assert.ok(!JSON.stringify(out).includes("scraped-display-name"));
    assert.match(out.parameters, /^<redacted:\d+ chars>$/);
    assert.match(out.publicData, /^<redacted:\d+ chars>$/);
    assert.equal(out.paramValues, "<redacted keys: username>", "object form keeps its key names");
  });

  it("blanks a provider script's return value whatever it contains", () => {
    // A customInjection can return anything; no substring rule can anticipate
    // its keys, so the call site nests it under an opaque key.
    const out = redact({ injectionResult: { emailAddress: "user@example.com" } });
    assert.equal(out.injectionResult, "[REDACTED]");
  });
});
