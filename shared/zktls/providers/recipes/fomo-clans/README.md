# fomo clan membership (connected)

Two providers in the `fomo` namespace, each with two requests in its single `providerConfigs[0]`:

| File | Proves that one signed-in fomo account |
| --- | --- |
| `clan-member.json` | is in the fomo umia test clan (`c970bdea-90bc-4e6a-b05f-73e9087daf35`), any role |
| `no-clan.json` | is in no clan (`clan: null`) |

fomo is a single-page app on `fomo.family`; its data comes from `prod-api.fomo.family` with a
session cookie.

## Requests

1. **Identity.** `GET /v2/users/current` returns the signed-in account and fails without the
   session. Its `responseObject.id` is the capture.
2. **Membership.** `GET /v2/users/<uuid>` returns the account's public profile with a `clan`
   object (`id`, `name`, `role`) or `clan: null`. The match pins the clan by ID; the name is display
   copy and does not affect eligibility.

## What is revealed

- Each request signs one capture, the account `responseObject.id`, hashed with `oprf-raw` as the
  `fomo_user` pseudonym.
- The profile URL is built from five secret parameters (`URL_PARAM_1_SECRET` to
  `URL_PARAM_5_SECRET`), one per hyphen-separated UUID group, so no part of the account ID appears
  in the signed claim. Only the hyphens are visible. The request uses `writeRedactionMode: "zk"`.
- The only other revealed span is the fixed clan ID (or `clan: null`).

## Invariants

- Request 2 alone proves nothing about the viewer. The verifier accepts the pair only when both
  captures are equal, which forces the profile to be the signed-in account's own.
- Changing the allowlisted clan requires a new recipe version; an unlisted clan ID or `clan: null`
  never satisfies `clan-member.json`.

## Request trigger

No fomo page requests `/v2/users/current`, so the recipe uses `providerRuntime.requestChain`. Once
per document in the provider tab, it polls `GET /v2/users/pin` (not proved) until it answers `200`,
then requests the account and its own profile. A pre-login attempt never queues a claim.
Destinations come from the recipe and must be in the session's signed host whitelist. Parameters
come from earlier JSON responses, must be secret-named, and may take a bounded slice of their
source value. Polling stops when the session authorization expires.
