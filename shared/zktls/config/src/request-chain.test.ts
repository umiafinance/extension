import { describe, expect, it } from "vitest";
import { parseZktlsRequestChain } from "./request-chain";

const plan = () => ({
  readyUrl: "https://api.example/pin",
  responseParameters: [
    { requestIndex: 0, path: ["responseObject", "userHandle"], parameter: "URL_PARAM_1_SECRET" },
  ],
});
const requests = [
  { method: "GET", url: "https://api.example/current" },
  { method: "GET", url: "https://api.example/profile/{{URL_PARAM_1_SECRET}}" },
];

describe("reviewed request chains", () => {
  it("resolves a later secret URL parameter from an earlier JSON response", () => {
    expect(parseZktlsRequestChain(plan(), requests)).toEqual(plan());
  });
  it.each([
    { ...plan(), readyUrl: "http://api.example/pin" },
    { ...plan(), readyUrl: "https://user:password@api.example/pin" },
    { ...plan(), code: "fetch('https://elsewhere.example')" },
    { ...plan(), responseParameters: [{ ...plan().responseParameters[0], path: ["__proto__"] }] },
    { ...plan(), responseParameters: [{ ...plan().responseParameters[0], parameter: "public" }] },
    { ...plan(), responseParameters: [{ ...plan().responseParameters[0], requestIndex: 1 }] },
    { ...plan(), responseParameters: [] },
    { ...plan(), readyUrl: requests[0]!.url },
  ])("rejects unsafe or unresolvable plans", (candidate) => {
    expect(parseZktlsRequestChain(candidate, requests)).toBeNull();
  });
  it("rejects non-GETs and templates in destination hosts", () => {
    expect(
      parseZktlsRequestChain(plan(), [{ ...requests[0], method: "POST" }, requests[1]]),
    ).toBeNull();
    expect(
      parseZktlsRequestChain(plan(), [
        requests[0],
        { method: "GET", url: "https://{{URL_PARAM_1_SECRET}}/" },
      ]),
    ).toBeNull();
  });
  it("permits sliced secrets and refuses any public parameter", () => {
    const mapping = { ...plan().responseParameters[0], slice: [14, 36] };
    expect(parseZktlsRequestChain({ ...plan(), responseParameters: [mapping] })).not.toBeNull();
    expect(
      parseZktlsRequestChain({ ...plan(), responseParameters: [{ ...mapping, slice: [36, 14] }] }),
    ).toBeNull();
    for (const parameter of ["account_url_fragment", "account", "URL_PARAM_1"]) {
      expect(
        parseZktlsRequestChain({ ...plan(), responseParameters: [{ ...mapping, parameter }] }),
      ).toBeNull();
    }
  });
});
