// Local preview without Vercel: node dev.mjs → http://localhost:3000 (in-memory data unless KV env vars are set)
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/api/")) {
    const name = u.pathname.slice(5).replace(/[^a-z]/g, "");
    let raw = ""; for await (const ch of req) raw += ch;
    req.query = Object.fromEntries(u.searchParams); req.body = raw ? JSON.parse(raw) : {};
    try { const mod = await import(path.join(root, "api", name + ".js")); return mod.default(req, res); } catch (e) { res.statusCode = 404; return res.end("{}"); }
  }
  let p = path.join(root, decodeURIComponent(u.pathname));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!fs.existsSync(p) && /^\/[a-z0-9][a-z0-9-]{1,29}$/.test(u.pathname)) p = path.join(root, "index.html");  // same as vercel.json rewrite
  if (!fs.existsSync(p)) { res.statusCode = 404; return res.end("not found"); }
  res.setHeader("Content-Type", types[path.extname(p)] || "application/octet-stream"); fs.createReadStream(p).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log("http://localhost:" + (process.env.PORT || 3000)));
