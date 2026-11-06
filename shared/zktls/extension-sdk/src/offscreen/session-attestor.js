import { AttestorClient } from "@reclaimprotocol/attestor-core/browser";
import { getBytes } from "ethers";
import { atDeadline } from "../utils/at-deadline.js";
import { boundSessionDeadline, requireAttestorAuth } from "../utils/session-config.js";
import { failureCode } from "../utils/constants/interfaces.js";

// Upstream trace logs include RPC payloads; keep signed auth and proofs out of diagnostics.
const privateClientLogger = {
  child() {
    return this;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function signedAuthRequest(session) {
  let signed;
  try {
    signed = requireAttestorAuth(session);
  } catch (error) {
    throw new Error(failureCode(error, "ATTESTOR_AUTH_FAILED"));
  }
  const data = Object.freeze({
    id: signed.data.id,
    createdAt: signed.data.createdAt,
    expiresAt: signed.data.expiresAt,
    hostWhitelist: Object.freeze([...signed.data.hostWhitelist]),
  });
  return Object.freeze({ data, signature: getBytes(signed.signature) });
}

export class BoundAttestorSessions {
  constructor({ Client = AttestorClient, makeWebSocket = (url) => new WebSocket(url) } = {}) {
    this.Client = Client;
    this.makeWebSocket = makeWebSocket;
    this.sessions = new Map();
  }

  open(session) {
    const authRequest = signedAuthRequest(session);
    const { sessionId, umia, route } = session;
    const routeKey = `${route.attestorUrl}|${route.witness}|${route.network.authorityDigest}`;
    let group = this.sessions.get(sessionId);
    if (
      group &&
      (group.sessionToken !== umia.sessionToken ||
        group.signature !== umia.attestorAuth.signature ||
        group.routeKey !== routeKey)
    ) {
      this.closeSession(sessionId);
      group = null;
    }
    if (!group) {
      group = {
        sessionToken: umia.sessionToken,
        signature: umia.attestorAuth.signature,
        routeKey,
        handles: new Set(),
      };
      this.sessions.set(sessionId, group);
    }

    let socket;
    let client;
    let opened = false;
    let dialFailed = false;
    try {
      client = new this.Client({
        url: route.attestorUrl,
        authRequest,
        logger: privateClientLogger,
        makeWebSocket: (url) => {
          socket = this.makeWebSocket(url);
          socket.addEventListener?.("open", () => (opened = true));
          socket.addEventListener?.("error", () => {
            if (!opened) dialFailed = true;
          });
          return socket;
        },
      });
    } catch {
      socket?.close();
      if (group.handles.size === 0) this.sessions.delete(sessionId);
      throw new Error("ATTESTOR_UNREACHABLE");
    }

    const deadline = boundSessionDeadline(session);
    let rejectCancellation;
    const cancelled = new Promise((_, reject) => {
      rejectCancellation = reject;
    });
    // A cancelled race is always observed by the active claim, or by this handler.
    cancelled.catch(() => {});
    const handle = {
      client,
      active: true,
      closedWith: null,
      cancelExpiry: null,
      cancelled,
      // True once the socket failed before it ever opened, i.e. the attestor was not reached.
      dialFailed: () => dialFailed,
      // The deadline closes with SESSION_EXPIRED so the terminal code does not
      // depend on whether this or the background's expiry timer fires first.
      close: (code = "CANCELLED") => {
        if (!handle.active) return;
        handle.active = false;
        handle.closedWith = code;
        handle.cancelExpiry?.();
        rejectCancellation(new Error(code));
        group.handles.delete(handle);
        if (group.handles.size === 0 && this.sessions.get(sessionId) === group) {
          this.sessions.delete(sessionId);
        }
        // The pinned client exposes no synchronous close method; close its captured socket.
        try {
          socket.close();
        } catch {}
      },
      assertLive: () => {
        if (!handle.active) throw new Error(handle.closedWith);
        try {
          requireAttestorAuth(session);
        } catch (error) {
          handle.close();
          throw error;
        }
      },
    };
    group.handles.add(handle);
    handle.cancelExpiry = atDeadline(deadline, () => handle.close("SESSION_EXPIRED"));
    return handle;
  }

  closeSession(sessionId) {
    const group = this.sessions.get(sessionId);
    if (!group) return;
    for (const handle of [...group.handles]) handle.close();
  }

  closeAll() {
    for (const sessionId of [...this.sessions.keys()]) this.closeSession(sessionId);
  }
}
