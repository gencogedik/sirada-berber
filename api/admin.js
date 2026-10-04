// Owner-only: shop settings and team (usta accounts).
import { send, fail, body, query, getCfg, setJSON, hallJSON, hgetJSON, hsetJSON, redis, currentUser, userView, hashPass, normUser, clip, rid, toMin, trNow } from "./_lib.js";

export default async function handler(req, res) {
  try {
    const u = await currentUser(req);
    if (!u) return fail(res, 401, "Oturum kapandı. Tekrar giriş yap.");
    if (u.role !== "sahip") return fail(res, 403, "Bu bölüm sadece dükkân sahibine açık.");
    const a = query(req).action, c = await getCfg();
    if (req.method === "GET" && a === "team") {
      const users = await hallJSON("users");
      return send(res, 200, { users: Object.values(users).map(x => ({ ...userView(x), disabled: !!x.disabled })), barbers: c.barbers });
    }
    if (req.method !== "POST") return fail(res, 404, "Bilinmeyen istek.");
    const b = body(req);
    if (a === "config") {
      const n = b.cfg || {};
      const next = { ...c };
      next.shopName = clip(n.shopName, 40) || c.shopName; next.address = clip(n.address, 90); next.phone = clip(n.phone, 20);
      for (const k of ["open", "close"]) if (!isNaN(toMin(n[k]))) next[k] = n[k];
      next.breakStart = n.breakStart && !isNaN(toMin(n.breakStart)) ? n.breakStart : ""; next.breakEnd = n.breakEnd && !isNaN(toMin(n.breakEnd)) ? n.breakEnd : "";
      if (toMin(next.open) >= toMin(next.close)) return fail(res, 400, "Kapanış saati açılıştan sonra olmalı.");
      if (!!next.breakStart !== !!next.breakEnd || (next.breakStart && toMin(next.breakStart) >= toMin(next.breakEnd))) return fail(res, 400, "Öğle arası başlangıcı ve bitişini birlikte, doğru sırayla seç.");
      next.closed = Array.isArray(n.closed) ? [...new Set(n.closed.map(Number).filter(d => d >= 0 && d <= 6))] : c.closed;
      if (next.closed.length === 7) return fail(res, 400, "En az bir gün açık olmalı.");
      next.horizon = [7, 14, 21, 30].includes(+n.horizon) ? +n.horizon : c.horizon;
      next.minNotice = [0, 30, 60, 120, 240].includes(+n.minNotice) ? +n.minNotice : c.minNotice;
      next.cancelHours = [0, 1, 2, 6, 24].includes(+n.cancelHours) ? +n.cancelHours : c.cancelHours;
      if (Array.isArray(n.services)) {
        const sv = n.services.slice(0, 30).map(s => ({ id: /^[\w-]{1,20}$/.test(s.id || "") ? s.id : "s" + rid(4), name: clip(s.name, 40) || "Hizmet", dur: [30, 60, 90, 120].includes(+s.dur) ? +s.dur : 30, price: Math.max(0, Math.round(+s.price || 0)) }));
        if (!sv.length) return fail(res, 400, "En az bir hizmet olmalı.");
        next.services = sv;
      }
      await setJSON("cfg", next);
      return send(res, 200, { cfg: next });
    }
    if (a === "addStaff") {
      const username = normUser(b.username), name = clip(b.name, 40);
      if (!name) return fail(res, 400, "Ustanın adını yaz.");
      if (username.length < 3) return fail(res, 400, "Kullanıcı adı en az 3 harf olmalı (a-z, 0-9).");
      if (String(b.password || "").length < 8) return fail(res, 400, "Şifre en az 8 karakter olmalı.");
      if (await hgetJSON("users", username)) return fail(res, 400, "Bu kullanıcı adı alınmış.");
      const barberId = "b" + rid(4);
      c.barbers = [...c.barbers, { id: barberId, name }]; await setJSON("cfg", c);
      await hsetJSON("users", username, { username, name, role: "usta", barberId, ver: 1, createdAt: Date.now(), ...hashPass(b.password) });
      return send(res, 200, { ok: true });
    }
    if (a === "updateStaff") {
      const t = await hgetJSON("users", normUser(b.username)); if (!t) return fail(res, 404, "Kullanıcı bulunamadı.");
      if (b.name) { t.name = clip(b.name, 40); if (t.barberId) { c.barbers = c.barbers.map(x => x.id === t.barberId ? { ...x, name: t.name } : x); await setJSON("cfg", c); } }
      if (b.password) { if (String(b.password).length < 8) return fail(res, 400, "Şifre en az 8 karakter olmalı."); Object.assign(t, hashPass(b.password), { ver: (t.ver || 1) + 1 }); }
      if (typeof b.disabled === "boolean" && t.username !== u.username) {
        t.disabled = b.disabled; t.ver = (t.ver || 1) + 1;
        if (t.barberId) { c.barbers = c.barbers.map(x => x.id === t.barberId ? { ...x, active: !b.disabled } : x); await setJSON("cfg", c); }
      }
      await hsetJSON("users", t.username, t);
      return send(res, 200, { ok: true });
    }
    if (a === "removeStaff") {
      const t = await hgetJSON("users", normUser(b.username)); if (!t) return fail(res, 404, "Kullanıcı bulunamadı.");
      if (t.username === u.username) return fail(res, 400, "Kendi hesabını silemezsin.");
      const bk = await hallJSON("bk"); const today = trNow().date;
      if (Object.values(bk).some(x => x.barberId === t.barberId && x.status === "bekliyor" && x.date >= today)) return fail(res, 400, "Bu ustanın yaklaşan randevuları var. Önce onları taşı ya da iptal et.");
      await redis("HDEL", "users", t.username);
      if (t.barberId) { c.barbers = c.barbers.map(x => x.id === t.barberId ? { ...x, active: false } : x); await setJSON("cfg", c); }
      return send(res, 200, { ok: true });
    }
    if (a === "ownerChair") {  // owner toggles whether they take customers themselves
      const me = await hgetJSON("users", u.username);
      if (b.on && !me.barberId) { const id = "b" + rid(4); c.barbers = [...c.barbers, { id, name: me.name }]; me.barberId = id; }
      else if (b.on && me.barberId) c.barbers = c.barbers.map(x => x.id === me.barberId ? { ...x, active: true } : x);
      else if (!b.on && me.barberId) {
        const bk = await hallJSON("bk"); const today = trNow().date;
        if (Object.values(bk).some(x => x.barberId === me.barberId && x.status === "bekliyor" && x.date >= today)) return fail(res, 400, "Yaklaşan randevuların var. Önce onları taşı ya da iptal et.");
        c.barbers = c.barbers.map(x => x.id === me.barberId ? { ...x, active: false } : x);
      }
      if (!c.barbers.some(x => x.active !== false)) return fail(res, 400, "En az bir usta randevu almalı.");
      await setJSON("cfg", c); await hsetJSON("users", me.username, me);
      return send(res, 200, { ok: true });
    }
    return fail(res, 404, "Bilinmeyen istek.");
  } catch (e) { console.error(e); return fail(res, 500, "Sunucu hatası."); }
}
