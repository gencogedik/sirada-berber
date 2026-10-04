// Platform admin (the person who sells Sırada to barbershops): create shop accounts, reset owner passwords, open/close shops.
import { send, fail, body, query, ip, rateLimit, handle, redis, hallJSON, hgetJSON, hsetJSON, getCfg, saveCfg, hashPass, checkPass,
  adminCookie, clearAdminCookie, currentAdmin, normUser, rid, genPass, K, DEFAULT_CFG, setSlug, validSlug, migrateLegacy, hasDb, OPEN } from "./_lib.js";

export default handle(async (req, res) => {
  const a = query(req).action;
  const admins = await hallJSON("padmins");
  if (req.method === "GET" && a === "status") {
    const me = await currentAdmin(req);
    return send(res, 200, { needsSetup: !Object.keys(admins).length, admin: me ? { username: me.username } : null, demo: !hasDb });
  }
  if (req.method === "POST" && a === "setup") {
    if (Object.keys(admins).length) return fail(res, 403, "Yönetici hesabı zaten var. Giriş yap.");
    const b = body(req), username = normUser(b.username);
    if (username.length < 3) return fail(res, 400, "Kullanıcı adı en az 3 harf olmalı (a-z, 0-9).");
    if (String(b.password || "").length < 10) return fail(res, 400, "Yönetici şifresi en az 10 karakter olmalı.");
    const ad = { username, ver: 1, createdAt: Date.now(), ...hashPass(b.password) };
    await hsetJSON("padmins", username, ad);
    const moved = await migrateLegacy();
    return send(res, 200, { admin: { username }, moved: moved ? moved.slug : null }, { "Set-Cookie": adminCookie(ad) });
  }
  if (req.method === "POST" && a === "login") {
    if (!(await rateLimit("plogin:" + ip(req), 8, 900))) return fail(res, 429, "Çok fazla deneme. 15 dakika sonra tekrar dene.");
    const b = body(req), ad = admins[normUser(b.username)];
    if (!ad || !checkPass(b.password || "", ad)) return fail(res, 401, "Kullanıcı adı ya da şifre hatalı.");
    await migrateLegacy();
    return send(res, 200, { admin: { username: ad.username } }, { "Set-Cookie": adminCookie(ad) });
  }
  if (req.method === "POST" && a === "logout") return send(res, 200, { ok: true }, { "Set-Cookie": clearAdminCookie() });

  const me = await currentAdmin(req);
  if (!me) return fail(res, 401, "Oturum kapandı. Tekrar giriş yap.");

  if (req.method === "GET" && a === "shops") {
    const shops = Object.values(await hallJSON("shops"));
    const out = [];
    for (const s of shops) {
      const [users, bk, c] = await Promise.all([hallJSON(K(s.id, "users")), hallJSON(K(s.id, "bk")), getCfg(s.id)]);
      const list = Object.values(bk);
      const owner = Object.values(users).find(x => x.role === "sahip");
      out.push({ id: s.id, slug: s.slug, name: c.shopName, disabled: !!s.disabled, createdAt: s.createdAt, note: s.note || "",
        owner: owner ? owner.username : null, ownerName: owner ? owner.name : null, barbers: c.barbers.filter(x => x.active !== false).length,
        bookings: list.length, open: list.filter(x => OPEN.has(x.status)).length, last: list.reduce((m, x) => Math.max(m, x.createdAt || 0), 0) });
    }
    out.sort((x, y) => x.createdAt - y.createdAt);
    return send(res, 200, { shops: out });
  }
  if (req.method !== "POST") return fail(res, 404, "Bilinmeyen istek.");
  const b = body(req);

  if (a === "create") {   // bulk-create ready-to-sell shop accounts
    const count = Math.max(1, Math.min(50, Math.round(+b.count || 1)));
    const prefix = (String(b.prefix || "berber").toLowerCase().replace(/[^a-z0-9]/g, "") || "berber").slice(0, 20);
    const made = [];
    let n = 1;
    for (let i = 0; i < count; i++) {
      let slug; do { slug = `${prefix}-${String(n).padStart(2, "0")}`; n++; } while (await redis("HGET", "slugs", slug));
      if (!validSlug(slug)) return fail(res, 400, "Geçersiz önek.");
      const id = "d" + rid(5);
      const shop = { id, slug, name: `Berber ${slug.split("-").pop()}`, createdAt: Date.now() + i, by: me.username };
      await hsetJSON("shops", id, shop); await redis("HSET", "slugs", slug, id);
      await saveCfg(id, { ...DEFAULT_CFG, shopName: shop.name });
      const username = slug.replace(/-/g, ""), password = genPass();
      await hsetJSON(K(id, "users"), username, { username, name: "Dükkân sahibi", role: "sahip", barberId: null, ver: 1, createdAt: Date.now(), ...hashPass(password) });
      made.push({ id, slug, username, password });
    }
    return send(res, 200, { made });
  }
  const s = await hgetJSON("shops", String(b.id || ""));
  if (!s) return fail(res, 404, "Dükkân bulunamadı.");
  if (a === "resetOwner") {
    const users = await hallJSON(K(s.id, "users"));
    const owner = Object.values(users).find(x => x.role === "sahip");
    if (!owner) return fail(res, 404, "Bu dükkânın sahip hesabı yok.");
    const password = genPass();
    Object.assign(owner, hashPass(password), { ver: (owner.ver || 1) + 1, disabled: false });
    await hsetJSON(K(s.id, "users"), owner.username, owner);
    return send(res, 200, { username: owner.username, password });
  }
  if (a === "toggle") { s.disabled = !!b.disabled; await hsetJSON("shops", s.id, s); return send(res, 200, { ok: true }); }
  if (a === "slug") { const e = await setSlug(s, b.slug); if (e) return fail(res, 400, e); return send(res, 200, { slug: s.slug }); }
  if (a === "note") { s.note = String(b.note || "").slice(0, 120); await hsetJSON("shops", s.id, s); return send(res, 200, { ok: true }); }
  return fail(res, 404, "Bilinmeyen istek.");
});
