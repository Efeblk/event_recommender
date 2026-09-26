# Bi’ Plan veri toplama

Bu paket eski Scrapy/FalkorDB uygulamasından bağımsızdır. Node 22 üzerinde Crawlee'nin kuyruk, sınırlı tekrar deneme ve çalışma istatistiklerini; Cheerio'nun HTML ayrıştırıcısını kullanır. Üç kaynağın açık sayfaları ve kaydırınca yapılan veri istekleri 9 Eylül 2026'da HTTP ve gerçek tarayıcı davranışıyla doğrulandı. Tarayıcı, proxy, CAPTCHA çözümü ve AI anahtarı bu akış için gerekli değil.

## Çalıştırma

```sh
cd collector
npm ci
npm test
npm run collect -- --limit 100
# Sadece keşif: snapshot ve canlı veritabanı değişmez
npm run collect -- --discover-only --discovery-pages 20
```

Varsayılan çıktı `web/data/events.json`; ayrıntılı kayıt `collector/output/report.json`. `web/` içinden `npm run data:refresh` aynı toplayıcıyı çağırır; önce collector bağımlılıklarını kur. `--sources biletix` tek kaynağı günceller, diğer kaynakların hâlâ taze kayıtlarını korur. `--snapshot /tmp/events.json --output /tmp/collection` ayrı bir deneme üretir. `--url https://...` tek bir güvenilir etkinliği yeniden doğrular (birden çok kez verilebilir); diğer kayıtlar tazelik kuralıyla korunur. `--save-html` hata ayıklamak için HTML kanıtlarını yerel çıktı klasöründe saklar. Her çalışma kuyruğu sıfırlayıp yeniden kontrol eder; önceki yarım çalışmanın işlenmiş URL'lerini yanlışlıkla güncel saymaz.

## Kaynaklar ve veri sözleşmesi

| Kaynak     | Okunan veri                                  | Kaynağa özgü işlem                                                                           |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Biletinial | Sayfalanan liste JSON yanıtları ve etkinlik JSON-LD       | İstanbul konumu, açık saat dilimi, seans bazında fiyat/satış durumu                          |
| Bubilet    | Tam kategori yanıtı ve gömülü seans verisi       | Seans başına satış bayrakları/fiyat; JSON-LD ile tarih kapsamı karşılaştırması                      |
| Biletix    | Sayfalanan arama sonuçları ve `ng-state` JSON | Etkinlik kodu ile bağlı performanslar, kuruş → TL, aynı saatteki bilet türlerini birleştirme |

Etkinlik **keşfi** ve seans **doğrulaması** ayrı bütçelere sahip:

- Biletinial konser/tiyatro: kaydırmanın çağırdığı `tr-tr/List/GetMoreItems`, `hasMore:false` gelene kadar. Stand-up grupları farklı bir `EventGroup/GetData` sayfalaması kullanıyor; İstanbul filtresi ve kaynak sayfadaki grup ID'siyle okunur.
- Bubilet: ilk HTML'de 24 etkinlik var. Liste altına yaklaşınca istemci `platform.api.bubilet.com.tr/v3/event/city/34/tag/<id>` üzerinden tam listeyi getiriyor, sonra kartları sanallaştırıyor. DOM'daki kart sayısı toplam etkinlik sayısı değildir. Grup ID'si sayfanın gömülü JSON verisinden alınır; ilk grubun tam yanıtta bulunması doğrulanır.
- Biletix: `solr/tr/select` araması `start`/`rows` ile ilerler. İstanbul ve desteklenen ana kategoriler filtrelenir. Başlangıcı geçmiş ama bitişi gelecekte olan çok günlük prodüksiyonlar da keşfedilir; listede yazan tarih aralığından seans uydurulmaz.

`--discovery-pages` varsayılan 20, üst sınır 50. Açık `hasMore`/toplam sayıya ulaşıldığında `completion:exhausted` yazılır. Tekrarlanan sayfa, değişen toplam, hata, kısa yanıt ve bütçe sınırı ayrı nedenlerle eksik olarak raporlanır. Önceden görülen bir prodüksiyon tekrar çıktı diye sayfalama durmaz. Her yanıta URL, yöntem ve içerik özeti eklenir; kullanıcı oturumu/anahtarı kullanılmaz. API alt alanlarının robots kuralları ayrıca kontrol edilir.

Keşif bitince liste başına `--limit` kadar **yeni prodüksiyon** seçilir (varsayılan 100, 1–100); önceki snapshot'tan bilinen en fazla 1000 prodüksiyon ayrıca yeniden ziyaret edilir. Dolayısıyla tüm liste bağlantılarını bulmak, tüm seansların doğrulandığı anlamına gelmez. `truncated` alanı detay bütçesini de gösterir. `--discover-only` sadece `collector/output/discovery.json` üretir; snapshot'ı ve normal aktarım raporunu değiştirmez. Eksik keşif varsa komut başarısız çıkar.

Bubilet seanslarında `promoteOnly`, `isSelectable`, `isMarkedSoldOut` ve kombine/yenileme koşulları okunur. Örneğin Şebnem Ferah'ın iki gelecekte satışa açılacak tarihi JSON-LD'de 99.999 TL görünüyordu; artık normal bilet olarak önerilmez, fiyatı bilinmeyen/bekleyen kayıt olur. Her tarih ve mekân ayrı değerlendirilir. JSON-LD bazı sayfalarda ilk mekânı bütün tarihlere kopyalıyor (Usta Komedyen'de doğrulandı); mekân doğrudan seans verisinden alınır. Gömülü seans listesi JSON-LD'de açıkça duyurulan gelecekteki bir tarihi kaybederse `session_coverage_mismatch` ile sayfa korunur. Takvimden ayrıca yüklenmesi gereken `calendarBased:true` sayfaları henüz desteklenmiyor; `calendar_requires_expansion` ile ayrılır ve mevcut kayıtları silmez. Bu kapsamda İstanbul'un eksiksiz indeksi veya her tür etkinlik desteği iddia edilmez.

Sayfa başına kaynak, URL, kontrol zamanı, parser sürümü ve içerik SHA-256 özeti tutulur. Kesin tarih/saat dilimi, İstanbul konumu, kategori ve güvenilir kaynak URL'si olmadan kayıt kabul edilmez. Satış durumu açıkça doğrulanmıyorsa `unknown` olur ve önerilerden elenir. Fiyatı olmayan etkinlik ücretsiz sayılmaz. 50.000 TL üzerindeki fiyatlar inceleme gerektiren aykırı kayıt olarak karantinaya alınır; bunların kesinlikle hatalı olduğu iddia edilmez.

Biletix'te `52000` değerinin arayüzde `520,00₺` olarak gösterildiği doğrulandı. Aynı etkinliğin kapalı bilet türleriyle satıştaki türü karıştırılmaz. Bubilet'te bilet tipi veya üyelik/kombine koşulu normal seansla karıştırılmaz. Aynı normalize başlık + mekân + kategori farklı kaynaklarda çıkarsa öneride tek prodüksiyon olarak gösterilir; benzer isimlere bulanık eşleştirme uygulanmaz. Kaynak kayıtları ve bağlantıları ayrı korunur.

## Hata ve yayın davranışı

- İki eşzamanlı iş; HTML, robots ve sonraki liste sayfaları dahil tüm HTTP istekleri arasında en az bir saniye (toplam en fazla yaklaşık 60/dakika). Geçici HTTP 429/5xx hatalarında en fazla iki tekrar; robots.txt okunamazsa o kaynak atlanır. Yönlendirmeler takip edilmez, yanıtlar okuma sırasında 4 MB ile sınırlandırılır.
- Bozuk şema, boş/okunamayan sayfa veya ağ hatası, eski prodüksiyonu silmek için kanıt sayılmaz. Önceki kayıtlar kendi kontrol zamanıyla en fazla 72 saat korunur; başarısız deneme onları tazelemez. Başarılı sayfa, aynı URL'nin seanslarını yeniler.
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

`publish.mjs`, başarılı raporun doğrulanmış sayfalarını sınırlı partilerle `POST /api/admin/import` adresine yollar. Varsayılan komut R2'siz yerel geliştirme sunucularıyla çalışmaya devam eder. `--checkpoint` açıldığında bütün partiler başarıyla bittikten sonra rapor özeti `POST /api/admin/collection` ile kaydedilir; ardından `GET /api/admin/collection` readback'i doğrulanır ve yerel snapshot sunucunun kanonik kayıtlarıyla atomik olarak değiştirilir. Bir import partisi başarısızsa checkpoint çağrısı yapılmaz. Endpoint kaynağı, alanları, tarihleri ve fiyatları tekrar doğrular; eski bir rapor yeni veriyi geri alamaz ve tekrar gönderim güvenlidir.

Varsayılan dışındaki bir rapor `npm run publish -- --report /tam/yol/report.json` ile seçilir. Uzak hedeflerde HTTPS zorunludur. Yalnızca yerel geliştirmede `--allow-loopback-http` açıkça verilerek `localhost`, `127.0.0.1` veya `[::1]` HTTP hedefi kullanılabilir; bu seçenek uzak bir HTTP adresine izin vermez. Yerel token oluşturma, sağlık kontrolü ve kalıcı D1 aktarımı için depo kökündeki `README.md` içindeki `web` komutlarını kullan.

`Monitor catalog readiness` iş akışı saat başı staging ve production ortamlarında `/api/ready` adresini kontrol eder; manuel çalıştırmada tek ortam seçilebilir. Endpoint yalnızca katalog hazırsa, önerilebilir kayıt varsa ve kalıcı checkpoint 24 saatten gençse 200 döndürür. Hata ayrıntısı GitHub job summary'ye yazılır ve standart başarısız workflow bildirimi kullanılır; harici mesaj gönderilmez.

Başarılı her toplama `output/soak-evidence.json` üretir. Dosya gerçek başlangıç/bitiş zamanlarını, çalışma süresini, kanonik checkpoint kayıt sayısını ve kaynak dağılımını taşır. Tek bir run 48 saatlik soak sonucu sayılmaz; 48 saat boyunca üretilen artifact'lar ayrıca incelenmeden böyle bir iddia yapılmaz.

## Araç seçimi

[Crawlee](https://crawlee.dev/js/docs/introduction) kuyruk ve crawler yönetimini mevcut TypeScript/Node uygulamasıyla birleştiriyor. [Scrapling](https://github.com/D4Vinci/Scrapling) Python ve değişen HTML seçicileri için güçlü bir alternatif; burada doğrulanmış yapısal veri öncelikli. [Crawl4AI](https://github.com/unclecode/crawl4ai) hem CSS hem LLM tabanlı çıkarım sunuyor. [Firecrawl](https://docs.firecrawl.dev/introduction) yönetilen bir alternatif; bu ilk akışın dış servis hesabına ihtiyacı yok. JavaScript gerektiren bir kaynak eklenirse aynı adaptör sözleşmesinin önüne Playwright veya yönetilen fetch servisi eklenebilir; şu an tarayıcı adaptörü uygulanmadı.

Bağımlılık notu: sabitlenmiş Crawlee 3.18.1 ağacında `adm-zip` ve `stream-json` kaynaklı orta seviye transitif audit bildirimleri var; bu toplayıcı arşiv açma veya stream-json filtreleme yollarını kullanmıyor. Zorla uyumsuz sürüm yükseltmesi yapılmadı. Crawler bağımlılıkları web Worker paketine eklenmez.

## Son doğrulama

9 Eylül 2026 genişletilmiş taraması: 7 listenin sonuna ulaşıldı, 2.863 benzersiz kaynak etkinlik bağlantısı keşfedildi. Önceki kayıtlar ve liste başına 15 yeni prodüksiyon örneği üzerinden 272 detay sayfasından 743 seans doğrulandı; 722'si satışta, 21'i kapalı/belirsiz. Eski kayıttan taşınan seans yok. Doğrulanamayan 7 detay sayfası ayrıldı. Ayrıntılar `reports/2026-09-09-expanded.json` içinde. Bunlar **2.863 doğrulanmış seans** veya tüm şehir anlamına gelmez.

Büyüyen katalog için uygulamanın D1 yazımları da UTF-8 boyutu ve kayıt sayısı sınırlı JSON partilerine taşındı. İlk snapshot ve kaynak sayfası değişimi atomik kalır; her seans için ayrı SQL sorgusu oluşturulmaz. Entegrasyon kontrolü snapshot'ın tamamını geri okuyup karşılaştırır ve çok baytlı metin/fiyatı bilinmeyen kayıtlarla 101 seanslık aktarımı doğrular.
