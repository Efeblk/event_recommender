'use client';
import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  ArrowUp,
  MapPin,
  Sparkles,
  Compass,
  SlidersHorizontal,
  RotateCcw,
  CalendarDays,
  LoaderCircle,
  Ticket,
  X,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  CATEGORIES,
  emptyFilters,
  type EventRecord,
  type Filters,
  type Message,
  type SearchResult,
} from '@/lib/types';

const dateLabel = (date: string) =>
  new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: 'numeric',
    month: 'long',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
const money = (price: number) =>
  new Intl.NumberFormat('tr-TR', {
    style: 'currency',
    currency: 'TRY',
    maximumFractionDigits: 0,
  }).format(price);
function EventCard({
  event,
  reason,
  compact = false,
}: {
  event: EventRecord;
  reason?: string;
  compact?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <article className={`event-card ${compact ? 'compact' : ''}`}>
      <div className="poster">
        {event.imageUrl && !imageFailed ? (
          <Image
            unoptimized
            width={90}
            height={126}
            src={event.imageUrl}
            alt={`${event.title} etkinlik afişi`}
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <Ticket size={30} />
        )}
      </div>
      <div className="event-content">
        <span className="event-category">{event.category}</span>
        <h3>{event.title}</h3>
        <p className="event-meta">
          <CalendarDays size={12} />
          {dateLabel(event.startsAt)}
        </p>
        <p className="event-meta">
          <MapPin size={12} />
          {event.venue}
        </p>
        {reason && <p className="event-reason">{reason}</p>}
        <div className="event-bottom">
          <span className="price">
            {event.price === null ? (
              'Fiyat belirtilmemiş'
            ) : event.price === 0 ? (
              'Ücretsiz'
            ) : (
              <>
                {money(event.price)}
                <small>’den başlayan</small>
              </>
            )}
          </span>
          <a
            className="ticket-link"
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Kaynağa git <ArrowUpRight size={14} />
          </a>
        </div>
        {!compact && (
          <details className="event-details">
            <summary>Etkinlik hakkında</summary>
            <p>{event.description || 'Kaynakta açıklama bulunmuyor.'}</p>
            {event.address && <p>{event.address}</p>}
            <span>
              Kaynak:{' '}
              {event.source === 'bubilet'
                ? 'Bubilet'
                : event.source === 'biletix'
                  ? 'Biletix'
                  : 'Biletinial'}{' '}
              · Kontrol: {dateLabel(event.checkedAt)}
            </span>
          </details>
        )}
      </div>
    </article>
  );
}
export default function Home() {
  const [message, setMessage] = useState('');
  const [filters, setFilters] = useState<Filters>({ ...emptyFilters });
  const [history, setHistory] = useState<Message[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [excluded, setExcluded] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const resultHeading = useRef<HTMLHeadingElement | null>(null);
  async function loadEvents() {
    try {
      const response = await fetch('/api/events');
      if (!response.ok) throw new Error('Etkinlikler yüklenemedi.');
      const data = (await response.json()) as {
        events: EventRecord[];
        total: number;
        aiEnabled: boolean;
      };
      setEvents(data.events);
      setTotal(data.total);
      setAiEnabled(data.aiEnabled);
      setError('');
    } catch {
      setError(
        'Etkinlikler yüklenemedi. Bağlantını kontrol edip yeniden deneyebilirsin.',
      );
    } finally {
      setInitialLoading(false);
    }
  }
  useEffect(() => {
    let active = true;
    const initialRequest = new AbortController();
    void fetch('/api/events', { signal: initialRequest.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Etkinlikler yüklenemedi.');
        return (await response.json()) as {
          events: EventRecord[];
          total: number;
          aiEnabled: boolean;
        };
      })
      .then((data) => {
        if (active) {
          setEvents(data.events);
          setTotal(data.total);
          setAiEnabled(data.aiEnabled);
        }
      })
      .catch(() => {
        if (active)
          setError('Etkinlikler yüklenemedi. Yeniden deneyebilirsin.');
      })
      .finally(() => {
        if (active) setInitialLoading(false);
      });
    return () => {
      active = false;
      initialRequest.abort();
      controller.current?.abort();
    };
  }, []);
  async function search(text = message, alternatives = false) {
    const query = text.trim() || 'Seçtiğim filtrelere göre etkinlik bul.';
    if (busy) return;
    if (
      filters.dateFrom &&
      filters.dateTo &&
      filters.dateFrom > filters.dateTo
    ) {
      setError('Bitiş tarihi başlangıçtan önce olamaz.');
      return;
    }
    const excludeIds = alternatives
      ? [
          ...new Set([
            ...excluded,
            ...(result?.recommendations.map((r) => r.event.id) || []),
          ]),
        ].slice(-100)
      : [];
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError('');
    setPending(query);
    try {
      const response = await fetch('/api/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({
          message: query,
          history: history.slice(-10),
          filters,
          excludeIds,
        }),
      });
      const data = (await response.json()) as SearchResult & { error?: string };
      if (!response.ok) throw new Error(data.error || 'Arama tamamlanamadı.');
      setResult(data);
      setFilters(data.filters);
      setHistory(
        (previous) =>
          [
            ...previous,
            { role: 'user', content: query },
            { role: 'assistant', content: data.message },
          ].slice(-12) as Message[],
      );
      setMessage('');
      setExcluded(excludeIds);
      requestAnimationFrame(() =>
        resultHeading.current?.focus({ preventScroll: true }),
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      setError(
        e instanceof Error
          ? e.message
          : 'Bir sorun oluştu. Lütfen yeniden dene.',
      );
    } finally {
      if (controller.current === abort) {
        setBusy(false);
        setPending('');
      }
    }
  }
  function reset() {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setPending('');
    setMessage('');
    setHistory([]);
    setResult(null);
    setFilters({ ...emptyFilters });
    setExcluded([]);
    setError('');
    textarea.current?.focus();
  }
  const hasFilters = Object.values(filters).some((v) => v !== null);
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link
          className="brand"
          href="/"
          aria-label="Bi’ Plan ana sayfa"
          onClick={reset}
        >
          bi’ plan
          <span className="brand-dot" aria-hidden="true">
            ✳
          </span>
        </Link>
        <span className="city">
          <MapPin size={14} /> İstanbul
        </span>
        <span className="edition">Şehrinle bir plan yap.</span>
        {result && (
          <Button variant="ghost" className="reset" onClick={reset}>
            <RotateCcw size={14} />
            <span>Yeni plan</span>
          </Button>
        )}
      </header>
      <main>
        <div className={`workspace ${result ? 'has-results' : ''}`}>
          <section className="conversation">
            <div className="eyebrow">
              <span className="live-dot" />
              {result ? 'SANA GÖRE BİR PLAN' : 'PLANIN BURADA BAŞLIYOR'}
            </div>
            {!result ? (
              <>
                <h1>
                  Bugün biraz
                  <br />
                  <em>dışarı çıksak?</em>
                </h1>
                <p className="intro">
                  Bir konser, küçük bir sahne, beklenmedik bir akşam.
                  <br />
                  Aklındakini anlat, sana göre olanı birlikte bulalım.
                </p>
              </>
            ) : (
              <>
                <h1 className="conversation-title">
                  Planı biraz
                  <br />
                  <em>sana uyduralım.</em>
                </h1>
                <div className="messages" aria-live="polite">
                  {history.slice(-4).map((m, i) => (
                    <div key={i} className={`message ${m.role}`}>
                      <span>{m.role === 'user' ? 'SEN' : 'Bİ’ PLAN'}</span>
                      <p>{m.content}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className={`preview-notice ${aiEnabled ? 'ai-on' : ''}`}>
              <span className="status-dot" />
              {aiEnabled
                ? 'AI destekli etkinlik keşfi'
                : 'Filtreli önizleme · AI henüz bağlı değil'}
            </div>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <label className="sr-only" htmlFor="message">
                Nasıl bir plan yapmak istiyorsun?
              </label>
              <Textarea
                ref={textarea}
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={busy}
                maxLength={1200}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void search();
                  }
                }}
                placeholder={
                  result
                    ? 'Mesela, bütçeyi 1.500 TL yapalım…'
                    : aiEnabled
                      ? 'Mesela, hafta sonu iki kişilik sakin bir plan…'
                      : 'Mesela, bu hafta sonu 1.000 TL altında bir konser…'
                }
              />
              <div className="composer-bottom">
                <span>
                  <Sparkles size={14} />
                  {busy
                    ? 'Etkinlikler aranıyor…'
                    : aiEnabled
                      ? 'Biraz senden, biraz şehirden.'
                      : 'Tarih, kişi başı bütçe ve kategori yazabilirsin.'}
                </span>
                <Button
                  type="submit"
                  aria-label="Planımı bul"
                  disabled={busy}
                  size="icon"
                  className="send"
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={20} />
                  ) : (
                    <ArrowUp size={21} />
                  )}
                </Button>
              </div>
            </form>
            <details className="filter-panel">
              <summary>
                <SlidersHorizontal size={13} /> Filtreleri kendim seçeyim{' '}
                {hasFilters && (
                  <span className="filter-count">
                    {Object.values(filters).filter((v) => v !== null).length}
                  </span>
                )}
              </summary>
              <div className="filter-grid">
                <label htmlFor="date-from">
                  Başlangıç
                  <Input
                    id="date-from"
                    type="date"
                    value={filters.dateFrom || ''}
                    disabled={busy}
                    onChange={(e) =>
                      setFilters({
                        ...filters,
                        dateFrom: e.target.value || null,
                      })
                    }
                  />
                </label>
                <label htmlFor="date-to">
                  Bitiş
                  <Input
                    id="date-to"
                    type="date"
                    value={filters.dateTo || ''}
                    disabled={busy}
                    onChange={(e) =>
                      setFilters({ ...filters, dateTo: e.target.value || null })
                    }
                  />
                </label>
                <label htmlFor="budget">
                  Kişi başı en fazla (TL)
                  <Input
                    id="budget"
                    type="number"
                    min="0"
                    max="100000"
                    placeholder="Sınır yok"
                    value={filters.maxPrice ?? ''}
                    disabled={busy}
                    onChange={(e) =>
                      setFilters({
                        ...filters,
                        maxPrice:
                          e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label htmlFor="category">
                  Kategori
                  <NativeSelect
                    id="category"
                    value={filters.category || ''}
                    disabled={busy}
                    onChange={(e) =>
                      setFilters({
                        ...filters,
                        category: (e.target.value ||
                          null) as Filters['category'],
                      })
                    }
                  >
                    <NativeSelectOption value="">Hepsi</NativeSelectOption>
                    {CATEGORIES.map((c) => (
                      <NativeSelectOption key={c} value={c}>
                        {c}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
              </div>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => search('Seçtiğim filtrelere göre etkinlik bul.')}
              >
                Filtreleri uygula <ArrowUpRight size={14} />
              </Button>
            </details>
            {hasFilters && (
              <div className="active-filters">
                {filters.category && <span>{filters.category}</span>}
                {filters.maxPrice !== null && (
                  <span>En fazla {money(filters.maxPrice)}</span>
                )}
                {filters.dateFrom && <span>{filters.dateFrom}</span>}
                {filters.dateTo && filters.dateTo !== filters.dateFrom && (
                  <span>→ {filters.dateTo}</span>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => setFilters({ ...emptyFilters })}
                  aria-label="Filtreleri temizle"
                >
                  <X size={12} />
                  Temizle
                </Button>
              </div>
            )}
            {!result && (
              <div className="prompts">
                {[
                  'Bu hafta sonu ne var?',
                  'Biraz canlı müzik',
                  'Gülecek bir şeyler',
                ].map((t) => (
                  <Button
                    disabled={busy}
                    variant="outline"
                    key={t}
                    onClick={() => search(t)}
                  >
                    {t}
                    <ArrowUpRight size={13} />
                  </Button>
                ))}
              </div>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
                <Button
                  variant="link"
                  onClick={() => (result ? search(message) : loadEvents())}
                  disabled={busy}
                >
                  Yeniden dene
                </Button>
              </div>
            )}
            {busy && (
              <output className="pending">
                <LoaderCircle className="spin" size={14} />“{pending}” için
                bakıyorum…
              </output>
            )}
            <p className="trust-note">
              {aiEnabled
                ? 'Tercihlerini anlamak için mesajın AI sağlayıcısına gönderilir.'
                : 'Anahtarsız sürüm kelime ve filtre eşleşmesi kullanır; ruh hâlini yorumlamaz.'}
              <br />
              Fiyatlar başlangıç fiyatıdır; son durumu bilet sayfasında kontrol
              et.
            </p>
          </section>
          <aside
            className={`discovery ${result ? 'results' : ''}`}
            aria-busy={busy}
          >
            {result ? (
              <>
                <div className="section-label">
                  <Compass size={16} />
                  {result.mode === 'semantic'
                    ? 'ANLAMSAL ARAMA'
                    : result.mode === 'ai'
                      ? 'AI ÖNERİLERİ'
                      : 'ARAMA SONUÇLARI'}
                </div>
                <div className="results-heading">
                  <h2 ref={resultHeading} tabIndex={-1}>
                    {result.recommendations.length
                      ? 'Bunlara bir bak.'
                      : 'Biraz daha geniş bakalım.'}
                  </h2>
                  <span>{result.recommendations.length} seçenek</span>
                </div>
                {result.notice && (
                  <p className="result-notice">{result.notice}</p>
                )}
                <div className="result-cards">
                  {result.recommendations.map((r) => (
                    <EventCard
                      key={r.event.id}
                      event={r.event}
                      reason={r.reason}
                    />
                  ))}
                </div>
                {!result.recommendations.length && (
                  <div className="empty-state">
                    <Compass size={35} />
                    <h3>Bu aramada eşleşme yok.</h3>
                    <p>
                      Tarih veya bütçe sınırını genişletmeyi deneyebilirsin.
                      Yalnızca son 72 saatte kontrol edilmiş gelecek etkinlikler
                      listelenir.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setFilters({ ...emptyFilters });
                        setMessage(
                          'Tarih ve bütçe sınırını kaldır, her kategoriden etkinlik bul.',
                        );
                        textarea.current?.focus();
                      }}
                    >
                      Aramayı genişlet
                    </Button>
                  </div>
                )}
                {result.recommendations.length > 0 && (
                  <Button
                    className="more-options"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      search('Aynı koşullarda başka etkinlikler bul.', true)
                    }
                  >
                    Başka seçenekler göster <ArrowUpRight size={14} />
                  </Button>
                )}
              </>
            ) : (
              <>
                <div className="section-label">
                  <Compass size={16} /> ŞEHİRDEN BİR NOT
                </div>
                <div className="city-photo">
                  <Image
                    unoptimized
                    width={1000}
                    height={700}
                    src="https://images.unsplash.com/photo-1524231757912-21f4fe3a7200?auto=format&fit=crop&w=1000&q=85"
                    alt="İstanbul’da Boğaz ve şehir manzarası"
                  />
                  <div className="photo-caption">
                    <span>41°00′ N · 28°58′ E</span>
                    <h2>
                      Aynı şehir.
                      <br />
                      Başka bir akşam.
                    </h2>
                  </div>
                </div>
                <p className="side-note">
                  Planın hazır olması gerekmiyor.
                  <br />
                  Bir yerden başlayalım.
                </p>
              </>
            )}
          </aside>
        </div>
        {!result && (
          <section className="browse">
            <div className="browse-heading">
              <div>
                <div className="eyebrow">İSTANBUL SEÇKİSİ</div>
                <h2>Şehirde yakında.</h2>
              </div>
              <span>
                {initialLoading
                  ? 'Etkinlikler yükleniyor…'
                  : `${total} güncel kaynak kaydı`}
              </span>
            </div>
            {initialLoading ? (
              <output className="list-loading">
                <LoaderCircle className="spin" />
                Güncel etkinlikler yükleniyor.
              </output>
            ) : events.length ? (
              <div className="browse-grid">
                {events.slice(0, 6).map((event) => (
                  <EventCard key={event.id} event={event} compact />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <p>
                  Şu anda doğrulanmış güncel etkinlik bulunmuyor. Kaynak veriler
                  yenilendiğinde burada görünecek.
                </p>
                <Button variant="outline" onClick={loadEvents}>
                  Yeniden yükle
                </Button>
              </div>
            )}
            <p className="coverage-note">
              <ExternalLink size={12} /> Bu ilk seçki tüm İstanbul
              etkinliklerini kapsamaz. Kaynakta değişen fiyatlar ve seanslar
              güncelleme sırasında yenilenir.
            </p>
          </section>
        )}
      </main>
      <footer>
        <span>İSTANBUL’U YENİDEN KEŞFET.</span>
        <span>bi’ plan · ilk durak: İstanbul</span>
      </footer>
    </div>
  );
}
