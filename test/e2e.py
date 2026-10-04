# End-to-end test of the multi-shop app against a real local Redis.
# Run: python3 test/e2e.py   (needs redis-server and Playwright's Chromium)
import asyncio, json, os, subprocess, time, urllib.request, datetime
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); OUT = ROOT + "/test/shots/"; os.makedirs(OUT, exist_ok=True)
PORT, RPORT = 3131, 6399; BASE = f"http://localhost:{PORT}"
subprocess.run(["redis-server", "--port", str(RPORT), "--save", "", "--daemonize", "yes"], stdout=subprocess.DEVNULL); time.sleep(0.6)
subprocess.run(["redis-cli", "-p", str(RPORT), "flushall"], stdout=subprocess.DEVNULL)
# legacy single-shop data, to check it is moved into the new structure
legacy_cfg = {"shopName": "Genco Berber", "barbers": [{"id": "bx1", "name": "Genco"}], "closed": [1], "open": "09:00", "close": "20:00", "services": [{"id": "s1", "name": "Saç kesimi", "dur": 30, "price": 400}]}
subprocess.run(["redis-cli", "-p", str(RPORT), "set", "cfg", json.dumps(legacy_cfg)], stdout=subprocess.DEVNULL)
srv = subprocess.Popen(["node", "dev.mjs"], cwd=ROOT, env={**os.environ, "PORT": str(PORT), "REDIS_URL": f"redis://127.0.0.1:{RPORT}"}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.2)
log = []
def ok(name, cond, extra=""): log.append(("PASS" if cond else "FAIL") + "  " + name + ("  " + str(extra) if extra else ""))
def get(path): return json.loads(urllib.request.urlopen(BASE + path).read())
def post(path, data):
    req = urllib.request.Request(BASE + path, data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args=["--no-sandbox"])
        errs = []
        async def ctx(w=400, h=860):
            c = await br.new_context(viewport={"width": w, "height": h}, timezone_id="Europe/Istanbul", locale="tr-TR", color_scheme="dark")
            pg = await c.new_page()
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "ERR_TUNNEL" not in m.text and "status of 4" not in m.text else None)
            return c, pg
        # landing
        lc, land = await ctx(); await land.goto(BASE + "/"); await land.wait_for_timeout(300)
        ok("landing page", "Sıra" in await land.inner_text("#app"))
        # 1. platform admin
        ac, ad = await ctx(1100, 900)
        await ad.goto(BASE + "/yonetim"); await ad.wait_for_timeout(400)
        await ad.fill("#u", "genco"); await ad.fill("#p", "kisa"); await ad.click("button[type=submit]"); await ad.wait_for_timeout(300)
        ok("admin short password refused", "10 karakter" in await ad.inner_text("#root"))
        await ad.fill("#u", "genco"); await ad.fill("#p", "yonetici-2026!"); await ad.click("button[type=submit]"); await ad.wait_for_timeout(700)
        txt = await ad.inner_text("#root")
        ok("legacy shop migrated", "Genco Berber" in txt and "/genco-berber" in txt)
        await ad.fill("#cn", "10"); await ad.click("#cf button[type=submit]"); await ad.wait_for_timeout(1500)
        rows = await ad.locator(".creds tbody tr").all_inner_texts()
        ok("10 shop accounts created", len(rows) == 10, rows[0] if rows else "")
        await ad.screenshot(path=OUT + "01_yonetim.png", full_page=True)
        cred = rows[0].split("\t"); slug, user0, pass0 = cred[1].strip(), cred[2].strip(), cred[3].strip()
        ok("first password is username+123", pass0 == user0 + "123", (user0, pass0))
        # second platform admin (e.g. for Baran)
        await ad.fill("#admU", "baran"); await ad.fill("#admP", "baran-sifre-2026"); await ad.click("#admF button[type=submit]"); await ad.wait_for_timeout(700)
        ok("second admin added and can log in", "baran" in await ad.inner_text("#root") and post("/api/platform?action=login", {"username": "baran", "password": "baran-sifre-2026"})[0] == 200)
        # 2. owner logs in, sets up the shop
        oc, ow = await ctx()
        await ow.goto(BASE + "/usta"); await ow.wait_for_timeout(300)
        await ow.fill("#lShop", slug); await ow.fill("#lUser", user0); await ow.fill("#lPass", "yanlis"); await ow.click("button[type=submit]"); await ow.wait_for_timeout(300)
        ok("wrong owner password refused", "hatalı" in await ow.inner_text("#root"))
        await ow.fill("#lShop", slug); await ow.fill("#lUser", user0); await ow.fill("#lPass", pass0); await ow.click("button[type=submit]"); await ow.wait_for_timeout(700)
        nav = await ow.inner_text("nav.tabs")
        ok("owner menus", all(x in nav for x in ["Ajanda", "Müşteriler", "Ustalar", "Ayarlar"]), nav.replace("\n", " "))
        await ow.click("nav [data-v=ayar]"); await ow.wait_for_timeout(300)
        await ow.fill("#cShop", "Kemal'in Yeri"); await ow.fill("#cAddr", "Ümraniye, İstanbul"); await ow.fill("#cPhone", "0216 555 44 33")
        await ow.click("[data-act=saveCfg]"); await ow.wait_for_timeout(400)
        ok("settings saved", "Ayarlar güncel" in await ow.inner_text("main"), await ow.inner_text("#toast"))
        await ow.click("nav [data-v=ustalar]"); await ow.wait_for_timeout(400)
        await ow.click("[data-act=addOpen]"); await ow.wait_for_timeout(200)
        await ow.fill("#aName", "Emre"); await ow.fill("#aTitle", "Sakal ustası"); await ow.select_option("#aStep", "20"); await ow.fill("#aUser", "emre"); await ow.fill("#aPass", "emre12345")
        await ow.click("#addF button[type=submit]"); await ow.wait_for_timeout(600)
        tt = await ow.inner_text("main")
        ok("usta added with own slot length", "Emre" in tt and "20 dk dilim" in tt)
        # Emre's own hours: 10:00–18:00, Sunday off
        await ow.click("[data-act=editB] >> nth=1"); await ow.wait_for_timeout(300)
        pre = (await ow.locator("[data-hf]").first.get_attribute("data-hf"))
        await ow.check(f"#h{pre}_own"); await ow.select_option(f"#h{pre}_open", "10:00"); await ow.select_option(f"#h{pre}_close", "18:00")
        await ow.click(f"#h{pre}_closed [data-v='0']"); await ow.click(f"[data-hf='{pre}'] button[type=submit]"); await ow.wait_for_timeout(500)
        ok("usta hours saved", "10:00–18:00" in await ow.inner_text("main"))
        await ow.screenshot(path=OUT + "02_ustalar.png", full_page=True)
        # 3. customer books with Emre
        cc, cu = await ctx()
        await cu.goto(BASE + "/" + slug); await cu.wait_for_timeout(500)
        ctext = await cu.inner_text("#app")
        ok("customer page: shop info + barber cards", "Ümraniye" in ctext and "Sakal ustası" in ctext and "20 dk'da bir" in ctext)
        await cu.screenshot(path=OUT + "03_customer.png", full_page=True)
        await cu.click(".bcard:has-text('Emre')"); await cu.wait_for_timeout(200)
        await cu.click(".day:not([disabled]) >> nth=1"); await cu.wait_for_timeout(200)
        first_time = (await cu.locator(".time:not([disabled])").first.inner_text()).strip()
        ok("Emre's grid starts at 10:00, 20 min steps", first_time == "10:00" and "10:20" in await cu.inner_text("#app"), first_time)
        await cu.click(".time:not([disabled]) >> nth=1"); await cu.wait_for_timeout(200)
        await cu.fill("#fn", "Ahmet Yılmaz"); await cu.fill("#fp", "0532 111 22 33"); await cu.fill("#fo", "Yanlar 2 numara")
        await cu.click("[data-act=confirm]"); await cu.wait_for_timeout(600)
        dtxt = await cu.inner_text("#app")
        ok("request sent, waiting for approval, countdown shown", "Onay bekliyor" in dtxt and "sonra" in dtxt, [l for l in dtxt.split("\n") if "sonra" in l][:1])
        await cu.screenshot(path=OUT + "04_requested.png", full_page=True)
        mine = await cu.evaluate(f"JSON.parse(localStorage.getItem('mine:{slug}'))")
        # second booking with the same phone is refused
        await cu.click("[data-act=openDone]"); await cu.wait_for_timeout(400)
        await cu.click("[data-act=book]"); await cu.wait_for_timeout(400)
        ok("open booking banner on booking page", "Açık randevun var" in await cu.inner_text("#app"))
        await cu.click(".time:not([disabled]) >> nth=2"); await cu.wait_for_timeout(200)
        await cu.click("[data-act=confirm]"); await cu.wait_for_timeout(500)
        ok("second open booking with the same usta refused", "açık bir randevun var" in await cu.inner_text("#sheet"), (await cu.inner_text("#sheet"))[-120:])
        await cu.click("[data-act=close] >> nth=1"); await cu.wait_for_timeout(200)
        # same phone, other usta: allowed (each usta has their own queue)
        init = get(f"/api/public?shop={slug}&action=init"); bars = init["cfg"]["barbers"]
        emre_id = [b for b in bars if b["name"] == "Emre"][0]["id"]; other_id = [b for b in bars if b["name"] != "Emre"][0]["id"]
        st, rx = post(f"/api/public?shop={slug}&action=book", {"serviceId": "s1", "barberId": other_id, "date": mine[0]["date"], "time": "16:00", "name": "Ahmet Yılmaz", "phone": "05321112233"})
        ok("same customer can book another usta", st == 200, (st, rx.get("error")))
        st, ry = post(f"/api/public?shop={slug}&action=book", {"serviceId": "s1", "barberId": other_id, "date": mine[0]["date"], "time": "17:00", "name": "Ahmet Yılmaz", "phone": "05321112233"})
        ok("but not twice with that usta", st == 423, st)
        lc2, lk = await ctx(); await lk.goto(BASE + f"/{slug}?u={emre_id}"); await lk.wait_for_timeout(500)
        ok("usta link preselects that usta", (await lk.locator(".bcard[aria-pressed='true']").inner_text()).startswith("E"))
        # 4. Emre logs in, approves
        ec, em = await ctx()
        await em.goto(BASE + f"/usta?d={slug}"); await em.wait_for_timeout(300)
        await em.fill("#lUser", "emre"); await em.fill("#lPass", "emre12345"); await em.click("button[type=submit]"); await em.wait_for_timeout(700)
        nav = await em.inner_text("nav.tabs"); etxt = await em.inner_text("main")
        ok("usta menus: Ajanda/Müşteriler/Saatlerim only", "Ustalar" not in nav and "Ayarlar" not in nav and "Saatlerim" in nav, nav.replace("\n", " "))
        ok("pending request in usta inbox", "Onay bekleyen 1 talep" in etxt and "Ahmet Yılmaz" in etxt)
        await em.screenshot(path=OUT + "05_usta_inbox.png", full_page=True)
        await em.click(".inbox [data-act=approve]"); await em.wait_for_timeout(600)
        ok("approved", "Onay bekleyen" not in await em.inner_text("main"))
        bk = get(f"/api/public?shop={slug}&action=booking&id={mine[0]['id']}&k={mine[0]['k']}")["booking"]
        ok("customer sees approved", bk["status"] == "onayli", bk["status"])
        await em.click("nav [data-v=saatler]"); await em.wait_for_timeout(300)
        ok("usta sees own hours page", "Randevu dilimi" in await em.inner_text("main"))
        # 5. owner: reject flow on a second customer, phone booking, block
        d2 = bk["date"]
        st, r2 = post(f"/api/public?shop={slug}&action=book", {"serviceId": "s1", "barberId": "any", "date": d2, "time": "15:00", "name": "Mehmet Kaya", "phone": "05441234567"})
        ok("second customer request", st == 200 and r2["booking"]["status"] == "talep", st)
        await ow.click("nav [data-v=ajanda]"); await ow.wait_for_timeout(500)
        await ow.click(".inbox [data-act=rejAsk]"); await ow.wait_for_timeout(200)
        await ow.fill(".inbox input", "O saat doluyum"); await ow.click("[data-act=rejYes]"); await ow.wait_for_timeout(600)
        rb = get(f"/api/public?shop={slug}&action=booking&id={r2['booking']['id']}&k={r2['key']}")["booking"]
        ok("rejected → customer sees red, slot freed", rb["status"] == "red")
        st, r3 = post(f"/api/public?shop={slug}&action=book", {"serviceId": "s1", "barberId": r2["booking"]["barberId"], "date": d2, "time": "15:00", "name": "Mehmet Kaya", "phone": "05441234567"})
        ok("same customer can book again after rejection", st == 200, st)
        await ow.click("[data-act=newBook]"); await ow.wait_for_timeout(300)
        await ow.fill("#bDate", d2); await ow.dispatch_event("#bDate", "change"); await ow.wait_for_timeout(200)
        await ow.fill("#bName", "Ali Veli")  # no phone: optional for staff
        await ow.click("#bf button[type=submit]"); await ow.wait_for_timeout(800)
        ok("staff booking without phone added (approved directly)", "Ali Veli" in await ow.inner_text("main"), (await ow.inner_text("#sheet"))[-160:] + " | " + await ow.inner_text("#toast"))
        await ow.screenshot(path=OUT + "06_owner_agenda.png", full_page=True)
        # 6. customer cancels own booking, then can book again
        await cu.goto(BASE + f"/{slug}?r={mine[0]['id']}&k={mine[0]['k']}"); await cu.wait_for_timeout(500)
        mt = await cu.inner_text("#app")
        ok("customer manage page shows approved + countdown", "Onaylandı" in mt and "sonra" in mt)
        await cu.screenshot(path=OUT + "07_manage.png", full_page=True)
        if "iptal et" in mt:
            await cu.click("[data-act=askCancel]"); await cu.click("[data-act=doCancel]"); await cu.wait_for_timeout(500)
            ok("customer cancel", "İptal edildi" in await cu.inner_text("#app"))
        # API-level guards
        ok("unknown shop 404", post("/api/public?shop=yok-boyle&action=book", {})[0] == 404)
        raw = urllib.request.urlopen(BASE + f"/api/public?shop={slug}&action=init").read().decode()
        ok("public data has no names/phones", "Ahmet" not in raw and "0532" not in raw)
        other = rows[1].split("\t")[1].strip()
        oi = get(f"/api/public?shop={other}&action=init")
        ok("new shop is bookable right away (owner chair)", oi["setup"] is False and [b["name"] for b in oi["cfg"]["barbers"]] == ["Usta"], oi["cfg"]["barbers"])
        # close that chair, then the admin's "Hemen aç" reopens the customer page
        import http.cookiejar
        cj = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        def opost(path, data):
            req = urllib.request.Request(BASE + path, data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
            try:
                with op.open(req) as r: return r.status
            except urllib.error.HTTPError as e: return e.code
        ocred = rows[1].split("\t")
        opost("/api/auth?action=login", {"shop": other, "username": ocred[2].strip(), "password": ocred[3].strip()})
        opost("/api/admin?action=ownerChair", {"on": False})
        ok("no usta → customer page closed", get(f"/api/public?shop={other}&action=init")["setup"] is True)
        await ad.reload(); await ad.wait_for_timeout(600)
        await ad.click(f"tr:has-text('/{other}') [data-act=manage]"); await ad.wait_for_timeout(600)
        ok("admin sees 'page closed' warning", "Müşteri sayfası kapalı" in await ad.inner_text(".det"))
        await ad.click("[data-act=openChair]"); await ad.wait_for_timeout(800)
        ok("admin 'Hemen aç' reopens customer page", get(f"/api/public?shop={other}&action=init")["setup"] is False and "Müşteri sayfası açık" in await ad.inner_text(".det"))
        await ad.click("[data-act=closeDetail]"); await ad.wait_for_timeout(200)
        ok("owner can't log into another shop", post("/api/auth?action=login", {"shop": other, "username": user0, "password": pass0})[0] == 401)
        # platform: reset owner password
        await ad.reload(); await ad.wait_for_timeout(600)
        btn = ad.locator(f"[data-act=reset][data-slug='{slug}']"); await btn.click(); await btn.click(); await ad.wait_for_timeout(500)
        rtxt = await ad.inner_text(".creds")
        newpw = rtxt.split("Şifre:")[1].split("\n")[0].strip()
        ok("owner password reset by admin", post("/api/auth?action=login", {"shop": slug, "username": user0, "password": newpw})[0] == 200 and post("/api/auth?action=login", {"shop": slug, "username": user0, "password": pass0})[0] == 401)
        # platform admin: full control over a shop
        await ad.click("[data-act=hideReset]"); await ad.wait_for_timeout(200)
        await ad.click(f"tr:has-text('/{slug}') [data-act=manage]"); await ad.wait_for_timeout(600)
        ok("admin shop detail opens", await ad.locator(".det .urow").count() >= 1)
        await ad.fill("#dName", "Yeni Ad Berber"); await ad.click("[data-act=saveName]"); await ad.wait_for_timeout(700)
        ok("admin renamed shop", get(f"/api/public?shop={slug}&action=init")["cfg"]["shopName"] == "Yeni Ad Berber")
        row = ad.locator(f".urow[data-u='{user0}']")
        await row.locator("[data-f=un]").fill("kemal"); await row.locator("[data-act=uSave]").click(); await ad.wait_for_timeout(700)
        ok("admin renamed owner username", post("/api/auth?action=login", {"shop": slug, "username": "kemal", "password": newpw})[0] == 200 and post("/api/auth?action=login", {"shop": slug, "username": user0, "password": newpw})[0] == 401)
        await ad.fill("#uaU", "ortak"); await ad.fill("#uaN", "Ortak"); await ad.click("#uaF button[type=submit]"); await ad.wait_for_timeout(700)
        ok("admin added a second owner login", await ad.locator(".urow[data-u='ortak']").count() == 1)
        await ad.fill("#uaU", "ahmetusta"); await ad.fill("#uaN", "Ahmet"); await ad.select_option("#uaR", "usta"); await ad.click("#uaF button[type=submit]"); await ad.wait_for_timeout(800)
        ok("admin-added usta gets a chair customers can pick", "Ahmet" in [b["name"] for b in get(f"/api/public?shop={slug}&action=init")["cfg"]["barbers"]])
        await ad.locator(".urow[data-u='ortak'] [data-act=uChair]").click(); await ad.wait_for_timeout(800)
        ok("Koltuk ver gives a chair to a login without one", "Ortak" in [b["name"] for b in get(f"/api/public?shop={slug}&action=init")["cfg"]["barbers"]])
        await ad.screenshot(path=OUT + "08_admin_detail.png", full_page=True)
        await ad.click("[data-act=enter]"); await ad.wait_for_timeout(900)
        pages = ac.pages; up = pages[-1]
        if up is ad: await ad.goto(BASE + "/usta"); up = ad
        await up.wait_for_timeout(900)
        utxt = await up.inner_text("#root")
        ok("admin entered shop panel as owner", "Yönetici modu" in utxt and "Ustalar" in utxt and "Ayarlar" in utxt)
        await up.screenshot(path=OUT + "09_admin_in_shop.png")
        # delete one shop from its row, then two with checkboxes
        await ad.goto(BASE + "/yonetim"); await ad.wait_for_timeout(700)
        n0 = len(get_shops := None or []) if False else None
        before = await ad.locator("tbody tr").count()
        s3 = rows[2].split("\t")[1].strip(); s4 = rows[3].split("\t")[1].strip(); s5 = rows[4].split("\t")[1].strip()
        await ad.click(f"tr:has-text('/{s3}') [data-act=rowDel]"); await ad.click(f"tr:has-text('/{s3}') [data-act=rowYes]"); await ad.wait_for_timeout(900)
        ok("row delete removes one shop", await ad.locator("tbody tr").count() == before - 1 and post(f"/api/public?shop={s3}&action=book", {})[0] == 404)
        await ad.check(f"tr:has-text('/{s4}') [data-pick]"); await ad.check(f"tr:has-text('/{s5}') [data-pick]"); await ad.wait_for_timeout(200)
        await ad.click("[data-act=bulkAsk]"); await ad.click("[data-act=bulkYes]"); await ad.wait_for_timeout(1200)
        ok("bulk delete removes selected shops", await ad.locator("tbody tr").count() == before - 3 and post(f"/api/public?shop={s4}&action=book", {})[0] == 404 and post(f"/api/public?shop={s5}&action=book", {})[0] == 404)
        await ad.screenshot(path=OUT + "10_list_delete.png", full_page=False)
        # wipe everything
        await ad.goto(BASE + "/yonetim"); await ad.wait_for_timeout(700)
        await ad.fill("#wipeC", "yanlış"); await ad.click("#wipeF button[type=submit]"); await ad.wait_for_timeout(400)
        ok("wipe refuses without exact confirmation", len(get("/api/platform?action=status") and []) == 0 and post("/api/public?shop=" + slug + "&action=book", {})[0] != 404)
        await ad.fill("#wipeC", "HEPSİNİ SİL"); await ad.click("#wipeF button[type=submit]"); await ad.wait_for_timeout(1500)
        ok("all shops deleted", "Henüz dükkân yok" in await ad.inner_text("#root") and post("/api/public?shop=" + slug + "&action=book", {})[0] == 404)
        keys = subprocess.run(["redis-cli", "-p", str(RPORT), "--scan"], capture_output=True, text=True).stdout.split()
        ok("no shop data left in the database", not [k for k in keys if k.startswith(("s:", "sl:", "act:"))], [k for k in keys if k.startswith(("s:", "sl:", "act:"))][:5])
        sw = await cu.evaluate("document.documentElement.scrollWidth"); ok("no horizontal scroll at 400px", sw <= 400, sw)
        bg = await cu.evaluate("getComputedStyle(document.body).backgroundColor"); ok("light paper theme on dark device", bg == "rgb(244, 240, 231)", bg)
        ok("no JS errors", not errs, errs[:5])
        await br.close()
try:
    asyncio.run(main())
finally:
    srv.terminate(); subprocess.run(["redis-cli", "-p", str(RPORT), "shutdown", "nosave"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("\n".join(log)); print(f"{sum(l.startswith('PASS') for l in log)}/{len(log)} passed")
