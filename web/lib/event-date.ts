import type { EventRecord } from './types.ts';
import { sourceTimeIsDoorsOnly } from '../../contracts/timing.ts';

const day = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long', year: 'numeric',
});
const session = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long', weekday: 'short',
  hour: '2-digit', minute: '2-digit',
});

export function eventDateLabel(event: Pick<EventRecord, 'startsAt' | 'attendanceTiming' | 'description' | 'category'>): string {
  const timing = event.attendanceTiming;
  if (timing?.kind === 'admission_window')
    return `${day.format(new Date(timing.validFrom))} – ${day.format(new Date(timing.validThrough))} · Ziyaret saatlerini kontrol edin`;
  if (sourceTimeIsDoorsOnly(event.description))
    return `${session.format(new Date(event.startsAt))} · Kapı açılışı · Etkinlik başlangıcını kontrol edin`;
  if (timing?.kind === 'unknown')
    return `${day.format(new Date(event.startsAt))} · ${['Müze', 'Sergi'].includes(event.category) ? 'Ziyaret saatini' : 'Etkinlik saatini'} kontrol edin`;
  return session.format(new Date(event.startsAt));
}
