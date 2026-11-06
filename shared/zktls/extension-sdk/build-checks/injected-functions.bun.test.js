import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, test } from "bun:test";

// Chrome serializes an executeScript function and runs it in the page, where the bundle's Babel
// helpers do not exist. These run each built function the same way, in a context with page globals only.
const BUNDLES = ["ReclaimExtensionSDK.bundle.js", "ReclaimExtensionSDK-mv2.bundle.js"];

function skipQuoted(source, i, quote) {
  for (i++; source[i] !== quote; i++) if (source[i] === "\\") i++;
  return i;
}

function skipTemplate(source, i) {
  for (i++; source[i] !== "`"; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "$" && source[i + 1] === "{") i = closingBrace(source, i + 1);
  }
  return i;
}

function closingBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'") i = skipQuoted(source, i, ch);
    else if (ch === "`") i = skipTemplate(source, i);
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  throw new Error("Unbalanced braces in an injected function");
}

function injectedFunctions(bundle) {
  const source = readFileSync(new URL(`../build/${bundle}`, import.meta.url), "utf8");
  const found = [];
  for (let at = source.indexOf("executeScript("); at !== -1; ) {
    const next = source.indexOf("executeScript(", at + 1);
    const func = source.indexOf("func:", at);
    assert.ok(func !== -1 && (next === -1 || func < next), `${bundle}: executeScript without func`);
    const start = func + "func:".length;
    found.push(source.slice(start, closingBrace(source, source.indexOf("{", start)) + 1));
    at = next;
  }
  return found;
}

const THREW = "the built function threw in the page, so it calls something only the bundle defines";

function inPage(fnSource, { href, interceptor = true } = {}) {
  const sent = [];
  class XMLHttpRequest {
    constructor() {
      this.headers = {};
      sent.push(this);
    }
    open(method, url, async) {
      Object.assign(this, { method, url, async });
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    send(body) {
      this.body = body;
    }
  }
  const window = { location: { href }, ...(interceptor ? { reclaimInterceptor: {} } : {}) };
  const context = vm.createContext({ window, XMLHttpRequest });
  return { context, sent, fn: vm.runInContext(`(${fnSource})`, context) };
}

for (const bundle of BUNDLES) {
  describe(bundle, () => {
    const functions = injectedFunctions(bundle);
    const replay = functions.find((source) => source.includes("XMLHttpRequest"));
    const chain = functions.find((source) => source.includes("readyUrl"));

    test("injects exactly the replay and request-chain functions, neither able to eval", () => {
      assert.equal(functions.length, 2);
      assert.ok(replay && chain);
      for (const source of functions) assert.equal(/\beval\b|new Function/.test(source), false);
    });

    test("the replay sends the document and each companion with the page's credentials", () => {
      const url = "https://github.com/pulls/search?q=author%3A%40me";
      const companion = "https://github.com/search?q=user%3A%40me&type=repositories";
      const page = inPage(replay, { href: url });
      assert.equal(page.fn(url, [companion]).status, "sent", THREW);
      assert.deepEqual(
        page.sent.map(({ method, url, async, withCredentials, body }) => ({
          method,
          url,
          async,
          withCredentials,
          body,
        })),
        [url, companion].map((target) => ({
          method: "GET",
          url: target,
          async: true,
          withCredentials: true,
          body: null,
        })),
      );
      assert.equal(page.sent[1].headers["cache-control"], "no-store");
    });

    test("the replay of a single-request recipe sends only the document", () => {
      const url = "https://github.com/search?q=user%3A%40me&type=repositories";
      const page = inPage(replay, { href: url });
      assert.equal(page.fn(url, []).status, "sent", THREW);
      assert.deepEqual(
        page.sent.map((xhr) => xhr.url),
        [url],
      );
    });

    test("the replay sends nothing from a moved or not-ready page", () => {
      const url = "https://github.com/pulls/search?q=author%3A%40me";
      const moved = inPage(replay, { href: `${url}&page=2` });
      assert.equal(moved.fn(url, []).status, "moved");
      const early = inPage(replay, { href: url, interceptor: false });
      assert.equal(early.fn(url, []).status, "not-ready");
      assert.equal(moved.sent.length + early.sent.length, 0);
    });

    test("a request chain runs under CSP with dynamic code generation blocked", async () => {
      const sent = [];
      const context = vm.createContext(
        {
          fetch: async (url, options) => {
            sent.push({ url, options });
            return {
              ok: true,
              status: 200,
              json: async () => ({ responseObject: { userHandle: "Own/handle?" } }),
            };
          },
          setTimeout() {
            throw new Error("unexpected polling");
          },
        },
        { codeGeneration: { strings: false, wasm: false } },
      );
      const fn = vm.runInContext(`(${chain})`, context);
      const root = "https://api.example";
      const urls = [`${root}/current`, `${root}/profile/{{URL_PARAM_1_SECRET}}`];
      const plan = {
        readyUrl: `${root}/pin`,
        responseParameters: [
          {
            requestIndex: 0,
            path: ["responseObject", "userHandle"],
            parameter: "URL_PARAM_1_SECRET",
          },
        ],
      };
      assert.equal(fn(plan, urls, Date.now() + 5000).status, "executed", THREW);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        sent.map((request) => request.url),
        [`${root}/pin`, `${root}/current`, `${root}/profile/Own%2Fhandle%3F`],
      );
      assert.ok(
        sent.every(
          (request) =>
            request.options.credentials === "include" && request.options.redirect === "error",
        ),
      );
    });
    test("the request chain splits the UUID into five hyphen-separated secrets", async () => {
      const sent = [];
      const id = "d16c8d0d-0000-4000-8000-000000000001";
      const context = vm.createContext(
        {
          fetch: async (url) => {
            sent.push(url);
            return { ok: true, status: 200, json: async () => ({ responseObject: { id } }) };
          },
        },
        { codeGeneration: { strings: false, wasm: false } },
      );
      const fn = vm.runInContext(`(${chain})`, context);
      const root = "https://api.example";
      const plan = {
        readyUrl: `${root}/pin`,
        responseParameters: [
          {
            requestIndex: 0,
            path: ["responseObject", "id"],
            parameter: "URL_PARAM_1_SECRET",
            slice: [0, 8],
          },
          {
            requestIndex: 0,
            path: ["responseObject", "id"],
            parameter: "URL_PARAM_2_SECRET",
            slice: [9, 13],
          },
          {
            requestIndex: 0,
            path: ["responseObject", "id"],
            parameter: "URL_PARAM_3_SECRET",
            slice: [14, 18],
          },
          {
            requestIndex: 0,
            path: ["responseObject", "id"],
            parameter: "URL_PARAM_4_SECRET",
            slice: [19, 23],
          },
          {
            requestIndex: 0,
            path: ["responseObject", "id"],
            parameter: "URL_PARAM_5_SECRET",
            slice: [24, 36],
          },
        ],
      };
      fn(
        plan,
        [
          `${root}/current`,
          `${root}/users/{{URL_PARAM_1_SECRET}}-{{URL_PARAM_2_SECRET}}-{{URL_PARAM_3_SECRET}}-{{URL_PARAM_4_SECRET}}-{{URL_PARAM_5_SECRET}}`,
        ],
        Date.now() + 5000,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(sent, [`${root}/pin`, `${root}/current`, `${root}/users/${id}`]);
    });
  });
}
