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

`Collect event data` iş akışı, bu değişiklik master'a alındığında her gün 03:17 ve 15:17 UTC'de (Türkiye 06:17/18:17) çalışır; manuel de başlatılabilir. Veri ve raporlar GitHub Actions artifact'ı olarak 14 gün saklanır. Son başarılı snapshot ayrıca Actions cache üzerinden sonraki çalışmaya taşınır; böylece daha önce keşfedilen prodüksiyonlar yeniden kontrol edilir. Cache yoksa repodaki başlangıç snapshot'ından devam edilir; bozuk/başarısız toplama cache'i güncellemez. Normal PR CI'ı internete çıkmadan fixture testlerini çalıştırır; gerçek site erişimi sadece ayrı toplama iş akışındadır.

Canlı aktarım için GitHub repository variable `BIPLAN_URL` ve secret `SYNC_TOKEN` tanımlanır; aynı `SYNC_TOKEN` uygulamanın sunucu sırrı olmalıdır. Sahibe özel Sites yayını ayrıca erişim doğrulaması gerektirir; kullanıcı tarafından sağlanmış Sites erişim tokenı varsa `SITES_ACCESS_TOKEN` olarak tutulur. Bu ayarlar yoksa iş akışı **yalnızca artifact üretir**, canlı veritabanını değiştirmez. Sırlar bu çalışmada oluşturulmadı veya paylaşılmadı.

```sh
npm run publish
```

`publish.mjs`, başarılı raporun doğrulanmış sayfalarını sınırlı partilerle `POST /api/admin/import` adresine yollar. Endpoint kaynağı, alanları, tarihleri ve fiyatları tekrar doğrular; her kaynak sayfasını atomik yazar. Eski bir rapor yeni veriyi geri alamaz; tekrar gönderim güvenlidir. Import embedding çağrısı yapmaz. Eski `/api/admin/sync` Biletinial'a özel uyumluluk yoludur; yeni üç kaynaklı akış için `collect` + `publish` kullanılır.

## Araç seçimi

[Crawlee](https://crawlee.dev/js/docs/introduction) kuyruk ve crawler yönetimini mevcut TypeScript/Node uygulamasıyla birleştiriyor. [Scrapling](https://github.com/D4Vinci/Scrapling) Python ve değişen HTML seçicileri için güçlü bir alternatif; burada doğrulanmış yapısal veri öncelikli. [Crawl4AI](https://github.com/unclecode/crawl4ai) hem CSS hem LLM tabanlı çıkarım sunuyor. [Firecrawl](https://docs.firecrawl.dev/introduction) yönetilen bir alternatif; bu ilk akışın dış servis hesabına ihtiyacı yok. JavaScript gerektiren bir kaynak eklenirse aynı adaptör sözleşmesinin önüne Playwright veya yönetilen fetch servisi eklenebilir; şu an tarayıcı adaptörü uygulanmadı.

Bağımlılık notu: sabitlenmiş Crawlee 3.18.1 ağacında `adm-zip` ve `stream-json` kaynaklı orta seviye transitif audit bildirimleri var; bu toplayıcı arşiv açma veya stream-json filtreleme yollarını kullanmıyor. Zorla uyumsuz sürüm yükseltmesi yapılmadı. Crawler bağımlılıkları web Worker paketine eklenmez.

## Son doğrulama

9 Eylül 2026 genişletilmiş taraması: 7 listenin sonuna ulaşıldı, 2.863 benzersiz kaynak etkinlik bağlantısı keşfedildi. Önceki kayıtlar ve liste başına 15 yeni prodüksiyon örneği üzerinden 272 detay sayfasından 743 seans doğrulandı; 722'si satışta, 21'i kapalı/belirsiz. Eski kayıttan taşınan seans yok. Doğrulanamayan 7 detay sayfası ayrıldı. Ayrıntılar `reports/2026-09-09-expanded.json` içinde. Bunlar **2.863 doğrulanmış seans** veya tüm şehir anlamına gelmez.

Büyüyen katalog için uygulamanın D1 yazımları da UTF-8 boyutu ve kayıt sayısı sınırlı JSON partilerine taşındı. İlk snapshot ve kaynak sayfası değişimi atomik kalır; her seans için ayrı SQL sorgusu oluşturulmaz. Entegrasyon kontrolü snapshot'ın tamamını geri okuyup karşılaştırır ve çok baytlı metin/fiyatı bilinmeyen kayıtlarla 101 seanslık aktarımı doğrular.
