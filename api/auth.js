// Staff login, first-run shop setup, logout, password change, owner recovery.
import crypto from "node:crypto";
import { send, fail, body, query, ip, rateLimit, getCfg, setJSON, hgetJSON, hsetJSON, hallJSON, hashPass, checkPass,
  sessionCookie, clearCookie, currentUser, userView, normUser, clip, rid, DEFAULT_CFG, hasDb } from "./_lib.js";

export default async function handler(req, res) {
  try {
    const a = query(req).action;
    if (req.method === "GET" && a === "me") {
      const users = await hallJSON("users");
      const u = await currentUser(req);
      return send(res, 200, { user: u ? userView(u) : null, needsSetup: !Object.keys(users).length, demo: !hasDb });
    }
    if (req.method === "POST" && a === "setup") {
      const users = await hallJSON("users");
      if (Object.keys(users).length) return fail(res, 403, "Dükkân zaten kurulmuş. Giriş yap.");
      const code = process.env.SETUP_CODE;
      const b = body(req);
      if (code && b.code !== code) return fail(res, 403, "Kurulum kodu hatalı.");
      const username = normUser(b.username), name = clip(b.name, 40), shopName = clip(b.shopName, 40);
      if (username.length < 3) return fail(res, 400, "Kullanıcı adı en az 3 harf olmalı (a-z, 0-9).");
      if (String(b.password || "").length < 8) return fail(res, 400, "Şifre en az 8 karakter olmalı.");
      if (!name || !shopName) return fail(res, 400, "Dükkân adını ve kendi adını yaz.");
      const barberId = "b" + rid(4);
      const cfg = { ...DEFAULT_CFG, shopName, barbers: b.cuts === false ? [] : [{ id: barberId, name }] };
      if (!cfg.barbers.length) return fail(res, 400, "En az bir usta olmalı.");
      await setJSON("cfg", cfg);
      const u = { username, name, role: "sahip", barberId: b.cuts === false ? null : barberId, ver: 1, createdAt: Date.now(), ...hashPass(b.password) };
      await hsetJSON("users", username, u);
      return send(res, 200, { user: userView(u) }, { "Set-Cookie": sessionCookie(u) });
    }
    if (req.method === "POST" && a === "login") {
      if (!(await rateLimit("login:" + ip(req), 10, 900))) return fail(res, 429, "Çok fazla deneme. 15 dakika sonra tekrar dene.");
      const b = body(req);
      const u = await hgetJSON("users", normUser(b.username));
      if (!u || u.disabled || !checkPass(b.password || "", u)) return fail(res, 401, "Kullanıcı adı ya da şifre hatalı.");
      return send(res, 200, { user: userView(u) }, { "Set-Cookie": sessionCookie(u) });
    }
    if (req.method === "POST" && a === "recover") {
      // Owner recovery: the code lives only in the Vercel project's env vars (RESET_CODE), so only whoever controls Vercel can use it.
      if (!(await rateLimit("recover:" + ip(req), 5, 3600))) return fail(res, 429, "Çok fazla deneme. 1 saat sonra tekrar dene.");
      const code = process.env.RESET_CODE || "";
      if (code.length < 8) return fail(res, 400, "Kurtarma kapalı. Vercel'de en az 8 karakterli RESET_CODE ortam değişkeni ekleyip yeniden dağıt.");
      const b = body(req);
      const given = Buffer.from(String(b.code || "")), want = Buffer.from(code);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return fail(res, 403, "Kurtarma kodu hatalı.");
      const u = await hgetJSON("users", normUser(b.username));
      if (!u) return fail(res, 404, "Bu kullanıcı adı yok.");
      if (String(b.password || "").length < 8) return fail(res, 400, "Yeni şifre en az 8 karakter olmalı.");
      Object.assign(u, hashPass(b.password), { ver: (u.ver || 1) + 1, disabled: false });
      await hsetJSON("users", u.username, u);
      return send(res, 200, { user: userView(u) }, { "Set-Cookie": sessionCookie(u) });
    }
    if (req.method === "POST" && a === "logout") return send(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
    if (req.method === "POST" && a === "password") {
      const u = await currentUser(req); if (!u) return fail(res, 401, "Oturum kapandı. Tekrar giriş yap.");
      const b = body(req);
      if (!checkPass(b.old || "", u)) return fail(res, 400, "Mevcut şifre hatalı.");
      if (String(b.password || "").length < 8) return fail(res, 400, "Yeni şifre en az 8 karakter olmalı.");
      Object.assign(u, hashPass(b.password), { ver: (u.ver || 1) + 1 });
      await hsetJSON("users", u.username, u);
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(u) });
    }
    return fail(res, 404, "Bilinmeyen istek.");
  } catch (e) { console.error(e); return fail(res, 500, "Sunucu hatası."); }
}
