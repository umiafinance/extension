# Connected GitHub fixture

`maintainer-contributor.json` is one provider in the `github` namespace with two requests in its
single `providerConfigs[0]`. It proves that one signed-in account is both:

1. **A contributor.** It authored at least one merged pull request in `umiafinance/umia`
   (pull-request search, also the login page).
2. **A maintainer.** It owns a public repository with at least 4 stars (repository search).

## What is revealed

Each request has one capture: the account id from the `octolytics-actor-id` meta tag, hashed with
`oprf-raw`. The counts are matched by pattern, not captured. The search queries are fixed in the
URLs and therefore public.

## Invariants

- No single GitHub page shows both facts, so the statement needs two proofs. The verifier accepts
  the pair only when both carry the same pseudonym, so one account's repository and another
  account's pull requests never combine.
- Replaying the pull-request search also requests the repository search with the same cookies, so
  both proofs come from one signed-in page with no navigation.
- This is a sandbox fixture for the connected-request flow, not a gate recipe.
