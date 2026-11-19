# GitHub contributor, reviewer and maintainer recipes

GitHub providers in the `github` namespace. Each is one request to a GitHub
search page, made with the signed-in session:

| Kind | Files | Proves |
| --- | --- | --- |
| Contributor | `accepted-contributor.json`, `*-contributor.json` | at least 1 merged pull request authored by `@me` in the named repo or org, merged 2026-07-01 to 2026-09-30 |
| Reviewer | `reviewer.json`, `*-reviewer.json` | at least 5 pull requests reviewed by `@me` in the named repo or org, created in the same window |
| Outside contributor | `outside-contributor.json` | at least 5 pull requests authored by `@me`, merged into public repos not owned by `@me`, merged 2025-10-01 to 2026-09-30 |
| Maintainer (50+ stars) | `maintainer-50-stars-before-2026-09-30.json` | at least one public repository owned by `@me`, with 50 or more stars, created before September 30, 2026 |
| Maintainer (3+ stars) | `maintainer-3-stars-oprf-raw.json` | at least one public repository owned by `@me` with 3 or more stars; no creation-date restriction |

## What is revealed

- One capture: the signed-in account's numeric id from the `octolytics-actor-id` meta tag, hashed
  with `oprf-raw` as `github_actor_id`. The claim holds a pseudonym, not the id or username.
- The count is matched by pattern (`totalCount` or `result_count` above the threshold); the exact
  count is not captured.
- The search query is fixed in the URL, so it is public in the claim.

## Invariants

- Every recipe uses the same capture field and hash mode, so one GitHub account has one identity
  across all of them.
- `@me` resolves to the session's account, so the result can only describe the signed-in user.
- Each file is an independent, immutable provider with its own id; it requires only that the
  `github` namespace exists.

## 50-star creation cutoff

`maintainer-50-stars-before-2026-09-30.json` searches
`user:@me stars:>=50 is:public created:<2026-09-30` in one fixed, signed URL. One proof therefore
requires the **same repository** to satisfy ownership, star count and creation date. September 30
itself is excluded; this is a fixed cutoff, not a rolling 30-day age requirement. The account
capture and OPRF identity are the same as in the other recipes.

The star threshold is checked at verification time. The proof does not establish when the
repository earned its stars, when the current owner acquired it, or whether the stars are organic.
