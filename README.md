# Sırada — berberler için online randevu

Çok dükkânlı bir platform. Her berberin kendi bağlantısı, ustaları ve randevuları var.

| Adres | Kimin için | Ne yapar |
|---|---|---|
| `/` | Herkes | Ürün sayfası; berberin bağlantı adını yazıp gider |
| `/<dükkân>` (örn. `/berber-01`) | Müşteri | Ustayı ve saati seçer, talep gönderir, durumunu ve ne kadar kaldığını görür, iptal eder |
| `/usta` | Dükkân sahibi ve ustalar | Dükkân kodu + kullanıcı adı + şifre ile girer |
| `/yonetim` | Sen (Sırada'yı satan kişi) | Dükkân hesabı oluşturur, sahip şifresini yeniler, dükkânı açar/kapatır |

## Randevu akışı

1. Müşteri saati seçer → randevu **onay bekliyor** olarak düşer (saat tutulur).
2. Usta panelinde **Onayla** ya da **Reddet** (isteğe bağlı neden). Reddedilince saat açılır.
3. Aynı telefon numarasıyla aynı dükkânda **tek açık randevu** olur; yenisi için eskisi iptal edilmeli.
4. Telefonla alınan randevular usta panelinden eklenir ve doğrudan onaylıdır.

## Ustalar

- Her ustanın kendi **randevu dilimi** (10–60 dk), çalışma saatleri, öğle arası ve izinli günleri var.
- Usta girişi olan usta yalnızca kendi ajandasını, müşterilerini ve saatlerini görür.
- Sahip; ustaları ekler, düzenler, gizler, siler, giriş hesabı verir ve şifre yeniler.

## Kurulum (Vercel)

1. [vercel.com/new](https://vercel.com/new) → bu repoyu içe aktar → **Deploy**.
2. **Storage** → **Redis** ya da **Upstash for Redis** ekle, projeye bağla → **Redeploy**.
3. `/yonetim` adresini aç ve **yönetici hesabını kur** (ilk açan kurar — yayına alır almaz yap).
4. **Hesapları oluştur** ile dükkân hesaplarını üret; listeyi kopyala ya da CSV indir.
5. Sattığın berbere bağlantıyı, dükkân kodunu, kullanıcı adını ve şifreyi ilet.

Eski tek dükkânlı sürümün verileri, yönetici hesabı kurulurken kendiliğinden yeni yapıya taşınır.

## Güvenlik

- Şifreler `scrypt` ile saklanır; oturumlar `HttpOnly` imzalı çerezlerle tutulur; giriş denemeleri sınırlıdır.
- Aynı saate iki randevu, ustanın gününü 5 dakikalık birimlere bölen atomik kilitlerle engellenir (Redis `SET NX`).
- Müşteri sayfası diğer müşterilerin adını ya da telefonunu almaz; sadece dolu aralıkları görür.
- Dükkânların verileri birbirinden ayrıdır; bir dükkânın hesabı başka dükkâna giremez.

## Yerelde çalıştırma

```bash
npm install
node dev.mjs        # http://localhost:3000 — REDIS_URL yoksa bellek içi çalışır
python3 test/e2e.py # uçtan uca test (redis-server ve Playwright gerekli)
```
