import asyncio, json, os, subprocess, time, urllib.request
from playwright.async_api import async_playwright

ROOT = "/home/claude/sirada-berber"; OUT = ROOT + "/test/shots/"; os.makedirs(OUT, exist_ok=True)
BASE = "http://localhost:3123"
srv = subprocess.Popen(["node", "dev.mjs"], cwd=ROOT, env={**os.environ, "PORT": "3123"}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.2)
log = []
def ok(name, cond, extra=""): log.append(("PASS" if cond else "FAIL") + "  " + name + ("  " + str(extra) if extra else ""))

def post(path, data, cookie=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(data).encode(), headers={"Content-Type": "application/json", **({"Cookie": cookie} if cookie else {})})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args=["--no-sandbox"])
        errs = []
        async def ctx(w=400, h=860, scheme="light"):
            c = await br.new_context(viewport={"width": w, "height": h}, color_scheme=scheme, timezone_id="Europe/Istanbul", locale="tr-TR")
            pg = await c.new_page()
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "ERR_TUNNEL" not in m.text and "fonts" not in m.text else None)
            return c, pg
        # 1. customer before setup
        cc, cu = await ctx()
        await cu.goto(BASE + "/"); await cu.wait_for_timeout(400)
        ok("customer sees 'not set up yet'", "Yakında" in await cu.inner_text("#app"))
        # 2. owner setup
        oc, ow = await ctx()
        await ow.goto(BASE + "/usta"); await ow.wait_for_timeout(400)
        await ow.screenshot(path=OUT + "01_setup.png")
        await ow.fill("#sShop", "Kemal'in Yeri"); await ow.fill("#sName", "Kemal Usta"); await ow.fill("#sUser", "kemal"); await ow.fill("#sPass", "kisa")
        await ow.click("button[type=submit]"); await ow.wait_for_timeout(300)
        ok("short password rejected", "8 karakter" in await ow.inner_text("#root"))
        await ow.fill("#sShop", "Kemal'in Yeri"); await ow.fill("#sName", "Kemal Usta"); await ow.fill("#sUser", "kemal"); await ow.fill("#sPass", "berber2026!")
        await ow.click("button[type=submit]"); await ow.wait_for_timeout(700)
        navtxt = await ow.inner_text("nav.tabs")
        ok("owner menus: Ajanda/Müşteriler/Ekip/Ayarlar", all(x in navtxt for x in ["Ajanda", "Müşteriler", "Ekip", "Ayarlar"]), navtxt.replace("\n", " "))
        # 3. add usta
        await ow.click("nav [data-v=ekip]"); await ow.wait_for_timeout(400)
        await ow.fill("#aName", "Emre"); await ow.fill("#aUser", "emre"); await ow.fill("#aPass", "emre12345")
        await ow.click("#addF button[type=submit]"); await ow.wait_for_timeout(500)
        ok("usta added", "emre" in await ow.inner_text("main"))
        await ow.screenshot(path=OUT + "02_team.png", full_page=True)
        # settings
        await ow.click("nav [data-v=ayar]"); await ow.wait_for_timeout(300)
        await ow.fill("#cAddr", "Ümraniye, İstanbul"); await ow.fill("#cPhone", "0216 555 44 33"); await ow.click("h1")
        await ow.select_option("#cBs", "13:00"); await ow.select_option("#cBe", "14:00")
        await ow.click("[data-act=saveCfg]"); await ow.wait_for_timeout(400)
        ok("settings saved", "Ayarlar güncel" in await ow.inner_text("main"))
        ok("phone typed after address kept", "555 44 33" in json.dumps(json.loads(urllib.request.urlopen(BASE + "/api/public?action=init").read())["cfg"]))
        await ow.screenshot(path=OUT + "03_settings.png", full_page=True)
        # 4. customer books (one tap + confirm)
        await cu.goto(BASE + "/"); await cu.wait_for_timeout(500)
        await cu.screenshot(path=OUT + "04_customer.png", full_page=True)
        ctext = await cu.inner_text("#app")
        ok("customer page shows address & both barbers", "Ümraniye" in ctext and "Emre" in ctext)
        await cu.click("[data-act=fast]"); await cu.wait_for_timeout(250)
        await cu.screenshot(path=OUT + "05_sheet.png")
        await cu.fill("#fn", "Ahmet Yılmaz"); await cu.fill("#fp", "0532 111 22 33"); await cu.fill("#fo", "Yanlar 2 numara")
        await cu.click("[data-act=confirm]"); await cu.wait_for_timeout(500)
        dtxt = await cu.inner_text("#app")
        ok("booking confirmed", "hazır" in dtxt, dtxt.split("\n")[2:4])
        await cu.screenshot(path=OUT + "06_done.png", full_page=True)
        mine = await cu.evaluate("JSON.parse(localStorage.getItem('sirada_mine'))")
        bid, bkey = mine[0]["id"], mine[0]["k"]
        # second booking: name remembered → two taps
        await cu.click("[data-act=again]"); await cu.wait_for_timeout(300)
        await cu.click(".day:not([disabled]) >> nth=2"); await cu.wait_for_timeout(200)
        await cu.click(".time:not([disabled]) >> nth=3"); await cu.wait_for_timeout(200)
        ok("name remembered", (await cu.input_value("#fn")) == "Ahmet Yılmaz")
        await cu.click("[data-act=confirm]"); await cu.wait_for_timeout(500)
        # 5. race: two parallel requests for the same chair+slot
        init = json.loads(urllib.request.urlopen(BASE + "/api/public?action=init").read())
        emre = [b for b in init["cfg"]["barbers"] if b["name"] == "Emre"][0]["id"]
        d = init["now"]["date"]; import datetime
        d2 = (datetime.date.fromisoformat(d) + datetime.timedelta(days=2))
        while d2.weekday() == 0: d2 += datetime.timedelta(days=1)  # Monday closed
        payload = {"serviceId": "s1", "barberId": emre, "date": d2.isoformat(), "time": "10:00", "name": "Yarış Bir", "phone": "05330000001"}
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(4) as ex: res = list(ex.map(lambda i: post("/api/public?action=book", {**payload, "name": f"Yarış {i}"})[0], range(4)))
        ok("double-booking blocked (1 wins, others 409)", sorted(res) == [200, 409, 409, 409], res)
        # outside hours / break / closed
        ok("break time refused", post("/api/public?action=book", {**payload, "time": "13:00"})[0] == 400)
        ok("bad phone refused", post("/api/public?action=book", {**payload, "time": "15:00", "phone": "123"})[0] == 400)
        # privacy: public init has no names/phones
        raw = urllib.request.urlopen(BASE + "/api/public?action=init").read().decode()
        ok("public data has no customer names/phones", "Ahmet" not in raw and "0532" not in raw)
        ok("staff API refuses without login", post("/api/staff?action=status", {"id": bid, "status": "geldi"})[0] == 401)
        # 6. owner agenda
        await ow.click("nav [data-v=ajanda]"); await ow.wait_for_timeout(300)
        await ow.click(f".day[data-v='{mine[0]['date']}']"); await ow.wait_for_timeout(400)
        atext = await ow.inner_text("main")
        ok("owner sees booking with note", "Ahmet Yılmaz" in atext and "Yanlar 2 numara" in atext)
        await ow.screenshot(path=OUT + "07a_agenda.png", full_page=True)
        await ow.click(".row .x >> nth=0"); await ow.wait_for_timeout(250)
        await ow.fill("textarea[id^=sn-]", "Kare sakal, 3 numara"); await ow.click("[data-act=note]"); await ow.wait_for_timeout(400)
        await ow.screenshot(path=OUT + "07_agenda_detail.png", full_page=True)
        opts = await ow.locator("select[id^=mvT-] option").all_inner_texts()
        print("MOVE OPTS", opts)
        tgt = [o for o in opts if o != mine[0]["time"]][-1]
        await ow.select_option("select[id^=mvT-]", tgt); await ow.click("[data-act=move]"); await ow.wait_for_timeout(500)
        print("TOAST", await ow.inner_text("#toast"))
        st, mb = 0, json.loads(urllib.request.urlopen(BASE + f"/api/public?action=booking&id={bid}&k={bkey}").read())["booking"]
        ok("move reflected for customer", mb["time"] != mine[0]["time"], (mine[0]["time"], "→", mb["time"]))
        await ow.click("[data-act=st][data-v=geldi] >> nth=0"); await ow.wait_for_timeout(400)
        await ow.click("[data-act=newBlock]"); await ow.wait_for_timeout(200)
        await ow.select_option("#kFrom", "16:00"); await ow.select_option("#kTo", "17:00"); await ow.click("#kf button[type=submit]"); await ow.wait_for_timeout(500)
        await ow.click("[data-act=newBook]"); await ow.wait_for_timeout(200)
        await ow.fill("#bName", "Mehmet Kaya"); await ow.fill("#bPhone", "5441234567"); await ow.click("#bf button[type=submit]"); await ow.wait_for_timeout(500)
        await ow.click("[data-act=filter] >> nth=1"); await ow.wait_for_timeout(300)
        await ow.screenshot(path=OUT + "08_agenda.png", full_page=True)
        atext = await ow.inner_text("main")
        ok("phone booking + block + gaps visible", "Mehmet Kaya" in atext and "Mola" in atext and "Boş" in atext)
        await ow.click("nav [data-v=musteri]"); await ow.wait_for_timeout(500)
        await ow.screenshot(path=OUT + "09_customers.png", full_page=True)
        ok("customer book lists visits", "Ahmet Yılmaz" in await ow.inner_text("main"))
        # 7. usta login → only own menus/bookings
        ec, em = await ctx()
        await em.goto(BASE + "/usta"); await em.wait_for_timeout(400)
        await em.fill("#lUser", "emre"); await em.fill("#lPass", "yanlis-sifre"); await em.click("button[type=submit]"); await em.wait_for_timeout(300)
        ok("wrong password refused", "hatalı" in await em.inner_text("#root"))
        await em.fill("#lUser", "Emre"); await em.fill("#lPass", "emre12345"); await em.click("button[type=submit]"); await em.wait_for_timeout(700)
        nav = await em.inner_text("nav.tabs")
        ok("usta menus only Ajanda/Müşteriler/Hesabım", "Ekip" not in nav and "Ayarlar" not in nav and "Hesabım" in nav, nav.replace("\n", " "))
        await em.click(f".day[data-v='{d2.isoformat()}']"); await em.wait_for_timeout(400)
        etext = await em.inner_text("main")
        ok("usta sees own race booking", "Yarış" in etext)
        await em.screenshot(path=OUT + "10_usta.png", full_page=True)
        ecookie = "; ".join(f"{c['name']}={c['value']}" for c in await ec.cookies())
        ok("usta can't open admin API", post("/api/admin?action=config", {"cfg": {}}, ecookie)[0] == 403)
        ok("usta can't touch another chair", post("/api/staff?action=status", {"id": bid, "status": "gelmedi"}, ecookie)[0] in (403, 404))
        # 8. customer cancels via link (the second booking, still pending)
        await cu.goto(BASE + f"/?r={mine[0]['id']}&k={mine[0]['k']}"); await cu.wait_for_timeout(500)
        mine2 = await cu.evaluate("JSON.parse(localStorage.getItem('sirada_mine'))")
        await cu.goto(BASE + f"/?r={mine2[0]['id']}&k={mine2[0]['k']}"); await cu.wait_for_timeout(500)
        await cu.screenshot(path=OUT + "11_manage.png", full_page=True)
        mt = await cu.inner_text("#app")
        if "iptal et" in mt:
            await cu.click("[data-act=askCancel]"); await cu.click("[data-act=doCancel]"); await cu.wait_for_timeout(500)
            ok("customer cancel works", "PTAL" in (await cu.inner_text("#app")).upper(), (await cu.inner_text("#app"))[:120])
        else: ok("customer cancel rule (too close) shown", "İptal süresi geçti" in mt)
        ok("wrong key can't view booking", post("/api/public?action=cancel", {"id": bid, "k": "x"})[0] == 404)
        # desktop dark
        dc, dk = await ctx(1280, 860, "dark")
        await dk.goto(BASE + "/"); await dk.wait_for_timeout(500); await dk.screenshot(path=OUT + "12_desktop_dark.png")
        await dk.goto(BASE + "/usta"); await dk.wait_for_timeout(400); await dk.screenshot(path=OUT + "13_login_dark.png")
        sw = await cu.evaluate("document.documentElement.scrollWidth")
        ok("no horizontal scroll at 400px", sw <= 400, sw)
        ok("no JS errors (expected 400/401 from wrong-password tests ignored)", not [e for e in errs if "status of 40" not in e], errs[:5])
        await br.close()
try:
    asyncio.run(main())
finally:
    srv.terminate()
    print("\n".join(log))
