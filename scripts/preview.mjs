import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve("out");
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain" };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1:3000");
    let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) { response.writeHead(403); response.end(); return; }
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, "index.html");
    response.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(await fs.readFile(file));
  } catch { response.writeHead(404); response.end("Not found"); }
});
server.listen(3000, "127.0.0.1", () => console.log("NoteLah preview: http://127.0.0.1:3000"));
