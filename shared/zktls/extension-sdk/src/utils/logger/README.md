# Logger

Console-only, level-gated logging with redaction. Logs never leave the device:
there is no queue, storage mirror, device ID or remote destination.

```javascript
// background
import { loggingHub } from "../utils/logger/LoggingHub";
loggingHub.info("[BACKGROUND] Fetched provider", "background.provider", { payload });

// content or offscreen: relayed to the hub over LOG_MESSAGE
import { createRemoteLogger } from "../utils/logger/RemoteLogger";
createRemoteLogger("content").info("[Content] Ready", "content.init");
```

`logLevel` (default `INFO`) prints payloads redacted; `FINE` prints them raw except
credentials (cookies, keys, tokens, signatures), which are blanked at every level.
`consoleEnabled` (default off) decides whether anything is printed. Both live in
`chrome.storage.local` and only an extension page can change them.
