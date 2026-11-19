import { describe, expect, it } from "bun:test";
import { ZKTLS_EXTENSION_ORIGIN_ALLOWLIST } from "@umia/zktls-config/self-host";

globalThis.window = globalThis.window || globalThis;
const { proto } = await import("@reclaimprotocol/attestor-core/browser");
const { BoundAttestorSessions } = await import("../src/offscreen/session-attestor.js");

const profile = ZKTLS_EXTENSION_ORIGIN_ALLOWLIST[0];
const second = Math.floor(Date.now() / 1000);
const route = {
  attestorUrl: profile.attestorUrl,
  backendUrl: profile.backendUrl,
  witness: `0x${"a".repeat(40)}`,
  network: {
    environment: "devnet",
    chainId: 10143,
    beaconAddress: `0x${"b".repeat(40)}`,
    expectedEpoch: 1,
    authorityDigest: `sha256:${"c".repeat(64)}`,
  },
};

function bound(id, marker = "a") {
  return {
    sessionId: id,
    route,
    umia: {
      sessionToken: marker.repeat(64),
      expiresAt: new Date((second + 600) * 1000).toISOString(),
      attestorAuth: {
        data: {
          id,
          createdAt: second - 1,
          expiresAt: second + 300,
          hostWhitelist: [`${marker}.fixture.example`, "xn--bcher-kva.example"],
        },
        signature: `0x${marker.repeat(130)}`,
      },
    },
  };
}

class Socket extends EventTarget {
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;
  readyState = 1;
  sent = [];
  constructor(url) {
    super();
    this.url = url;
  }
  send(bytes) {
    this.sent.push(proto.RPCMessages.decode(bytes));
  }
  close() {
    this.readyState = this.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

function init(socket) {
  const encoded = new URL(socket.url).searchParams.get("messages");
  return proto.RPCMessages.decode(Buffer.from(encoded, "base64")).messages[0].initRequest;
}

describe("pinned browser AttestorClient bound sockets", () => {
  it("encodes exact signed auth in distinct concurrent and sequential same-URL init messages", () => {
    const sockets = [];
    const sessions = new BoundAttestorSessions({
      makeWebSocket: (url) => {
        const socket = new Socket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const a = sessions.open(bound("private-run-a", "a"));
    const b = sessions.open(bound("private-run-b", "b"));
    expect(sockets).toHaveLength(2);
    expect(sockets[0]).not.toBe(sockets[1]);
    expect(new URL(sockets[0].url).origin).toBe(new URL(route.attestorUrl).origin);
    expect(init(sockets[0]).auth.data.id).toBe("private-run-a");
    expect(init(sockets[1]).auth.data.id).toBe("private-run-b");
    expect(init(sockets[0]).auth.data.createdAt).toBe(second - 1);
    expect(init(sockets[0]).auth.data.expiresAt).toBe(second + 300);
    expect(init(sockets[0]).auth.data.hostWhitelist).toEqual(
      bound("private-run-a").umia.attestorAuth.data.hostWhitelist,
    );
    expect(init(sockets[1]).auth.data.hostWhitelist).toEqual(
      bound("private-run-b", "b").umia.attestorAuth.data.hostWhitelist,
    );
    expect(Buffer.from(init(sockets[0]).auth.signature).toString("hex")).toBe("a".repeat(130));
    expect(String(sockets[0].url)).not.toContain(bound("private-run-a").umia.sessionToken);
    a.close();
    expect(sockets[0].readyState).toBe(sockets[0].CLOSED);
    expect(sockets[1].readyState).toBe(sockets[1].OPEN);
    const next = sessions.open(bound("private-run-a", "c"));
    expect(sockets).toHaveLength(3);
    expect(init(sockets[2]).auth.data.id).toBe("private-run-a");
    expect(Buffer.from(init(sockets[2]).auth.signature).toString("hex")).toBe("c".repeat(130));
    next.close();
    b.close();
    expect(sessions.sessions.size).toBe(0);
  });

  it("closes a replaced identity and all sockets on teardown", () => {
    const sockets = [];
    const sessions = new BoundAttestorSessions({
      makeWebSocket: (url) => {
        const socket = new Socket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const old = sessions.open(bound("private-run", "a"));
    sessions.open(bound("private-run", "b"));
    expect(old.active).toBe(false);
    expect(sockets[0].readyState).toBe(sockets[0].CLOSED);
    expect(sockets[1].readyState).toBe(sockets[1].OPEN);
    sessions.closeAll();
    expect(sockets[1].readyState).toBe(sockets[1].CLOSED);
  });

  it("closes at the session deadline with SESSION_EXPIRED and a plain close with CANCELLED", async () => {
    const sessions = new BoundAttestorSessions({ makeWebSocket: (url) => new Socket(url) });
    const expiring = bound("expiring-run");
    expiring.umia.attestorAuth.data.expiresAt = Math.floor(Date.now() / 1000) + 1;
    const handle = sessions.open(expiring);
    await expect(handle.cancelled).rejects.toThrow("SESSION_EXPIRED");
    expect(handle.active).toBe(false);
    expect(() => handle.assertLive()).toThrow("SESSION_EXPIRED");

    const closed = sessions.open(bound("closed-run"));
    closed.close();
    await expect(closed.cancelled).rejects.toThrow("CANCELLED");
    expect(() => closed.assertLive()).toThrow("CANCELLED");
  });

  it("rejects expired auth before any socket and sends claimTunnel without TEE", async () => {
    const sockets = [];
    const sessions = new BoundAttestorSessions({
      makeWebSocket: (url) => {
        const socket = new Socket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const expired = bound("expired");
    expired.umia.attestorAuth.data.expiresAt = second - 1;
    expect(() => sessions.open(expired)).toThrow("SESSION_EXPIRED");
    const malformed = bound("malformed");
    malformed.umia.attestorAuth.signature = "0xabc";
    expect(() => sessions.open(malformed)).toThrow("ATTESTOR_AUTH_FAILED");
    const beyondSession = bound("beyond-session");
    beyondSession.umia.expiresAt = new Date((second + 200) * 1000).toISOString();
    expect(() => sessions.open(beyondSession)).toThrow("ATTESTOR_AUTH_FAILED");
    expect(sockets).toHaveLength(0);
    const handle = sessions.open(bound("private-run"));
    expect(handle.client.metadata).toBeDefined();
    const response = handle.client.rpc("claimTunnel", {});
    expect(sockets[0].sent).toHaveLength(1);
    expect(sockets[0].sent[0].messages[0].claimTunnelRequest).toBeDefined();
    expect(sockets[0].sent[0].messages[0].claimTeeBundleRequest).toBeUndefined();
    handle.close();
    await expect(response).rejects.toThrow();
    await expect(handle.cancelled).rejects.toThrow("CANCELLED");
  });
});
