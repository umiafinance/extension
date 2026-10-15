import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  designThemeAssets,
  OVERLAY_THEME_PATH,
  PAGE_THEME_PATH,
  parseTokenCss,
  referencedTokens,
  themeCss,
} from "./design-theme.js";

const extensionRoot = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(extensionRoot, path), "utf8");
const UI_FILES = ["public/grant.html", "public/grant.css", "public/popup-patches.css"];
const assets = designThemeAssets();
const asset = (fileName) => assets.find((entry) => entry.fileName === fileName);

const TOKENS = `:root {
  --color-neutral-0: rgb(100% 100% 100%);
  --color-neutral-950: rgb(10% 10% 10%);
}

:root, [data-theme=light] {
  --color-text-primary: var(--color-neutral-950);
  --color-surface-default: var(--color-neutral-0);
}

[data-theme=dark] {
  --color-text-primary: var(--color-neutral-0);
  --color-surface-default: var(--color-neutral-950);
}
`;

test("UI styles name colours only through design tokens", () => {
  for (const path of UI_FILES) {
    const source = read(path).replace(/\sd="[^"]*"/g, "");
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i, path);
  }
});

test("every token the UI styles read is defined by the emitted theme", () => {
  for (const [css, theme] of [
    [read("public/grant.css"), asset(PAGE_THEME_PATH).source],
    [read("public/popup-patches.css"), asset(OVERLAY_THEME_PATH).source],
  ]) {
    const used = referencedTokens(css);
    assert.ok(used.length > 10);
    for (const name of used) assert.match(theme, new RegExp(`^  ${name}: `, "m"), name);
  }
});

test("a variable outside the design system fails the build", () => {
  assert.throws(
    () =>
      themeCss({
        selector: ":root",
        consumers: ["a { color: var(--brand-blue); }"],
        tokens: parseTokenCss(TOKENS),
      }),
    /--brand-blue is not an @umia\/design token/,
  );
});

test("dark values come from the dark token block under prefers-color-scheme", () => {
  const css = themeCss({
    selector: "#popup",
    consumers: [
      "a { color: var(--color-text-primary); background: var(--color-surface-default); }",
    ],
    tokens: parseTokenCss(TOKENS),
  });
  assert.match(css, /#popup \{\n {2}--color-surface-default: rgb\(100% 100% 100%\);/);
  assert.match(
    css,
    /@media \(prefers-color-scheme: dark\) \{\n {2}#popup \{\n {4}--color-surface-default: rgb\(10% 10% 10%\);\n {4}--color-text-primary: rgb\(100% 100% 100%\);/,
  );
  assert.match(
    css,
    /#popup\[data-umia-theme=light\] \{\n {2}--color-surface-default: rgb\(100% 100% 100%\);/,
  );
  assert.match(
    css,
    /#popup\[data-umia-theme=dark\] \{\n {2}--color-surface-default: rgb\(10% 10% 10%\);/,
  );
});

test("the overlay theme stays scoped to the popup on provider pages", () => {
  const overlay = asset(OVERLAY_THEME_PATH);
  assert.equal(overlay.contentScript, true);
  assert.doesNotMatch(overlay.source, /:root|@font-face|url\(/);
  const selectors = overlay.source.match(/^ *[^@\n]+(?= \{$)/gm).map((line) => line.trim());
  assert.deepEqual(
    [...new Set(selectors)],
    [
      "#reclaim-protocol-popup",
      "#reclaim-protocol-popup[data-umia-theme=light]",
      "#reclaim-protocol-popup[data-umia-theme=dark]",
    ],
  );
});

test("the grant page loads the Hub fonts from the package, never a remote host", () => {
  const html = read("public/grant.html");
  assert.ok(
    html.indexOf(`href="${PAGE_THEME_PATH}"`) < html.indexOf('href="grant.css"'),
    "the theme loads before the page styles",
  );
  const page = asset(PAGE_THEME_PATH).source;
  for (const [, url] of page.matchAll(/url\("([^"]+)"\)/g)) {
    const font = asset(`theme/${url}`);
    assert.ok(font, url);
    assert.deepEqual(font.source, readFileSync(join(extensionRoot, "../../shared/design", url)));
  }
  assert.match(page, /font-family: "Geist"/);
  assert.match(page, /font-family: "Sora"/);
  for (const source of [html, read("public/grant.css"), page]) {
    assert.doesNotMatch(source, /https?:\/\//);
  }
});

test("the font licences ship next to the fonts", () => {
  assert.ok(asset("theme/fonts/LICENSE-Geist.txt"));
  assert.ok(asset("theme/fonts/LICENSE-Sora.txt"));
});
