# Privacy & data handling — Umia extension

Canonical data-handling disclosure for the extension. It feeds the Chrome Web Store
"Privacy practices" tab and must be reflected at the published privacy policy URL
(https://umia.finance/privacy-policy). Confirm every statement is true for the current
build before publishing.

## What the extension can access

To generate zkTLS proofs, the extension uses host access scoped to specific domains plus
`cookies`, never `<all_urls>`. **No host is granted at install** — every domain is an optional
permission the user grants at runtime, in context:

- **The Umia webapp** (`*.umia.finance`, plus `*.umia.localhost` and `localhost` for local
  dev), where a verification is started. The user enables it once, from the Hub's "Enable"
  button; a small `externally_connectable` channel lets the Hub detect the extension and open
  that grant. Until then the extension has no access to the page.
- **A provider site, requested in context** the first time a verification targets that
  provider. Provider sites fall under a broad optional host scope (`https://*/*`), but the
  extension never requests that wildcard: it asks for access to just the one site being
  verified, and the user grants or declines it then. Granted access, webapp or provider, can be
  revoked at any time from the browser's extension settings.

## What it does with that access

- Access is exercised **only during a verification the user explicitly starts** from the
  Umia Hub.
- During that flow it reads the provider's session (cookies + the relevant network response)
  to construct a zkTLS proof bound to the user's wallet.
- The proof is returned to the Umia Hub/API for off-chain verification and storage.
- **TLS traffic transits Umia's attestor.** Umia's attestor service relays the encrypted
  connection for the request being proven. It sees the provider's host name, connection
  metadata such as timing and sizes, and the parts of the response the proof is designed to
  reveal; request credentials such as session cookies are redacted from what it can read. It
  signs the resulting claim.
- **Session telemetry goes to Umia.** While a verification runs, the extension reports fixed
  progress events (for example "page ready", "request captured") with a fixed stage name to the
  Umia API, authenticated by that session. These events carry no page content, URLs, cookies,
  extracted values or proof data. Diagnostic logs stay in the local browser console and are off
  by default.
- Outside an active verification it does not read browsing data, inject into pages for any
  other purpose, or send telemetry.

## What it does not do

- Does not collect, store, or transmit personal data to Umia beyond the user-initiated proof
  and the fixed-event session telemetry above.
- Sends nothing to any service other than Umia's and the provider site being verified: no
  hosted Reclaim endpoints and no IP-geolocation lookups.
- Does not track browsing, sell data, or use data for advertising.
- The proof is designed to minimize revealed data; the exact fields depend on provider
  design (see `web/site/content/docs/technical-reference/zktls-integration.mdx`). Where the
  provider exposes a pseudonymous identifier, no raw account handle is revealed.

## Compliance

- Adheres to Google's Limited Use requirements: data accessed is used solely to provide the
  user-facing verification feature.
- Privacy policy: https://umia.finance/privacy-policy — ensure it contains an
  extension-specific section describing the above before submitting.
