// Sırada login card (QR) and QR scanner, shared by the usta panel and the admin panel.
(function () {
  const CDN_QR = "/assets/vendor/qrcode.js";
  const CDN_JSQR = "/assets/vendor/jsQR.js";
  const loaded = {};
  const load = (src) => loaded[src] || (loaded[src] = new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => { delete loaded[src]; no(new Error("Kütüphane yüklenemedi. İnternet bağlantını kontrol et.")); }; document.head.appendChild(s); }));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = `
.sc-ov{position:fixed;inset:0;z-index:200;background:rgba(29,27,25,.86);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:16px;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}
.sc-ov img{max-width:min(420px,100%);max-height:calc(100dvh - 150px);border-radius:22px;box-shadow:0 18px 50px rgba(0,0,0,.45);background:#f4f0e7}
.sc-ov .sc-acts{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.sc-ov .sc-acts button{font:600 .95rem/1 "Instrument Sans",system-ui,sans-serif;border:0;border-radius:12px;padding:12px 16px;background:#f4f0e7;color:#1d1b19;cursor:pointer}
.sc-ov .sc-acts button.y{background:#f6d24a}
.sc-ov .sc-acts button.ghost{background:transparent;color:#f4f0e7;box-shadow:inset 0 0 0 1.5px rgba(244,240,231,.5)}
.sc-ov .sc-note{color:#f4f0e7;font:500 .9rem/1.4 "Instrument Sans",system-ui,sans-serif;text-align:center;max-width:420px;opacity:.85}
.sc-full{position:fixed;inset:0;z-index:210;background:#f4f0e7;display:flex;align-items:center;justify-content:center}
.sc-full img{width:100%;height:100%;object-fit:contain}
.sc-cam{position:relative;width:min(420px,100%);aspect-ratio:3/4;border-radius:22px;overflow:hidden;background:#000}
.sc-cam video{width:100%;height:100%;object-fit:cover}
.sc-cam .sc-frame{position:absolute;inset:18%;border:3px solid #f6d24a;border-radius:18px;box-shadow:0 0 0 999px rgba(0,0,0,.35)}`;
  function style() { if (document.getElementById("sc-css")) return; const s = document.createElement("style"); s.id = "sc-css"; s.textContent = css; document.head.appendChild(s); }

  const SCISSORS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#f6d24a"/><g fill="none" stroke="#1d1b19" stroke-width="2.6" stroke-linecap="round"><circle cx="9" cy="10" r="3.4"/><circle cx="9" cy="22" r="3.4"/><path d="M12 11.6 26 20M12 20.4 26 12"/></g></svg>';
  const img = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
  function wrap(ctx, text, maxW) { const words = String(text).split(/\s+/), lines = []; let cur = ""; for (const w of words) { const t = cur ? cur + " " + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; } if (cur) lines.push(cur); return lines; }
  function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // draws a 1080x1920 card and returns a PNG blob + data URL
  async function render(d) {
    await load(CDN_QR);
    try { await Promise.all([document.fonts.load('80px "DM Serif Display"'), document.fonts.load('600 40px "Instrument Sans"'), document.fonts.load('600 40px "IBM Plex Mono"')]); } catch (e) {}
    const SERIF = '"DM Serif Display", Georgia, serif', SANS = '"Instrument Sans", system-ui, sans-serif', MONO = '"IBM Plex Mono", ui-monospace, monospace';
    const W = 1080, H = 1920, cv = document.createElement("canvas"); cv.width = W; cv.height = H; const ctx = cv.getContext("2d");
    const INK = "#1d1b19", SOFT = "#6f685f", PAPER = "#f4f0e7", BAND = "#f6d24a";
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
    // header
    const logo = await img("data:image/svg+xml;charset=utf-8," + encodeURIComponent(SCISSORS));
    ctx.drawImage(logo, 96, 110, 112, 112);
    ctx.fillStyle = INK; ctx.font = `64px ${SERIF}`; ctx.textBaseline = "alphabetic"; ctx.fillText("Sırada", 236, 182);
    ctx.fillStyle = SOFT; ctx.font = `600 30px ${SANS}`; ctx.fillText("USTA GİRİŞ KARTI", 238, 220);
    // shop name with highlight band
    ctx.font = `92px ${SERIF}`; const shopLines = wrap(ctx, d.shopName || "Dükkân", W - 192).slice(0, 2);
    let y = 400;
    for (const ln of shopLines) { const w = ctx.measureText(ln).width; ctx.fillStyle = BAND; ctx.fillRect(90, y - 52, w + 18, 46); ctx.fillStyle = INK; ctx.fillText(ln, 96, y); y += 104; }
    // QR panel
    const qr = qrcode(0, "M"); qr.addData(d.url); qr.make();
    const n = qr.getModuleCount(), box = 840, px = (W - box) / 2, py = y + 10;
    ctx.save(); ctx.shadowColor = "rgba(29,27,25,.10)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12; ctx.fillStyle = "#fff"; rrect(ctx, px, py, box, box, 44); ctx.fill(); ctx.restore();
    const pad = 64, cell = Math.floor((box - pad * 2) / n), q = cell * n, qx = Math.round(px + (box - q) / 2), qy = Math.round(py + (box - q) / 2);
    ctx.fillStyle = INK; for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(qx + c * cell, qy + r * cell, cell + 0.5, cell + 0.5);
    // who
    y = py + box + 110;
    ctx.fillStyle = INK; ctx.font = `72px ${SERIF}`; ctx.fillText(wrap(ctx, d.name || d.username, W - 192)[0], 96, y);
    ctx.fillStyle = SOFT; ctx.font = `600 38px ${MONO}`; ctx.fillText(d.username + (d.role === "sahip" ? "  ·  dükkân sahibi" : "  ·  usta"), 98, y + 60);
    // how to
    y += 150; ctx.fillStyle = INK; ctx.font = `600 34px ${SANS}`;
    for (const ln of wrap(ctx, "Usta panelinde “QR ile giriş”e bas ve bu kartı okut. Telefon kamerasıyla okutmak da olur.", W - 192)) { ctx.fillText(ln, 96, y); y += 48; }
    ctx.fillStyle = "#a8432a"; ctx.font = `600 28px ${SANS}`; ctx.fillText("Bu kart giriş anahtarıdır, müşterilerle paylaşma.", 96, H - 90);
    const blob = await new Promise((ok) => cv.toBlob(ok, "image/png"));
    return { blob, url: cv.toDataURL("image/png") };
  }

  async function show(d, opts = {}) {
    style();
    const ov = document.createElement("div"); ov.className = "sc-ov"; ov.innerHTML = `<p class="sc-note">Kart hazırlanıyor…</p>`; document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); }; document.addEventListener("keydown", onKey);
    let out;
    try { out = await render(d); } catch (e) { ov.innerHTML = `<p class="sc-note">${esc(e.message)}</p><div class="sc-acts"><button data-x="close">Kapat</button></div>`; ov.onclick = (e) => { if (e.target.dataset.x === "close" || e.target === ov) close(); }; return; }
    const file = new File([out.blob], `sirada-kart-${d.username}.png`, { type: "image/png" });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    ov.innerHTML = `<img alt="Giriş kartı: ${esc(d.name || d.username)}" src="${out.url}">
      <div class="sc-acts"><button class="y" data-x="full">Tam ekran göster</button>${canShare ? `<button data-x="share">Paylaş</button>` : ""}<button data-x="dl">Resmi indir</button>${opts.onRenew ? `<button class="ghost" data-x="renew">Yeni kart (eskisi çalışmaz)</button>` : ""}<button class="ghost" data-x="close">Kapat</button></div>
      <p class="sc-note">Kartı ustanın telefonuna gönder ya da ekranda okut. Kart kaybolursa “Yeni kart” ile eskisini iptal et.</p>`;
    ov.onclick = async (e) => {
      const x = e.target.dataset && e.target.dataset.x; if (e.target === ov) return close(); if (!x) return;
      if (x === "close") close();
      if (x === "dl") { const a = document.createElement("a"); a.href = out.url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); }
      if (x === "share") { try { await navigator.share({ files: [file], title: "Sırada giriş kartı" }); } catch (err) {} }
      if (x === "full") { const f = document.createElement("div"); f.className = "sc-full"; f.innerHTML = `<img alt="" src="${out.url}">`; f.onclick = () => { f.remove(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }; document.body.appendChild(f); try { await f.requestFullscreen(); } catch (err) {} }
      if (x === "renew") { if (!confirmRenew(e.target)) return; close(); opts.onRenew(); }
    };
  }
  function confirmRenew(btn) { if (btn.dataset.sure) return true; btn.dataset.sure = "1"; btn.textContent = "Emin misin? Eski kart çalışmayacak"; return false; }

  // camera scanner; calls onToken(token) once a Sırada card is read
  async function scan(onToken) {
    style();
    const ov = document.createElement("div"); ov.className = "sc-ov";
    ov.innerHTML = `<div class="sc-cam"><video playsinline muted></video><div class="sc-frame"></div></div><p class="sc-note">Giriş kartındaki QR kodu çerçevenin içine getir.</p><div class="sc-acts"><button data-x="close">Vazgeç</button></div>`;
    document.body.appendChild(ov);
    let stream = null, stop = false;
    const close = () => { stop = true; if (stream) stream.getTracks().forEach(t => t.stop()); ov.remove(); };
    ov.onclick = (e) => { if (e.target.dataset && e.target.dataset.x === "close") close(); };
    const fail = (m) => { ov.querySelector(".sc-note").textContent = m; };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return fail("Bu tarayıcı kamerayı açamıyor. Kartı telefonun kamera uygulamasıyla okut.");
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }); }
    catch (e) { return fail("Kamera izni verilmedi. Tarayıcı ayarlarından bu site için kameraya izin ver."); }
    if (stop) return close();
    const v = ov.querySelector("video"); v.srcObject = stream; await v.play().catch(() => {});
    let detect;
    if ("BarcodeDetector" in window) { try { const bd = new BarcodeDetector({ formats: ["qr_code"] }); detect = async () => { const r = await bd.detect(v); return r[0] && r[0].rawValue; }; } catch (e) {} }
    if (!detect) {
      try { await load(CDN_JSQR); } catch (e) { return fail(e.message); }
      const cv = document.createElement("canvas"), cx = cv.getContext("2d", { willReadFrequently: true });
      detect = async () => { const w = v.videoWidth, h = v.videoHeight; if (!w) return null; const s = Math.min(1, 640 / Math.max(w, h)); cv.width = w * s; cv.height = h * s; cx.drawImage(v, 0, 0, cv.width, cv.height); const r = jsQR(cx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height); return r && r.data; };
    }
    const tick = async () => {
      if (stop) return;
      let txt = null; try { txt = await detect(); } catch (e) {}
      const tok = txt && parse(txt);
      if (tok) { close(); onToken(tok); return; }
      if (txt) fail("Bu bir Sırada giriş kartı değil.");
      setTimeout(tick, 180);
    };
    tick();
  }
  function parse(txt) {
    try { const u = new URL(txt); const k = u.searchParams.get("k"); if (k) return k; } catch (e) {}
    return /^[A-Za-z0-9]+~[a-z0-9._-]+~[A-Za-z0-9]+$/.test(txt) ? txt : null;
  }
  window.SiradaCard = { show, scan, parse };
})();
