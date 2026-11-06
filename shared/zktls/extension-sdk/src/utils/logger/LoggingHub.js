/**
 * LoggingHub - the single place every SDK log is leveled and redacted.
 *
 * Background logs to it directly; content, offscreen and the MAIN-world
 * interceptor reach it through `handleRemoteLog` (see RemoteLogger and the
 * RECLAIM_LOG bridge in content.js).
 *
 * Logs never leave the device: there is no queue, storage mirror, device ID or
 * remote destination. When `config.consoleEnabled` is on, lines are mirrored to
 * this context's console. ONE threshold, `config.logLevel`, decides both what is
 * emitted and in what form:
 *
 *   INFO (default): payloads REDACTED, values blanked, key names kept.
 *   FINE: payloads RAW except credentials (response bodies, extracted
 *         parameters and the proof). Local debugging only.
 *
 * Session telemetry is separate and finite; see background/telemetry.js.
 */

import {
  LOG_LEVEL,
  DEFAULT_LOG_CONFIG,
  LOG_CONFIG_STORAGE_KEY,
  normalizeLogLevel,
} from "./constants.js";
import { redact, redactCredentials } from "./redact.js";

// Singleton guard to prevent multiple instances
let singletonInstance = null;

class LoggingHub {
  constructor() {
    // Return existing instance if already created
    if (singletonInstance) {
      return singletonInstance;
    }

    // Log config (log level + console output)
    this.config = { ...DEFAULT_LOG_CONFIG };

    // Config loads on first use: `background.js` is imported at module scope by
    // `ReclaimExtensionSDK.js`, so consumer pages must not touch storage eagerly.
    this._started = false;
    this.ready = Promise.resolve();

    singletonInstance = this;
  }

  /**
   * Start async init exactly once, on first real use.
   * @returns {Promise<void>}
   */
  _ensureStarted() {
    if (this._started) return this.ready;
    this._started = true;
    this.ready = this._loadConfig().then(() => this._watchConfigChanges());
    return this.ready;
  }

  /**
   * Load log config from storage
   */
  async _loadConfig() {
    try {
      const result = await chrome.storage.local.get(LOG_CONFIG_STORAGE_KEY);
      if (result[LOG_CONFIG_STORAGE_KEY]) {
        this.config = { ...this.config, ...result[LOG_CONFIG_STORAGE_KEY] };
      }
    } catch {
      // Storage may not be available, use defaults
    }
  }

  /**
   * Watch for config changes in storage (live sync)
   */
  _watchConfigChanges() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[LOG_CONFIG_STORAGE_KEY]) {
          const newConfig = changes[LOG_CONFIG_STORAGE_KEY].newValue;
          if (newConfig) {
            this.config = { ...this.config, ...newConfig };
          }
        }
      });
    } catch {
      // Storage may not be available
    }
  }

  /**
   * Force reload config from storage (useful for ensuring sync)
   */
  async reloadConfig() {
    await this._loadConfig();
  }

  /**
   * Set log config programmatically
   * @param {Object} config - Partial config to merge
   */
  setConfig(config) {
    this.config = { ...this.config, ...config };
    try {
      chrome.storage.local.set({ [LOG_CONFIG_STORAGE_KEY]: this.config });
    } catch {
      // Storage may not be available
    }
  }

  /**
   * Compare a level against a threshold. Lower number = higher severity.
   * @param {string} level - Log level of the entry
   * @param {string} threshold - Configured threshold name
   * @returns {boolean}
   */
  _passes(level, threshold) {
    const max = LOG_LEVEL[normalizeLogLevel(threshold)] || LOG_LEVEL.INFO;
    const requested = LOG_LEVEL[normalizeLogLevel(level)] || LOG_LEVEL.INFO;
    return requested <= max;
  }

  /**
   * Whether this level is emitted at all.
   *
   * @param {string} level
   * @returns {boolean}
   */
  _passesThreshold(level) {
    return this._passes(level, this.config.logLevel);
  }

  /**
   * Whether payloads are serialised raw rather than redacted.
   *
   * True only at FINE. This is the single switch between "everything about the
   * session, values blanked" and "everything about the session, values intact",
   * and it governs every console the hub writes to.
   *
   * @returns {boolean}
   */
  _isRaw() {
    return normalizeLogLevel(this.config.logLevel) === "FINE";
  }

  /**
   * Internal method to emit a log line.
   *
   * Redaction follows the LEVEL: at INFO the console gets a redacted *copy* of
   * `payload`; only FINE shows it raw. The content-script console is the
   * provider tab's console, so the default must never print user data there.
   *
   * @param {string} message - Log message. MUST NOT embed user data: redaction
   *   cannot reach inside a string that was already concatenated at the call
   *   site. Pass structured data as `payload` instead.
   * @param {string} type - Log type/category
   * @param {string} level - "SEVERE" | "WARNING" | "INFO" | "FINE" (older
   *   spellings ERROR/WARN/DEBUG are accepted and normalized)
   * @param {string} [context] - Emitting context: background | content | offscreen | interceptor
   * @param {Object} [options]
   * @param {string} [options.eventType] - Accepted from existing call sites; not emitted.
   * @param {*} [options.payload] - Structured data. Pass the OBJECT, never a
   *   pre-stringified blob: stringifying at the call site defeats redaction.
   */
  _addLog(message, type, level = "INFO", context = "background", options = undefined) {
    this._ensureStarted();

    const resolvedLevel = normalizeLogLevel(level);
    if (!this._passesThreshold(resolvedLevel) || !this.config.consoleEnabled) {
      return;
    }

    const { payload } = options || {};
    const hasPayload = payload !== undefined;
    const consoleFn =
      resolvedLevel === "SEVERE"
        ? console.error
        : resolvedLevel === "WARNING"
          ? console.warn
          : console.log;
    // Literal format string with `message` as an argument (see log-bridge.js):
    // a message carrying "%s" would otherwise consume the payload.
    const format = type ? "[%s] [%s] [%s] %s" : "[%s] [%s] %s";
    const parts = type
      ? [resolvedLevel, context, type, message]
      : [resolvedLevel, context, message];
    if (hasPayload) {
      consoleFn(format, ...parts, this._isRaw() ? redactCredentials(payload) : redact(payload));
    } else {
      consoleFn(format, ...parts);
    }
  }

  // Public API - consistent across all loggers

  /**
   * Log an error message (highest severity - always logged)
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {Object} [options] - `{ eventType, payload }`; see _addLog
   */
  error(message, type, options) {
    this._addLog(message, type, "SEVERE", "background", options);
  }

  /**
   * Log a warning message
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {Object} [options] - `{ eventType, payload }`; see _addLog
   */
  warn(message, type, options) {
    this._addLog(message, type, "WARNING", "background", options);
  }

  /**
   * Log an info message
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {Object} [options] - `{ eventType, payload }`; see _addLog
   */
  info(message, type, options) {
    this._addLog(message, type, "INFO", "background", options);
  }

  /**
   * Log at FINE — emitted only when `logLevel` is FINE, and that is also the
   * level at which payloads are serialised raw. Use it for the detail that only
   * matters while actively debugging a session.
   *
   * `debug()` is kept as the name because every existing call site uses it.
   *
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {Object} [options] - `{ eventType, payload }`; see _addLog
   */
  debug(message, type, options) {
    this._addLog(message, type, "FINE", "background", options);
  }

  /** @see debug - alias spelled the way the platform spells the level. */
  fine(message, type, options) {
    this._addLog(message, type, "FINE", "background", options);
  }

  /**
   * Handle a log relayed from another context (content / offscreen /
   * interceptor). Called by the message router on LOG_MESSAGE.
   *
   * A relayed log appears in two consoles by design: its own context's (from
   * RemoteLogger) and the service worker's (from `_addLog` below), the latter
   * labelled with the originating context so a multi-context flow reads in one
   * place. `payload` survives chrome messaging as a structured clone, so the
   * level-based redaction applies to it here exactly as it would to a
   * background log.
   *
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {string} level - "SEVERE" | "WARNING" | "INFO" | "FINE"
   * @param {string} [context] - Originating context
   * @param {Object} [options] - `{ eventType, payload }` forwarded from that context
   */
  handleRemoteLog(message, type, level = "INFO", context = "remote", options = undefined) {
    this._addLog(message, type, level, context, options);
  }
}

// Export singleton instance for background use
export const loggingHub = new LoggingHub();

// Export class for testing
export { LoggingHub };
