# Content script

`content.js` is built as a classic UMD bundle (`content/content.bundle.js`, global
`ReclaimContent`); an ES module would fail as a content script. Umia's extension does not declare it
statically: the consumer registers it at `document_start` in every frame, only on sites the user
granted, through `providerContentScript()` (`../background/providerAccess.js`). It is rebuilt on
every navigation, so nothing in its state survives a page load.

## Files

```
src/content/
├── content.js                 # entry: relay, interception, filtering, widget
├── criteria-result.js         # decides when a response conclusively misses the criteria
└── components/
    └── reclaim-provider-verification-popup.js   # mounts the src/ui widget in a closed shadow root
```

## Two roles

**Caller relay (the Umia app tab).** It bridges the page SDK and the background over
`window.postMessage` (same window only) and `chrome.runtime`: `RECLAIM_EXTENSION_CHECK` /
`RECLAIM_EXTENSION_RESPONSE`, `RECLAIM_START_VERIFICATION` / `RECLAIM_VERIFICATION_STARTED`,
`RECLAIM_VERIFICATION_COMPLETED`, `RECLAIM_VERIFICATION_FAILED` (finite codes only) and
`RECLAIM_CANCEL_VERIFICATION`. On `pagehide` it sends `CANCEL_VERIFICATION`, because proofs can
only be delivered to the initiating document.

**Provider tab (managed by the background).** After `REQUEST_PROVIDER_DATA` /
`PROVIDER_DATA_READY` it:

1. Injects `interceptor/network-interceptor.bundle.js` (web-accessible) into the MAIN world.
2. Polls intercepted requests every `NETWORK_FILTERING_INTERVAL_MS` against the recipe with
   `describeRequestMatch` (`../utils/claim-creator/network-filter.js`) and sends a match as
   `FILTERED_REQUEST_FOUND {requestHash, request}`; the background, not the page, picks the
   criteria.
3. Sends `RESPONSE_MATCH_RESULT` when `criteria-result.js` finds a complete, signed-in response
   that fails the recipe's rule (GitHub counts, FOMO own profiles), so the background can fail the
   session with `CRITERIA_NOT_MET` at once.
4. Asks the background to run the recipe's declarative request chain and document replay
   (`INJECT_VIA_SCRIPTING` with `RUN_REQUEST_CHAIN` or `REPLAY_BOUND_DOCUMENT`); the message
   carries only the op.
5. Shows the Umia widget on `SHOW_PROVIDER_VERIFICATION_POPUP` (top frame only) and updates it
   from the claim and proof status messages, including `PROVIDER_TAB_VERIFIED` for the success
   state. The widget follows the Umia app's theme from `chrome.storage.local` (`umiaTheme`).

It exposes no page API to provider scripts. It relays MAIN-world logs (`RECLAIM_LOG`) and pushes
the log config down as `RECLAIM_LOG_CONFIG`.

## Debugging

Logs go through `createRemoteLogger("content")` to the service worker's console and are off by
default. Enable them from an extension page with
`setLogConfig({ consoleEnabled: true, logLevel: "FINE" })`; a web page cannot change them.
