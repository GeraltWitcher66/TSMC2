import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const dist = path.join(here, "dist");
const appCssPath = path.join(repo, "app", "globals.css");
const fontDir = path.join(repo, "node_modules", "@fontsource-variable", "vazirmatn", "files");

const FONT_FILES = [
  "vazirmatn-arabic-wght-normal.woff2",
  "vazirmatn-latin-ext-wght-normal.woff2",
  "vazirmatn-latin-wght-normal.woff2",
];

/**
 * The screens import their data client from the shared library. For this build
 * the same specifier resolves to the browser implementation, so no route, no
 * server and no network endpoint is involved.
 */
const browserDataClient = {
  name: "browser-data-client",
  setup(builder) {
    // Matches both "./lib/data-client" and the sibling "./data-client" import.
    builder.onResolve({ filter: /(^|\/)(lib\/)?data-client$/ }, () => ({
      path: path.join(here, "src", "api", "data-client.ts"),
    }));
  },
};

function kib(bytes) {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, "fonts"), { recursive: true });

  const [appCss, fontCss, shellCss] = await Promise.all([
    readFile(appCssPath, "utf8"),
    readFile(path.join(here, "src", "fonts.css"), "utf8"),
    readFile(path.join(here, "src", "shell.css"), "utf8"),
  ]);
  // The utility framework is only a build-time layer in the deployed project;
  // this stylesheet keeps the hand-written rules that the screens use.
  const styles = [fontCss, appCss.replace(/@import\s+["']tailwindcss["'];?\s*/g, ""), shellCss].join("\n\n");
  await writeFile(path.join(dist, "styles.css"), styles, "utf8");

  await build({
    entryPoints: [path.join(here, "src", "main.tsx")],
    outfile: path.join(dist, "app.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome109", "firefox115"],
    jsx: "automatic",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    charset: "utf8",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [browserDataClient],
    logLevel: "warning",
  });

  await copyFile(path.join(here, "index.html"), path.join(dist, "index.html"));
  await copyFile(path.join(repo, "public", "favicon.svg"), path.join(dist, "favicon.svg"));
  await writeFile(path.join(dist, ".nojekyll"), "", "utf8");

  let missingFonts = 0;
  for (const name of FONT_FILES) {
    try {
      await copyFile(path.join(fontDir, name), path.join(dist, "fonts", name));
    } catch {
      missingFonts += 1;
      console.warn(`[font] ${name} در node_modules پیدا نشد.`);
    }
  }
  if (missingFonts === FONT_FILES.length) {
    throw new Error("فونت‌های محلی پیدا نشدند؛ ابتدا در ریشه پروژه دستور npm install را اجرا کنید.");
  }

  const files = ["app.js", "styles.css", "index.html", "favicon.svg"];
  console.log("خروجی استاتیک ساخته شد: static/dist");
  for (const file of files) {
    const info = await stat(path.join(dist, file));
    console.log(`  ${file.padEnd(14)} ${kib(info.size)}`);
  }
  console.log(`  fonts/         ${FONT_FILES.length} فایل`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
