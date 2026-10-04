// Barber panel API. Ustas see and change only their own chair; the shop owner sees every chair.
import { send, fail, body, query, handle, getCfg, saveCfg, hallJSON, hgetJSON, hsetJSON, redis, currentUser, userView, createBooking, closeBooking,
  lockRange, unlockRange, claimPhone, releasePhone, toMin, fmt, isDate, trNow, addDays, slotOk, sched, barberView, clip, rid, K, OPEN, isOpen,
  STEPS, UNIT, startTs } from "./_lib.js";

const clean = ({ keyHash, ...b }) => b;
const timeOk = (s) => !s || !isNaN(toMin(s));

export default handle(async (req, res) => {
  const u = await currentUser(req);
  if (!u) return fail(res, 401, "Oturum kapandı. Tekrar giriş yap.");
  const S = u.shop, owner = u.role === "sahip";
  const mine = (barberId) => owner || barberId === u.barberId;
  const q = query(req), a = q.action, c = await getCfg(S);
  const BK = K(S, "bk"), BL = K(S, "bl");

  if (req.method === "GET" && a === "agenda") {
    const now = trNow();
    const from = isDate(q.from) ? q.from : addDays(now.date, -7), to = isDate(q.to) ? q.to : addDays(now.date, 31);
    const [bk, bl, users] = await Promise.all([hallJSON(BK), hallJSON(BL), hallJSON(K(S, "users"))]);
    const all = Object.values(bk);
    const bookings = all.filter(b => b.date >= from && b.date <= to && mine(b.barberId)).map(clean);
    const pending = all.filter(b => b.status === "talep" && mine(b.barberId) && startTs(b.date, b.time) > Date.now()).sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time)).map(clean);
    const blocks = Object.values(bl).filter(b => b.date >= from && b.date <= to && mine(b.barberId));
    const visits = {}; for (const b of all) if (b.status === "geldi") visits[b.phone] = (visits[b.phone] || 0) + 1;
    const counts = {}; for (const b of all) if (OPEN.has(b.status) && mine(b.barberId) && b.date >= now.date) counts[b.date] = (counts[b.date] || 0) + 1;
    const online7 = all.filter(b => b.source === "online" && mine(b.barberId) && b.createdAt > Date.now() - 7 * 864e5).length;
    const d30 = all.filter(b => mine(b.barberId) && b.createdAt > Date.now() - 30 * 864e5 && (b.status === "geldi" || b.status === "gelmedi"));
    const noshow = d30.length ? Math.round(100 * d30.filter(b => b.status === "gelmedi").length / d30.length) : 0;
    const names = Object.fromEntries(Object.values(users).map(x => [x.username, x.name]));
    const barbers = c.barbers.filter(b => !b.removed).map(b => ({ ...barberView(c, b), active: b.active !== false, ownHours: !!b.ownHours }));
    return send(res, 200, { me: userView(u), shop: { slug: u.shopObj.slug }, cfg: { ...c, barbers }, bookings, pending, blocks, visits, counts, stats: { online7, noshow }, names, now });
  }
  if (req.method === "GET" && a === "customers") {
    const bk = await hallJSON(BK); const map = {};
    for (const b of Object.values(bk)) {
      if (!mine(b.barberId)) continue;
      const x = (map[b.phone] ||= { name: b.name, phone: b.phone, visits: 0, noshow: 0, cancels: 0, spent: 0, last: "", next: "", note: "", t: 0 });
      if (b.createdAt > x.t) { x.t = b.createdAt; x.name = b.name; }
      if (b.status === "geldi") { x.visits++; x.spent += b.price || 0; if (b.date > x.last) x.last = b.date; }
      if (b.status === "gelmedi") x.noshow++;
      if (b.status === "iptal" || b.status === "red") x.cancels++;
      if (isOpen(b) && (!x.next || b.date + " " + b.time < x.next)) x.next = b.date + " " + b.time;
      if (b.staffNote) x.note = b.staffNote;
    }
    return send(res, 200, { customers: Object.values(map).map(({ t, ...x }) => x) });
  }
  if (req.method !== "POST") return fail(res, 404, "Bilinmeyen istek.");
  const b = body(req);

  if (a === "schedule") {   // a barber's own slot length, hours, break and days off
    const target = owner && b.barberId ? b.barberId : u.barberId;
    if (!target || !mine(target)) return fail(res, 403, "Sadece kendi çalışma saatlerini değiştirebilirsin.");
    const i = c.barbers.findIndex(x => x.id === target); if (i < 0) return fail(res, 404, "Usta bulunamadı.");
    const nb = { ...c.barbers[i] };
    if (b.step !== undefined) { if (!STEPS.includes(+b.step)) return fail(res, 400, "Geçersiz randevu dilimi."); nb.step = +b.step; }
    if (b.title !== undefined) nb.title = clip(b.title, 40);
    if (b.ownHours !== undefined) nb.ownHours = !!b.ownHours;
    if (nb.ownHours) {
      if (![b.open, b.close, b.breakStart, b.breakEnd].every(timeOk)) return fail(res, 400, "Geçersiz saat.");
      const o = b.open || nb.open || c.open, cl = b.close || nb.close || c.close;
      if (toMin(o) >= toMin(cl)) return fail(res, 400, "Bitiş saati başlangıçtan sonra olmalı.");
      const bs = b.breakStart ?? "", be = b.breakEnd ?? "";
      if (!!bs !== !!be || (bs && toMin(bs) >= toMin(be))) return fail(res, 400, "Öğle arası başlangıcını ve bitişini birlikte, doğru sırayla seç.");
      Object.assign(nb, { open: o, close: cl, breakStart: bs, breakEnd: be });
      if (Array.isArray(b.closed)) { const cd = [...new Set(b.closed.map(Number).filter(d => d >= 0 && d <= 6))]; if (cd.length === 7) return fail(res, 400, "En az bir gün çalışmalısın."); nb.closed = cd; }
    }
    c.barbers[i] = nb; await saveCfg(S, c);
    return send(res, 200, { barber: { ...barberView(c, nb), active: nb.active !== false, ownHours: !!nb.ownHours } });
  }
  if (a === "book") {
    const target = owner ? b.barberId : u.barberId;
    if (!target) return fail(res, 400, "Usta seç.");
    const r = await createBooking(S, c, { ...b, barberId: target }, { source: "telefon", by: u.username });
    if (r.error) return fail(res, r.code === "taken" ? 409 : 400, r.error);
    return send(res, 200, { booking: clean(r.booking) });
  }
  if (a === "block") {
    const date = b.date, f = toMin(b.from), t = toMin(b.to);
    if (!isDate(date) || isNaN(f) || isNaN(t) || t <= f || f % UNIT || t % UNIT) return fail(res, 400, "Geçerli bir aralık seç.");
    const targets = b.barberId === "all" ? (owner ? c.barbers.filter(x => x.active !== false).map(x => x.id) : []) : [b.barberId || u.barberId];
    if (!targets.length || !targets.every(mine)) return fail(res, 403, "Sadece kendi saatlerini kapatabilirsin.");
    let made = 0, skipped = 0;
    for (const bid of targets) {
      // split the range around anything already booked, block the free parts
      let runStart = null;
      for (let m = f; m <= t; m += UNIT) {
        const free = m < t && (await lockRange(S, date, bid, m, UNIT, "tmp"));
        if (free) { await unlockRange(S, date, bid, m, UNIT, "tmp"); if (runStart === null) runStart = m; }
        if ((!free || m === t) && runStart !== null) {
          const id = rid(8);
          if (await lockRange(S, date, bid, runStart, m - runStart, "blk" + id)) { await hsetJSON(BL, id, { id, date, barberId: bid, time: fmt(runStart), dur: m - runStart, label: clip(b.label, 40) || "Kapalı", by: u.username }); made++; }
          runStart = null;
        }
        if (!free && m < t) skipped++;
      }
    }
    return send(res, 200, { made, skipped });
  }
  if (a === "unblock") {
    const ids = Array.isArray(b.ids) ? b.ids : [b.id];
    for (const id of ids) { const k = await hgetJSON(BL, String(id)); if (!k || !mine(k.barberId)) continue; await unlockRange(S, k.date, k.barberId, toMin(k.time), k.dur, "blk" + k.id); await redis("HDEL", BL, k.id); }
    return send(res, 200, { ok: true });
  }

  const bk = await hgetJSON(BK, String(b.id || ""));
  if (!bk) return fail(res, 404, "Randevu bulunamadı.");
  if (!mine(bk.barberId)) return fail(res, 403, "Bu randevu başka bir ustanın.");
  const save = async () => { bk.updatedAt = Date.now(); await hsetJSON(BK, bk.id, bk); return send(res, 200, { booking: clean(bk) }); };

  if (a === "approve") { if (bk.status !== "talep") return fail(res, 400, "Bu randevu onay beklemiyor."); bk.status = "onayli"; bk.approvedBy = u.username; bk.approvedAt = Date.now(); return save(); }
  if (a === "reject") { if (bk.status !== "talep") return fail(res, 400, "Bu randevu onay beklemiyor."); bk.rejectReason = clip(b.reason, 120); await closeBooking(S, bk, "red", "dukkan:" + u.username); return send(res, 200, { booking: clean(bk) }); }
  if (a === "status") {
    if (!["geldi", "gelmedi", "onayli"].includes(b.status)) return fail(res, 400, "Geçersiz durum.");
    if (!["onayli", "geldi", "gelmedi"].includes(bk.status)) return fail(res, 400, "Önce randevuyu onayla ya da geri al.");
    if (b.status === "onayli") { if (!(await claimPhone(S, bk.phone, bk.id))) return fail(res, 409, "Bu müşterinin başka açık randevusu var."); bk.status = "onayli"; return save(); }
    await closeBooking(S, bk, b.status, "dukkan:" + u.username); return send(res, 200, { booking: clean(bk) });
  }
  if (a === "note") { bk.staffNote = clip(b.staffNote, 300); return save(); }
  if (a === "cancel") { if (!OPEN.has(bk.status)) return fail(res, 400, "Bu randevu zaten kapanmış."); await closeBooking(S, bk, "iptal", "dukkan:" + u.username); return send(res, 200, { booking: clean(bk) }); }
  if (a === "restore") {
    if (!["iptal", "red"].includes(bk.status)) return send(res, 200, { booking: clean(bk) });
    if (startTs(bk.date, bk.time) < Date.now()) return fail(res, 400, "Geçmiş bir randevu geri alınamaz.");
    if (!(await claimPhone(S, bk.phone, bk.id))) return fail(res, 409, "Bu müşterinin başka açık randevusu var.");
    if (!(await lockRange(S, bk.date, bk.barberId, toMin(bk.time), bk.dur, bk.id))) { await releasePhone(S, bk); return fail(res, 409, "Bu saat artık dolu; önce saati değiştir."); }
    bk.status = "onayli"; bk.closedBy = null; return save();
  }
  if (a === "move") {
    if (!OPEN.has(bk.status)) return fail(res, 400, "Kapanmış randevu taşınamaz.");
    const date = b.date, m = toMin(b.time), barberId = owner && b.barberId ? b.barberId : bk.barberId;
    const barber = c.barbers.find(x => x.id === barberId); if (!barber) return fail(res, 404, "Usta bulunamadı.");
    if (!isDate(date)) return fail(res, 400, "Geçersiz gün.");
    const err = slotOk(c, barber, date, m, bk.dur); if (err) return fail(res, 400, err);
    const nw = trNow(); if (date < nw.date || (date === nw.date && m < nw.min)) return fail(res, 400, "Geçmiş bir saate taşınamaz.");
    if (date === bk.date && fmt(m) === bk.time && barberId === bk.barberId) return send(res, 200, { booking: clean(bk) });
    if (!(await lockRange(S, date, barberId, m, bk.dur, bk.id))) return fail(res, 409, "Bu saat dolu.");
    const keep = new Set(); if (date === bk.date && barberId === bk.barberId) for (let x = m; x < m + bk.dur; x += UNIT) keep.add(x);
    for (let x = toMin(bk.time); x < toMin(bk.time) + bk.dur; x += UNIT) if (!keep.has(x)) await unlockRange(S, bk.date, bk.barberId, x, UNIT, bk.id);
    bk.history = [...(bk.history || []), { from: `${bk.date} ${bk.time}`, to: `${date} ${fmt(m)}`, by: u.username, at: Date.now() }];
    Object.assign(bk, { date, time: fmt(m), barberId });
    return save();
  }
  return fail(res, 404, "Bilinmeyen istek.");
});
