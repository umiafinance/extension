import { afterEach, expect, test } from "bun:test";
import {
  ZKTLS_LOGIN_URL_GOLDEN,
  ZKTLS_PATH_SEGMENT_GOLDEN,
} from "@umia/zktls-config/login-url.golden";
import { API_ENDPOINTS } from "../src/utils/constants/constants.js";
import { fetchProviderData } from "../src/utils/fetch-calls.js";

const BACKEND = "https://api.umia.localhost/zktls";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function session() {
  const now = Math.floor(Date.now() / 1000);
  return {
    sessionId: "synthetic-session",
    umia: {
      sessionToken: "a".repeat(64),
      expiresAt: new Date((now + 600) * 1000).toISOString(),
      attestorAuth: { data: { id: "synthetic-session", createdAt: now, expiresAt: now + 300 } },
    },
    route: {
      backendUrl: BACKEND,
      network: { environment: "devnet", chainId: 10143 },
    },
  };
}

test.each(ZKTLS_LOGIN_URL_GOLDEN)("the extension opens login URL %j: %s", async (loginUrl, accepted) => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        providers: {
          id: "provider-one",
          recipeDigest: `sha256:${"a".repeat(64)}`,
          providerConfigs: [{ loginUrl }],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const result = fetchProviderData("provider-one", session());
  if (accepted) expect((await result).loginUrl).toBe(loginUrl);
  else await expect(result).rejects.toThrow("Provider login URL unavailable");
});

test.each(ZKTLS_PATH_SEGMENT_GOLDEN)("the extension fetches path segment %j: %s", (segment, accepted) => {
  const build = () => API_ENDPOINTS.PROVIDER_URL(segment, BACKEND);
  if (accepted) expect(build()).toBe(`${BACKEND}/api/providers/${segment}`);
  else expect(build).toThrow("Invalid backend path segment");
});

test("a provider carrying injection code is rejected before any tab opens", async () => {
  const provider = {
    id: "provider-one",
    recipeDigest: `sha256:${"a".repeat(64)}`,
    providerConfigs: [{ loginUrl: "https://fomo.family/" }],
  };
  const serve = (extra) => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ providers: { ...provider, ...extra } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  };
  serve({});
  expect((await fetchProviderData("provider-one", session())).loginUrl).toBe("https://fomo.family/");
  for (const extra of [
    { customInjection: "fetch('/x')" },
    { customInjectionSha256: `sha256:${"b".repeat(64)}` },
  ]) {
    serve(extra);
    await expect(fetchProviderData("provider-one", session())).rejects.toThrow(
      "Pinned provider metadata rejected",
    );
  }
});
