import { readFileSync, writeFileSync } from "node:fs";
import { compileMarkCss, generatedModule } from "../src/ui/umia-mark-css-compiler.js";

const assets = new URL("../src/ui/assets/", import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, assets), "utf8"));
const compiled = compileMarkCss(read("umia-mark.json"), read("umia-mark.state-machine.json"));
writeFileSync(new URL("umia-mark-css.generated.js", assets), generatedModule(compiled));
console.log(`umia-mark-css.generated.js: css ${compiled.css.length} B, svg ${compiled.svg.length} B`);
