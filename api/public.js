// Customer-facing API: no login. Only non-personal data leaves except a customer's own booking (by its secret key).
import { send, fail, body, query, ip, rateLimit, getCfg, publicCfg, hallJSON, hgetJSON, createBooking, cancelBooking, customerView,
  trNow, addDays, isDate, sha, startTs, hasDb } from "./_lib.js";

export default async function handler(req, res) {
  try {
    const q = query(req); const a = q.action;
    const c = await getCfg();
    if (req.method === "GET" && a === "init") {
      const setup = !c.barbers.length;
      const now = trNow();
      const from = now.date, to = addDays(now.date, Number(c.horizon) - 1);
      const [bk, bl] = await Promise.all([hallJSON("bk"), hallJSON("bl")]);
      const busy = [];
      for (const b of Object.values(bk)) if (b.status !== "iptal" && b.date >= from && b.date <= to) busy.push([b.date, b.barberId, b.time, b.dur]);
      for (const b of Object.values(bl)) if (b.date >= from && b.date <= to) busy.push([b.date, b.barberId, b.time, b.dur]);
      return send(res, 200, { cfg: publicCfg(c), busy, now, setup, demo: !hasDb });
    }
    if (req.method === "GET" && a === "booking") {
      const bk = await hgetJSON("bk", String(q.id || ""));
      if (!bk || bk.keyHash !== sha(q.k || "")) return fail(res, 404, "Randevu bulunamadı.");
      return send(res, 200, { booking: customerView(bk, c), canCancel: canCancel(bk, c) });
    }
    if (req.method === "POST" && a === "book") {
      if (!(await rateLimit("book:" + ip(req), 12, 3600))) return fail(res, 429, "Çok fazla deneme. Biraz sonra tekrar dene.");
      const b = body(req);
      const r = await createBooking(c, b, { source: "online" });
      if (r.error) return fail(res, r.code === "taken" ? 409 : 400, r.error);
      return send(res, 200, { booking: customerView(r.booking, c), key: r.key });
    }
    if (req.method === "POST" && a === "cancel") {
      const b = body(req);
      const bk = await hgetJSON("bk", String(b.id || ""));
      if (!bk || bk.keyHash !== sha(b.k || "")) return fail(res, 404, "Randevu bulunamadı.");
      if (bk.status === "iptal") return send(res, 200, { booking: customerView(bk, c) });
      if (bk.status !== "bekliyor") return fail(res, 400, "Bu randevu artık iptal edilemez.");
      if (!canCancel(bk, c)) return fail(res, 400, `İptal için en geç ${c.cancelHours} saat önce haber vermelisin. Dükkânı ara.`);
      await cancelBooking(bk, "musteri");
      return send(res, 200, { booking: customerView(bk, c) });
    }
    return fail(res, 404, "Bilinmeyen istek.");
  } catch (e) { console.error(e); return fail(res, 500, "Sunucu hatası. Biraz sonra tekrar dene."); }
}
function canCancel(bk, c) { return bk.status === "bekliyor" && startTs(bk.date, bk.time) - Date.now() > Number(c.cancelHours || 0) * 3600e3; }
