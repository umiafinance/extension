import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OVERLAY_THEME_PATH } from "../src/themePaths.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export { OVERLAY_THEME_PATH };

const designRoot = join(extensionRoot, "../../shared/design");
const publicDir = join(extensionRoot, "public");

export const PAGE_THEME_PATH = "theme/page.css";
const FONTS = [
  {
    family: "Geist",
    file: "Geist-Variable.woff2",
    weight: "100 900",
    license: "LICENSE-Geist.txt",
  },
  { family: "Sora", file: "Sora-Variable.woff2", weight: "100 800", license: "LICENSE-Sora.txt" },
];

function fail(message) {
  throw new Error(`[design theme] ${message}`);
}

// tokens.css is Terrazzo output: primitives in `:root`, semantic tokens in a light block and a
// `[data-theme=dark]` block. The JS resolver carries no dark values, so the CSS is the source.
export function parseTokenCss(text) {
  const blocks = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    const open = /^(\S.*) \{$/.exec(line);
    if (open) {
      current = new Map();
      blocks.set(open[1], current);
      continue;
    }
    if (line === "}") {
      current = null;
      continue;
    }
    const declaration = /^\s+(--[\w-]+): (.+);$/.exec(line);
    if (declaration && current) current.set(declaration[1], declaration[2]);
  }
  const primitives = blocks.get(":root");
  const light = blocks.get(":root, [data-theme=light]");
  const dark = blocks.get("[data-theme=dark]");
  if (!primitives || !light || !dark) fail("tokens.css no longer has the expected blocks");
  return {
    light: new Map([...primitives, ...light]),
    dark: new Map([...primitives, ...light, ...dark]),
  };
}

function resolveToken(tokens, name, seen = []) {
  if (seen.includes(name)) fail(`token cycle: ${[...seen, name].join(" -> ")}`);
  const value = tokens.get(name);
  if (value === undefined) fail(`${name} is not an @umia/design token`);
  return value.replace(/var\((--[\w-]+)\)/g, (_, ref) =>
    resolveToken(tokens, ref, [...seen, name]),
  );
}

export function referencedTokens(css) {
  return [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]))].sort();
}

// Only the tokens a stylesheet uses, resolved to literals, so the scope needs no primitives.
export function themeCss({ selector, consumers, tokens, fontFaces = "" }) {
  const names = referencedTokens(consumers.join("\n"));
  const light = names.map((name) => [name, resolveToken(tokens.light, name)]);
  const darkValues = names.map((name) => [name, resolveToken(tokens.dark, name)]);
  const dark = darkValues.filter(([, value], index) => value !== light[index][1]);
  const block = (entries, indent) =>
    entries.map(([name, value]) => `${indent}${name}: ${value};`).join("\n");
  return [
    "/* Generated from @umia/design by web/extension/scripts/design-theme.js. Do not edit. */",
    fontFaces,
    `${selector} {\n${block(light, "  ")}\n}`,
    dark.length
      ? `@media (prefers-color-scheme: dark) {\n  ${selector} {\n${block(dark, "    ")}\n  }\n}`
      : "",
    `${selector}[data-umia-theme=light] {\n${block(light, "  ")}\n  color-scheme: light;\n}`,
    `${selector}[data-umia-theme=dark] {\n${block(darkValues, "  ")}\n  color-scheme: dark;\n}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
}

function fontFaceCss() {
  return FONTS.map(
    ({ family, file, weight }) =>
      `@font-face {\n  font-family: "${family}";\n  src: url("fonts/${file}") format("woff2");\n  font-weight: ${weight};\n  font-display: swap;\n}`,
  ).join("\n\n");
}

export function designThemeAssets({ design = designRoot, ui = publicDir } = {}) {
  const tokens = parseTokenCss(readFileSync(join(design, "tokens/tokens.css"), "utf8"));
  const read = (file) => readFileSync(join(ui, file), "utf8");
  return [
    {
      fileName: PAGE_THEME_PATH,
      source: themeCss({
        selector: ":root",
        consumers: [read("grant.css")],
        tokens,
        fontFaces: fontFaceCss(),
      }),
    },
    {
      fileName: OVERLAY_THEME_PATH,
      contentScript: true,
      source: themeCss({
        selector: "#reclaim-protocol-popup",
        consumers: [read("popup-patches.css")],
        tokens,
      }),
    },
    ...FONTS.flatMap(({ file, license }) => [
      { fileName: `theme/fonts/${file}`, source: readFileSync(join(design, "fonts", file)) },
      { fileName: `theme/fonts/${license}`, source: readFileSync(join(design, "fonts", license)) },
    ]),
  ];
}

export function umiaDesignTheme() {
  return {
    name: "umia-design-theme",
    generateBundle() {
      for (const { fileName, source } of designThemeAssets()) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
  };
}
