> Legacy reference: the active recommendation route now uses TypeSafe Jev only. These chat/embedding adapters remain for migration reference and optional admin tooling; setting their keys does not enable recommendations. See [Jev setup](jev-evaluation.md).

# AI sağlayıcı bağlantısı

Bu altyapı sağlayıcı hesabı açmaz, anahtar üretmez ve anahtarsız modda AI çağrısı yapmaz. Ayarlar yalnızca sunucuda okunur. İstemci API adresi, anahtarı veya model seçemez. Sağlayıcı ve model seçildiğinde aşağıdaki ayarlar yeterlidir; gerçek modelin Türkçe öneri kalitesi ayrıca ölçülmelidir.

## Sohbet

`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` birlikte tanımlanır. Model kimliğini sağlayıcının panelinden al. `AI_BASE_URL` HTTPS API köküdür; sonuna `/chat/completions` veya `/responses` ekleme. Adres içinde kullanıcı adı, şifre, sorgu parametresi veya fragment kabul edilmez; HTTP yönlendirmeleri takip edilmez.

| Servis                                    | AI_BASE_URL                                               | AI_PROTOCOL        |
| ----------------------------------------- | --------------------------------------------------------- | ------------------ |
| OpenRouter                                | `https://openrouter.ai/api/v1`                            | `chat-completions` |
| Gemini uyumluluk API'si                   | `https://generativelanguage.googleapis.com/v1beta/openai` | `chat-completions` |
| Doğrudan OpenAI                           | `https://api.openai.com/v1`                               | `responses`        |
| Başka uyumlu servis / barındırdığın model | Servisin HTTPS API kökü                                   | `chat-completions` |

OpenRouter örneği (anahtar ve model yer tutucudur):

```dotenv
AI_API_KEY=<sunucu-sirri>
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=<saglayici/model-kimligi>
AI_PROTOCOL=chat-completions
AI_OUTPUT_FORMAT=json_schema
AI_MAX_OUTPUT_TOKENS=1800
AI_TOKEN_PARAMETER=max_tokens
```

Varsayılan `json_schema` modu için seçilen model/endpoint yapılandırılmış çıktıyı desteklemelidir. Yalnızca JSON modu sunan modellerde `AI_OUTPUT_FORMAT=json_object` seçilebilir; şema sistem talimatına eklenir ve gelen veri her iki modda uygulama içinde doğrulanır. Yalnızca düz metin üreten, bu formatları desteklemeyen servisler için ek adaptör gerekir. Otomatik format değiştirip ikinci ücretli istek yapılmaz.

`AI_MAX_OUTPUT_TOKENS` 256–8192 arasında, her bir sohbet çağrısının çıktı sınırıdır. Chat Completions modelinin gerektirmesi durumunda `AI_TOKEN_PARAMETER=max_completion_tokens` kullan. Akıl yürütme modellerinde bu sınır düşünme tokenlarını da kapsayabilir; yarım kalan sonuç filtreli aramaya düşer. Responses her zaman `max_output_tokens` kullanır.

Eski `OPENAI_API_KEY` / `OPENAI_MODEL` kurulumu korunur. `AI_API_KEY` veya `AI_BASE_URL` varsa sohbet için eski anahtar kullanılmaz; yanlışlıkla başka servise gönderilmez. Kullanıcı metinleri, sınırlı geçmiş ve aday açıklamaları seçilen sohbet servisine gider. Responses'taki `store:false`, diğer servislerin saklama politikasının yerine geçmez.

## Bağımsız embedding

Sohbet tek başına çalışabilir: filtreleme → kelime sıralaması → AI seçimi. Embedding için ayrı ayarlar kullanılır:

```dotenv
EMBEDDING_ENABLED=true
EMBEDDING_API_KEY=<ayri-sunucu-sirri>
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=512
EMBEDDING_SEND_DIMENSIONS=true
```

Embedding servisi OpenAI uyumlu `/embeddings` arayüzü ve sıralı `index` + sayısal `embedding` alanlarını sağlamalıdır. `EMBEDDING_DIMENSIONS` modelin döndüreceği boyuttur (1–4096). Boyut küçültme desteklenmiyorsa gerçek doğal boyutu yaz ve `EMBEDDING_SEND_DIMENSIONS=false` kullan; bu durumda istekte `dimensions` gönderilmez. Modelin sorgu/doküman için ek görev parametresi gerektirmesi durumunda o sağlayıcıya özel adaptör gerekir.

Üçüncü taraf sohbet anahtarı embedding için otomatik kullanılmaz. Aynı şirketi kullanmak istersen embedding anahtarını da açıkça ayarla. Geriye uyumluluk için yalnızca eski `OPENAI_API_KEY` kurulumu kullanılıyorsa OpenAI embedding'i varsayılan olarak açılır; `EMBEDDING_ENABLED=false` bunu kapatır. Embedding yapılandırması hatalı olsa da sohbetin aday seçimi çalışır.

Korumalı `POST /api/admin/sync`, etkinlikleri yeniler ve değişen kayıtları en fazla 32'lik embedding partileriyle indeksler. İndeks sohbetten bağımsız oluşturulabilir. Kaynak metni, API kökü, model, boyut veya boyut gönderme ayarı değişirse eski vektörler kullanılmaz. Anahtar yenilenmesi indeksi bozmaz. Geçersiz önbellek kayıtları atlanır. Önceki sürümün indeksini yeni kimliğe geçirmek için bir sync gerekir.

Yerelde sync için `SYNC_TOKEN` yeterlidir. Sahibe özel Sites yayınına dışarıdan erişim ayrıca Sites oturumu/erişim doğrulamasına tabidir; tek başına `SYNC_TOKEN` bu giriş kapısını geçmez. Bu sürümde otomatik zamanlanmış veri yenileme kurulmamıştır.

## Maliyet ve hata davranışı

- Normal öneri: en fazla iki sohbet çağrısı (isteği anlama ve aday seçimi), indeks hazırsa bir sorgu embedding çağrısı. Netleştirme veya eşleşme olmaması halinde ikinci sohbet çağrısı yapılmaz.
- AI açıkken IP başına dakikada 5 ve saatte 20; AI kapalı temel aramada saatte 60; uygulama genelinde varsayılan günde 100 AI öneri isteği. `AI_DAILY_LIMIT` istek sayısıdır, dolar limiti değildir. IP sınırı katalog kontrolünden önce, günlük AI sınırı yalnızca hazır katalogdan sonra uygulanır. Sync embedding çağrıları bu sayaçtan ayrıdır.
- Her dış istek 25 saniye ile sınırlıdır. 429, zaman aşımı, yarım/bozuk yanıt ve şema hatası ücretli tekrar denenmez. Sohbet hatasında açıklamalı filtreli arama; embedding hatasında kelime sıralaması ve AI seçimi kullanılır.
- Yanıt boyutları sınırlıdır; sağlayıcının ham hata gövdesi kullanıcıya aktarılmaz. Olay adı, tarih, fiyat ve URL daima yerel aday kaydından gelir.
- Sahte HTTP yanıtlarıyla adaptör sözleşmeleri ve hata yolları test edilir. Gerçek sağlayıcıya ücretli çağrı yapılmadı; fiyat, gecikme ve öneri kalitesi ölçülmedi.

Arayüz kaynakları: [OpenRouter yapılandırılmış çıktılar](https://openrouter.ai/docs/guides/features/structured-outputs), [Gemini OpenAI uyumluluğu](https://ai.google.dev/gemini-api/docs/openai), [OpenAI yapılandırılmış çıktılar](https://developers.openai.com/api/docs/guides/structured-outputs). Model ve endpoint desteği sağlayıcıya göre değişir.
