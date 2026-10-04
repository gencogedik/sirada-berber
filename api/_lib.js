// Shared helpers for all API routes (files starting with "_" are not routes on Vercel).
import crypto from "node:crypto";

/* ---------------- storage: Upstash Redis REST, or in-memory for local dev ---------------- */
// Works with: Upstash REST (KV_REST_API_URL + KV_REST_API_TOKEN), any Redis via REDIS_URL (Vercel "Redis" / Redis Cloud), or in-memory for local dev.
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";
const useRest = !!(URL_ && TOKEN), useTcp = !useRest && !!REDIS_URL;
export const hasDb = useRest || useTcp;
const DB_SECRET = TOKEN || REDIS_URL;

async function tcp() {
  const g = globalThis;
  if (g.__siradaRedis && g.__siradaRedis.isReady) return g.__siradaRedis;
  if (!g.__siradaRedisP) {
    g.__siradaRedisP = (async () => {
      const { createClient } = await import("redis");
      const c = createClient({ url: REDIS_URL, socket: { connectTimeout: 8000, reconnectStrategy: (n) => Math.min(n * 200, 2000) } });
      c.on("error", (e) => console.error("redis", e.message));
      await c.connect();
      g.__siradaRedis = c; return c;
    })().catch((e) => { g.__siradaRedisP = null; throw e; });
  }
  return g.__siradaRedisP;
}

const mem = globalThis.__siradaMem || (globalThis.__siradaMem = { kv: new Map(), exp: new Map() });
function memAlive(k) { const e = mem.exp.get(k); if (e && e < Date.now()) { mem.kv.delete(k); mem.exp.delete(k); } return mem.kv.has(k); }
async function memCmd(c) {
  const [op, k, ...a] = c; const O = String(op).toUpperCase();
  switch (O) {
    case "GET": return memAlive(k) ? mem.kv.get(k) : null;
    case "SET": {
      const nx = a.includes("NX"); const ei = a.indexOf("EX");
      if (nx && memAlive(k)) return null;
      mem.kv.set(k, String(a[0])); if (ei > -1) mem.exp.set(k, Date.now() + Number(a[ei + 1]) * 1000); else mem.exp.delete(k);
      return "OK";
    }
    case "DEL": { let n = 0; for (const x of [k, ...a]) { if (mem.kv.delete(x)) n++; mem.exp.delete(x); } return n; }
    case "INCR": { const v = (memAlive(k) ? Number(mem.kv.get(k)) : 0) + 1; mem.kv.set(k, String(v)); return v; }
    case "EXPIRE": mem.exp.set(k, Date.now() + Number(a[0]) * 1000); return 1;
    case "HSET": { const h = memAlive(k) ? mem.kv.get(k) : new Map(); for (let i = 0; i < a.length; i += 2) h.set(a[i], String(a[i + 1])); mem.kv.set(k, h); return 1; }
    case "HGET": return memAlive(k) ? (mem.kv.get(k).get(a[0]) ?? null) : null;
    case "HDEL": { if (!memAlive(k)) return 0; return a.reduce((n, f) => n + (mem.kv.get(k).delete(f) ? 1 : 0), 0); }
    case "HGETALL": { if (!memAlive(k)) return []; const out = []; for (const [f, v] of mem.kv.get(k)) out.push(f, v); return out; }
    case "HEXISTS": return memAlive(k) && mem.kv.get(k).has(a[0]) ? 1 : 0;
    default: throw new Error("mem: unsupported " + O);
  }
}
export async function redis(...cmd) {
  if (!hasDb) return memCmd(cmd);
  if (useTcp) {
    const c = await tcp();
    const r = await c.sendCommand(cmd.map(String));
    return Buffer.isBuffer(r) ? r.toString() : r;
  }
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd.map(String)) });
  const j = await r.json();
  if (j.error) throw new Error("redis: " + j.error);
  return j.result;
}
export async function getJSON(k) { const v = await redis("GET", k); return v ? JSON.parse(v) : null; }
export async function setJSON(k, v) { return redis("SET", k, JSON.stringify(v)); }
export async function hgetJSON(h, f) { const v = await redis("HGET", h, f); return v ? JSON.parse(v) : null; }
export async function hsetJSON(h, f, v) { return redis("HSET", h, f, JSON.stringify(v)); }
export async function hallJSON(h) { const a = (await redis("HGETALL", h)) || []; const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = JSON.parse(a[i + 1]); return o; }

/* ---------------- http helpers ---------------- */
export function send(res, code, obj, headers = {}) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}
export const fail = (res, code, msg) => send(res, code, { error: msg });
export function body(req) { const b = req.body; if (!b) return {}; if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } } return b; }
export function query(req) { if (req.query) return req.query; const u = new URL(req.url, "http://x"); return Object.fromEntries(u.searchParams); }
export function ip(req) { return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0].trim(); }
export async function rateLimit(key, max, sec) { const n = await redis("INCR", "rl:" + key); if (n === 1) await redis("EXPIRE", "rl:" + key, sec); return n <= max; }
export const rid = (n = 10) => crypto.randomBytes(n).toString("base64url");
export const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("base64url");
export const clip = (s, n) => String(s ?? "").trim().slice(0, n);

/* ---------------- time (Türkiye: UTC+3, no DST) ---------------- */
const TR = 3 * 3600e3;
const pad = (n) => String(n).padStart(2, "0");
export function trNow() { const d = new Date(Date.now() + TR); return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, min: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
export const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
export const fmt = (m) => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
export function addDays(date, n) { const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export const weekday = (date) => new Date(date + "T00:00:00Z").getUTCDay();
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
export function startTs(date, time) { return Date.parse(date + "T00:00:00Z") - TR + toMin(time) * 60e3; }

/* ---------------- config ---------------- */
export const STEP = 30;
export const DEFAULT_CFG = {
  shopName: "Berber", address: "", phone: "",
  open: "09:00", close: "20:00", breakStart: "", breakEnd: "",
  closed: [1], horizon: 14, minNotice: 30, cancelHours: 2,
  services: [
    { id: "s1", name: "Saç kesimi", dur: 30, price: 400 },
    { id: "s2", name: "Sakal tıraşı", dur: 30, price: 250 },
    { id: "s3", name: "Saç + sakal", dur: 60, price: 600 },
    { id: "s4", name: "Çocuk tıraşı", dur: 30, price: 300 }
  ],
  barbers: []
};
export async function getCfg() { const c = await getJSON("cfg"); return { ...DEFAULT_CFG, ...(c || {}) }; }
export const publicCfg = (c) => ({ shopName: c.shopName, address: c.address, phone: c.phone, open: c.open, close: c.close, breakStart: c.breakStart, breakEnd: c.breakEnd,
  closed: c.closed, horizon: c.horizon, minNotice: c.minNotice, cancelHours: c.cancelHours, services: c.services, barbers: c.barbers.filter(b => b.active !== false).map(b => ({ id: b.id, name: b.name })) });
export function inHours(c, m, dur) {
  const o = toMin(c.open), cl = toMin(c.close);
  if (m < o || m + dur > cl || m % STEP) return false;
  const bs = toMin(c.breakStart), be = toMin(c.breakEnd);
  if (!isNaN(bs) && !isNaN(be) && bs < be && m < be && bs < m + dur) return false;
  return true;
}

/* ---------------- slot locks (atomic, one key per 30-min block) ---------------- */
const lockKey = (date, barberId, m) => `sl:${date}:${barberId}:${fmt(m).replace(":", "")}`;
function lockTtl(date) { return Math.max(3600, Math.round((Date.parse(date + "T00:00:00Z") + 3 * 864e5 - Date.now()) / 1000)); }
export async function lockRange(date, barberId, m, dur, owner) {
  const got = [];
  for (let x = m; x < m + dur; x += STEP) {
    const k = lockKey(date, barberId, x);
    const ok = await redis("SET", k, owner, "NX", "EX", lockTtl(date));
    if (ok !== "OK") { const cur = await redis("GET", k); if (cur === owner) { got.push(k); continue; } for (const g of got) await redis("DEL", g); return false; }
    got.push(k);
  }
  return true;
}
export async function unlockRange(date, barberId, m, dur, owner) {
  for (let x = m; x < m + dur; x += STEP) { const k = lockKey(date, barberId, x); const cur = await redis("GET", k); if (cur === owner) await redis("DEL", k); }
}

/* ---------------- bookings ---------------- */
export function validPhone(p) { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("90") && d.length === 12) d = "0" + d.slice(2); if (d.length === 10 && d[0] === "5") d = "0" + d; return /^05\d{9}$/.test(d) ? d : null; }

export async function createBooking(c, { serviceId, barberId, date, time, name, phone, note }, meta) {
  const s = c.services.find(x => x.id === serviceId);
  if (!s) return { error: "Hizmet bulunamadı." };
  if (!isDate(date)) return { error: "Geçersiz gün." };
  const now = trNow();
  if (date < now.date || date > addDays(now.date, Number(c.horizon) - 1)) return { error: "Bu gün için randevu açık değil." };
  if (c.closed.includes(weekday(date))) return { error: "Dükkân bu gün kapalı." };
  const m = toMin(time);
  if (!inHours(c, m, s.dur)) return { error: "Bu saat çalışma saatleri dışında." };
  if (meta.source === "online" && date === now.date && m <= now.min + Number(c.minNotice || 0)) return { error: "Bu saat için artık çok geç; daha ileri bir saat seç." };
  if (meta.source !== "online" && date === now.date && m + s.dur <= now.min) return { error: "Geçmiş bir saate randevu eklenemez." };
  const nm = clip(name, 60), ph = validPhone(phone);
  if (nm.length < 2) return { error: "Adını yaz." };
  if (!ph) return { error: "Telefonu 05xx xxx xx xx biçiminde yaz." };
  const active = c.barbers.filter(b => b.active !== false);
  const order = barberId && barberId !== "any" ? active.filter(b => b.id === barberId) : active;
  if (!order.length) return { error: "Usta bulunamadı." };
  const id = rid(9);
  let chosen = null;
  for (const b of order) { if (await lockRange(date, b.id, m, s.dur, id)) { chosen = b; break; } }
  if (!chosen) return { error: "Bu saat az önce doldu. Başka bir saat seç.", code: "taken" };
  const key = rid(16);
  const bk = { id, date, time: fmt(m), dur: s.dur, serviceId: s.id, serviceName: s.name, price: Number(s.price) || 0, barberId: chosen.id,
    name: nm, phone: ph, note: clip(note, 240), staffNote: "", status: "bekliyor", source: meta.source, by: meta.by || null,
    createdAt: Date.now(), updatedAt: Date.now(), keyHash: sha(key), history: [] };
  await hsetJSON("bk", id, bk);
  return { booking: bk, key };
}
export async function cancelBooking(bk, by) {
  if (bk.status !== "iptal") await unlockRange(bk.date, bk.barberId, toMin(bk.time), bk.dur, bk.id);
  bk.status = "iptal"; bk.cancelledBy = by; bk.updatedAt = Date.now();
  await hsetJSON("bk", bk.id, bk);
  return bk;
}
export const customerView = (bk, c) => ({ id: bk.id, date: bk.date, time: bk.time, dur: bk.dur, serviceName: bk.serviceName, price: bk.price, barberId: bk.barberId,
  barberName: (c.barbers.find(b => b.id === bk.barberId) || {}).name || "Usta", name: bk.name, note: bk.note, status: bk.status, cancelledBy: bk.cancelledBy || null });

/* ---------------- auth: scrypt passwords + HMAC session cookie ---------------- */
const SECRET = process.env.SESSION_SECRET || (DB_SECRET ? sha("sirada-session:" + DB_SECRET) : "dev-only-secret");
export function hashPass(pw, salt = rid(12)) { return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString("base64url") }; }
export function checkPass(pw, u) { const h = crypto.scryptSync(String(pw), u.salt, 32); const t = Buffer.from(u.hash, "base64url"); return t.length === h.length && crypto.timingSafeEqual(h, t); }
function sign(p) { const d = Buffer.from(JSON.stringify(p)).toString("base64url"); return d + "." + crypto.createHmac("sha256", SECRET).update(d).digest("base64url"); }
function unsign(t) {
  const [d, s] = String(t || "").split("."); if (!d || !s) return null;
  const want = crypto.createHmac("sha256", SECRET).update(d).digest("base64url");
  if (want.length !== s.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(s))) return null;
  try { const p = JSON.parse(Buffer.from(d, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const secure = () => (process.env.VERCEL ? "; Secure" : "");
export function sessionCookie(u) { const t = sign({ u: u.username, v: u.ver || 1, exp: Date.now() + 30 * 864e5 }); return `ss=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure()}`; }
export const clearCookie = () => `ss=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure()}`;
export async function currentUser(req) {
  const m = /(?:^|;\s*)ss=([^;]+)/.exec(req.headers.cookie || ""); if (!m) return null;
  const p = unsign(decodeURIComponent(m[1])); if (!p) return null;
  const u = await hgetJSON("users", p.u);
  if (!u || (u.ver || 1) !== p.v || u.disabled) return null;
  return u;
}
export const userView = (u) => ({ username: u.username, name: u.name, role: u.role, barberId: u.barberId || null });
export const normUser = (s) => String(s || "").trim().toLocaleLowerCase("tr-TR").replace(/[^a-z0-9._-]/g, "");
