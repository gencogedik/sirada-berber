// Shop owner only: shop settings, link name, team (ustas with or without a login).
import { send, fail, body, query, handle, getCfg, saveCfg, hallJSON, hgetJSON, hsetJSON, redis, currentUser, userView, hashPass, normUser, clip, rid,
  toMin, trNow, K, OPEN, STEPS, DURS, setSlug, barberView } from "./_lib.js";

export default handle(async (req, res) => {
  const u = await currentUser(req);
  if (!u) return fail(res, 401, "Oturum kapandı. Tekrar giriş yap.");
  if (u.role !== "sahip") return fail(res, 403, "Bu bölüm sadece dükkân sahibine açık.");
  const S = u.shop, a = query(req).action, c = await getCfg(S), UK = K(S, "users");
  const futureOpen = async (barberId) => Object.values(await hallJSON(K(S, "bk"))).some(x => x.barberId === barberId && OPEN.has(x.status) && x.date >= trNow().date);

  if (req.method === "GET" && a === "team") {
    const users = await hallJSON(UK);
    const byBarber = Object.fromEntries(Object.values(users).filter(x => x.barberId).map(x => [x.barberId, x]));
    return send(res, 200, {
      barbers: c.barbers.filter(b => !b.removed).map(b => ({ ...barberView(c, b), active: b.active !== false, ownHours: !!b.ownHours, login: byBarber[b.id] ? { username: byBarber[b.id].username, disabled: !!byBarber[b.id].disabled, role: byBarber[b.id].role } : null })),
      users: Object.values(users).map(x => ({ ...userView(x), disabled: !!x.disabled })), slug: u.shopObj.slug
    });
  }
  if (req.method !== "POST") return fail(res, 404, "Bilinmeyen istek.");
  const b = body(req);

  if (a === "config") {
    const n = b.cfg || {}, next = { ...c };
    next.shopName = clip(n.shopName, 40) || c.shopName; next.address = clip(n.address, 90); next.phone = clip(n.phone, 20);
    for (const k of ["open", "close"]) if (!isNaN(toMin(n[k]))) next[k] = n[k];
    next.breakStart = n.breakStart && !isNaN(toMin(n.breakStart)) ? n.breakStart : ""; next.breakEnd = n.breakEnd && !isNaN(toMin(n.breakEnd)) ? n.breakEnd : "";
    if (toMin(next.open) >= toMin(next.close)) return fail(res, 400, "Kapanış saati açılıştan sonra olmalı.");
    if (!!next.breakStart !== !!next.breakEnd || (next.breakStart && toMin(next.breakStart) >= toMin(next.breakEnd))) return fail(res, 400, "Öğle arası başlangıcını ve bitişini birlikte, doğru sırayla seç.");
    next.closed = Array.isArray(n.closed) ? [...new Set(n.closed.map(Number).filter(d => d >= 0 && d <= 6))] : c.closed;
    if (next.closed.length === 7) return fail(res, 400, "En az bir gün açık olmalı.");
    next.horizon = [7, 14, 21, 30].includes(+n.horizon) ? +n.horizon : c.horizon;
    next.minNotice = [0, 30, 60, 120, 240].includes(+n.minNotice) ? +n.minNotice : c.minNotice;
    next.cancelHours = [0, 1, 2, 6, 24].includes(+n.cancelHours) ? +n.cancelHours : c.cancelHours;
    if (Array.isArray(n.services)) {
      const sv = n.services.slice(0, 30).map(s => ({ id: /^[\w-]{1,20}$/.test(s.id || "") ? s.id : "s" + rid(4), name: clip(s.name, 40) || "Hizmet", dur: DURS.includes(+s.dur) ? +s.dur : 30, price: Math.max(0, Math.round(+s.price || 0)) }));
      if (!sv.length) return fail(res, 400, "En az bir hizmet olmalı.");
      next.services = sv;
    }
    if (n.slug && n.slug !== u.shopObj.slug) { const e = await setSlug(u.shopObj, n.slug); if (e) return fail(res, 400, e); }
    const shop = { ...u.shopObj, name: next.shopName }; await hsetJSON("shops", shop.id, shop);
    await saveCfg(S, next);
    return send(res, 200, { cfg: next, slug: u.shopObj.slug });
  }
  if (a === "addBarber") {   // a new chair, optionally with its own login
    const name = clip(b.name, 40); if (!name) return fail(res, 400, "Ustanın adını yaz.");
    const step = STEPS.includes(+b.step) ? +b.step : 30;
    let username = null;
    if (b.username) {
      username = normUser(b.username);
      if (username.length < 3) return fail(res, 400, "Kullanıcı adı en az 3 harf olmalı (a-z, 0-9).");
      if (String(b.password || "").length < 8) return fail(res, 400, "Şifre en az 8 karakter olmalı.");
      if (await hgetJSON(UK, username)) return fail(res, 400, "Bu kullanıcı adı alınmış.");
    }
    if (c.barbers.filter(x => x.active !== false).length >= 20) return fail(res, 400, "En fazla 20 usta eklenebilir.");
    const barberId = "b" + rid(4);
    c.barbers = [...c.barbers, { id: barberId, name, title: clip(b.title, 40), step }]; await saveCfg(S, c);
    if (username) await hsetJSON(UK, username, { username, name, role: "usta", barberId, ver: 1, createdAt: Date.now(), ...hashPass(b.password) });
    return send(res, 200, { ok: true, barberId });
  }
  if (a === "barber") {     // rename, show/hide a chair
    const i = c.barbers.findIndex(x => x.id === b.barberId); if (i < 0) return fail(res, 404, "Usta bulunamadı.");
    const nb = { ...c.barbers[i] };
    if (b.name) nb.name = clip(b.name, 40);
    if (b.title !== undefined) nb.title = clip(b.title, 40);
    if (typeof b.active === "boolean") {
      if (!b.active && await futureOpen(nb.id)) return fail(res, 400, "Bu ustanın açık randevuları var. Önce onları taşı ya da iptal et.");
      nb.active = b.active;
      if (!c.barbers.some((x, j) => (j === i ? nb.active : x.active !== false))) return fail(res, 400, "En az bir usta randevu almalı.");
    }
    c.barbers[i] = nb; await saveCfg(S, c);
    const users = await hallJSON(UK);
    for (const x of Object.values(users)) if (x.barberId === nb.id && b.name) { x.name = nb.name; await hsetJSON(UK, x.username, x); }
    return send(res, 200, { ok: true });
  }
  if (a === "login") {      // give an existing chair a login, or reset / close / open it
    const barber = c.barbers.find(x => x.id === b.barberId); if (!barber) return fail(res, 404, "Usta bulunamadı.");
    const users = await hallJSON(UK);
    let t = Object.values(users).find(x => x.barberId === barber.id);
    if (!t) {
      const username = normUser(b.username);
      if (username.length < 3) return fail(res, 400, "Kullanıcı adı en az 3 harf olmalı (a-z, 0-9).");
      if (users[username]) return fail(res, 400, "Bu kullanıcı adı alınmış.");
      if (String(b.password || "").length < 8) return fail(res, 400, "Şifre en az 8 karakter olmalı.");
      t = { username, name: barber.name, role: "usta", barberId: barber.id, ver: 1, createdAt: Date.now(), ...hashPass(b.password) };
    } else {
      if (t.username === u.username && b.disabled) return fail(res, 400, "Kendi hesabını kapatamazsın.");
      if (b.password) { if (String(b.password).length < 8) return fail(res, 400, "Şifre en az 8 karakter olmalı."); Object.assign(t, hashPass(b.password), { ver: (t.ver || 1) + 1 }); }
      if (typeof b.disabled === "boolean") { t.disabled = b.disabled; t.ver = (t.ver || 1) + 1; }
    }
    await hsetJSON(UK, t.username, t);
    return send(res, 200, { ok: true });
  }
  if (a === "removeBarber") {
    const barber = c.barbers.find(x => x.id === b.barberId); if (!barber) return fail(res, 404, "Usta bulunamadı.");
    if (barber.id === u.barberId) return fail(res, 400, "Kendi koltuğunu silemezsin; istersen gizle.");
    if (await futureOpen(barber.id)) return fail(res, 400, "Bu ustanın açık randevuları var. Önce onları taşı ya da iptal et.");
    const users = await hallJSON(UK);
    for (const x of Object.values(users)) if (x.barberId === barber.id) await redis("HDEL", UK, x.username);
    c.barbers = c.barbers.map(x => x.id === barber.id ? { ...x, active: false, removed: true } : x);
    if (!c.barbers.some(x => x.active !== false)) return fail(res, 400, "En az bir usta randevu almalı.");
    await saveCfg(S, c);
    return send(res, 200, { ok: true });
  }
  if (a === "ownerChair") {  // the owner takes customers too
    const me = await hgetJSON(UK, u.username);
    if (b.on) {
      if (!me.barberId) { const id = "b" + rid(4); c.barbers = [...c.barbers, { id, name: me.name, step: 30 }]; me.barberId = id; await hsetJSON(UK, me.username, me); }
      else c.barbers = c.barbers.map(x => x.id === me.barberId ? { ...x, active: true, removed: false } : x);
    } else if (me.barberId) {
      if (await futureOpen(me.barberId)) return fail(res, 400, "Açık randevuların var. Önce onları taşı ya da iptal et.");
      c.barbers = c.barbers.map(x => x.id === me.barberId ? { ...x, active: false } : x);
    }
    await saveCfg(S, c);
    return send(res, 200, { ok: true });
  }
  return fail(res, 404, "Bilinmeyen istek.");
});
