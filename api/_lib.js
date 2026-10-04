// Shared helpers for all API routes (files starting with "_" are not routes on Vercel). Multi-shop: every key is scoped by shop id.
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

/* ================= http helpers ================= */
export function send(res, code, obj, headers = {}) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}
export const fail = (res, code, msg, extra = {}) => send(res, code, { error: msg, ...extra });
export function body(req) { const b = req.body; if (!b) return {}; if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } } return b; }
export function query(req) { if (req.query) return req.query; const u = new URL(req.url, "http://x"); return Object.fromEntries(u.searchParams); }
export function ip(req) { return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0].trim(); }
export async function rateLimit(key, max, sec) { const n = await redis("INCR", "rl:" + key); if (n === 1) await redis("EXPIRE", "rl:" + key, sec); return n <= max; }
export const rid = (n = 10) => crypto.randomBytes(n).toString("base64url").replace(/[-_]/g, "x");
export const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("base64url");
export const clip = (s, n) => String(s ?? "").trim().slice(0, n);
export function handle(fn) { return async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e); if (!res.writableEnded) fail(res, 500, "Sunucu hatası. Biraz sonra tekrar dene."); } }; }

/* ================= time (Türkiye: UTC+3, no DST) ================= */
const TR = 3 * 3600e3;
const pad = (n) => String(n).padStart(2, "0");
export function trNow() { const d = new Date(Date.now() + TR); return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, min: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
export const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
export const fmt = (m) => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
export function addDays(date, n) { const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export const weekday = (date) => new Date(date + "T00:00:00Z").getUTCDay();
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
export function startTs(date, time) { return Date.parse(date + "T00:00:00Z") - TR + toMin(time) * 60e3; }

/* ================= shops (tenants) ================= */
export const K = (shop, name) => `s:${shop}:${name}`;
export const slugify = (s) => String(s || "").toLocaleLowerCase("tr-TR").replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
const RESERVED = new Set(["api", "usta", "yonetim", "assets", "admin", "www", "index", "favicon", "robots"]);
export const validSlug = (s) => /^[a-z0-9][a-z0-9-]{1,29}$/.test(s) && !RESERVED.has(s);
export async function shopBySlug(slug) { const id = await redis("HGET", "slugs", String(slug || "").toLowerCase()); if (!id) return null; const s = await hgetJSON("shops", id); return s || null; }
export async function shopById(id) { return id ? hgetJSON("shops", id) : null; }
export async function setSlug(shop, slug) {
  slug = String(slug || "").toLowerCase();
  if (!validSlug(slug)) return "Bağlantı adı 2-30 karakter olmalı; küçük harf, rakam ve tire kullan.";
  const cur = await redis("HGET", "slugs", slug);
  if (cur && cur !== shop.id) return "Bu bağlantı adı başka bir dükkânda kullanılıyor.";
  if (shop.slug && shop.slug !== slug) await redis("HDEL", "slugs", shop.slug);
  await redis("HSET", "slugs", slug, shop.id);
  shop.slug = slug; await hsetJSON("shops", shop.id, shop);
  return null;
}

/* ================= config & barbers ================= */
export const UNIT = 5;                      // lock granularity in minutes
export const STEPS = [10, 15, 20, 30, 40, 45, 60];
export const DURS = [10, 15, 20, 30, 40, 45, 60, 75, 90, 120];
export const DEFAULT_CFG = {
  shopName: "Yeni berber", address: "", phone: "",
  open: "09:00", close: "20:00", breakStart: "", breakEnd: "",
  closed: [1], horizon: 14, minNotice: 30, cancelHours: 2,
  services: [
    { id: "s1", name: "Saç kesimi", dur: 30, price: 400 },
    { id: "s2", name: "Sakal tıraşı", dur: 20, price: 250 },
    { id: "s3", name: "Saç + sakal", dur: 45, price: 600 },
    { id: "s4", name: "Çocuk tıraşı", dur: 20, price: 300 }
  ],
  barbers: []
};
export async function getCfg(shop) { const c = await getJSON(K(shop, "cfg")); return { ...DEFAULT_CFG, ...(c || {}) }; }
export const saveCfg = (shop, c) => setJSON(K(shop, "cfg"), c);
export const activeBarbers = (c) => c.barbers.filter(b => b.active !== false);
// A barber's effective schedule: own values, otherwise the shop's.
export function sched(c, b) {
  const own = !!(b && b.ownHours);
  return { step: STEPS.includes(+b?.step) ? +b.step : 30,
    open: own && b.open ? b.open : c.open, close: own && b.close ? b.close : c.close,
    breakStart: own ? (b.breakStart || "") : c.breakStart, breakEnd: own ? (b.breakEnd || "") : c.breakEnd,
    closed: own && Array.isArray(b.closed) ? b.closed : c.closed };
}
export function barberView(c, b) { const s = sched(c, b); return { id: b.id, name: b.name, title: b.title || "", step: s.step, open: s.open, close: s.close, breakStart: s.breakStart, breakEnd: s.breakEnd, closed: s.closed }; }
export const publicCfg = (c) => ({ shopName: c.shopName, address: c.address, phone: c.phone, open: c.open, close: c.close, breakStart: c.breakStart, breakEnd: c.breakEnd,
  closed: c.closed, horizon: c.horizon, minNotice: c.minNotice, cancelHours: c.cancelHours, services: c.services, barbers: activeBarbers(c).map(b => barberView(c, b)) });
// Is start time m a valid slot for this barber on this date for a service of `dur` minutes?
export function slotOk(c, b, date, m, dur) {
  const s = sched(c, b);
  if (s.closed.includes(weekday(date))) return "Usta bu gün çalışmıyor.";
  const o = toMin(s.open), cl = toMin(s.close);
  if (isNaN(m) || m < o || m + dur > cl || (m - o) % s.step) return "Bu saat ustanın çalışma saatleri dışında.";
  const bs = toMin(s.breakStart), be = toMin(s.breakEnd);
  if (!isNaN(bs) && !isNaN(be) && bs < be && m < be && bs < m + dur) return "Bu saat öğle arasına denk geliyor.";
  return null;
}

/* ================= locks: one key per 5-minute unit of a barber's day ================= */
const lockKey = (shop, date, barberId, m) => `sl:${shop}:${date}:${barberId}:${fmt(m).replace(":", "")}`;
function lockTtl(date) { return Math.max(3600, Math.round((Date.parse(date + "T00:00:00Z") + 3 * 864e5 - Date.now()) / 1000)); }
export async function lockRange(shop, date, barberId, m, dur, owner) {
  const got = [];
  for (let x = m; x < m + dur; x += UNIT) {
    const k = lockKey(shop, date, barberId, x);
    const ok = await redis("SET", k, owner, "NX", "EX", lockTtl(date));
    if (ok !== "OK") { const cur = await redis("GET", k); if (cur === owner) { got.push(k); continue; } for (const g of got) await redis("DEL", g); return false; }
    got.push(k);
  }
  return true;
}
export async function unlockRange(shop, date, barberId, m, dur, owner) {
  for (let x = m; x < m + dur; x += UNIT) { const k = lockKey(shop, date, barberId, x); const cur = await redis("GET", k); if (cur === owner) await redis("DEL", k); }
}

/* ================= bookings ================= */
// talep: waiting for the barber · onayli: accepted · geldi / gelmedi: done · iptal: cancelled · red: declined
export const OPEN = new Set(["talep", "onayli"]);
export function validPhone(p) { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("90") && d.length === 12) d = "0" + d.slice(2); if (d.length === 10 && d[0] === "5") d = "0" + d; return /^05\d{9}$/.test(d) ? d : null; }
const endTs = (b) => startTs(b.date, b.time) + b.dur * 60e3;
export const isOpen = (b) => OPEN.has(b.status) && endTs(b) > Date.now();
// One open booking per customer phone *per barber*: each usta keeps their own queue.
const actKey = (shop, barberId, phone) => `act:${shop}:${barberId}:${phone}`;
export async function claimPhone(shop, barberId, phone, id) {
  for (let i = 0; i < 2; i++) {
    if ((await redis("SET", actKey(shop, barberId, phone), id, "NX")) === "OK") return true;
    const cur = await redis("GET", actKey(shop, barberId, phone));
    const b = cur ? await hgetJSON(K(shop, "bk"), cur) : null;
    if (b && isOpen(b)) return false;
    await redis("DEL", actKey(shop, barberId, phone));
  }
  return false;
}
export async function releasePhone(shop, b) { const k = actKey(shop, b.barberId, b.phone); const cur = await redis("GET", k); if (cur === b.id) await redis("DEL", k); }

export async function createBooking(shop, c, { serviceId, barberId, date, time, name, phone, note }, meta) {
  const s = c.services.find(x => x.id === serviceId);
  if (!s) return { error: "Hizmet bulunamadı." };
  if (!isDate(date)) return { error: "Geçersiz gün." };
  const now = trNow();
  if (date < now.date || date > addDays(now.date, Number(c.horizon) - 1)) return { error: "Bu gün için randevu açık değil." };
  if (c.closed.includes(weekday(date)) && !activeBarbers(c).some(b => !sched(c, b).closed.includes(weekday(date)))) return { error: "Dükkân bu gün kapalı." };
  const m = toMin(time);
  if (meta.source === "online" && date === now.date && m <= now.min + Number(c.minNotice || 0)) return { error: "Bu saat için artık çok geç; daha ileri bir saat seç." };
  if (meta.source !== "online" && date === now.date && m < now.min) return { error: "Geçmiş bir saate randevu eklenemez." };
  const nm = clip(name, 60), ph = validPhone(phone);
  if (nm.length < 2) return { error: "Adını yaz." };
  if (!ph) return { error: "Telefonu 05xx xxx xx xx biçiminde yaz." };
  const order = barberId && barberId !== "any" ? activeBarbers(c).filter(b => b.id === barberId) : activeBarbers(c);
  if (!order.length) return { error: "Usta bulunamadı." };
  const cands = order.filter(b => !slotOk(c, b, date, m, s.dur));
  if (!cands.length) return { error: slotOk(c, order[0], date, m, s.dur) || "Bu saat uygun değil." };
  const id = rid(9);
  let chosen = null, blockedByOpen = 0;
  for (const b of cands) {
    if (!(await claimPhone(shop, b.id, ph, id))) { blockedByOpen++; continue; }
    if (await lockRange(shop, date, b.id, m, s.dur, id)) { chosen = b; break; }
    await redis("DEL", actKey(shop, b.id, ph));
  }
  if (!chosen && blockedByOpen === cands.length) return { error: cands.length === 1 ? `${cands[0].name} ile zaten açık bir randevun var. Yeni randevu için önce onu iptal et.` : "Bu ustalarla zaten açık randevun var. Yeni randevu için önce onu iptal et.", code: "open" };
  if (!chosen) return { error: "Bu saat az önce doldu. Başka bir saat seç.", code: "taken" };
  const key = rid(16);
  const bk = { id, date, time: fmt(m), dur: s.dur, serviceId: s.id, serviceName: s.name, price: Number(s.price) || 0, barberId: chosen.id,
    name: nm, phone: ph, note: clip(note, 240), staffNote: "", status: meta.source === "online" ? "talep" : "onayli", source: meta.source, by: meta.by || null,
    createdAt: Date.now(), updatedAt: Date.now(), keyHash: sha(key), history: [] };
  await hsetJSON(K(shop, "bk"), id, bk);
  return { booking: bk, key };
}
export async function closeBooking(shop, bk, status, by) {
  if (OPEN.has(bk.status) && !OPEN.has(status) && (status === "iptal" || status === "red")) await unlockRange(shop, bk.date, bk.barberId, toMin(bk.time), bk.dur, bk.id);
  bk.status = status; bk.updatedAt = Date.now(); if (by) bk.closedBy = by;
  if (!OPEN.has(status)) await releasePhone(shop, bk);
  await hsetJSON(K(shop, "bk"), bk.id, bk);
  return bk;
}
export const customerView = (bk, c) => ({ id: bk.id, date: bk.date, time: bk.time, dur: bk.dur, serviceName: bk.serviceName, price: bk.price, barberId: bk.barberId,
  barberName: (c.barbers.find(b => b.id === bk.barberId) || {}).name || "Usta", name: bk.name, note: bk.note, status: bk.status, closedBy: bk.closedBy || null });

/* ================= auth ================= */
const SECRET = process.env.SESSION_SECRET || (DB_SECRET ? sha("sirada-session:" + DB_SECRET) : "dev-only-secret");
export function hashPass(pw, salt = rid(12)) { return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString("base64url") }; }
export function checkPass(pw, u) { if (!u || !u.salt) return false; const h = crypto.scryptSync(String(pw), u.salt, 32); const t = Buffer.from(u.hash, "base64url"); return t.length === h.length && crypto.timingSafeEqual(h, t); }
function sign(p) { const d = Buffer.from(JSON.stringify(p)).toString("base64url"); return d + "." + crypto.createHmac("sha256", SECRET).update(d).digest("base64url"); }
function unsign(t) {
  const [d, s] = String(t || "").split("."); if (!d || !s) return null;
  const want = crypto.createHmac("sha256", SECRET).update(d).digest("base64url");
  if (want.length !== s.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(s))) return null;
  try { const p = JSON.parse(Buffer.from(d, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const secure = () => (process.env.VERCEL ? "; Secure" : "");
const cookie = (name, val, age) => `${name}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure()}`;
const readCookie = (req, name) => { const m = new RegExp("(?:^|;\\s*)" + name + "=([^;]+)").exec(req.headers.cookie || ""); return m ? decodeURIComponent(m[1]) : null; };
// shop staff session
export const sessionCookie = (shop, u, imp) => cookie("ss", sign({ s: shop, u: u.username, v: u.ver || 1, ...(imp ? { imp } : {}), exp: Date.now() + (imp ? 8 * 3600e3 : 30 * 864e5) }), imp ? 8 * 3600 : 30 * 86400);
export const clearCookie = () => cookie("ss", "", 0);
export async function currentUser(req) {
  const p = unsign(readCookie(req, "ss")); if (!p || !p.s) return null;
  const shop = await shopById(p.s); if (!shop || shop.disabled) return null;
  const u = await hgetJSON(K(p.s, "users"), p.u);
  if (!u || (u.ver || 1) !== p.v || u.disabled) return null;
  return { ...u, shop: p.s, shopObj: shop, imp: p.imp || null };
}
// platform admin session
export const adminCookie = (a) => cookie("ps", sign({ a: a.username, v: a.ver || 1, exp: Date.now() + 14 * 864e5 }), 14 * 86400);
export const clearAdminCookie = () => cookie("ps", "", 0);
export async function currentAdmin(req) {
  const p = unsign(readCookie(req, "ps")); if (!p || !p.a) return null;
  const a = await hgetJSON("padmins", p.a);
  return a && (a.ver || 1) === p.v ? a : null;
}
export const userView = (u) => ({ username: u.username, name: u.name, role: u.role, barberId: u.barberId || null, ...(u.imp ? { imp: u.imp } : {}) });
export const normUser = (s) => String(s || "").trim().toLocaleLowerCase("tr-TR").replace(/ı/g, "i").replace(/[^a-z0-9._-]/g, "");
export function genPass() { const a = "abcdefghjkmnpqrstuvwxyz23456789"; return Array.from(crypto.randomBytes(10), x => a[x % a.length]).join(""); }

/* ================= one-time move of the old single-shop data ================= */
export async function migrateLegacy() {
  const legacy = await getJSON("cfg");
  if (!legacy || (await redis("GET", "migrated")) === "1") return null;
  const id = "d" + rid(5);
  let slug = slugify(legacy.shopName) || "berber";
  if (!validSlug(slug) || (await redis("HGET", "slugs", slug))) slug = slug + "-" + rid(2).toLowerCase();
  const shop = { id, slug, name: legacy.shopName, createdAt: Date.now(), legacy: true };
  await hsetJSON("shops", id, shop); await redis("HSET", "slugs", slug, id);
  const cfg = { ...DEFAULT_CFG, ...legacy, barbers: (legacy.barbers || []).map(b => ({ ...b, step: 30 })) };
  await saveCfg(id, cfg);
  for (const [k, v] of Object.entries(await hallJSON("users"))) await hsetJSON(K(id, "users"), k, v);
  for (const [k, b] of Object.entries(await hallJSON("bk"))) {
    if (b.status === "bekliyor") b.status = "onayli";
    await hsetJSON(K(id, "bk"), k, b);
    if (OPEN.has(b.status)) { await lockRange(id, b.date, b.barberId, toMin(b.time), b.dur, b.id); await redis("SET", actKey(id, b.barberId, b.phone), b.id, "NX"); }
  }
  for (const [k, b] of Object.entries(await hallJSON("bl"))) { const nb = { ...b, id: k }; await hsetJSON(K(id, "bl"), k, nb); await lockRange(id, b.date, b.barberId, toMin(b.time), b.dur, "blk" + k); }
  await redis("SET", "migrated", "1");
  return shop;
}

/* ================= permanent removal of a shop and everything in it ================= */
export async function purgeShop(shop) {
  const bk = await hallJSON(K(shop.id, "bk")), bl = await hallJSON(K(shop.id, "bl"));
  for (const b of Object.values(bk)) { if (OPEN.has(b.status)) await unlockRange(shop.id, b.date, b.barberId, toMin(b.time), b.dur, b.id); await redis("DEL", actKey(shop.id, b.barberId, b.phone)); }
  for (const b of Object.values(bl)) await unlockRange(shop.id, b.date, b.barberId, toMin(b.time), b.dur, "blk" + b.id);
  await redis("DEL", K(shop.id, "cfg"), K(shop.id, "users"), K(shop.id, "bk"), K(shop.id, "bl"));
  if (shop.slug) { const cur = await redis("HGET", "slugs", shop.slug); if (cur === shop.id) await redis("HDEL", "slugs", shop.slug); }
  await redis("HDEL", "shops", shop.id);
}
