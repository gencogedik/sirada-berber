# Sırada — berber online randevu

İki ayrı uygulama, tek site:

| Adres | Kimin için | Ne yapar |
|---|---|---|
| `/` | Müşteri | Hesapsız randevu alır, takvime ekler, bağlantısından görür ve iptal eder |
| `/usta` | Ustalar | Kullanıcı adı ve şifreyle girer; ajanda, müşteriler (sahip için ayrıca ekip ve ayarlar) |

## Vercel'e kurulum (5 dakika)

1. [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → bu repoyu seç → **Deploy**.
2. Proje sayfasında **Storage** → **Create Database** → **Upstash for Redis** (ücretsiz plan) → projeye bağla.
   Bu adım `KV_REST_API_URL` ve `KV_REST_API_TOKEN` değişkenlerini kendiliğinden ekler.
3. **Deployments** → son dağıtımda **⋯ → Redeploy** (değişkenlerin devreye girmesi için).
4. `https://<proje>.vercel.app/usta` adresini aç ve **Dükkânını kur** formunu doldur. İlk hesap sahip hesabıdır.
5. **Ekip** bölümünden ustaları ekle, kullanıcı adı ve şifrelerini onlara ilet.

İsteğe bağlı ortam değişkenleri:

- `SETUP_CODE` — verilirse ilk kurulumda bu kod istenir (kurulumu birinin senden önce yapmasını engeller).
- `SESSION_SECRET` — oturum imzası için gizli anahtar. Verilmezse veritabanı anahtarından türetilir.

## Roller

- **Sahip**: tüm ustaların ajandası, müşteri defteri, ekip (usta ekle, şifre sıfırla, hesabı kapat/sil), dükkân ayarları.
- **Usta**: yalnızca kendi koltuğunun ajandası ve müşterileri, şifre değiştirme.

## Güvenlik

- Şifreler `scrypt` ile saklanır; oturum `HttpOnly` imzalı çerezle tutulur; giriş denemeleri sınırlıdır.
- Aynı saate iki randevu atomik kilitle engellenir (her 30 dakikalık blok için Redis `SET NX`).
- Müşteri sayfası diğer müşterilerin adını ya da telefonunu hiç almaz; sadece dolu saatleri görür.
- Müşteri kendi randevusunu yalnızca kendisine verilen gizli bağlantıyla görür ve iptal eder.

## Yerelde çalıştırma

```bash
node dev.mjs        # http://localhost:3000 — veritabanı yoksa bellek içi çalışır
python3 test/e2e.py # uçtan uca test (Playwright gerekli)
```
