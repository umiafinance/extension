/**
 * Redaction for log payloads at the default level.
 *
 * Console logs can be read from the provider tab, where the user is logged in,
 * so two kinds of value must never appear there by default:
 *
 *  - credentials — `signature` authenticates the session-init request
 *  - user data — `parameters` holds whatever the provider script needs, which
 *    for a real provider is exactly the sensitive value being proven (account
 *    number, email, balance)
 *
 * Keys are matched case-insensitively on substrings, so `appSecret`,
 * `secretKey` and `SECRET` are all caught by one entry. The shape is preserved
 * — a redacted log still shows which fields were present, which is usually the
 * diagnostic question — and the value is replaced with a marker that records
 * enough to correlate without disclosing.
 */

const SENSITIVE_KEY_PATTERNS = [
  "signature",
  "secret",
  "password",
  "token",
  "cookie",
  "authorization",
  "privatekey",
  "apikey",
];

/**
 * Keys whose values are user data: keep the key names, drop the values.
 *
 * These are matched whatever the value's TYPE is. That matters because the
 * attestor hands several of them back as JSON *strings* rather than objects:
 * `claim.parameters` is a serialised blob holding `paramValues`.
 */
const USER_DATA_KEYS = ["parameters", "paramvalues", "publicdata", "witnessparameters"];

/**
 * Keys replaced wholesale, without descending into them.
 *
 * `claimData` is the attestor's claim: `parameters` (the substituted request,
 * including `paramValues`) and `context` (which carries `extractedParameters` —
 * the plaintext value the user is proving). There is nothing inside it worth
 * keeping at INFO, and walking it key-by-key means every future field the
 * attestor adds is exposed until someone remembers to list it here. The InApp
 * SDK blanks exactly this field in its own PROOF_GENERATED line.
 *
 * `rdObject` is the request descriptor a provider script hands to
 * `window.Reclaim.requestClaim()`. Like `injectionResult` it is provider-shaped
 * — it routinely carries the response the claim is being built from — so no
 * substring rule can anticipate its key names either.
 */
const OPAQUE_KEYS = ["claimdata", "context", "extractedparameters", "injectionresult", "rdobject"];

/**
 * Keys carrying raw response or page content as a STRING.
 *
 * `USER_DATA_KEYS` only covers object values, so a plain string of the user's
 * authenticated page would otherwise travel verbatim. The length is kept
 * because it is the actual diagnostic: it separates "the selector matched
 * nothing" from "it matched the wrong region". Deliberately narrow — bare
 * `body` is NOT here, because a claim's `params.body` is a provider-authored
 * request template, which is config worth reading, not user data.
 */
const RESPONSE_CONTENT_KEYS = ["element", "responsebody", "responsetext"];

function isSensitive(key) {
  const lower = String(key).toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isUserData(key) {
  return USER_DATA_KEYS.includes(String(key).toLowerCase());
}

function isOpaque(key) {
  return OPAQUE_KEYS.includes(String(key).toLowerCase());
}

function isResponseContent(key) {
  return RESPONSE_CONTENT_KEYS.includes(String(key).toLowerCase());
}

/**
 * Deep-copy `value` with sensitive fields replaced.
 *
 * @param {*} value
 * @param {number} [depth] - recursion guard for cyclic or pathological objects
 * @returns {*}
 */
export function redact(value, depth = 0) {
  return scrub(value, depth, false);
}

/**
 * Deep-copy `value` with only credentials replaced: what FINE prints. Cookies,
 * keys and tokens are never printed at any level.
 *
 * @param {*} value
 * @returns {*}
 */
export function redactCredentials(value) {
  return scrub(value, 0, true);
}

function scrub(value, depth, credentialsOnly) {
  if (depth > 8) return "<max-depth>";
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, depth + 1, credentialsOnly));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitive(key)) {
      out[key] = typeof val === "string" ? `<redacted:${val.length} chars>` : "<redacted>";
    } else if (credentialsOnly) {
      out[key] = scrub(val, depth + 1, credentialsOnly);
    } else if (isOpaque(key)) {
      out[key] = "[REDACTED]";
    } else if (isUserData(key)) {
      // Field names are safe and useful; the values are the user's data. An
      // object keeps its key names; a string (the attestor serialises several of
      // these) keeps only its length.
      out[key] =
        val && typeof val === "object"
          ? `<redacted keys: ${Object.keys(val).join(", ") || "none"}>`
          : typeof val === "string"
            ? `<redacted:${val.length} chars>`
            : "<redacted>";
    } else if (isResponseContent(key) && typeof val === "string") {
      out[key] = `<redacted:${val.length} chars>`;
    } else {
      out[key] = scrub(val, depth + 1, credentialsOnly);
    }
  }
  return out;
}
