# Bi’ Plan

Yerel önizleme: **http://127.0.0.1:3001**. Aşağıdaki `local:start` komutuyla açılır; bu çalışma yayın yapmaz.

İstanbul’da konuşarak etkinlik bulma uygulaması. Yeni sürüm `web/` altında; eski Python/FalkorDB uygulaması ve React dashboard’u geçiş sırasında referans olarak korunuyor. Eski kurulumu [arşivlenen README](docs/legacy-readme.md) anlatıyor.

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
- İsteğe bağlı OpenAI Responses veya OpenAI uyumlu Chat Completions API ile niyet/filtre çıkarımı, gerektiğinde netleştirme sorusu, adaylar arasından gerekçeli seçim.
- Sohbetten bağımsız, isteğe bağlı embedding sağlayıcısıyla anlamsal sıralama; metin hash’i, API adresi, model ve boyuta göre kalıcı embedding önbelleği. Graph veritabanı gerektirmez.
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

## AI’ı açma

`web/.env.example` anahtarsız önizleme için hazırdır. Sağlayıcı seçilene kadar anahtarları boş bırak; hiçbir AI çağrısı yapılmaz. Üçüncü taraf bağlantısında `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` ayarlanır. Yerelde `.env` değişikliğinden sonra geliştirme sunucusunu yeniden başlat; yayında anahtarlar sunucu sırları olarak tanımlanır.

[Sağlayıcı kurulumu ve örnekler](web/docs/providers.md): OpenRouter, Gemini'nin OpenAI uyumlu arayüzü ve genel uyumlu servisler için ayarlar; bağımsız embedding ve hata davranışları. Sağlayıcı/model uyumluluğu gerçek anahtarla henüz test edilmedi.

Eski doğrudan OpenAI ayarları da çalışır: yalnızca `OPENAI_API_KEY` ile sohbet modeli `OPENAI_MODEL` (varsayılan `gpt-4.1-mini`), embedding modeli `text-embedding-3-small` (512 boyut). Embedding'i kapatmak için `EMBEDDING_ENABLED=false`.

Anlamsal arama için anahtar tanımlandıktan sonra korumalı `/api/admin/sync` işlemini çalıştır: etkinlikleri ve embedding önbelleğini oluşturur. Embedding bulunmuyorsa kelime tabanlı aday sıralaması + AI değerlendirmesi kullanılır. Embedding adresi/modeli/boyutu değişirse eski indeks kullanılmaz; sync ile yeniden oluşturulur. Yeni `embedding-v2` önbellek kimliğine geçişte de bir sync gerekir.

Akış: **isteği anla → kesin filtreler → embedding/kelime sıralaması → en fazla 16 farklı aday → 3–5 gerekçeli öneri**. AI yalnızca aday ID’lerini seçebilir; gösterilen etkinlik bilgileri veritabanından gelir. Öneri gerekçelerinin kalitesi gerçek sağlayıcıyla ayrıca değerlendirilmelidir.

Ücretli aramalar IP başına saatte 20, tüm uygulama için varsayılan günde 100 istekle sınırlıdır (`AI_DAILY_LIMIT`). Bu bir dolar harcama limiti değildir; sağlayıcı hesabında ayrıca bütçe limiti tanımlanabilir. Veri yenilemenin embedding çağrıları bu sohbet sayacından ayrıdır ve yönetici sırrı gerektirir. Kullanıcı mesajı, kısa sohbet geçmişi ve aday açıklamaları AI sağlayıcısına gönderilir; Responses isteklerinde `store:false` kullanılır. Bu ayar üçüncü tarafların saklama politikasını garanti etmez. İstekler 25 saniyede zaman aşımına uğrar; otomatik ücretli tekrar denenmez. Sohbet geçmişi bu sürümde yalnızca açık sekmenin belleğinde tutulur.

## Kontroller

```sh
cd web
npm test
npm run typecheck
npm run lint
npm run build
npm run test:smoke
```

Testler tarih/saat dilimi sınırlarını, fiyatı bilinmeyen ve eski kayıtları, kaynak ayrıştırmayı, yinelenen seansları, alternatif önerileri, AI kesintisini ve uydurma ID’lerin elenmesini kapsar. AI testlerinde sağlayıcı yerine kontrollü test yanıtları kullanılır; gerçek anahtarla model kalitesi/latans testi henüz yapılmamıştır.

GitHub Actions, `master` için her PR'da ve `master` push'larında bu kontrolleri çalıştırır. Smoke kontrolü derlenen Worker'ı geçici bir D1 veritabanıyla açar; sayfa, anahtarsız API, geçersiz istek ve yönetici erişim korumasını doğrular. Yerel sırları ve mevcut veritabanını kullanmaz. Eski Python testleri ayrı CI iş akışında korunur.

## Yayın

Yeni uygulama React + TypeScript + Vinext üzerinde tek Cloudflare Worker ve D1 veritabanı olarak paketlenir; GPU, FalkorDB veya Python servisi gerektirmez. `.openai/hosting.json` Sites yayın bağlantısını tutar. Sunucu sırları bu dosyaya veya Git’e yazılmaz. `SITE_URL` güvenilir yayın kökü olmalı (sosyal önizleme bağlantıları için).

`db/schema.ts` şema kaynağıdır; değişiklik sonrası `npm run db:generate` ile SQL üret. Migration’lar `drizzle/` altında sürümlenir. Çalışma sırasında ilk açılışta doğrulanmış başlangıç seçkisi veritabanına aktarılır.

Henüz kapsam dışı: kullanıcı hesapları, kalıcı kişisel zevk profili, favoriler, ödeme/bilet satışı, tüm Türkiye ve eksiksiz şehir kapsamı. Eski `src/`, `frontend/` ve `tests/` yeni uygulamanın çalışma bağımlılığı değildir.

## Destek ve reklam alanları

Ana sayfa sohbet çubuğu, önerilen etkinlikler ve projeye destek bölümü içerir. Bağış sayfasının HTTPS adresini `web/.env` veya `web/.dev.vars` içine `DONATION_URL` olarak ekleyip yerel sunucuyu yeniden başlat. Bağlantı tanımlanana kadar destek bölümü “yakında” durumunda kalır; ödeme alınmaz. `/api/site` yalnızca bu herkese açık bağlantıyı döndürür.

Sayfada iki ayrı reklam alanı ayrılmıştır. Henüz reklam ağı, takip betiği veya reklam isteği yoktur. Bu alanlar ileride reklam içeriğiyle doldurulabilir.

## Public beta hazırlığı

[Cloudflare kurulum, staging/production ayrımı, deployment ve rollback](docs/deployment.md) hazırdır. Deployment iş akışı yalnızca elle başlatılır; PR veya push siteyi yayınlamaz. [Yayın sırası ve kalan doğrulamalar](docs/launch-checklist.md) tamamlanmadan public beta hazır sayılmaz.

`/api/health` uygulamanın çalıştığını, `/api/ready` ise kataloğun ve kalıcı toplama checkpoint'inin sağlığını gösterir. İkincisi eksik, 24 saatten eski veya ciddi şekilde küçülmüş katalog/checkpoint için 503 döner. Yerel sunucu D1 yanında yerel R2 deposunu da kalıcı tutar; normal arama checkpoint olmadan çalışır. `collector/publish.mjs --checkpoint` bütün import partileri tamamlandıktan sonra sunucudaki gerçek kayıtların R2 snapshot'ını alır ve geri okuyarak doğrular.

[Jev deneme yolu](web/docs/jev-evaluation.md), 12 Türkçe örnekle sıralama kalitesini, gecikmeyi ve token tüketimini ölçmeye hazırlanmıştır. Varsayılan test API çağrısı yapmaz. Jev public öneri akışına henüz bağlanmamıştır; gerçek sağlayıcı kalitesi ayrıca ölçülmelidir.
