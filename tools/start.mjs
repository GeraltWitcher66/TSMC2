import { registerHooks } from "node:module";
import { parseArgs } from "node:util";

// Vinext 0.0.50 indexes cached assets using Windows path separators. Normalize
// only its URL cache keys at load time; never modify the installed dependency.
if (process.platform === "win32") {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.endsWith("/vinext/dist/server/static-file-cache.js")) return loaded;
      const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
      return { ...loaded, source: source.replace("relativePath: path.relative(base, batch[j]),", 'relativePath: path.relative(base, batch[j]).split(path.sep).join("/"),') };
    },
  });
}

const { values } = parseArgs({ options: { port: { type: "string", short: "p" }, hostname: { type: "string", short: "H" } } });
const { startProdServer } = await import("vinext/server/prod-server");
await startProdServer({ port: Number(values.port ?? process.env.PORT ?? 3000), host: values.hostname ?? process.env.HOST ?? "127.0.0.1" });
