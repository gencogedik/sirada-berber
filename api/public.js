// Customer-facing API: no login. Every call names a shop by its link (?shop=<slug>).
import { send, fail, body, query, ip, rateLimit, handle, getCfg, publicCfg, hallJSON, hgetJSON, createBooking, closeBooking, customerView,
  trNow, addDays, sha, startTs, hasDb, shopBySlug, K, OPEN } from "./_lib.js";

export default handle(async (req, res) => {
  const q = query(req), a = q.action;
  const shop = await shopBySlug(q.shop);
  if (!shop) return fail(res, 404, "Dükkân bulunamadı. Bağlantıyı kontrol et.");
  if (shop.disabled) return fail(res, 403, "Bu dükkân şu an online randevu almıyor.");
  const c = await getCfg(shop.id);
  if (req.method === "GET" && a === "init") {
    const now = trNow(), from = now.date, to = addDays(now.date, Number(c.horizon) - 1);
    const [bk, bl] = await Promise.all([hallJSON(K(shop.id, "bk")), hallJSON(K(shop.id, "bl"))]);
    const busy = [];
    for (const b of Object.values(bk)) if (OPEN.has(b.status) && b.date >= from && b.date <= to) busy.push([b.date, b.barberId, b.time, b.dur]);
    for (const b of Object.values(bl)) if (b.date >= from && b.date <= to) busy.push([b.date, b.barberId, b.time, b.dur]);
    return send(res, 200, { shop: { slug: shop.slug, name: c.shopName }, cfg: publicCfg(c), busy, now, setup: !publicCfg(c).barbers.length, demo: !hasDb });
  }
  if (req.method === "GET" && a === "booking") {
    const bk = await hgetJSON(K(shop.id, "bk"), String(q.id || ""));
    if (!bk || bk.keyHash !== sha(q.k || "")) return fail(res, 404, "Randevu bulunamadı.");
    return send(res, 200, { booking: customerView(bk, c), canCancel: canCancel(bk, c) });
  }
  if (req.method === "POST" && a === "book") {
    if (!(await rateLimit("book:" + ip(req), 12, 3600))) return fail(res, 429, "Çok fazla deneme. Biraz sonra tekrar dene.");
    const r = await createBooking(shop.id, c, body(req), { source: "online" });
    if (r.error) return fail(res, r.code === "taken" ? 409 : r.code === "open" ? 423 : 400, r.error, { code: r.code || null });
    return send(res, 200, { booking: customerView(r.booking, c), key: r.key });
  }
  if (req.method === "POST" && a === "cancel") {
    const b = body(req);
    const bk = await hgetJSON(K(shop.id, "bk"), String(b.id || ""));
    if (!bk || bk.keyHash !== sha(b.k || "")) return fail(res, 404, "Randevu bulunamadı.");
    if (!OPEN.has(bk.status)) return send(res, 200, { booking: customerView(bk, c) });
    if (!canCancel(bk, c)) return fail(res, 400, `İptal için en geç ${c.cancelHours} saat önce haber vermelisin. Dükkânı ara.`);
    await closeBooking(shop.id, bk, "iptal", "musteri");
    return send(res, 200, { booking: customerView(bk, c) });
  }
  return fail(res, 404, "Bilinmeyen istek.");
});
// A pending request can always be withdrawn; an accepted one only up to the shop's limit.
function canCancel(bk, c) { if (bk.status === "talep") return startTs(bk.date, bk.time) > Date.now(); return bk.status === "onayli" && startTs(bk.date, bk.time) - Date.now() > Number(c.cancelHours || 0) * 3600e3; }
