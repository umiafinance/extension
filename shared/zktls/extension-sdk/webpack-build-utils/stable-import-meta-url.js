const path = require("path");
const { ConstDependency } = require("webpack").dependencies;
const BasicEvaluatedExpression = require("webpack/lib/javascript/BasicEvaluatedExpression");

const PLUGIN_NAME = "StableImportMetaUrlPlugin";
const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

// The module's path from its own package root, so it is the same in every checkout.
function stableFileUrl(resource, root) {
  const at = resource.lastIndexOf(NODE_MODULES);
  const relative =
    at === -1
      ? path.relative(root, resource)
      : `node_modules${path.sep}${resource.slice(at + NODE_MODULES.length)}`;
  return `file:///${relative.split(path.sep).join("/")}`;
}

// webpack inlines import.meta.url as the module's absolute file URL, which bakes the checkout
// path into the bundle. Only attestor-core's Node-only local file fetch reads it; the browser
// fetches circuits from the extension-relative base, so its runtime resolution is unchanged.
class StableImportMetaUrlPlugin {
  constructor(root) {
    this.root = root;
  }

  apply(compiler) {
    compiler.hooks.compilation.tap(PLUGIN_NAME, (_compilation, { normalModuleFactory }) => {
      const handler = (parser) => {
        const url = () => stableFileUrl(parser.state.module.resource, this.root);
        parser.hooks.expression.for("import.meta.url").tap(PLUGIN_NAME, (expression) => {
          const dependency = new ConstDependency(JSON.stringify(url()), expression.range);
          dependency.loc = parser.getLocation(expression);
          parser.state.module.addPresentationalDependency(dependency);
          return true;
        });
        parser.hooks.evaluateIdentifier
          .for("import.meta.url")
          .tap(PLUGIN_NAME, (expression) =>
            new BasicEvaluatedExpression().setString(url()).setRange(expression.range),
          );
      };
      for (const type of ["javascript/auto", "javascript/esm"]) {
        normalModuleFactory.hooks.parser.for(type).tap(PLUGIN_NAME, handler);
      }
    });
  }
}

module.exports = { StableImportMetaUrlPlugin, stableFileUrl };
