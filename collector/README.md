# Bi’ Plan veri toplama

Bu paket eski Scrapy/FalkorDB uygulamasından bağımsızdır. Node 22 üzerinde Crawlee'nin kuyruk, sınırlı tekrar deneme ve çalışma istatistiklerini; Cheerio'nun HTML ayrıştırıcısını kullanır. Üç kaynağın açık sayfaları ve kaydırınca yapılan veri istekleri 9 Eylül 2026'da HTTP ve gerçek tarayıcı davranışıyla doğrulandı. Tarayıcı, proxy, CAPTCHA çözümü ve AI anahtarı bu akış için gerekli değil.

## Çalıştırma

```sh
cd collector
npm ci
npm test
npm run collect -- --max-details 2000
# Sadece keşif: snapshot ve canlı veritabanı değişmez
npm run collect -- --discover-only --discovery-pages 20
```

Varsayılan çıktı `web/data/events.json`; ayrıntılı kayıt `collector/output/report.json`. `web/` içinden `npm run data:refresh` aynı toplayıcıyı çağırır; önce collector bağımlılıklarını kur. `--sources biletix` tek kaynağı günceller, diğer kaynakların hâlâ taze kayıtlarını korur. `--snapshot /tmp/events.json --output /tmp/collection` ayrı bir deneme üretir. `--url https://...` tek bir güvenilir etkinliği yeniden doğrular (birden çok kez verilebilir); diğer kayıtlar tazelik kuralıyla korunur. `--save-html` hata ayıklamak için HTML kanıtlarını yerel çıktı klasöründe saklar. Crawlee kuyruğu her çalışmada sıfırlanır; buna karşılık keşfedilen detay URL'lerinin kapsam durumu snapshot'ın yanındaki `coverage.json` dosyasına atomik yazılır ve yarım çalışma sonraki çalışmada kaldığı yerden devam eder.

## Kaynaklar ve veri sözleşmesi

| Kaynak     | Okunan veri                                  | Kaynağa özgü işlem                                                                           |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Biletinial | Sayfalanan liste JSON yanıtları ve etkinlik JSON-LD       | İstanbul konumu, açık saat dilimi, seans bazında fiyat/satış durumu                          |
| Bubilet    | Tam kategori yanıtı ve gömülü seans verisi       | Seans başına satış bayrakları/fiyat; JSON-LD ile tarih kapsamı karşılaştırması                      |
| Biletix    | Sayfalanan arama sonuçları ve `ng-state` JSON | Etkinlik kodu ile bağlı performanslar, kuruş → TL, aynı saatteki bilet türlerini birleştirme |

Etkinlik **keşfi** ve seans **doğrulaması** ayrı bütçelere sahip:

- Biletinial: kaynak menüsündeki kategoriler keşfedilir. Standart listeler `tr-tr/List/GetMoreItems` üzerinden `hasMore:false` gelene kadar okunur. Stand-up ve senfoni gruplarında `EventGroup/GetData` için kısa sayfa veya ilan edilen toplam yeterli değildir; boş son yanıt gerekir. Çocuk, spor ve futbol listelerinin kendi şablonları; sinemanın şehir/tarih/seans uçları ayrıca doğrulanır.
- Bubilet: şehir sayfasının sunduğu bütün etiketler `platform.api.bubilet.com.tr/v3/event/city/34/tag/<id>` üzerinden birleştirilir. Yalnızca varsayılan etiket ya da ilk HTML kartları katalog sayılmaz. Etiket bazında hata ve kalan işler raporlanır.
- Biletix: `solr/tr/select` araması `start`/`rows` ile ilerler. İstanbul ve etkinlik türü filtrelenir; müzik/sanat kategori kısıtı yoktur. Başlangıcı geçmiş ama bitişi gelecekte olan çok günlük prodüksiyonlar da keşfedilir; listede yazan tarih aralığından seans uydurulmaz.

`--discovery-pages` çalışma başına varsayılan 20, üst sınır 50. Bitmeyen sayfalamanın devam konumu `coverage.json` içinde tutulur; sonraki çalışma aynı ilk sayfalarda takılmaz. Başlangıç envanteri veya kaynak yapılandırması değişirse devam konumu sıfırlanır. Kaynağa uygun bitiş kanıtıyla `completion:exhausted` yazılır. Tekrarlanan sayfa, değişen toplam, hata, kısa yanıt ve bütçe sınırı ayrı nedenlerle eksik olarak raporlanır. Her yanıta URL, yöntem ve içerik özeti eklenir; kullanıcı oturumu/anahtarı kullanılmaz. API alt alanlarının robots kuralları ayrıca kontrol edilir.

Keşfedilen ve önceki snapshot'tan bilinen bütün detay URL'leri sabit bir örnekleme sınırı olmadan kalıcı kapsama kuyruğuna eklenir. Bir çalışma varsayılan olarak en fazla 2000 detay sayfası, 6000 HTTP isteği ve 50 dakika işler; `--max-details`, `--max-http` ve `--max-minutes` bu bütçeleri değiştirir. Eski `--limit` parametresi geriye uyumluluk için aynı çalışma-geneli detay bütçesi olarak kabul edilir. Önce bütün güncel liste keşifleri çalışır; sonra detay sırası kaynaklar arasında dönüşümlü olarak hiç ziyaret edilmemiş ve en eski denenen URL'leri seçer. Böylece küçük veya yeni bir kategori eski büyük kuyruğun arkasında kalmaz. Kalan URL'ler kaybolmaz. `report.summary.sourceCoverage` her kaynak için `discovered`, `attempted`, `verified`, `quarantined`, `unvisited`, `stale`, `unattemptedThisRun`, `failure`, `retired` ve `complete` sayılarını verir. Gelecek doğrulanmış seansı kalmayan bir detay açıkça `retired` olur; hata eski kaydı tazelemez. `complete` yalnızca bu çalışmadaki bütün liste keşifleri tükendiğinde ve bilinen/keşfedilen tüm etkin detaylar son 72 saat içinde başarıyla işlendiğinde doğrudur. `--discover-only` sadece `collector/output/discovery.json` üretir; snapshot'ı ve normal aktarım raporunu değiştirmez. Eksik keşif varsa komut başarısız çıkar.

Bubilet seanslarında `promoteOnly`, `isSelectable`, `isMarkedSoldOut` ve kombine/yenileme koşulları okunur. Her tarih ve mekân ayrı değerlendirilir. Mekân doğrudan seans verisinden alınır; JSON-LD'nin ilk mekânı bütün tarihlere kopyalaması kullanılmaz. `calendarBased:true` sayfaları için kaynak istemcisinde gözlenen şehir/seans API'siyle seans kimlikleri karşılaştırılır. Eksik veya çelişkili kapsam eski kaydı silmez. Üç sağlayıcının keşfedilen envanterini kapsamak, İstanbul'daki sağlayıcı dışı bütün etkinliklerin bulunduğu anlamına gelmez.

Sayfa başına kaynak, URL, kontrol zamanı, parser sürümü ve içerik SHA-256 özeti tutulur. Kesin tarih/saat dilimi, İstanbul konumu, kategori ve güvenilir kaynak URL'si olmadan kayıt kabul edilmez. Satış durumu açıkça doğrulanmıyorsa `unknown` olur ve önerilerden elenir. Fiyatı olmayan etkinlik ücretsiz sayılmaz. 50.000 TL üzerindeki fiyatlar inceleme gerektiren aykırı kayıt olarak karantinaya alınır; bunların kesinlikle hatalı olduğu iddia edilmez.

Biletix'te `52000` değerinin arayüzde `520,00₺` olarak gösterildiği doğrulandı. Kapalı bilet türleri, üyelik ve kombine koşulları normal satışla karıştırılmaz. Sağlayıcı teklifleri yalnızca desteklenen başlık kimliği, aynı mekân ve aynı seans anıyla birleşir. Açıkça farklı yaş grubu, format veya uyarlama kanıtı birleştirmeyi engeller. Her teklifin kaynak kimliği, bağlantısı, fiyatı ve satış durumu korunur; kart fiyatı satışta olduğu doğrulanan tekliften seçilir.

## Hata ve yayın davranışı

- İki eşzamanlı iş; HTML, robots ve sonraki liste sayfaları dahil tüm HTTP istekleri arasında en az bir saniye (toplam en fazla yaklaşık 60/dakika). Geçici HTTP 429/5xx hatalarında en fazla iki tekrar; robots.txt okunamazsa o kaynak atlanır. Yönlendirmeler takip edilmez, yanıtlar okuma sırasında 4 MB ile sınırlandırılır.
- Bozuk şema, boş/okunamayan sayfa veya ağ hatası, eski prodüksiyonu silmek için kanıt sayılmaz. Önceki kayıtlar kendi kontrol zamanıyla en fazla 72 saat korunur; başarısız deneme onları tazelemez. Başarılı sayfa, aynı URL'nin seanslarını yeniler.
- Tek bir geçersiz seans bile o sayfanın kısmi olarak yayımlanmasını önler. Kaynakla doğrulanan boş envanter ise `events:[]` ve `retiredAt` ile açıkça aktarılır. Hem GCP hem Cloudflare eski aktarımın kaldırılmış seansları yeniden oluşturmasını engelleyen zaman damgasını saklar. Yeniden başlatmada URL'nin eski seansları başarılı checkpoint ile tamamen değiştirilir.
- Farklı şehirler, geçmiş tarihler, belirsiz saat dilimleri ve aykırı fiyatlar ayrılır. Snapshot'ta kapalı/bilinmeyen durumlar saklanabilir; uygulama yalnızca `available` kayıtları önerir.
- Hiç doğrulanmış satıştaki etkinlik yoksa veya önceki taze katalogda en az 20 kayıt varken sayı %40'tan fazla düşerse snapshot değiştirilmez. Başarılı kısmi toplama diğer kaynakların güncellenmesini engellemez; hatalar raporda kalır.
- Snapshot geçici dosyadan atomik olarak değiştirilir. Ham sayfalar, kuyruk ve tam raporlar Git'e girmez; fixture'lar kişisel oturum veya takip verisi içermeyen küçük şema örnekleridir.

## Zamanlama ve canlı aktarım

`Collect event data` iş akışı her gün 03:17 ve 15:17 UTC'de (Türkiye 06:17/18:17) production ortamında çalışır; manuel çalıştırmada `staging` veya `production` seçilir. Yapılandırılmış çalışmada taramadan önce `GET /api/admin/collection` ile R2'deki son kalıcı snapshot okunur. Yalnızca 404, ilk kurulum olarak kabul edilip repodaki başlangıç snapshot'ını kullanır. Kimlik doğrulama, ağ ve 503 hataları eski repo verisine sessizce dönmez. Veri, rapor, kanonik readback ve çalışma kanıtı GitHub Actions artifact'ı olarak 14 gün saklanır. Normal PR CI'ı internete çıkmadan fixture testlerini çalıştırır; gerçek site erişimi sadece ayrı toplama iş akışındadır.

GitHub'da `staging` ve `production` environment'ları oluşturulur. Her birine o dağıtımın HTTPS kök adresi `BIPLAN_URL` variable'ı, uygulamayla aynı değer olan `SYNC_TOKEN` secret'ı olarak eklenir. Sahibe özel Sites yayını erişim doğrulaması gerektiriyorsa `SITES_ACCESS_TOKEN` da environment secret'ı olur. `BIPLAN_URL` ve `SYNC_TOKEN` birlikte yoksa toplama **yalnızca artifact üretir** ve bunu job summary'de açıkça bildirir; yalnızca birinin bulunması yapılandırma hatasıdır.

```sh
npm run publish
# Üretim akışı: tüm importlar sonrası kalıcı snapshot oluştur, tekrar oku ve yerel state'i kanonik veriyle değiştir
npm run publish -- --checkpoint --snapshot state/events.json
# Son kalıcı snapshot'ı tara öncesi geri yükle (yalnızca 404'te fallback)
npm run checkpoint:restore -- --output state/events.json --fallback ../web/data/events.json
```

`publish.mjs`, başarılı raporun doğrulanmış sayfalarını en fazla üç tam kaynak sayfası ve 3,5 MB içeren sınırlı partilerle `POST /api/admin/import` adresine yollar; kaynak sayfasındaki seansları farklı isteklere bölmez. Varsayılan komut R2'siz yerel geliştirme sunucularıyla çalışmaya devam eder. `--checkpoint` açıldığında bütün partiler başarıyla bittikten sonra rapor özeti `POST /api/admin/collection` ile kaydedilir; ardından `GET /api/admin/collection` readback'i doğrulanır ve yerel snapshot sunucunun kanonik veriyle atomik olarak değiştirilir. Bir import partisi başarısızsa checkpoint çağrısı yapılmaz. Endpoint kaynağı, alanları, tarihleri ve fiyatları tekrar doğrular; eski bir rapor yeni veriyi geri alamaz. Otomatik yeniden deneme yapılmaz.

Varsayılan dışındaki bir rapor `npm run publish -- --report /tam/yol/report.json` ile seçilir. Uzak hedeflerde HTTPS zorunludur. Yalnızca yerel geliştirmede `--allow-loopback-http` açıkça verilerek `localhost`, `127.0.0.1` veya `[::1]` HTTP hedefi kullanılabilir; bu seçenek uzak bir HTTP adresine izin vermez. Yerel token oluşturma, sağlık kontrolü ve kalıcı D1 aktarımı için depo kökündeki `README.md` içindeki `web` komutlarını kullan.

`Monitor catalog readiness` iş akışı saat başı staging ve production ortamlarında `/api/ready` adresini kontrol eder; manuel çalıştırmada tek ortam seçilebilir. Endpoint yalnızca katalog hazırsa, önerilebilir kayıt varsa ve kalıcı checkpoint 24 saatten gençse 200 döndürür. Hata ayrıntısı GitHub job summary'ye yazılır ve standart başarısız workflow bildirimi kullanılır; harici mesaj gönderilmez.

Başarılı her toplama `output/soak-evidence.json` üretir. Dosya gerçek başlangıç/bitiş zamanlarını, çalışma süresini, kanonik checkpoint kayıt sayısını ve kaynak dağılımını taşır. Tek bir run 48 saatlik soak sonucu sayılmaz; 48 saat boyunca üretilen artifact'lar ayrıca incelenmeden böyle bir iddia yapılmaz.

## Araç seçimi

[Crawlee](https://crawlee.dev/js/docs/introduction) kuyruk ve crawler yönetimini mevcut TypeScript/Node uygulamasıyla birleştiriyor. [Scrapling](https://github.com/D4Vinci/Scrapling) Python ve değişen HTML seçicileri için güçlü bir alternatif; burada doğrulanmış yapısal veri öncelikli. [Crawl4AI](https://github.com/unclecode/crawl4ai) hem CSS hem LLM tabanlı çıkarım sunuyor. [Firecrawl](https://docs.firecrawl.dev/introduction) yönetilen bir alternatif; bu ilk akışın dış servis hesabına ihtiyacı yok. JavaScript gerektiren bir kaynak eklenirse aynı adaptör sözleşmesinin önüne Playwright veya yönetilen fetch servisi eklenebilir; şu an tarayıcı adaptörü uygulanmadı.

Bağımlılık notu: sabitlenmiş Crawlee 3.18.1 ağacında `adm-zip` ve `stream-json` kaynaklı orta seviye transitif audit bildirimleri var; bu toplayıcı arşiv açma veya stream-json filtreleme yollarını kullanmıyor. Zorla uyumsuz sürüm yükseltmesi yapılmadı. Crawler bağımlılıkları web Worker paketine eklenmez.

## Son doğrulama

9 Eylül 2026 genişletilmiş taraması: 7 listenin sonuna ulaşıldı, 2.863 benzersiz kaynak etkinlik bağlantısı keşfedildi. Önceki kayıtlar ve liste başına 15 yeni prodüksiyon örneği üzerinden 272 detay sayfasından 743 seans doğrulandı; 722'si satışta, 21'i kapalı/belirsiz. Eski kayıttan taşınan seans yok. Doğrulanamayan 7 detay sayfası ayrıldı. Ayrıntılar `reports/2026-09-09-expanded.json` içinde. Bunlar **2.863 doğrulanmış seans** veya tüm şehir anlamına gelmez.

Büyüyen katalog için uygulamanın D1 yazımları da UTF-8 boyutu ve kayıt sayısı sınırlı JSON partilerine taşındı. İlk snapshot ve kaynak sayfası değişimi atomik kalır; her seans için ayrı SQL sorgusu oluşturulmaz. Entegrasyon kontrolü snapshot'ın tamamını geri okuyup karşılaştırır ve çok baytlı metin/fiyatı bilinmeyen kayıtlarla 101 seanslık aktarımı doğrular.
