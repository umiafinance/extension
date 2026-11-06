/**
 * The user-visible contract this file protects:
 *
 *  1. ONE threshold, `logLevel`, decides what is printed and in what form: INFO
 *     blanks values, FINE keeps them raw. A stock install prints no user data,
 *     and no level prints a cookie, key or token.
 *  2. Levels use the platform spelling (SEVERE/WARNING/INFO/FINE); the older
 *     ERROR/WARN/DEBUG spellings still resolve.
 *  3. Logs never leave the device: no queue, storage mirror, device ID, timer
 *     or network call.
 *
 * The hub talks to `chrome.*` and the console, both stubbed here. It is a
 * singleton claimed at module import; node:test gives each file its own
 * process, so there is no cross-file bleed.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";

import { EVENT_TYPES, DEFAULT_LOG_CONFIG } from "./constants.js";

const storage = { local: new Map(), session: new Map() };
const writes = [];
let fetched = 0;
let timers = 0;

function installChromeStub() {
  const area = (name, map) => ({
    get: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    set: async (obj) => {
      writes.push({ area: name, keys: Object.keys(obj) });
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
    remove: async (key) => {
      writes.push({ area: name, keys: [key] });
      map.delete(key);
    },
  });

  globalThis.chrome = {
    storage: {
      local: area("local", storage.local),
      session: area("session", storage.session),
      onChanged: { addListener() {} },
    },
    alarms: {
      create() {
        timers++;
      },
      onAlarm: { addListener() {} },
    },
    runtime: { onSuspend: { addListener() {} } },
  };
  globalThis.fetch = async () => {
    fetched++;
    return { ok: true, status: 200 };
  };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    timers++;
    return realSetInterval(...args);
  };
}

let hub;

before(async () => {
  installChromeStub();
  const mod = await import("./LoggingHub.js");
  hub = mod.loggingHub;
  hub.info("bootstrap", "test.bootstrap");
  await hub.ready;
});

function capture(run) {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ["log", "warn", "error"]) {
    console[level] = (...args) => lines.push(args);
  }
  try {
    run();
  } finally {
    Object.assign(console, real);
  }
  return lines;
}

beforeEach(() => {
  hub.config = { logLevel: "FINE", consoleEnabled: true };
});

describe("one threshold governs what is printed", () => {
  it("prints nothing below the threshold", () => {
    hub.config = { logLevel: "INFO", consoleEnabled: true };
    assert.equal(capture(() => hub.debug("fine-detail", "test.category")).length, 0);
  });

  it("prints nothing while the console is off", () => {
    hub.config = { logLevel: "FINE", consoleEnabled: false };
    assert.equal(capture(() => hub.error("boom", "test.category")).length, 0);
  });

  it("keeps WARNING and SEVERE visible at the INFO default", () => {
    hub.config = { logLevel: "INFO", consoleEnabled: true };
    const lines = capture(() => {
      hub.error("boom", "test.category");
      hub.warn("careful", "test.category");
      hub.info("normal", "test.category");
      hub.debug("verbose", "test.category");
    });
    assert.deepEqual(
      lines.map((args) => args[4]),
      ["boom", "careful", "normal"],
    );
  });

  it("labels lines with the platform's level spelling", () => {
    const lines = capture(() => {
      hub.error("a", "t");
      hub.warn("b", "t");
      hub.info("c", "t");
      hub.debug("d", "t");
    });
    assert.deepEqual(
      lines.map((args) => args[1]),
      ["SEVERE", "WARNING", "INFO", "FINE"],
    );
  });

  it("accepts the pre-rename spellings from a persisted config", () => {
    hub.config = { logLevel: "DEBUG", consoleEnabled: true };
    assert.equal(capture(() => hub.debug("still-verbose", "t")).length, 1);

    hub.config = { logLevel: "ERROR", consoleEnabled: true };
    const lines = capture(() => {
      hub.info("dropped", "t");
      hub.error("kept", "t");
    });
    assert.deepEqual(
      lines.map((args) => args[4]),
      ["kept"],
    );
  });

  it("passes the message as an argument, never as the format string", () => {
    const [args] = capture(() => hub.info("100%s done", "t", { payload: { a: 1 } }));
    assert.equal(args[0], "[%s] [%s] [%s] %s");
    assert.equal(args[4], "100%s done");
  });
});

describe("redaction follows the level", () => {
  const TEMPLATE = {
    sessionId: "sess-1",
    signature: "0xsignaturevalue",
    parameters: { accountNumber: "1234567890" },
  };

  it("prints a redacted copy at INFO", () => {
    // The content-script console is the provider tab's console; at the default
    // level it must not show the user's own extracted data.
    hub.config = { logLevel: "INFO", consoleEnabled: true };
    const [args] = capture(() =>
      hub.info("Starting verification:", "background.verification", { payload: TEMPLATE }),
    );
    const shown = args.at(-1);
    assert.notEqual(shown, TEMPLATE, "the console must not get the live object at INFO");
    const json = JSON.stringify(shown);
    assert.ok(!json.includes("0xsignaturevalue"));
    assert.ok(!json.includes("1234567890"));
    assert.ok(json.includes("accountNumber"), "field names stay: they are the diagnostic");
    assert.ok(json.includes("sess-1"), "innocuous fields are untouched");
  });

  it("prints user data raw at FINE, but never a credential", () => {
    const [args] = capture(() =>
      hub.info("Starting verification:", "background.verification", { payload: TEMPLATE }),
    );
    const json = JSON.stringify(args.at(-1));
    assert.ok(json.includes("1234567890"));
    assert.ok(!json.includes("0xsignaturevalue"));
  });

  it("blanks cookies and keys at FINE however deeply they are nested", () => {
    const claim = {
      ownerPrivateKey: "0xownerkey",
      secretParams: { cookieStr: "sid=deadbeef", headers: { Cookie: "sid=deadbeef" } },
      params: { headers: { Authorization: "Bearer bearer-value" } },
      session: { umia: { sessionToken: "token-value" } },
    };
    const [args] = capture(() => hub.debug("claim", "claim.creation", { payload: claim }));
    const json = JSON.stringify(args.at(-1));
    for (const secret of ["0xownerkey", "deadbeef", "bearer-value", "token-value"]) {
      assert.ok(!json.includes(secret), secret);
    }
  });
});

describe("no user data is printed at the default level", () => {
  const CLAIM = {
    name: "http",
    params: {
      url: "https://etherscan.io/myaccount",
      paramValues: { etherscanaccount: "exampleuser" },
    },
    secretParams: {
      cookieStr: "ASP.NET_SessionId=deadbeef; etherscan_pwd=hunter2",
      paramValues: { secretToken: "tok-abc123" },
    },
    ownerPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    signature: "0xsignaturevalue",
  };

  // `claimData.context.extractedParameters` is the plaintext value being proven.
  const PROOF = {
    identifier: "0xe46c982a",
    claimData: {
      provider: "http",
      parameters: JSON.stringify({ paramValues: { username: "exampleuser" } }),
      context: JSON.stringify({ extractedParameters: { username: "exampleuser" } }),
      owner: "0xowner",
    },
    signatures: ["0x0ed30f08"],
    witnesses: [{ id: "0x24489757", url: "wss://attestor.zktls.umia.finance/ws" }],
    publicData: "scraped-display-name",
    providerRequest: { url: "https://kaggle.com/api", method: "POST", urlType: "TEMPLATE" },
  };

  const SECRETS = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "ASP.NET_SessionId=deadbeef",
    "etherscan_pwd=hunter2",
    "tok-abc123",
    "exampleuser",
    "0xsignaturevalue",
    "scraped-display-name",
  ];

  function printed(message, type, payload) {
    hub.config = { ...DEFAULT_LOG_CONFIG, consoleEnabled: true };
    const [args] = capture(() => hub.info(message, type, { payload }));
    return JSON.stringify(args);
  }

  it("blanks the claim", () => {
    const line = printed("[CLAIM-CREATOR] Claim object:", "claim.creation", CLAIM);
    for (const secret of SECRETS) {
      assert.ok(!line.includes(secret), `${secret} LEAKED at stock defaults`);
    }
    assert.ok(line.includes("<redacted"), "values are blanked, not the whole line dropped");
    assert.ok(line.includes("etherscanaccount"), "param NAMES survive; their values do not");
    assert.ok(line.includes("https://etherscan.io/myaccount"), "the provider url is config");
  });

  it("blanks claimData wholesale in a submitted proof", () => {
    const line = printed("[BACKGROUND] Submitting proofs", "background.proof", [PROOF]);
    assert.ok(!line.includes("exampleuser"));
    assert.ok(!line.includes("extractedParameters"), "not even the key");
    assert.ok(line.includes("[REDACTED]"));
    assert.ok(line.includes("0xe46c982a"), "the identifier survives");
    assert.ok(line.includes("urlType"), "and the provider request");
  });

  it("blanks a provider script's return value, whatever keys it invents", () => {
    const line = printed("[BACKGROUND] injection result", "background.injection", {
      injectionResult: { emailAddress: "user@example.com", tier: "gold" },
    });
    assert.ok(!line.includes("user@example.com"));
    assert.ok(!line.includes("emailAddress"));
  });

  it("keeps the extracted value's length but not the value", () => {
    const line = printed(
      "[PARAM-EXTRACTOR] responseMatch #0 resolved via template: userName(len=11)",
      "claim.params",
      { extractedParameters: { userName: "exampleuser" } },
    );
    assert.ok(!line.includes("exampleuser"));
    assert.ok(line.includes("len=11"));
  });
});

describe("relayed logs", () => {
  it("label the originating context and normalize the level", () => {
    const [args] = capture(() =>
      hub.handleRemoteLog("from the page", "interceptor.network", "WARN", "interceptor"),
    );
    assert.equal(args[1], "WARNING");
    assert.equal(args[2], "interceptor");
  });

  it("stay redacted at INFO and keep credentials blanked at FINE across the hop", () => {
    const payload = { secretParams: { cookieStr: "ASP.NET_SessionId=deadbeef" } };
    hub.config = { logLevel: "INFO", consoleEnabled: true };
    const [redacted] = capture(() =>
      hub.handleRemoteLog("claim", "offscreen.proof", "INFO", "offscreen", { payload }),
    );
    assert.ok(!JSON.stringify(redacted).includes("deadbeef"));

    hub.config = { logLevel: "FINE", consoleEnabled: true };
    const [fine] = capture(() =>
      hub.handleRemoteLog("claim", "offscreen.proof", "FINE", "offscreen", { payload }),
    );
    assert.ok(!JSON.stringify(fine).includes("deadbeef"));
  });
});

describe("logs never leave the device", () => {
  it("mints no device ID and persists, schedules and sends nothing", async () => {
    hub.config = { ...DEFAULT_LOG_CONFIG };
    for (let i = 0; i < 50; i++) {
      hub.error(`line ${i}`, "test.category", { payload: { parameters: { a: i } } });
    }
    await hub.ready;
    assert.equal(storage.local.has("reclaim_device_id"), false);
    assert.equal(storage.session.size, 0);
    assert.deepEqual(writes, []);
    assert.equal(fetched, 0);
    assert.equal(timers, 0);
    for (const removed of ["flush", "forceFlush", "logs", "deviceId", "diagnosticSink"]) {
      assert.equal(hub[removed], undefined, `${removed} is gone`);
    }
  });
});

describe("eventType taxonomy", () => {
  it("uses names that exist in the InApp SDK where one exists", () => {
    const names = new Set(Object.keys(EVENT_TYPES));
    for (const inApp of [
      "NO_RESPONSE_MATCH_WARNING",
      "PROOF_GENERATED",
      "PROOF_GENERATION_FAILED_EXCEPTION",
      "CLAIM_CREATION_CANCELLED_EXCEPTION",
      "RECLAIM_EXCEPTION",
      "FETCHED_PROVIDERS",
      "REQUEST_INTERCEPTED",
      "PROVIDER_SCRIPT_REQUESTED_CLAIM",
      "CLAIM_CREATION_TIMED_OUT_EXCEPTION",
    ]) {
      assert.ok(names.has(inApp), `missing InApp name ${inApp}`);
    }
    for (const retired of [
      "RESPONSE_MATCH_FAILED",
      "CLAIM_CREATION_SUCCESS",
      "CLAIM_CREATION_FAILED",
      "PROOF_GENERATION_ABORTED",
      "VERIFICATION_FLOW_FAILED",
      "FILTERED_REQUEST_FOUND",
      "SUBMITTING_PROOF_TO_CALLBACK_URL",
    ]) {
      assert.ok(!names.has(retired), `${retired} was renamed away; do not reintroduce it`);
    }
    for (const [key, value] of Object.entries(EVENT_TYPES)) {
      assert.equal(key, value, `EVENT_TYPES.${key} !== "${value}"`);
    }
  });
});
