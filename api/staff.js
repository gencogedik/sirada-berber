// Barber panel API. Requires a logged-in staff member. Ustas see and change only their own chair; the owner sees everything.
import { send, fail, body, query, getCfg, hallJSON, hgetJSON, hsetJSON, redis, currentUser, userView, createBooking, cancelBooking,
  lockRange, unlockRange, toMin, fmt, isDate, trNow, addDays, inHours, clip, rid, STEP } from "./_lib.js";

const clean = ({ keyHash, ...b }) => b;

export default async function handler(req, res) {
  try {
    const u = await currentUser(req);
    if (!u) return fail(res, 401, "Oturum kapandı. Tekrar giriş yap.");
    const owner = u.role === "sahip";
    const mine = (barberId) => owner || barberId === u.barberId;
    const q = query(req), a = q.action, c = await getCfg();

    if (req.method === "GET" && a === "agenda") {
      const now = trNow();
      const from = isDate(q.from) ? q.from : now.date, to = isDate(q.to) ? q.to : addDays(from, 14);
      const [bk, bl, users] = await Promise.all([hallJSON("bk"), hallJSON("bl"), hallJSON("users")]);
      const bookings = Object.values(bk).filter(b => b.date >= from && b.date <= to && mine(b.barberId)).map(clean);
      const blocks = Object.values(bl).filter(b => b.date >= from && b.date <= to && mine(b.barberId));
      const visits = {};
      for (const b of Object.values(bk)) if (b.status === "geldi") visits[b.phone] = (visits[b.phone] || 0) + 1;
      const counts = {};
      for (const b of Object.values(bk)) if (b.status !== "iptal" && mine(b.barberId) && b.date >= now.date && b.date <= addDays(now.date, 30)) counts[b.date] = (counts[b.date] || 0) + 1;
      const online7 = Object.values(bk).filter(b => b.source === "online" && mine(b.barberId) && b.createdAt > Date.now() - 7 * 864e5).length;
      const d30 = Object.values(bk).filter(b => mine(b.barberId) && b.createdAt > Date.now() - 30 * 864e5 && (b.status === "geldi" || b.status === "gelmedi"));
      const noshow = d30.length ? Math.round(100 * d30.filter(b => b.status === "gelmedi").length / d30.length) : 0;
      const names = Object.fromEntries(Object.values(users).map(x => [x.username, x.name]));
      return send(res, 200, { me: userView(u), cfg: c, bookings, blocks, visits, counts, stats: { online7, noshow }, names, now });
    }
    if (req.method === "GET" && a === "customers") {
      const bk = await hallJSON("bk"); const map = {};
      for (const b of Object.values(bk)) {
        if (!mine(b.barberId)) continue;
        const k = b.phone; const x = (map[k] ||= { name: b.name, phone: b.phone, visits: 0, noshow: 0, cancels: 0, spent: 0, last: "", next: "", note: "", t: 0 });
        if (b.createdAt > x.t) { x.t = b.createdAt; x.name = b.name; }
        if (b.status === "geldi") { x.visits++; x.spent += b.price || 0; if (b.date > x.last) x.last = b.date; }
        if (b.status === "gelmedi") x.noshow++;
        if (b.status === "iptal") x.cancels++;
        if (b.status === "bekliyor" && b.date >= trNow().date && (!x.next || b.date + " " + b.time < x.next)) x.next = b.date + " " + b.time;
        if (b.staffNote) x.note = b.staffNote;
      }
      return send(res, 200, { customers: Object.values(map).map(({ t, ...x }) => x) });
    }
    if (req.method !== "POST") return fail(res, 404, "Bilinmeyen istek.");
    const b = body(req);

    if (a === "book") {
      if (!mine(b.barberId) && b.barberId !== "any") return fail(res, 403, "Sadece kendi koltuğuna randevu ekleyebilirsin.");
      const r = await createBooking(c, { ...b, barberId: owner ? b.barberId : u.barberId }, { source: "telefon", by: u.username });
      if (r.error) return fail(res, r.code === "taken" ? 409 : 400, r.error);
      return send(res, 200, { booking: clean(r.booking) });
    }
    if (a === "block") {
      const date = b.date, f = toMin(b.from), t = toMin(b.to);
      if (!isDate(date) || isNaN(f) || isNaN(t) || t <= f || f % STEP || t % STEP) return fail(res, 400, "Geçerli bir aralık seç.");
      const targets = b.barberId === "all" ? (owner ? c.barbers.filter(x => x.active !== false).map(x => x.id) : []) : [b.barberId];
      if (!targets.length || !targets.every(mine)) return fail(res, 403, "Sadece kendi saatlerini kapatabilirsin.");
      let made = 0, skipped = 0;
      for (const bid of targets) {
        for (let m = f; m < t; m += STEP) {
          const id = rid(8);
          if (await lockRange(date, bid, m, STEP, "blk" + id)) { await hsetJSON("bl", id, { id, date, barberId: bid, time: fmt(m), dur: STEP, label: clip(b.label, 40) || "Kapalı", by: u.username, group: b.group || null }); made++; }
          else skipped++;
        }
      }
      return send(res, 200, { made, skipped });
    }
    if (a === "unblock") {
      const ids = Array.isArray(b.ids) ? b.ids : [b.id];
      for (const id of ids) { const k = await hgetJSON("bl", String(id)); if (!k || !mine(k.barberId)) continue; await unlockRange(k.date, k.barberId, toMin(k.time), k.dur, "blk" + k.id); await redis("HDEL", "bl", k.id); }
      return send(res, 200, { ok: true });
    }

    const bk = await hgetJSON("bk", String(b.id || ""));
    if (!bk) return fail(res, 404, "Randevu bulunamadı.");
    if (!mine(bk.barberId)) return fail(res, 403, "Bu randevu başka bir ustanın.");
    if (a === "status") {
      if (!["geldi", "gelmedi", "bekliyor"].includes(b.status)) return fail(res, 400, "Geçersiz durum.");
      if (bk.status === "iptal") return fail(res, 400, "İptal edilmiş randevu için önce geri al.");
      bk.status = b.status; bk.updatedAt = Date.now(); await hsetJSON("bk", bk.id, bk);
      return send(res, 200, { booking: clean(bk) });
    }
    if (a === "note") { bk.staffNote = clip(b.staffNote, 300); bk.updatedAt = Date.now(); await hsetJSON("bk", bk.id, bk); return send(res, 200, { booking: clean(bk) }); }
    if (a === "cancel") { await cancelBooking(bk, "dukkan:" + u.username); return send(res, 200, { booking: clean(bk) }); }
    if (a === "restore") {
      if (bk.status !== "iptal") return send(res, 200, { booking: clean(bk) });
      if (!(await lockRange(bk.date, bk.barberId, toMin(bk.time), bk.dur, bk.id))) return fail(res, 409, "Bu saat artık dolu; önce saati değiştir.");
      bk.status = "bekliyor"; bk.cancelledBy = null; bk.updatedAt = Date.now(); await hsetJSON("bk", bk.id, bk);
      return send(res, 200, { booking: clean(bk) });
    }
    if (a === "move") {
      if (bk.status === "iptal") return fail(res, 400, "İptal edilmiş randevu taşınamaz.");
      const date = b.date, m = toMin(b.time);
      const barberId = owner && b.barberId ? b.barberId : bk.barberId;
      if (!isDate(date) || !inHours(c, m, bk.dur)) return fail(res, 400, "Bu saat çalışma saatleri dışında.");
      const nw = trNow(); if (date < nw.date || (date === nw.date && m < nw.min)) return fail(res, 400, "Geçmiş bir saate taşınamaz.");
      if (c.closed.includes(new Date(date + "T00:00:00Z").getUTCDay())) return fail(res, 400, "Dükkân bu gün kapalı.");
      if (date === bk.date && fmt(m) === bk.time && barberId === bk.barberId) return send(res, 200, { booking: clean(bk) });
      if (!(await lockRange(date, barberId, m, bk.dur, bk.id))) return fail(res, 409, "Bu saat dolu.");
      // release old blocks that are not part of the new range
      const keep = new Set(); if (date === bk.date && barberId === bk.barberId) for (let x = m; x < m + bk.dur; x += STEP) keep.add(x);
      for (let x = toMin(bk.time); x < toMin(bk.time) + bk.dur; x += STEP) if (!keep.has(x)) await unlockRange(bk.date, bk.barberId, x, STEP, bk.id);
      bk.history = [...(bk.history || []), { from: `${bk.date} ${bk.time}`, to: `${date} ${fmt(m)}`, by: u.username, at: Date.now() }];
      Object.assign(bk, { date, time: fmt(m), barberId, updatedAt: Date.now() });
      await hsetJSON("bk", bk.id, bk);
      return send(res, 200, { booking: clean(bk) });
    }
    return fail(res, 404, "Bilinmeyen istek.");
  } catch (e) { console.error(e); return fail(res, 500, "Sunucu hatası."); }
}
