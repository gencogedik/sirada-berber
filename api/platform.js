// Platform admin (the person who sells Sırada to barbershops): create shop accounts, reset owner passwords, open/close shops.
import { send, fail, body, query, ip, rateLimit, handle, redis, hallJSON, hgetJSON, hsetJSON, getCfg, saveCfg, hashPass, checkPass,
  adminCookie, clearAdminCookie, currentAdmin, normUser, rid, genPass, K, DEFAULT_CFG, setSlug, validSlug, migrateLegacy, hasDb, OPEN,
  clip, sessionCookie, userView, purgeShop } from "./_lib.js";

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

  if (req.method === "GET" && a === "admins") return send(res, 200, { admins: Object.values(admins).map(x => ({ username: x.username, createdAt: x.createdAt, by: x.by || null })), me: me.username });
  if (req.method === "POST" && a === "addAdmin") {   // another platform admin (full rights)
    const b = body(req), username = normUser(b.username);
    if (username.length < 3) return fail(res, 400, "Kullanıcı adı en az 3 harf olmalı (a-z, 0-9).");
    if (admins[username]) return fail(res, 400, "Bu yönetici zaten var.");
    if (String(b.password || "").length < 10) return fail(res, 400, "Yönetici şifresi en az 10 karakter olmalı.");
    await hsetJSON("padmins", username, { username, ver: 1, createdAt: Date.now(), by: me.username, ...hashPass(b.password) });
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && a === "removeAdmin") {
    const username = normUser(body(req).username);
    if (username === me.username) return fail(res, 400, "Kendi yönetici hesabını silemezsin.");
    if (!admins[username]) return fail(res, 404, "Yönetici bulunamadı.");
    await redis("HDEL", "padmins", username);
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && a === "adminPass") {  // change your own admin password
    const b = body(req);
    if (!checkPass(b.old || "", me)) return fail(res, 400, "Mevcut şifre hatalı.");
    if (String(b.password || "").length < 10) return fail(res, 400, "Yeni şifre en az 10 karakter olmalı.");
    const ad = { ...me, ...hashPass(b.password), ver: (me.ver || 1) + 1 }; await hsetJSON("padmins", me.username, ad);
    return send(res, 200, { ok: true }, { "Set-Cookie": adminCookie(ad) });
  }
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
  if (req.method === "GET" && a === "shop") {   // one shop's accounts, for the admin's detail view
    const s = await hgetJSON("shops", String(query(req).id || "")); if (!s) return fail(res, 404, "Dükkân bulunamadı.");
    const [users, c] = await Promise.all([hallJSON(K(s.id, "users")), getCfg(s.id)]);
    const chair = (id) => { const x = c.barbers.find(y => y.id === id && !y.removed); return x && x.active !== false ? x.name : null; };
    return send(res, 200, { shop: { id: s.id, slug: s.slug, name: c.shopName, disabled: !!s.disabled, note: s.note || "", barbers: c.barbers.filter(x => x.active !== false).length },
      users: Object.values(users).map(x => ({ ...userView(x), disabled: !!x.disabled, chair: chair(x.barberId) })).sort((x, y) => (x.role === "sahip" ? -1 : 0) - (y.role === "sahip" ? -1 : 0)) });
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
      const chair = "b" + rid(4);
      await saveCfg(id, { ...DEFAULT_CFG, shopName: shop.name, barbers: [{ id: chair, name: "Usta", step: 30 }] });
      const username = slug.replace(/-/g, ""), password = username + "123";   // first password: <username>123
      await hsetJSON(K(id, "users"), username, { username, name: "Usta", role: "sahip", barberId: chair, ver: 1, createdAt: Date.now(), ...hashPass(password) });
      made.push({ id, slug, username, password });
    }
    return send(res, 200, { made });
  }
  if (a === "deleteShops") {  // delete the selected shops (the list's checkboxes)
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, 200).map(String) : [];
    if (!ids.length) return fail(res, 400, "Silinecek dükkân seç.");
    if (b.confirm !== true) return fail(res, 400, "Silmeyi onayla.");
    let n = 0; for (const id of ids) { const x = await hgetJSON("shops", id); if (x) { await purgeShop(x); n++; } }
    return send(res, 200, { deleted: n });
  }
  if (a === "deleteAll") {   // wipe every shop, its accounts and bookings — typed confirmation required
    if (b.confirm !== "HEPSİNİ SİL") return fail(res, 400, "Onay için tam olarak HEPSİNİ SİL yaz.");
    const all = Object.values(await hallJSON("shops"));
    for (const x of all) await purgeShop(x);
    await redis("DEL", "slugs", "cfg", "users", "bk", "bl"); await redis("SET", "migrated", "1");
    return send(res, 200, { deleted: all.length });
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
  const UK = K(s.id, "users");
  const getUser = async () => { const u = await hgetJSON(UK, normUser(b.username)); if (!u) { fail(res, 404, "Hesap bulunamadı."); return null; } return u; };
  if (a === "rename") {
    const name = clip(b.name, 40); if (!name) return fail(res, 400, "Dükkân adını yaz.");
    const c = await getCfg(s.id); c.shopName = name; await saveCfg(s.id, c);
    s.name = name; await hsetJSON("shops", s.id, s);
    return send(res, 200, { ok: true });
  }
  if (a === "userRename") {   // change a login's username
    const u = await getUser(); if (!u) return;
    const nu = normUser(b.newUsername);
    if (nu.length < 3) return fail(res, 400, "Kullanıcı adı en az 3 harf olmalı (a-z, 0-9).");
    if (nu === u.username) return send(res, 200, { ok: true });
    if (await hgetJSON(UK, nu)) return fail(res, 400, "Bu kullanıcı adı bu dükkânda zaten var.");
    await redis("HDEL", UK, u.username);
    await hsetJSON(UK, nu, { ...u, username: nu, ver: (u.ver || 1) + 1 });
    return send(res, 200, { ok: true });
  }
  if (a === "userName") {
    const u = await getUser(); if (!u) return;
    const name = clip(b.name, 40); if (!name) return fail(res, 400, "Adı yaz.");
    u.name = name; await hsetJSON(UK, u.username, u);
    if (u.barberId) { const c = await getCfg(s.id); c.barbers = c.barbers.map(x => x.id === u.barberId ? { ...x, name } : x); await saveCfg(s.id, c); }
    return send(res, 200, { ok: true });
  }
  if (a === "userPass") {
    const u = await getUser(); if (!u) return;
    const password = b.password ? String(b.password) : genPass();
    if (password.length < 8) return fail(res, 400, "Şifre en az 8 karakter olmalı.");
    Object.assign(u, hashPass(password), { ver: (u.ver || 1) + 1 });
    await hsetJSON(UK, u.username, u);
    return send(res, 200, { username: u.username, password });
  }
  if (a === "userToggle") {
    const u = await getUser(); if (!u) return;
    u.disabled = !!b.disabled; u.ver = (u.ver || 1) + 1; await hsetJSON(UK, u.username, u);
    return send(res, 200, { ok: true });
  }
  if (a === "userDelete") {
    const u = await getUser(); if (!u) return;
    const users = Object.values(await hallJSON(UK));
    if (u.role === "sahip" && users.filter(x => x.role === "sahip").length < 2) return fail(res, 400, "Dükkânın tek sahip hesabı silinemez; önce şifresini ya da kullanıcı adını değiştir.");
    await redis("HDEL", UK, u.username);
    return send(res, 200, { ok: true });
  }
  if (a === "userAdd") {      // add another login (owner or usta) to a shop
    const username = normUser(b.username), name = clip(b.name, 40) || "Dükkân sahibi";
    if (username.length < 3) return fail(res, 400, "Kullanıcı adı en az 3 harf olmalı (a-z, 0-9).");
    if (await hgetJSON(UK, username)) return fail(res, 400, "Bu kullanıcı adı bu dükkânda zaten var.");
    const password = b.password ? String(b.password) : username + "123";
    if (password.length < 6) return fail(res, 400, "Şifre en az 6 karakter olmalı.");
    let barberId = null;
    if (b.role === "usta") {   // an usta login always comes with their own chair, so customers can pick them
      const c = await getCfg(s.id); barberId = "b" + rid(4);
      c.barbers = [...c.barbers, { id: barberId, name: name === "Dükkân sahibi" ? "Usta" : name, step: 30 }]; await saveCfg(s.id, c);
    }
    await hsetJSON(UK, username, { username, name, role: b.role === "usta" ? "usta" : "sahip", barberId, ver: 1, createdAt: Date.now(), ...hashPass(password) });
    return send(res, 200, { username, password });
  }
  if (a === "giveChair") {     // a login without a chair (or a hidden one): give / reopen it
    const u = await getUser(); if (!u) return;
    const c = await getCfg(s.id);
    if (u.barberId && c.barbers.some(x => x.id === u.barberId)) c.barbers = c.barbers.map(x => x.id === u.barberId ? { ...x, active: true, removed: false } : x);
    else { u.barberId = "b" + rid(4); c.barbers = [...c.barbers, { id: u.barberId, name: u.name && u.name !== "Dükkân sahibi" ? u.name : "Usta", step: 30 }]; await hsetJSON(UK, u.username, u); }
    await saveCfg(s.id, c);
    return send(res, 200, { ok: true });
  }
  if (a === "openChair") {   // a shop with no active usta: give the owner a chair so customers can book
    const c = await getCfg(s.id);
    if (c.barbers.some(x => x.active !== false)) return send(res, 200, { ok: true });
    const users = Object.values(await hallJSON(UK));
    const owner = users.find(x => x.role === "sahip"); if (!owner) return fail(res, 404, "Bu dükkânın sahip hesabı yok; önce bir sahip hesabı ekle.");
    if (owner.barberId && c.barbers.some(x => x.id === owner.barberId)) c.barbers = c.barbers.map(x => x.id === owner.barberId ? { ...x, active: true, removed: false } : x);
    else { const id = "b" + rid(4); c.barbers = [...c.barbers, { id, name: owner.name && owner.name !== "Dükkân sahibi" ? owner.name : "Usta", step: 30 }]; owner.barberId = id; await hsetJSON(UK, owner.username, owner); }
    await saveCfg(s.id, c);
    return send(res, 200, { ok: true });
  }
  if (a === "enter") {        // open this shop's panel with owner rights (8-hour session, marked as admin)
    const users = Object.values(await hallJSON(UK));
    const owner = users.find(x => x.role === "sahip" && !x.disabled) || users.find(x => x.role === "sahip");
    if (!owner) return fail(res, 404, "Bu dükkânın sahip hesabı yok; önce bir sahip hesabı ekle.");
    return send(res, 200, { ok: true, slug: s.slug }, { "Set-Cookie": sessionCookie(s.id, owner, me.username) });
  }
  if (a === "deleteShop") {   // removes the shop from the platform; its link stops working
    if (b.confirm !== s.slug) return fail(res, 400, "Silmek için dükkân kodunu aynen yaz.");
    await purgeShop(s);
    return send(res, 200, { ok: true });
  }
  if (a === "toggle") { s.disabled = !!b.disabled; await hsetJSON("shops", s.id, s); return send(res, 200, { ok: true }); }
  if (a === "slug") { const e = await setSlug(s, b.slug); if (e) return fail(res, 400, e); return send(res, 200, { slug: s.slug }); }
  if (a === "note") { s.note = String(b.note || "").slice(0, 120); await hsetJSON("shops", s.id, s); return send(res, 200, { ok: true }); }
  return fail(res, 404, "Bilinmeyen istek.");
});
