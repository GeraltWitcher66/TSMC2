import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

const read = (name) => readFile(path.join(dist, name), "utf8");

test("the build ships a self-contained page with relative asset paths", async () => {
  const html = await read("index.html");
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /href="\.\/favicon\.svg"/);
  assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//);
  const script = await stat(path.join(dist, "app.js"));
  assert.ok(script.size > 200_000, "the bundle should contain the screens");
});

test("no local data endpoint call survives in the build output", async () => {
  // Remote data-source URLs (https://host/api/...) are expected; what must not
  // survive is any call to one of the application's own routes.
  const localRoutes = [
    "/api/screener",
    "/api/holders",
    "/api/holder-increases",
    "/api/market-highlights",
    "/api/market-universe",
    "/api/market-color",
    "/api/tsetmc-relay",
  ];
  const files = ["index.html", "styles.css", "app.js"];
  for (const file of files) {
    const content = await read(file);
    for (const route of localRoutes) {
      assert.equal(content.includes(route), false, `${file} must not call ${route}`);
    }
  }
});

test("fonts and icons are local and the page requests no external asset", async () => {
  const css = await read("styles.css");
  assert.match(css, /url\(\.\/fonts\/vazirmatn-arabic-wght-normal\.woff2\)/);
  assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic|@import\s+url\(\s*["']?https?:/);
  assert.doesNotMatch(css, /@import\s+url\(\s*["']?\/\//);
  const font = await stat(path.join(dist, "fonts", "vazirmatn-arabic-wght-normal.woff2"));
  assert.ok(font.size > 10_000);
  await stat(path.join(dist, "favicon.svg"));
});

test("the bundle is minified and carries no source map reference", async () => {
  const js = await read("app.js");
  assert.doesNotMatch(js, /sourceMappingURL/);
  // The embedded symbol list keeps some source line breaks, so judge density.
  const lines = js.split("\n").length;
  assert.ok(js.length / lines > 400, "the bundle should be minified");
});
