# Bi’ Plan veri toplama

Bu paket eski Scrapy/FalkorDB uygulamasından bağımsızdır. Node 22 üzerinde Crawlee'nin kuyruk, sınırlı tekrar deneme ve çalışma istatistiklerini; Cheerio'nun HTML ayrıştırıcısını kullanır. Üç kaynağın açık sayfaları 9 Eylül 2026'da HTTP ile doğrulandı. Tarayıcı, proxy, CAPTCHA çözümü ve AI anahtarı bu akış için gerekli değil.

## Çalıştırma

```sh
cd collector
npm ci
npm test
npm run collect -- --limit 20
```

Varsayılan çıktı `web/data/events.json`; ayrıntılı kayıt `collector/output/report.json`. `web/` içinden `npm run data:refresh` aynı toplayıcıyı çağırır; önce collector bağımlılıklarını kur. `--sources biletix` tek kaynağı günceller, diğer kaynakların hâlâ taze kayıtlarını korur. `--snapshot /tmp/events.json --output /tmp/collection` ayrı bir deneme üretir. `--save-html` hata ayıklamak için HTML kanıtlarını yerel çıktı klasöründe saklar. Her çalışma kuyruğu sıfırlayıp yeniden kontrol eder; önceki yarım çalışmanın işlenmiş URL'lerini yanlışlıkla güncel saymaz.

## Kaynaklar ve veri sözleşmesi

| Kaynak     | Okunan veri                                  | Kaynağa özgü işlem                                                                           |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Biletinial | Kategori listeleri ve etkinlik JSON-LD       | İstanbul konumu, açık saat dilimi, seans bazında fiyat/satış durumu                          |
| Bubilet    | İstanbul kategori listeleri ve JSON-LD       | AggregateOffer üst kaydı yerine her `subEvent`; kategori breadcrumb'tan                      |
| Biletix    | Müzik/ana sayfa ve sayfadaki `ng-state` JSON | Etkinlik kodu ile bağlı performanslar, kuruş → TL, aynı saatteki bilet türlerini birleştirme |

Liste başına `--limit` yeni prodüksiyon alınır (1–100); daha önce bulunan prodüksiyonlar ayrıca yeniden ziyaret edilir. Rapor, bulunan ve seçilen URL sayılarını ve kapsamın kesildiğini açıkça belirtir. Bu, İstanbul'daki tüm etkinliklerin eksiksiz indeksi değildir. Sitemap/pagination ve yeni kaynaklar eklenmeden tüm şehir kapsanmış sayılmaz.

Sayfa başına kaynak, URL, kontrol zamanı, parser sürümü ve içerik SHA-256 özeti tutulur. Kesin tarih/saat dilimi, İstanbul konumu, kategori ve güvenilir kaynak URL'si olmadan kayıt kabul edilmez. Satış durumu açıkça doğrulanmıyorsa `unknown` olur ve önerilerden elenir. Fiyatı olmayan etkinlik ücretsiz sayılmaz. 50.000 TL üzerindeki fiyatlar inceleme gerektiren aykırı kayıt olarak karantinaya alınır; bunların kesinlikle hatalı olduğu iddia edilmez.

Biletix'te `52000` değerinin arayüzde `520,00₺` olarak gösterildiği doğrulandı. Aynı etkinliğin kapalı bilet türleriyle satıştaki türü karıştırılmaz. Bubilet'te tek sayfadaki farklı tarihler ayrı kayıtlar olarak tutulur. Aynı normalize başlık + mekân + kategori farklı kaynaklarda çıkarsa öneride tek prodüksiyon olarak gösterilir; benzer isimlere bulanık eşleştirme uygulanmaz. Kaynak kayıtları ve bağlantıları ayrı korunur.

## Hata ve yayın davranışı

- İki eşzamanlı iş, kaynak başına en az bir saniyelik aralık ve dakikada en fazla 60 görev. Geçici HTTP 429/5xx hatalarında en fazla iki tekrar; robots.txt okunamazsa o kaynak atlanır. Yönlendirmeler takip edilmez, yanıtlar okuma sırasında 4 MB ile sınırlandırılır.
- Bozuk şema, boş/okunamayan sayfa veya ağ hatası, eski prodüksiyonu silmek için kanıt sayılmaz. Önceki kayıtlar kendi kontrol zamanıyla en fazla 72 saat korunur; başarısız deneme onları tazelemez. Başarılı sayfa, aynı URL'nin seanslarını yeniler.
- Farklı şehirler, geçmiş tarihler, belirsiz saat dilimleri ve aykırı fiyatlar ayrılır. Snapshot'ta kapalı/bilinmeyen durumlar saklanabilir; uygulama yalnızca `available` kayıtları önerir.
- Hiç doğrulanmış satıştaki etkinlik yoksa veya önceki taze katalogda en az 20 kayıt varken sayı %40'tan fazla düşerse snapshot değiştirilmez. Başarılı kısmi toplama diğer kaynakların güncellenmesini engellemez; hatalar raporda kalır.
- Snapshot geçici dosyadan atomik olarak değiştirilir. Ham sayfalar, kuyruk ve tam raporlar Git'e girmez; fixture'lar kişisel oturum veya takip verisi içermeyen küçük şema örnekleridir.

## Zamanlama ve canlı aktarım

`Collect event data` iş akışı, bu değişiklik master'a alındığında her gün 03:17 ve 15:17 UTC'de (Türkiye 06:17/18:17) çalışır; manuel de başlatılabilir. Veri ve raporlar GitHub Actions artifact'ı olarak 14 gün saklanır. Normal PR CI'ı internete çıkmadan fixture testlerini çalıştırır; gerçek site erişimi sadece ayrı toplama iş akışındadır.

Canlı aktarım için GitHub repository variable `BIPLAN_URL` ve secret `SYNC_TOKEN` tanımlanır; aynı `SYNC_TOKEN` uygulamanın sunucu sırrı olmalıdır. Sahibe özel Sites yayını ayrıca erişim doğrulaması gerektirir; kullanıcı tarafından sağlanmış Sites erişim tokenı varsa `SITES_ACCESS_TOKEN` olarak tutulur. Bu ayarlar yoksa iş akışı **yalnızca artifact üretir**, canlı veritabanını değiştirmez. Sırlar bu çalışmada oluşturulmadı veya paylaşılmadı.

```sh
npm run publish
```

`publish.mjs`, başarılı raporun doğrulanmış sayfalarını sınırlı partilerle `POST /api/admin/import` adresine yollar. Endpoint kaynağı, alanları, tarihleri ve fiyatları tekrar doğrular; her kaynak sayfasını atomik yazar. Eski bir rapor yeni veriyi geri alamaz; tekrar gönderim güvenlidir. Import embedding çağrısı yapmaz. Eski `/api/admin/sync` Biletinial'a özel uyumluluk yoludur; yeni üç kaynaklı akış için `collect` + `publish` kullanılır.

## Araç seçimi

[Crawlee](https://crawlee.dev/js/docs/introduction) kuyruk ve crawler yönetimini mevcut TypeScript/Node uygulamasıyla birleştiriyor. [Scrapling](https://github.com/D4Vinci/Scrapling) Python ve değişen HTML seçicileri için güçlü bir alternatif; burada doğrulanmış yapısal veri öncelikli. [Crawl4AI](https://github.com/unclecode/crawl4ai) hem CSS hem LLM tabanlı çıkarım sunuyor. [Firecrawl](https://docs.firecrawl.dev/introduction) yönetilen bir alternatif; bu ilk akışın dış servis hesabına ihtiyacı yok. JavaScript gerektiren bir kaynak eklenirse aynı adaptör sözleşmesinin önüne Playwright veya yönetilen fetch servisi eklenebilir; şu an tarayıcı adaptörü uygulanmadı.

Bağımlılık notu: sabitlenmiş Crawlee 3.18.1 ağacında `adm-zip` ve `stream-json` kaynaklı orta seviye transitif audit bildirimleri var; bu toplayıcı arşiv açma veya stream-json filtreleme yollarını kullanmıyor. Zorla uyumsuz sürüm yükseltmesi yapılmadı. Crawler bağımlılıkları web Worker paketine eklenmez.
