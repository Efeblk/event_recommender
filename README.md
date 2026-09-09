# Bi’ Plan

[Özel önizlemeyi aç](https://biplan-istanbul.efebalikofc.chatgpt.site) — yalnızca site sahibine açık, anahtarsız sürüm.

İstanbul’da konuşarak etkinlik bulma uygulaması. Yeni sürüm `web/` altında; eski Python/FalkorDB uygulaması ve React dashboard’u geçiş sırasında referans olarak korunuyor. Eski kurulumu [arşivlenen README](docs/legacy-readme.md) anlatıyor.

## Çalıştırma

Node **22.13+** gerekir (Node 20 desteklenmez).

```sh
cd web
npm ci
cp .env.example .env
npm run dev
```

Terminalin gösterdiği yerel adresi aç. `.env` dosyasında API anahtarı boş bırakıldığında uygulama **Filtreli önizleme · AI henüz bağlı değil** modunda çalışır. Anahtar tarayıcıya gönderilmez. Geliştirme veritabanı `.wrangler/` altında yerel SQLite/D1 olarak tutulur.

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
npm run collect -- --limit 20
```

Yeni Crawlee toplayıcısı eski Python scraper'lardan bağımsızdır. Üç kaynağın açık sayfalarını okur, seansları doğrular, kaynaklar arası kesin eşleşmeleri işaretler ve `web/data/events.json` dosyasını atomik yeniler. Başarısız sayfaların eski kayıtları kendi kontrol zamanı korunarak 72 saate kadar tutulur. Fiyatı/satış durumu belirsiz kayıtlar doğrulanmış bilet gibi gösterilmez.

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

Henüz kapsam dışı: kullanıcı hesapları, kalıcı kişisel zevk profili, favoriler, ödeme/bilet satışı, tüm Türkiye ve çok kaynaklı kapsam. Eski `src/`, `frontend/` ve `tests/` yeni uygulamanın çalışma bağımlılığı değildir.
