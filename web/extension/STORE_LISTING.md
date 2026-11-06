# Chrome Web Store listing

The store listing's answers for the Umia Extension. `bun run release-check` checks the
permission justifications below against `public/manifest.json`.

- **Store item ID:** `ejcaahfcaaiblipldkfijdcbannidbdd`
- **Listing:** https://chromewebstore.google.com/detail/umia/ejcaahfcaaiblipldkfijdcbannidbdd
- **Name:** `Umia`, offered by **umiafinance**, developer email **hello@umia.finance**
- **Homepage:** https://umia.finance
- **Privacy policy:** https://umia.finance/privacy-policy (extension practices: `PRIVACY.md`)

## Single-purpose statement

> The extension's single purpose is to generate zkTLS proofs for Umia auction eligibility,
> started by the user from the Umia app.

## Permission justifications (Privacy practices tab)

No host is granted at install, and the extension does not request `<all_urls>`.

- **Optional host permissions, Umia app and API (requested at runtime):** the Umia app origins
  and each one's API host. A content script on the Umia app relays the app's messages to the
  background, and the background calls the Umia API for the verification session. Both are
  requested together when the user enables the extension on the Umia app.
- **Optional host permissions, provider sites (requested at runtime):** the optional scope is
  `https://*/*` plus `http://localhost/*` so any provider an auction configures can be verified
  without a new release. The extension never requests the wildcard. When a verification starts
  it requests the one exact host that verification reads, and removes that access when the
  verification ends.
- **`externally_connectable` (Umia app origins):** lets the Umia app detect whether the
  extension is installed and enabled, open the enable window and pass its light or dark theme.
  It is a messaging allowlist, not a host permission.
- **`cookies`:** reads the provider's session cookies during a user-started verification so the
  proof can attest to the signed-in session. Not used outside an active verification.
- **`scripting`:** registers the content script on the sites the user granted, injects it into
  the open Umia app tab on grant, and runs the extension's fixed page re-request in the provider
  tab. Recipes cannot carry scripts.
- **`offscreen`:** runs zero-knowledge proof generation (Stwo or snarkjs WASM, in workers) in an
  offscreen document, the MV3 way to do heavy computation off the service worker.
- **`storage`:** stores the diagnostic log settings (off by default), the Umia app's theme
  choice, and when each provider site was granted, so the grant can be removed. No provider
  data, cookies or proofs are stored.

## Data use disclosures

- During a user-started verification the extension reads the provider session locally and does
  not store it. Only the resulting proof and session telemetry are sent to the Umia API, and the
  TLS traffic of the proven request is relayed by Umia's attestor in encrypted form.
- Not sold to third parties, not used for advertising or unrelated purposes, and handled
  according to Google's Limited Use requirements.
