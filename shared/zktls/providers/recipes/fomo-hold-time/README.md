# FOMO average hold time

Two providers in the `fomo` namespace prove ownership of an account whose **average** hold time
exceeds a threshold. This is the profile's hold-time metric, not account age or the age of any
one position. No clan membership is required.

| Recipe | Predicate |
| --- | --- |
| `more-than-30-days.json` | `averageHoldTimeSeconds > 2592000` |
| `more-than-5-days.json` | `averageHoldTimeSeconds > 432000` |

Both use the `fomo_user:oprf-raw` account capture. Each has two required requests in one config:

1. `GET /v2/users/current` establishes the signed-in account UUID. Its response does not
   contain the hold-time metric, so a second request is needed.
2. `GET /v2/users/<uuid>` returns the same account UUID and its `averageHoldTimeSeconds` field.
   The second request alone cannot prove ownership: a signed-in session can read other users'
   profiles too. The verifier requires both OPRF account captures to agree.

## Privacy

The runtime waits for the `/v2/users/pin` sign-in check, then derives the profile URL from the
session response. All five hyphen-separated UUID segments are secret URL parameters, so no part
of the UUID is public. The segments are 8/4/4/4/12 characters, which keeps each hidden run within
the attestor's per-run limit. The profile request uses `writeRedactionMode: "zk"`.

Each claim's only extracted field is the OPRF-hashed `fomo_user`, so both claims have the same
identity shape. The threshold rule reveals the numeric average; it does not add that changing
value to the extracted identity.

## Matching

The numeric regex accepts decimal numbers strictly above the threshold, including fractional
seconds. Exactly thirty or five days, `null`, a missing field, strings and negative values do not
qualify. Scientific notation fails closed; the FOMO API serializes this metric as integer
seconds. The field name and numeric delimiter are included in both the response match and its
redaction, so partial numbers and escaped description text cannot satisfy the rule.

## Tests

The SDK tests cover strict boundaries, fractional seconds, digit boundaries, invalid values,
description spoofing, identity consistency, a different account's distinct subject, all five
secret URL slices and the absence of public URL fragments. They check the recipes against
response shapes; they are not a live proof.
