export interface ZktlsRequestChain {
  readyUrl: string;
  responseParameters: Array<{
    requestIndex: number;
    path: string[];
    parameter: string;
    slice?: [number, number];
  }>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Reviewed data only: no executable source or page-supplied destinations. */
export function parseZktlsRequestChain(
  value: unknown,
  requests?: unknown,
): ZktlsRequestChain | null {
  if (
    !object(value) ||
    Object.keys(value).some((key) => key !== "readyUrl" && key !== "responseParameters") ||
    typeof value.readyUrl !== "string" ||
    !Array.isArray(value.responseParameters) ||
    value.responseParameters.length > 16
  )
    return null;
  try {
    const url = new URL(value.readyUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.href !== value.readyUrl
    )
      return null;
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const mapping of value.responseParameters) {
    if (
      !object(mapping) ||
      Object.keys(mapping).some(
        (key) => !["requestIndex", "path", "parameter", "slice"].includes(key),
      ) ||
      !Number.isInteger(mapping.requestIndex) ||
      Number(mapping.requestIndex) < 0 ||
      Number(mapping.requestIndex) >= 64 ||
      !Array.isArray(mapping.path) ||
      mapping.path.length === 0 ||
      mapping.path.length > 8 ||
      mapping.path.some(
        (key) =>
          typeof key !== "string" ||
          !key ||
          ["__proto__", "prototype", "constructor"].includes(key),
      ) ||
      typeof mapping.parameter !== "string" ||
      !/^[A-Z][A-Z0-9_]*_SECRET$/.test(mapping.parameter) ||
      (mapping.slice !== undefined &&
        (!Array.isArray(mapping.slice) ||
          mapping.slice.length !== 2 ||
          !mapping.slice.every(Number.isInteger) ||
          mapping.slice[0] < 0 ||
          mapping.slice[1] <= mapping.slice[0] ||
          mapping.slice[1] > 256)) ||
      names.has(mapping.parameter)
    )
      return null;
    names.add(mapping.parameter);
  }
  if (requests !== undefined) {
    if (!Array.isArray(requests) || !requests.length || requests.length > 64) return null;
    for (const [index, request] of requests.entries()) {
      if (
        !object(request) ||
        request.method !== "GET" ||
        typeof request.url !== "string" ||
        !["TEMPLATE", "CONSTANT", undefined].includes(request.urlType as string | undefined) ||
        (object(request.bodySniff) && request.bodySniff.enabled)
      )
        return null;
      try {
        const url = new URL(request.url);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.hash ||
          url.host.includes("{{")
        )
          return null;
      } catch {
        return null;
      }
      if (request.url === value.readyUrl) return null;
      for (const match of request.url.matchAll(/\{\{(\w+)\}\}/g)) {
        if (
          !value.responseParameters.some(
            (mapping) => mapping.parameter === match[1] && mapping.requestIndex < index,
          )
        )
          return null;
      }
    }
    if (value.responseParameters.some((mapping) => mapping.requestIndex >= requests.length - 1))
      return null;
  }
  return value as unknown as ZktlsRequestChain;
}
