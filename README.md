# Umia browser extension

This packaging branch is a draft. Its isolated tests do not establish a working
bound self-host proof flow or Chrome admission behavior; those require the
reviewed SDK transport, browser validator dependency, and pinned Deployor run.

Manifest V3 Chrome extension that wraps the
`@umia/reclaim-browser-extension-sdk` workspace to generate privacy-preserving
zkTLS proofs for Umia Tailored Auctions. The Hub starts a
verification, the extension runs the provider flow in the user's session, and
returns the proof to the Hub for off-chain verification.

The public source mirror is <https://github.com/umiafinance/extension>. Run
`just update-extension-mirror` from a committed Umia checkout to sync this
directory. The separate SDK source mirror is
<https://github.com/umiafinance/extension-sdk>; both packages are built from the
Umia monorepo workspace.

- User-facing overview: `web/site/content/docs/zktls-extension.mdx`
- Architecture / privacy model: `web/site/content/docs/technical-reference/zktls-integration.mdx`
- Published as **Umia** on the Chrome Web Store (`ejcaahfcaaiblipldkfijdcbannidbdd`), offered by umiafinance (hello@umia.finance).

## Build

Dependencies come from the workspace install (`bun install --frozen-lockfile` at the repo root).
The build reads the single canonical asset manifest at
`infra/aws/src/asset-mirror/manifest.json`. Stage its objects into a local directory
with `node infra/aws/src/asset-mirror/assets.mjs stage <manifest> <root>` and run
`node infra/aws/src/asset-mirror/assets.mjs verify-local <manifest> <root>` on
all nine objects, including the separate license. The root must
contain each file at `<root>/<object.key>`, including the pinned commit prefix.
The extension build reads only this local root; it never downloads assets.

SDK 0.5.2 uses `attestor-core` 5.1.5 and the patched Stwo WASM from
`zk-symmetric-crypto` 5.1.7. Its proof encoding requires a verifier using the
same patched WASM; proofs made with the previous encoding must be regenerated.
The separate TLS application-key binding finding remains unresolved upstream.

```bash
cd web/extension
bun run build --asset-dir /absolute/staged/root \
  --activation /absolute/reviewed/activation.json \
  --network-config /absolute/reviewed/devnet-network.json \
  --network-config /absolute/reviewed/other-network.json
bun run test
```

Each `--network-config` is an existing version-1 network config with its own
single local attestor. The shared browser-safe loader validates every config
independently and checks that each activation record belongs to exactly one of
them. Missing, expired, ambiguous or unprovisioned records fail the build.
One build may include multiple provisioned profiles, while `dist/manifest.json`
lists the exact Hub caller origins for every canonical profile in an activated
environment, including native devnet when hosted devnet is active. Those caller
patterns admit status and enable probes; the background
uses the shared resolver to select one active record for each START and the SDK independently
binds the session to it.

The artifact manifest in `dist/` binds the source SHA, dirty state, profile-set
hash, exact activation input SHA-256, each exact network-config input size and
SHA-256, package versions, canonical asset-manifest SHA-256, SDK source/build
hashes, and every packaged file's size and SHA-256. The eight circuit resources go under
`browser-rpc/resources/`; the license and its separate upstream provenance notice go
under `licenses/`. SDK bundles and
`snarkjs.min.js` come from the local SDK build. Missing or altered assets fail
the build.

Load `dist/` via `chrome://extensions` → "Load unpacked" only in a reviewed
isolated browser session. Deployor owns shared devnet runtime testing.

Every build runs as the store item's extension ID (`ejcaahfcaaiblipldkfijdcbannidbdd`) when
loaded unpacked: it writes the item's public key from `store-key.json` (Developer Dashboard →
Package → View public key; public by design) to `dist/manifest.json` as `key`, before the
artifact manifest, and refuses a `store-key.json` whose key no longer yields its `id`. The ZIP
therefore carries the key too: it is for Load unpacked, not a store upload. An unpacked build
and the store install share one ID, so a browser runs one of them at a time.

## Permissions: no required host access, optional runtime grants

Installing from the Chrome Web Store shows **no** "read and change your data" warning: the
manifest declares no `host_permissions` and no static `content_scripts`. Every host the
extension touches — the Umia webapp and the provider sites alike — lives in
`optional_host_permissions` and is granted at runtime, in context, one site at a time.

- **The Umia webapp** (exact caller origins from approved canonical profiles). The Hub page
  loads the extension SDK, which reaches the extension by posting window
  messages (`RECLAIM_EXTENSION_CHECK`, `RECLAIM_START_VERIFICATION`, …) that a content script
  relays to the background worker. That relay needs the webapp host permission, so it is
  registered dynamically the first time the user enables the extension for the site (see the
  flow below) and re-registered on every worker start while the grant holds — it is **not**
  static and adds nothing to the install prompt.
- **The provider sites** are covered by a wildcard `optional_host_permissions`
  (`https://*/*`, plus `http://localhost/*`). Each provider site is requested at runtime the
  first time a verification targets it, and only for that one site — the gate never requests the
  wildcard itself (that would prompt for every site); it derives the specific site pattern from
  the tab URL. A new provider therefore needs **no manifest change**.

Because the webapp relay is no longer present at install, the Hub can't reach it to detect the
extension. `externally_connectable` (generated from canonical Hub origins) gives
the Hub a direct `chrome.runtime.sendMessage` channel to the background worker,
used for two things only:

- a **status ping** (`umia:status`) so the Hub can tell _not installed_ from _installed but not
  yet enabled for this site_ — the SDK's `isExtensionInstalled()` probe returns false for both;
- an **enable trigger** (`umia:enable`) so the Hub's "Enable" button can ask the background to
  open the grant window for the current origin.

The proof protocol still flows entirely through the content-script relay once granted;
`externally_connectable` carries only these two lightweight control messages.

`web_accessible_resources` uses wildcard matches (`http://localhost/*`, `https://*/*`)
for provider-page bundles because provider hosts are not enumerated. The extension's
own injected content script reaches these resources through `chrome.runtime.getURL`.
Only the interceptor bundles and the popup template are listed. The offscreen document and
its circuits load only inside the extension, so a page can neither frame nor fingerprint them.

### Adding a new provider

Because the scope is a wildcard, the manifest no longer enumerates provider domains — **a new
provider works with zero extension or manifest changes.** The wildcard lets the gate request
that provider's site at runtime, so the user gets a per-provider approval prompt the first time
a verification opens it.

There is one **optional, hub-side** step to know about. To also **merge** a provider's grant
into the single app-enable approval (one click for both the Umia app and that provider), add an
`origin` field to that provider's entry in the `PROVIDERS` map in
`web/hub/components/market/contribute/verification-list.tsx`, keyed by the same brand word
`resolveProviderBrand` matches:

```ts
const PROVIDERS: Record<string, ProviderBrand> = {
  github: {
    label: "GitHub",
    logo: { src: "/icons/verification/github.png", invertOnDark: true },
    origin: "https://*.github.com/*", // fold GitHub into the one-click app-enable approval
  },
  // …
};
```

Skipping the `origin` only costs the merge: the provider still verifies fine, it just gets its
own approval prompt. The same `PROVIDERS` entry also carries the brand's label/logo.

### Runtime permission flow

Implemented in `src/providerPermissionGate.js`, installed from `src/extensionBackground.js`
right after `reclaimExtensionSDK.initializeBackground()`. It handles two grant paths, both
ending at the same `public/grant.html` window — whose button click supplies the user gesture
that `chrome.permissions.request` requires (a background- or message-triggered request would
lose the gesture).

**Enabling the Umia webapp (hub-triggered).** The Hub sends `umia:enable` over
`externally_connectable` when the enable step opens. The message may carry `extraOrigins` — the
current provider's site — so the background requests the webapp origin **and** that provider in
one `grant.html` approval (see "Adding a new provider"); verification then opens the provider tab
with no second prompt. On grant it reconciles the dynamic content-script registration (for future
loads) _and_ injects the relay into the requesting tab with `chrome.scripting.executeScript`, so
the open verification resumes with no page reload. The `umia:status` ping answers
`{ installed, enabled }` by checking `chrome.permissions.contains` for the requesting origin.

**Granting a provider site (SDK-triggered).** The SDK resolves a provider's login URL inside
the background worker and calls `chrome.tabs.create` to open the provider tab. The provider
origin isn't known before that call, and the `START_VERIFICATION` message carries no user
gesture, so the gate hooks exactly at the tab-open:

1. **Wrap `chrome.tabs.create`.** For a URL within the optional wildcard scope the gate
   intercepts (deriving the site's registrable-domain pattern to request); every other URL
   passes through.
2. **Check.** `chrome.permissions.contains` for the matched origin. If already granted, the
   gate makes sure the content script is registered and lets the tab open.
3. **Request (needs a gesture).** If missing, the gate opens `grant.html` in a small popup
   window; the request fires from the button click there, and the page reports the result back
   over a dedicated `chrome.runtime` port.
4. **Register before opening.** On grant, the gate registers the SDK content script for the
   granted origin(s) at `document_start` (`persistAcrossSessions`), then opens the provider tab.
   On denial (or if the user closes the popup) the gate fails the verification cleanly via the
   SDK's `failSession`.

Registered origins are kept in sync with what is actually granted: worker start-up,
`chrome.runtime.onStartup` / `onInstalled`, and `chrome.permissions.onAdded` / `onRemoved` all
reconcile a single dynamic registration (id `reclaim-provider-sites`) whose `matches` are
exactly the currently granted optional origins (webapp + providers). Revoking a host permission
unregisters it.

> **Local dev.** Unpacked builds carry the store key, so their extension id is the published
> `ejcaahfcaaiblipldkfijdcbannidbdd` that `NEXT_PUBLIC_ZKTLS_EXTENSION_ID` targets, and the
> `externally_connectable` ping reaches them on every canonical Umia Hub origin in
> the activated environment.

### Adding a new webapp domain

A new zkTLS **provider** needs no manifest change: the wildcard optional scope already covers
it (see "Adding a new provider" above). A new **webapp** origin that must run the SDK handshake
requires a canonical structural profile and an extension version bump. Proof use also
requires a reviewed activation record backed by a validated network config. The build derives the
narrow
`externally_connectable.matches` list; the source manifest remains empty.

Everything host-related is optional, so neither a new provider nor a new webapp domain forces a
"requires new permissions" re-prompt or auto-disable on existing users: they get the in-context
grant the first time they enable/verify against it.

### Release rule for API permissions

`permissions` (`offscreen`, `cookies`, `scripting`, `storage`) is the set the extension SDK needs
and should not grow in a routine update; `scripting` also backs the dynamic content-script
registration and the live-tab relay injection. Narrowing host scope — as the 0.3.1 release
does, by removing `host_permissions` and the static `content_scripts` entirely and moving the
webapp into `optional_host_permissions` — is a reduction and is safe for existing users (no
auto-disable; a previously granted webapp host is retained). Adding a new API permission (e.g.
`declarativeNetRequest`) triggers a forced re-grant and should ship deliberately with user
communication.

Permission justifications and store copy live in `STORE_LISTING.md`; data handling lives
in `PRIVACY.md`.

## Publishing checklist

1. Bump `version` in both `public/manifest.json` and `package.json` (keep them equal).
   `bun run release-check` (also run in CI) fails if they differ, if the SDK or attestor-core
   version leaves the pin in `release-baseline.json`, if any permission, host scope, content
   script match or flag, `externally_connectable` entry, web-accessible resource, match or
   dynamic-URL flag, or CSP differs from that reviewed baseline, if
   `STORE_LISTING.md` does not justify exactly the requested permissions, or if `PRIVACY.md`
   names a hosted or non-Umia endpoint. A deliberate permission change means editing
   `release-baseline.json` and `STORE_LISTING.md` in the same reviewed PR.
2. `just extension …` builds and then runs `scripts/package.js`, which writes a reproducible
   `extension-dist.zip` only if `dist/` matches `artifact-manifest.json` exactly (every attested
   file present with the same bytes, nothing extra) and the built manifest passes the same
   permission and version checks. Its `externally_connectable.matches` must equal the caller
   origins of the attested endpoint profiles, no wider.
3. Diff the requested host + API permissions against the installed store version
   (`chrome://extensions` → Details → Permissions). The 0.3.1 release removes `host_permissions`
   and the static `content_scripts` entirely and moves the webapp to `optional_host_permissions`
   — a reduction of install-time host scope, safe for existing users. The API `permissions` set
   is unchanged.
4. Load `dist/` unpacked and run one verification end to end: confirm a fresh install shows the
   Hub's **Enable** state; that clicking Enable opens the grant window and, on grant, injects the
   relay so the Hub flips to enabled with no reload; that the provider in-context grant popup
   still appears and completes the proof; and that a clean install shows no host warning.
5. Upload via the Chrome Web Store Developer Dashboard, complete the Privacy practices tab
   from `STORE_LISTING.md` + `PRIVACY.md`, and submit for review.
