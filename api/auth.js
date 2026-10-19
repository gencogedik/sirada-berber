// Shop staff login (shop link + username + password), logout, own password and name.
import { send, fail, body, query, ip, rateLimit, handle, hgetJSON, hsetJSON, hashPass, checkPass, sessionCookie, clearCookie, currentUser,
  userView, normUser, clip, shopBySlug, getCfg, saveCfg, K, hasDb, hallJSON, userByCard } from "./_lib.js";

export default handle(async (req, res) => {
  const a = query(req).action;
  if (req.method === "GET" && a === "me") {
    const u = await currentUser(req);
    return send(res, 200, { user: u ? userView(u) : null, shop: u ? { id: u.shopObj.id, slug: u.shopObj.slug } : null, demo: !hasDb });
  }
  if (req.method === "POST" && a === "login") {
    if (!(await rateLimit("login:" + ip(req), 10, 900))) return fail(res, 429, "Çok fazla deneme. 15 dakika sonra tekrar dene.");
    const b = body(req), un = normUser(b.username), pw = b.password || "";
    const code = String(b.shop || "").trim().replace(/^.*\//, "");
    let shop = null, u = null;
    if (code) { shop = await shopBySlug(code); u = shop ? await hgetJSON(K(shop.id, "users"), un) : null; if (u && !checkPass(pw, u)) u = null; }
    else if (un) {   // no shop code: find the shop by username + password
      const hits = [];
      for (const s of Object.values(await hallJSON("shops"))) { const x = await hgetJSON(K(s.id, "users"), un); if (x && !x.disabled && checkPass(pw, x)) hits.push([s, x]); }
      if (hits.length > 1) return fail(res, 409, "Bu kullanıcı adı birden fazla dükkânda var. Dükkân kodunu da yaz.", { needShop: true });
      if (hits.length) [shop, u] = hits[0];
    }
    if (!shop || !u || u.disabled) return fail(res, 401, code ? "Dükkân kodu, kullanıcı adı ya da şifre hatalı." : "Kullanıcı adı ya da şifre hatalı.");
    if (shop.disabled) return fail(res, 403, "Bu dükkânın hesabı kapalı. Sırada ile iletişime geç.");
    return send(res, 200, { user: userView(u), shop: { id: shop.id, slug: shop.slug } }, { "Set-Cookie": sessionCookie(shop.id, u) });
  }
  if (req.method === "POST" && a === "card") {   // QR login card
    if (!(await rateLimit("card:" + ip(req), 20, 900))) return fail(res, 429, "Çok fazla deneme. 15 dakika sonra tekrar dene.");
    const hit = await userByCard(body(req).k);
    if (!hit) return fail(res, 401, "Bu giriş kartı geçersiz ya da yenilenmiş. Dükkân sahibinden yeni kart iste.");
    if (hit.rec.disabled) return fail(res, 403, "Bu hesabın girişi kapalı. Dükkân sahibine sor.");
    if (hit.shop.disabled) return fail(res, 403, "Bu dükkânın hesabı kapalı. Sırada ile iletişime geç.");
    return send(res, 200, { user: userView(hit.rec), shop: { id: hit.shop.id, slug: hit.shop.slug } }, { "Set-Cookie": sessionCookie(hit.shop.id, hit.rec) });
  }
  if (req.method === "POST" && a === "logout") return send(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
  const u = await currentUser(req); if (!u) return fail(res, 401, "Oturum kapandı. Tekrar giriş yap.");
  if (req.method === "POST" && a === "password") {
    const b = body(req);
    if (!checkPass(b.old || "", u)) return fail(res, 400, "Mevcut şifre hatalı.");
    if (String(b.password || "").length < 8) return fail(res, 400, "Yeni şifre en az 8 karakter olmalı.");
    const { shop, shopObj, ...rec } = u;
    Object.assign(rec, hashPass(b.password), { ver: (rec.ver || 1) + 1 });
    await hsetJSON(K(shop, "users"), rec.username, rec);
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(shop, rec) });
  }
  if (req.method === "POST" && a === "name") {
    const name = clip(body(req).name, 40); if (!name) return fail(res, 400, "Adını yaz.");
    const { shop, shopObj, ...rec } = u; rec.name = name; await hsetJSON(K(shop, "users"), rec.username, rec);
    if (rec.barberId) { const c = await getCfg(shop); c.barbers = c.barbers.map(x => x.id === rec.barberId ? { ...x, name } : x); await saveCfg(shop, c); }
    return send(res, 200, { user: userView(rec) });
  }
  return fail(res, 404, "Bilinmeyen istek.");
});
