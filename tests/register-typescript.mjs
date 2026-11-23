import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL) {
      const target = new URL(specifier, context.parentURL);
      if (!/\.[a-z]+$/i.test(target.pathname)) {
        target.pathname += ".ts";
        if (existsSync(fileURLToPath(target))) return nextResolve(target.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && new URL(url).pathname.endsWith(".ts")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      return { format: "module", shortCircuit: true, source: ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
    }
    return nextLoad(url, context);
  },
});
