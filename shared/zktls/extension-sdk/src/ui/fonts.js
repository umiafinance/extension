// Chrome ignores @font-face inside a shadow root, so the faces go on the document. `baseUrl` is
// where the SDK build's fonts/ directory is served from.
const FACES = [
  ["Umia Geist", "Geist-Variable.woff2", "100 900"],
  ["Umia Geist Mono", "GeistMono-Variable.woff2", "100 900"],
  ["Umia Sora", "Sora-Variable.woff2", "100 800"],
];

const STYLE_ID = "umia-extension-fonts";

export function installFonts(doc, baseUrl) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = FACES.map(
    ([family, file, weight]) =>
      `@font-face{font-family:"${family}";src:url("${baseUrl}${file}") format("woff2");font-weight:${weight};font-display:swap}`,
  ).join("\n");
  (doc.head ?? doc.documentElement).appendChild(style);
}
