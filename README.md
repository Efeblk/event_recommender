# Bi’ Plan

Yerel önizleme: **http://127.0.0.1:3001**. Aşağıdaki `local:start` komutuyla açılır; bu çalışma yayın yapmaz.

İstanbul’da doğal dille arayıp etkinlik kartları bulma uygulaması. Yeni sürüm `web/` altında; eski Python/FalkorDB uygulaması ve React dashboard’u geçiş sırasında referans olarak korunuyor. Eski kurulumu [arşivlenen README](docs/legacy-readme.md) anlatıyor.

## Yerel çalıştırma

Node **22.13+** gerekir. Proje kökünde bağımlılıkları kur:

```sh
npm ci --prefix web
npm ci --prefix collector
```

İlk terminalde önizlemeyi başlat:

```sh
cd web
npm run local:start
```

**http://127.0.0.1:3001** adresini aç. Bu komut uygulamayı derler ve kalıcı yerel D1 ile çalıştırır; hiçbir şeyi yayına göndermez. API anahtarı olmadan tarih, bütçe, kategori ve kelime eşleşmesi çalışır. İkinci terminalde güncel veri toplayıp çalışan uygulamaya aktar:

```sh
cd web
npm run local:refresh -- --collect
```

Bu işlem liste sayfalarını ve bilinen etkinlik detaylarını yeniden kontrol ettiği için birkaç dakika sürebilir. Daha önce üretilmiş başarılı raporu yeniden aktarmak için `npm run local:refresh`; farklı bir rapor için `npm run local:refresh -- --report /tam/yol/report.json` kullan.

`local:start` yalnızca `127.0.0.1:3001` adresini dinler. Yoksa rastgele bir `SYNC_TOKEN` üretip Git tarafından yok sayılan `web/.dev.vars` dosyasında saklar; mevcut ayarları korur ve sırrı terminale basmaz. İsteğe bağlı sağlayıcı ayarlarını `.env.example` rehberiyle `.env` veya `.dev.vars` içinde tutabilirsin. Sırlar yalnızca yok sayılan yerel çalışma klasörüne yüklenir; derleme çıktısına eklenmez.

`local:refresh`, sunucunun hazır olmasını bekleyip doğrulanmış raporu korumalı import endpoint'ine gönderir. Başarılı import anında aramaya yansır; veri için yeniden başlatma gerekmez. Kod veya sağlayıcı ayarı değiştiğinde `local:start` komutunu yeniden çalıştır. HMR geliştirme modu ayrıca `npm run local:start -- --dev` ile açılır. Kayıtlar `.wrangler/` altındaki yerel SQLite/D1 içinde yeniden başlatmalar arasında korunur.

## Şu an ne çalışıyor?

- Biletinial, Bubilet ve Biletix’ten doğrulanmış İstanbul konser, tiyatro ve stand-up seansları; afiş, mekân, başlangıç fiyatı, açıklama ve kaynak bağlantısı.
- Türkçe tarih, kişi başı bütçe ve kategori filtreleri; aramaya devam ederken önceki filtreleri koruma.
- Aynı prodüksiyonun farklı seanslarını tek öneride toplama; başka seçenekleri isteme.
- Geçmiş, iptal edilmiş, tükenmiş ve **72 saatten eski kontrol tarihli** kayıtları eleme. Bütçe varken fiyatı bilinmeyen kayıtları eleme. Kaynak fiyatları bilet garantisi değildir.
- TypeSafe Jev ile adayların isteğe uygunluğunu puanlama; sonuçlarda yalnızca doğrulanmış etkinlik kartları gösterilir. Üretilmiş sohbet yanıtı veya gerekçe yoktur.
- Konser gibi kategorileri hariç tutma, toplam grup bütçesini kişi başına çevirme, belirsiz koşullarda statik netleştirme durumu.
- Etkin öneri akışı embedding veya başka bir sohbet modeli çağırmaz. Eski sağlayıcı/embedding modülleri ve önbellek geçiş referansı olarak korunur; GPU veya graph veritabanı gerekmez.
- AI kapalıysa veya sağlayıcı başarısızsa açıkça belirtilen kelime/filtre araması. Anahtarsız mod ruh hâlini yorumladığını iddia etmez.
- Mobil uyumlu arayüz, yüklenme/hata/boş sonuç durumları, klavye ile gönderme (Enter; yeni satır Shift+Enter).

## Veriyi yenileme

```sh
cd collector
npm ci
npm run collect -- --limit 100
# Yalnızca tüm liste sayfalarını keşfet; seans/veritabanı güncelleme:
npm run collect -- --discover-only
```

Yeni Crawlee toplayıcısı eski Python scraper'lardan bağımsızdır. Üç kaynağın kaydırmayla yüklenen açık liste isteklerini takip eder, ardından seçilen etkinliklerin seanslarını doğrular, kaynaklar arası kesin eşleşmeleri işaretler ve `web/data/events.json` dosyasını atomik yeniler. Başarısız sayfaların eski kayıtları kendi kontrol zamanı korunarak 72 saate kadar tutulur. Fiyatı/satış durumu belirsiz kayıtlar doğrulanmış bilet gibi gösterilmez.

[Araç karşılaştırması, kapsam, kalite kuralları ve zamanlama](collector/README.md). Koleksiyon raporu `collector/output/report.json` altında. Günde iki toplama için GitHub iş akışı eklendi; master'a alındığında çalışır. Canlı aktarım hedefi ve sunucu sırrı tanımlanmadığında yalnızca artifact üretir. Canlıya aktarım için korumalı `/api/admin/import` ve `collector/publish.mjs` kullanılır; AI anahtarı gerekmez.

## Jev’i açma

Anahtarsız önizleme çalışmaya devam eder. Jev sıralamasını kullanmak için `web/.dev.vars` içine `TYPESAFE_API_KEY` ekle ve yerel sunucuyu yeniden başlat. Anahtarı sohbete veya Git’e yazma. `TYPESAFE_MODEL` varsayılanı `jev-1.13.0`; eski `AI_API_KEY` / `OPENAI_API_KEY` ayarları öneri akışını açmaz. Kurulum ve değerlendirme: [Jev rehberi](web/docs/jev-evaluation.md).

Akış: **kesin filtreleri yorumla → güncel adayları bul → en fazla 16 farklı prodüksiyon → tek Jev isteği → en fazla 5 etkinlik kartı**. Jev’e özgün istek, kısa kullanıcı arama geçmişi ve adayların kaynak metinleri gönderilir; embedding vektörü gönderilmez. Başlık, fiyat, tarih ve bağlantı her zaman veritabanındaki kayıttan gelir. Genel sohbet modeli çalışmaz.

Jev, dört seviyeli uygunluk ölçeğinde puan verir. Başlangıç politikası en az 2 puan alanları göstermektir; bu eşik Türkçe verilerle henüz kalibre edilmemiştir. Geçerli bir “uygun aday yok” yanıtı boş sonuç olarak kalır. Ağ/sağlayıcı hatasında açıkça belirtilen temel arama gösterilir. Belirsiz bütçe veya tarihte önceki filtreler değiştirilmez; kullanıcı aramasını düzenleyebilir. Doğal dil yorumlama her ifade biçimini desteklemez.

“Ciddi bir oyun” gibi bağlamı açık tiyatro istekleri artık konser adaylarına genişlemez. Çocuk gösterisi istemeyen aramalarda açıklamadaki çocuklara yönelik yaş ve izleyici bilgileri de denetlenir. Aynı kurallar anahtarsız aramada ve sağlayıcı kesintisinde geçerlidir; az sonuç varsa ilgisiz kartlarla tamamlanmaz.

Ücretli aramalar IP başına saatte 20, uygulama genelinde varsayılan günde 100 istekle sınırlıdır (`AI_DAILY_LIMIT`). Bir arama en fazla bir Jev çağrısı yapar; 15 saniye zaman aşımı ve sınırlı girdi/çıktı boyutu vardır. Otomatik ücretli tekrar yoktur. Bu sayaç dolar harcama limiti değildir. Arama geçmişi yalnızca açık sekmenin belleğinde tutulur.

[Eski sağlayıcı rehberi](web/docs/providers.md) korunur, fakat aktif öneri yolunu anlatmaz. Embedding önbelleği isteğe bağlı eski yönetici araçlarında kalır; bu sürümün sonuç sıralaması onu kullanmaz. İlk canlı Jev denemesinde 10 etiketli isteğin ilk sonucu doğru, iki desteksiz tercih isteğinin sonucu boştu. Ciddi yetişkin oyunu isteğinde bazı zayıf ek sonuçlar da eşikten geçti; tüm sonuç listesinin kalitesi henüz doğrulanmış sayılmaz. [Ölçüm raporu](web/evals/reports/2026-09-22-jev-1.13.0.json) 12 çağrı, tokenlar ve gecikmeyi kaydeder. Daha geniş gerçek katalog denemeleri gerekir.

Değerlendirme artık yalnızca ilk sırayı değil, dönen bütün kartların uygunluğunu ölçer. Kayıtlı puanları ağ çağrısı yapmadan tekrar uygulayan denetim, filtre değişikliklerinin bilinen yanlış ek sonuçları engellediğini sınar. Bu denetim yeni bir canlı Jev ölçümü değildir; eşik ve modelin Türkçe kalitesi için daha geniş örnekler gerekir.

## Kontroller

```sh
cd web
npm test
npm run typecheck
npm run lint
npm run build
npm run test:smoke
```

Testler tarih/saat dilimi sınırlarını, fiyatı bilinmeyen ve eski kayıtları, kaynak ayrıştırmayı, yinelenen seansları, alternatif önerileri, AI kesintisini ve uydurma ID’lerin elenmesini kapsar. Otomatik testler kontrollü sağlayıcı yanıtları kullanır ve ücretli API çağrısı yapmaz. Ayrıca kullanıcı onayıyla 12 örnek üzerinde bir canlı Jev değerlendirmesi kaydedilmiştir.

GitHub Actions, `master` için her PR'da ve `master` push'larında bu kontrolleri çalıştırır. Smoke kontrolü derlenen Worker'ı geçici bir D1 veritabanıyla açar; sayfa, anahtarsız API, geçersiz istek ve yönetici erişim korumasını doğrular. Yerel sırları ve mevcut veritabanını kullanmaz. Eski Python testleri ayrı CI iş akışında korunur.

## Yayın

Yeni uygulama React + TypeScript + Vinext üzerinde tek Cloudflare Worker ve D1 veritabanı olarak paketlenir; GPU, FalkorDB veya Python servisi gerektirmez. `.openai/hosting.json` Sites yayın bağlantısını tutar. Sunucu sırları bu dosyaya veya Git’e yazılmaz. `SITE_URL` güvenilir yayın kökü olmalı (sosyal önizleme bağlantıları için).

`db/schema.ts` şema kaynağıdır; değişiklik sonrası `npm run db:generate` ile SQL üret. Migration’lar `drizzle/` altında sürümlenir. Çalışma sırasında ilk açılışta doğrulanmış başlangıç seçkisi veritabanına aktarılır.

Henüz kapsam dışı: kullanıcı hesapları, kalıcı kişisel zevk profili, favoriler, ödeme/bilet satışı, tüm Türkiye ve eksiksiz şehir kapsamı. Eski `src/`, `frontend/` ve `tests/` yeni uygulamanın çalışma bağımlılığı değildir.

## Destek ve reklam alanları

Ana sayfa doğal dil arama çubuğu, önerilen etkinlikler ve projeye destek bölümü içerir. Bağış sayfasının HTTPS adresini `web/.env` veya `web/.dev.vars` içine `DONATION_URL` olarak ekleyip yerel sunucuyu yeniden başlat. Bağlantı tanımlanana kadar destek bölümü “yakında” durumunda kalır; ödeme alınmaz. `/api/site` yalnızca bu herkese açık bağlantıyı döndürür.

Sayfada iki ayrı reklam alanı ayrılmıştır. Henüz reklam ağı, takip betiği veya reklam isteği yoktur. Bu alanlar ileride reklam içeriğiyle doldurulabilir.

## Public beta hazırlığı

[Cloudflare kurulum, staging/production ayrımı, deployment ve rollback](docs/deployment.md) hazırdır. Deployment iş akışı yalnızca elle başlatılır; PR veya push siteyi yayınlamaz. [Yayın sırası ve kalan doğrulamalar](docs/launch-checklist.md) tamamlanmadan public beta hazır sayılmaz.

`/api/health` uygulamanın çalıştığını, `/api/ready` ise kataloğun ve kalıcı toplama checkpoint'inin sağlığını gösterir. İkincisi eksik, 24 saatten eski veya ciddi şekilde küçülmüş katalog/checkpoint için 503 döner. Yerel sunucu D1 yanında yerel R2 deposunu da kalıcı tutar; normal arama checkpoint olmadan çalışır. `collector/publish.mjs --checkpoint` bütün import partileri tamamlandıktan sonra sunucudaki gerçek kayıtların R2 snapshot'ını alır ve geri okuyarak doğrular.

[Jev değerlendirmesi](web/docs/jev-evaluation.md), 12 Türkçe örnekle aday kapsamını, sıralamayı, boş sonuç davranışını, gecikmeyi ve token tüketimini ölçer. Varsayılan test API çağrısı yapmaz. Jev öneri akışına bağlanmıştır; anahtar olmadan temel arama çalışır. Gerçek sağlayıcı kalitesi ayrıca ölçülmelidir.
