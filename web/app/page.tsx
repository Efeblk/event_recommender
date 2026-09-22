'use client';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  CalendarDays,
  Check,
  Clock3,
  Compass,
  ExternalLink,
  LoaderCircle,
  MapPin,
  MessageCircle,
  RotateCcw,
  Sparkles,
  Ticket,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  emptyFilters,
  type EventRecord,
  type Filters,
  type Message,
  type SearchResult,
} from '@/lib/types';

type CatalogInfo = {
  status: 'ready' | 'stale' | 'empty';
  stored: number;
  eligible: number;
  lastCheckedAt: string | null;
  oldestCheckedAt: string | null;
  expiresAt: string | null;
};
type EventsResponse = {
  events: EventRecord[];
  total: number;
  checkedAt?: string;
  aiEnabled: boolean;
  catalog?: CatalogInfo;
};
type SearchAttempt = {
  query: string;
  filters: Filters;
  history: Message[];
  excludeIds: string[];
};
type RetryAction =
  | { kind: 'events' }
  | { kind: 'search'; attempt: SearchAttempt }
  | null;
type SiteConfig = { donationUrl: string | null };
const formatDate = (date: string) =>
  new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: 'numeric',
    month: 'long',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
const formatShortDate = (date: string) =>
  new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: 'numeric',
    month: 'short',
  }).format(new Date(date));
const formatMoney = (price: number) =>
  new Intl.NumberFormat('tr-TR', {
    style: 'currency',
    currency: 'TRY',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(price);
const sourceName = (source: EventRecord['source']) =>
  source === 'bubilet'
    ? 'Bubilet'
    : source === 'biletix'
      ? 'Biletix'
      : 'Biletinial';

function EventCard({ event, reason }: { event: EventRecord; reason?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <article className="event-card">
      <div className="event-poster">
        {event.imageUrl && !imageFailed ? (
          <Image
            unoptimized
            fill
            sizes="(max-width: 700px) 32vw, (max-width: 1100px) 25vw, 260px"
            src={event.imageUrl}
            alt={`${event.title} afişi`}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="poster-fallback" aria-hidden="true">
            <Ticket />
            <span>bi’ plan</span>
          </div>
        )}
        <span className="category-tag">{event.category}</span>
      </div>
      <div className="event-copy">
        <div className="event-date">
          <CalendarDays size={14} /> {formatDate(event.startsAt)}
        </div>
        <h3>{event.title}</h3>
        <p className="venue">
          <MapPin size={14} />
          <span>
            {event.venue}
            {event.district ? ` · ${event.district}` : ''}
          </span>
        </p>
        {reason && <p className="event-reason">{reason}</p>}
        <div className="event-actions">
          <div className="event-price">
            <span>
              {event.price === null
                ? 'Fiyat bilgisi yok'
                : event.price === 0
                  ? 'Ücretsiz'
                  : formatMoney(event.price)}
            </span>
            {event.price !== null && event.price > 0 && (
              <small>başlangıç</small>
            )}
          </div>
          <a href={event.url} target="_blank" rel="noopener noreferrer">
            {sourceName(event.source)}
            {event.source === 'biletinial' ? '’de' : '’te'} aç{' '}
            <ExternalLink size={14} />
          </a>
        </div>
      </div>
    </article>
  );
}

function LoadingCards() {
  return (
    <div className="events-grid" aria-label="Etkinlikler yükleniyor">
      {[0, 1, 2, 3, 4, 5].map((item) => (
        <div className="event-card event-skeleton" key={item}>
          <div className="event-poster" />
          <div className="event-copy">
            <i />
            <b />
            <i />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const [message, setMessage] = useState('');
  const [filters, setFilters] = useState<Filters>({ ...emptyFilters });
  const [history, setHistory] = useState<Message[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [catalog, setCatalog] = useState<CatalogInfo | null>(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryAction, setRetryAction] = useState<RetryAction>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [donationUrl, setDonationUrl] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const searchBusy = useRef(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const resultsRef = useRef<HTMLElement | null>(null);
  const hasFilters = Object.values(filters).some((value) => value !== null);
  const activeFilterCount = Object.values(filters).filter(
    (value) => value !== null,
  ).length;
  const catalogLabel = useMemo(() => {
    if (catalog?.status === 'stale') return 'Katalog yenilenmeyi bekliyor';
    if (catalog?.status === 'empty') return 'Katalog henüz hazır değil';
    if (catalog?.lastCheckedAt)
      return `Son kontrol ${formatShortDate(catalog.lastCheckedAt)}`;
    return total ? `${total} güncel kayıt` : 'Canlı etkinlik kataloğu';
  }, [catalog, total]);

  function applyEvents(data: EventsResponse) {
    setEvents(data.events);
    setTotal(data.total);
    setAiEnabled(data.aiEnabled);
    setCatalog(data.catalog ?? null);
  }
  async function loadEvents() {
    setInitialLoading(true);
    try {
      const response = await fetch('/api/events');
      if (!response.ok) throw new Error();
      applyEvents((await response.json()) as EventsResponse);
      setError('');
      setRetryAction(null);
    } catch {
      setError(
        'Etkinlikler şu an yüklenemedi. Bağlantını kontrol edip tekrar dene.',
      );
      setRetryAction({ kind: 'events' });
    } finally {
      setInitialLoading(false);
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/events', { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        applyEvents((await response.json()) as EventsResponse);
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof Error && reason.name === 'AbortError'))
          setError(
            'Etkinlikler şu an yüklenemedi. Birazdan tekrar deneyebilirsin.',
          );
        if (!(reason instanceof Error && reason.name === 'AbortError'))
          setRetryAction({ kind: 'events' });
      })
      .finally(() => setInitialLoading(false));
    return () => {
      abort.abort();
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/site', { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as SiteConfig;
        setDonationUrl(data.donationUrl);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, []);

  async function search(
    queryText = message,
    alternatives = false,
    retryAttempt?: SearchAttempt,
  ) {
    if (searchBusy.current) return;
    const query =
      retryAttempt?.query ??
      (queryText.trim() || 'Seçtiğim filtrelere göre etkinlik bul.');
    const requestFilters = retryAttempt?.filters ?? filters;
    const requestHistory = retryAttempt?.history ?? history.slice(-10);
    if (
      requestFilters.dateFrom &&
      requestFilters.dateTo &&
      requestFilters.dateFrom > requestFilters.dateTo
    ) {
      setError('Bitiş tarihi başlangıç tarihinden önce olamaz.');
      setRetryAction(null);
      return;
    }
    const excludeIds =
      retryAttempt?.excludeIds ??
      (alternatives
        ? [
            ...new Set([
              ...excluded,
              ...(result?.recommendations.map((item) => item.event.id) ?? []),
            ]),
          ].slice(-100)
        : []);
    const attempt: SearchAttempt = {
      query,
      filters: { ...requestFilters },
      history: [...requestHistory],
      excludeIds: [...excludeIds],
    };
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    searchBusy.current = true;
    setBusy(true);
    setError('');
    setRetryAction(null);
    try {
      const response = await fetch('/api/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({
          message: query,
          history: requestHistory,
          filters: requestFilters,
          excludeIds,
        }),
      });
      const data = (await response.json()) as SearchResult & { error?: string };
      if (!response.ok) throw new Error(data.error || 'Arama tamamlanamadı.');
      setResult(data);
      setFilters(data.filters);
      setHistory((previous) =>
        [
          ...previous,
          { role: 'user' as const, content: query },
          { role: 'assistant' as const, content: data.message },
        ].slice(-12),
      );
      setMessage('');
      setExcluded(excludeIds);
      requestAnimationFrame(() =>
        resultsRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        }),
      );
    } catch (reason) {
      if (reason instanceof Error && reason.name === 'AbortError') return;
      setError(
        reason instanceof Error
          ? reason.message
          : 'Bir sorun oluştu. Tekrar dene.',
      );
      setRetryAction({ kind: 'search', attempt });
    } finally {
      if (controller.current === abort) {
        searchBusy.current = false;
        setBusy(false);
      }
    }
  }

  function reset() {
    controller.current?.abort();
    setMessage('');
    setFilters({ ...emptyFilters });
    setHistory([]);
    setResult(null);
    setExcluded([]);
    setBusy(false);
    searchBusy.current = false;
    setError('');
    setRetryAction(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const displayedEvents = result
    ? result.recommendations.map((item) => item.event)
    : events;

  return (
    <div className="site-shell">
      <header className="site-header">
        <Link
          href="/"
          className="brand"
          onClick={reset}
          aria-label="Bi’ Plan ana sayfa"
        >
          bi’ plan<span>✳</span>
        </Link>
        <nav aria-label="Ana menü">
          <a href="#etkinlikler">Etkinlikler</a>
          <a href="#destek">Destek ol</a>
        </nav>
        <div className="header-city">
          <MapPin size={14} /> İstanbul
        </div>
      </header>
      <main>
        <section className="hero" id="plan" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="kicker">
              <span /> İstanbul’da bugün
            </p>
            <h1 id="hero-title">
              Bu akşam ne <em>yapsak?</em>
            </h1>
            <p className="hero-intro">
              Nasıl bir plan istediğini anlat; İstanbul’daki güncel etkinlikler
              arasından sana uygun seçenekleri bulalım.
            </p>
            <div className="catalog-status">
              <Check size={13} /> {catalogLabel}
            </div>
            <div className="chat-panel">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void search();
                }}
              >
                <label className="sr-only" htmlFor="plan-message">
                  Planını anlat
                </label>
                <Textarea
                  id="plan-message"
                  ref={textarea}
                  value={message}
                  maxLength={1200}
                  disabled={busy}
                  placeholder={
                    aiEnabled
                      ? 'Örn. Cumartesi iki kişilik, sakin ama sıkıcı olmayan bir akşam…'
                      : 'Örn. Cumartesi 1.000 TL altında canlı müzik…'
                  }
                  onChange={(e) => setMessage(e.target.value)}
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
                />
                <div className="chat-actions">
                  <span>
                    {aiEnabled
                      ? 'Mesajın öneri üretmek için AI sağlayıcısına gönderilir.'
                      : 'Şimdilik güncel katalogda arama yapar. AI desteği yakında.'}
                  </span>
                  <Button
                    type="submit"
                    size="icon"
                    disabled={busy}
                    aria-label="Planımı bul"
                  >
                    {busy ? <LoaderCircle className="spin" /> : <ArrowUp />}
                  </Button>
                </div>
              </form>
            </div>
            <div className="prompt-chips" aria-label="Örnek istekler">
              {[
                'Bu hafta sonu bir konser',
                'İki kişilik tiyatro akşamı',
                'Uygun fiyatlı stand-up',
              ].map((prompt) => (
                <button
                  type="button"
                  key={prompt}
                  disabled={busy}
                  onClick={() => void search(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
            {result && hasFilters && (
              <div className="active-filters" aria-label="Etkin filtreler">
                {filters.dateFrom && <span>{filters.dateFrom}</span>}
                {filters.dateTo && <span>{filters.dateTo}</span>}
                {filters.maxPrice !== null && (
                  <span>En fazla {formatMoney(filters.maxPrice)}</span>
                )}
                {filters.category && <span>{filters.category}</span>}
                <button type="button" onClick={reset}>
                  <X size={13} /> Temizle ({activeFilterCount})
                </button>
              </div>
            )}
            {history.length > 0 && (
              <div className="messages">
                {history.slice(-4).map((item, index) => (
                  <div
                    className={`message ${item.role}`}
                    key={`${item.role}-${index}`}
                  >
                    <span>{item.role === 'user' ? 'Sen' : 'Bi’ Plan'}</span>
                    <p>{item.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <Button
              variant="ghost"
              disabled={busy || initialLoading}
              onClick={() => {
                if (retryAction?.kind === 'search')
                  void search('', false, retryAction.attempt);
                else void loadEvents();
              }}
            >
              Yeniden dene
            </Button>
          </div>
        )}
        {catalog?.status === 'stale' && (
          <div className="catalog-warning">
            <Clock3 size={16} />
            <p>
              <strong>Etkinlik verilerinin yenilenmesi gerekiyor.</strong> Eski
              kayıtları sonuç gibi göstermiyoruz.
            </p>
          </div>
        )}

        <output className="sr-only">
          {busy
            ? 'Sana uygun etkinlikler aranıyor.'
            : result
              ? `${result.recommendations.length} etkinlik bulundu. ${result.message}`
              : ''}
        </output>
        <section className="events-section" id="etkinlikler" ref={resultsRef}>
          <div className="section-heading">
            <div>
              <p className="kicker">
                <Compass size={13} />{' '}
                {result ? 'Sana göre' : 'Yakında İstanbul’da'}
              </p>
              <h2>
                {result
                  ? result.recommendations.length
                    ? 'Bunlara bir bak.'
                    : 'Henüz bir eşleşme yok.'
                  : 'Şehirde ne var?'}
              </h2>
            </div>
            <span>
              {result
                ? `${result.recommendations.length} sonuç`
                : total
                  ? `${total} kayıt içinden seçki`
                  : catalogLabel}
            </span>
          </div>
          {result && (
            <div className="conversation-note">
              <div>
                <MessageCircle size={16} />
                <p>{result.message}</p>
              </div>
              {result.notice && <small>{result.notice}</small>}
            </div>
          )}
          {initialLoading ? (
            <LoadingCards />
          ) : displayedEvents.length ? (
            <div className="events-grid">
              {result
                ? result.recommendations.map((item) => (
                    <EventCard
                      key={item.event.id}
                      event={item.event}
                      reason={item.reason}
                    />
                  ))
                : events
                    .slice(0, 6)
                    .map((event) => <EventCard key={event.id} event={event} />)}
            </div>
          ) : (
            <div className="empty-state">
              <Compass size={34} />
              <h3>
                {catalog?.status === 'stale'
                  ? 'Etkinlik verileri yenilenmeli.'
                  : 'Bu koşullarda etkinlik bulamadık.'}
              </h3>
              <p>
                {catalog?.status === 'stale'
                  ? 'Eski etkinlikleri önermemek için sonuçları göstermiyoruz.'
                  : 'Tarihi veya bütçeyi biraz genişletip yeniden deneyebilirsin.'}
              </p>
              <Button variant="outline" onClick={reset}>
                Filtreleri kaldır
              </Button>
            </div>
          )}
          {result?.recommendations.length ? (
            <div className="result-tools">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void search('Aynı koşullarda başka etkinlikler bul.', true)
                }
              >
                {busy ? <LoaderCircle className="spin" /> : <RotateCcw />} Başka
                seçenekler
              </Button>
              <Button variant="ghost" onClick={reset}>
                Yeni arama
              </Button>
            </div>
          ) : null}
        </section>
        <aside
          className="ad-slot ad-wide"
          data-ad-slot="after-events"
          aria-label="Reklam alanı"
        >
          <span>Reklam alanı</span>
          <p>Bu alan reklamlar için ayrıldı.</p>
        </aside>
        <section className="donation-section" id="destek">
          <div>
            <p className="kicker">
              <Sparkles size={13} /> Bağımsız proje
            </p>
            <h2>Bi’ Plan’a destek ol.</h2>
            <p>
              Bu proje İstanbul’daki etkinlikleri daha kolay keşfedebilmek için
              bağımsız olarak geliştiriliyor.
            </p>
          </div>
          {donationUrl ? (
            <a
              className="donation-link"
              href={donationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Projeye destek ol <ExternalLink size={16} />
            </a>
          ) : (
            <span className="donation-pending">Destek bağlantısı yakında</span>
          )}
        </section>
        <aside
          className="ad-slot ad-compact"
          data-ad-slot="footer"
          aria-label="Reklam alanı"
        >
          <span>Reklam alanı</span>
        </aside>
      </main>
      <footer>
        <div className="brand">
          bi’ plan<span>✳</span>
        </div>
        <p>İstanbul’u yeniden keşfet.</p>
        <small>
          Fiyat ve uygunluk değişebilir. Son durumu etkinliğin bilet sayfasından
          kontrol et.
        </small>
      </footer>
    </div>
  );
}
