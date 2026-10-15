# Chrome Web Store listing — Umia

Canonical copy and dashboard answers for the Chrome Web Store submission. Keep in sync with
`public/manifest.json`.

- **Store item ID:** `ejcaahfcaaiblipldkfijdcbannidbdd`
- **Live listing:** https://chromewebstore.google.com/detail/umia/ejcaahfcaaiblipldkfijdcbannidbdd
- **Published name:** `Umia` · offered by **umiafinance** · developer email **hello@umia.finance**
- **Live state (2026-06):** version 0.2.0, updated 2026-04-10, 4 users, no ratings.

## Identity

- **Name (manifest `name`):** keep `Umia`. This is the live store title. Do not rename on
  re-submit — a rename changes the title/slug and draws extra review.
- **Homepage:** https://umia.finance
- **Privacy policy URL:** https://umia.finance/privacy-policy (must cover the extension's data
  practices — see `PRIVACY.md`).
- **Category:** match the current listing.

## Why the warnings appear (context for whoever publishes)

- **"Not trusted by Enhanced Safe Browsing"** is a reputation/time signal. With 4 users, no
  ratings, and an item only a couple of months old, trust has not accrued. It is not fixable
  from the manifest; it clears as installs/reputation grow and the developer stays compliant.
  Verifying the publisher domain accelerates it. Reducing install-time host scope also drops
  the "Read and change your data" warning, the harshest trust signal Chrome shows on the
  install prompt.
- **The "Read and change your data" install warning** came from the host list in
  `host_permissions`. Version 0.3.0 moved the four provider sites (`*.x.com`, `*.github.com`,
  `*.google.com`, `*.uber.com`) to `optional_host_permissions`, leaving only the Umia webapp at
  install; version 0.3.1 removes `host_permissions` and the static `content_scripts` **entirely**
  — the Umia webapp is now optional too, granted at runtime via the Hub's "Enable" button, with a
  small `externally_connectable` channel so the Hub can still detect/enable the extension. With no
  host granted at install, the prompt shows **no** "Read and change your data" line. See the
  runtime permission flow in `README.md`.
- **"Requires new permissions" auto-disable** came from Chrome re-evaluating the broad
  permission set the live 0.2.0 build requested (`<all_urls>` + `cookies`). Each subsequent
  release has only *reduced* host scope (0.2.1: `<all_urls>` → explicit allowlist; 0.3.0:
  providers → optional; 0.3.1: `host_permissions` removed entirely, webapp → optional). A
  permission *reduction* does not force-disable or re-prompt installed users, and every host
  domain is now optional, so adding a future provider or webapp origin is not a forced re-grant
  either — users get the in-context prompt on first use.

## Short description (manifest `description`, ≤132 chars)

> Generate privacy-preserving zkTLS proofs to verify eligibility for Umia Tailored Auctions.

## Detailed description

> Umia lets you prove you meet a Tailored Auction's eligibility criteria — GitHub activity,
> token holdings, reputation scores, loyalty tiers, and more — without exposing your personal
> data or publicly linking your identity to your wallet. When you start a verification from the
> Umia Hub, the extension runs the zkTLS flow against the relevant provider in your own
> browser session and returns a proof bound to your wallet. You choose when and whether to
> generate a proof; it does not transmit raw provider session data and only sends the resulting proof to the Umia Hub/API.

## Permission justifications (Privacy practices tab)

One justification per requested permission. Each is required by the zkTLS SDK. No host
is granted at install — the Umia webapp and every provider site are optional and requested at
runtime; it is not `<all_urls>`.

- **Optional host permissions — Umia webapp (`*.umia.finance`, requested at runtime):** a
  content script runs on the Umia webapp to bridge the Hub and the extension (the SDK posts
  window messages the content script relays to the background). It is granted the first time the
  user enables the extension for the site — no host is granted at install.
- **Optional host permissions — provider sites (requested at runtime):**
  `optional_host_permissions` is a broad optional scope (`https://*/*`, plus `http://localhost/*`)
  so any zkTLS provider a Tailored Auction configures can be verified. The extension never
  requests the wildcard itself; it requests only the specific provider site a verification
  targets, in context, one site at a time, the first time that verification runs. The proof flow
  reads that site's authenticated session to build the zkTLS proof, so access is requested only
  when the user starts such a verification. Supporting a new provider needs no manifest change or
  re-publish.
- **`externally_connectable` (Umia webapp origins):** lets the Hub page message the background
  directly (`chrome.runtime.sendMessage`) to detect whether the extension is installed/enabled
  and to open the enable-grant window. It is a messaging allowlist, not a host permission, and
  shows no install warning.
- **`cookies`:** reads the provider's session cookies during a user-initiated verification so
  the zkTLS proof can attest to the authenticated session. Not used outside an active
  verification.
- **`scripting`:** injects the zkTLS network interceptor and verification UI into the
  provider page to capture the TLS response the proof is built from.
- **`offscreen`:** runs zk proof generation (WASM / snarkjs) in an offscreen document — the
  MV3-supported way to do heavy computation off the service worker.
- **`storage`:** stores SDK config and in-progress verification session state.

## Single-purpose statement

> The extension's single purpose is to generate zkTLS proofs for Umia Tailored Auction
> eligibility, initiated by the user from the Umia Hub.

## Data use disclosures

- The live listing currently states the developer "will not collect or use your data."
  Reconcile this with the host + `cookies` access: the extension *accesses* provider
  session data locally during a user-initiated verification but does not transmit or store it;
  only the resulting proof and fixed-event session telemetry are sent to the Umia Hub/API, and
  the TLS traffic for the proven request transits Umia's attestor. State this precisely so the
  disclosure is accurate and survives review (see `PRIVACY.md`).
- Not sold to third parties; not used for advertising or unrelated purposes; adheres to
  Google's Limited Use requirements.

## Pre-submit checklist

- [ ] `version` bumped and equal in `public/manifest.json` and `package.json`.
- [ ] `permissions` (API) unchanged from the live version. `host_permissions` is removed and
      there is no static `content_scripts`; the webapp and provider sites all live in
      `optional_host_permissions` — a reduction of install-time scope, so no forced disable for
      existing users.
- [ ] `optional_host_permissions` and every `web_accessible_resources[].matches` cover the
      provider scope (the `https://*/*` + `http://localhost/*` wildcard), so any provider an
      active auction configures verifies without a manifest change. The Umia webapp origins are
      listed in `externally_connectable.matches` (the one host list that is not a wildcard).
- [ ] `name` is `Umia` (store title and slug unchanged).
- [ ] Privacy practices tab filled from this file and `PRIVACY.md`, accurately reflecting the
      host/cookies access.
- [ ] Privacy policy URL reachable and covers extension data practices.
- [ ] **Publisher domain (umia.finance) verified** in Google Search Console; complete publisher
      verification (feeds Enhanced Safe Browsing trust).
- [ ] **Trader status declared** in the dashboard (EU DSA) — the listing currently shows "has
      not identified itself as a trader."
