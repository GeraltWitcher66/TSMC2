import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local preview of the built site. The browser must load the page from an
 * http origin (not file://) for the market data requests to be permitted.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "dist");
const requestedPort = Number(process.env.PORT);
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

http
  .createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    if (relative.endsWith("/")) relative += "index.html";
    const file = path.join(root, relative);
    if (!file.startsWith(root + path.sep) && file !== root) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("forbidden");
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    createReadStream(file).pipe(response);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`پیش‌نمایش محلی: http://127.0.0.1:${port}/`);
  });
