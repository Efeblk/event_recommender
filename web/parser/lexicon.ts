/**
 * Recall-oriented vocabulary. Entries only PROPOSE mentions; they never decide
 * polarity, strength, scope or edits. Keys are folded (lowercase, no diacritics).
 */
import type { Category } from './contract.ts';

/** Length-preserving fold so offsets in folded text equal original offsets. */
export function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    let c = ch === 'İ' ? 'i' : ch === 'I' ? 'ı' : ch.toLocaleLowerCase('tr-TR');
    c = c.normalize('NFD').replace(/\p{M}/gu, '');
    if (c === 'ı') c = 'i';
    if (c === '’' || c === '`') c = "'";
    if (c.length !== ch.length) c = c.length > ch.length ? c.slice(0, ch.length) : c.padEnd(ch.length, ' ');
    out += c;
  }
  return out;
}

export const CATEGORY_TERMS: Record<Category, string[]> = {
  concert: ['konser', 'concert', 'concerts', 'gig', 'canli muzik', 'live music', 'dinleti', 'resital', 'recital'],
  theatre: ['tiyatro', 'theatre', 'theater', 'theatrical', 'oyun', 'play', 'plays', 'piyes'],
  standup: ['stand-up', 'standup', 'stand up', 'stand-upci', 'standap', 'stendap', 'stand ap', 'komedyen', 'comedian'],
  workshop: ['atolye', 'workshop', 'workshops', 'uygulamali'],
  exhibition: ['sergi', 'exhibition', 'exhibit', 'exhibitions', 'galeri', 'gallery'],
  festival: ['festival', 'fest', 'senlik'],
  sport: ['spor', 'sports', 'sport', 'mac', 'match', 'game'],
  cinema: ['sinema', 'cinema', 'film', 'movie', 'movies', 'gosterim', 'screening'],
  talk: ['soylesi', 'talk', 'talks', 'panel', 'seminer', 'seminar', 'konferans', 'conference', 'lecture', 'konusma'],
  dance: ['dans', 'dance', 'bale', 'ballet', 'dancing'],
  show: ['gosteri', 'show', 'shows', 'performans', 'performance'],
  course: ['kurs', 'course', 'courses', 'ders', 'class', 'classes', 'egitim', 'training'],
  tour: ['tur', 'tour', 'tours', 'gezi', 'walk', 'yuruyus'],
  museum: ['muze', 'museum', 'museums'],
};

/** Canonical topic slug -> surface terms. Unknown topics may come from GLiNER. */
export const TOPIC_TERMS: Record<string, string[]> = {
  jazz: ['caz', 'jazz'],
  blues: ['blues'],
  rock: ['rock'],
  classical: ['klasik muzik', 'classical music', 'classical'],
  electronic: ['elektronik muzik', 'electronic music', 'elektronik', 'electronic', 'techno', 'tekno'],
  rap: ['rap', 'hip-hop', 'hip hop'],
  pop: ['pop'],
  folk: ['turku', 'halk muzigi', 'folk'],
  photography: ['fotografcilik', 'fotograf', 'photography', 'photo'],
  history: ['tarih', 'tarihi', 'history', 'historical'],
  ceramics: ['seramik', 'ceramics', 'ceramic', 'comlek', 'pottery'],
  gardening: ['bahcecilik', 'bahce', 'gardening', 'garden'],
  painting: ['resim', 'painting', 'tablo'],
  sculpture: ['heykel', 'sculpture'],
  literature: ['edebiyat', 'literature', 'kitap', 'book', 'books'],
  poetry: ['siir', 'poetry', 'poem'],
  science: ['bilim', 'science'],
  technology: ['teknoloji', 'technology', 'tech'],
  architecture: ['mimari', 'mimarlik', 'architecture'],
  cooking: ['yemek yapimi', 'yemek atolyesi', 'mutfak', 'cooking', 'cookery', 'gastronomi', 'gastronomy'],
  wine: ['sarap', 'wine'],
  coffee: ['kahve', 'coffee'],
  design: ['tasarim', 'design'],
  opera: ['opera'],
  musical: ['muzikal', 'muzikali', 'musical', 'musicals'],
  improv: ['dogaclama', 'improv', 'improvisation'],
  magic: ['sihirbazlik', 'illuzyon', 'magic'],
  philosophy: ['felsefe', 'philosophy'],
  astronomy: ['astronomi', 'astronomy'],
};

export const EXPERIENCE_TERMS: Record<string, string[]> = {
  quiet: ['sessiz', 'sakin ortam', 'quiet', 'silent', 'gurultu', 'gurultulu', 'gurultusuz', 'gurultucu', 'noise', 'noisy', 'loud', 'loudness'],
  seated: ['oturmali', 'oturma duzeni', 'oturma yeri', 'oturarak', 'sitting', 'oturacak yer', 'koltuklu', 'seated', 'seating', 'seat', 'ayakta', 'ayakta durma', 'standing', 'standing room'],
  outdoors: ['acik hava', 'acik havada', 'disarida', 'outdoor', 'outdoors', 'open-air', 'open air'],
  wheelchair_accessible: ['tekerlekli sandalye', 'engelli erisimi', 'engelli dostu', 'erisilebilir', 'basamaksiz', 'wheelchair', 'accessible', 'accessibility', 'step-free', 'step free'],
  family_friendly: ['aile dostu', 'ailece izlenebilir', 'aileye uygun', 'ailelere uygun', 'family-friendly', 'family friendly', 'suitable for families'],
  uncrowded: ['kalabalik', 'kalabaliksiz', 'asiri kalabalik', 'crowded', 'overcrowded', 'uncrowded', 'crowd', 'crowds', 'tenha'],
  romantic: ['romantik', 'romantic'],
  beginner_friendly: ['yeni baslayan', 'yeni baslayanlar', 'baslangic seviyesi', 'baslangic', 'acemi', 'deneyimsiz', 'beginner', 'beginners', 'beginner-friendly', 'no experience'],
};

export const CONTENT_TERMS: Record<string, string[]> = {
  profanity: ['kufur', 'kufurlu', 'kufursuz', 'argo', 'profanity', 'profane', 'swearing', 'swear', 'cursing', 'bad language', 'explicit language'],
  sexual_content: ['cinsel icerik', 'cinsellik', 'mustehcen', 'sexual content', 'sexual', 'nudity', 'ciplaklik'],
};

/** Outing preferences, distinct from guarantees about noise or venue policy. */
export const MOOD_TERMS: Record<'calm' | 'intimate', string[]> = {
  calm: ['sakin', 'calm', 'relaxing', 'relaxed', 'dinlendirici', 'huzurlu', 'dingin'],
  intimate: ['samimi', 'intimate'],
};

export const COMPANION_TERMS: Record<string, string[]> = {
  partner: ['sevgili', 'sevgilim', 'kiz arkadas', 'kiz arkadasimla', 'erkek arkadas', 'erkek arkadasimla', 'esim', 'es ile', 'esimle', 'partner', 'partnerim', 'girlfriend', 'boyfriend', 'wife', 'husband', 'spouse', 'date'],
  friends: ['arkadas', 'arkadaslar', 'arkadaslarla', 'arkadaslarimla', 'friends', 'friend', 'buddies'],
  family: ['aile', 'ailece', 'ailemle', 'family'],
  children: ['cocuk', 'cocuklar', 'cocuklarla', 'cocugum', 'cocuklarim', 'children', 'child', 'kids', 'kid', 'ogul', 'oglum', 'kizim', 'son', 'daughter'],
};

export const DISTRICTS = ['Adalar', 'Arnavutköy', 'Ataşehir', 'Avcılar', 'Bağcılar', 'Bahçelievler', 'Bakırköy',
  'Başakşehir', 'Bayrampaşa', 'Beşiktaş', 'Beykoz', 'Beylikdüzü', 'Beyoğlu', 'Büyükçekmece', 'Çatalca', 'Çekmeköy',
  'Esenler', 'Esenyurt', 'Eyüpsultan', 'Fatih', 'Gaziosmanpaşa', 'Güngören', 'Kadıköy', 'Kağıthane', 'Kartal',
  'Küçükçekmece', 'Maltepe', 'Pendik', 'Sancaktepe', 'Sarıyer', 'Silivri', 'Sultanbeyli', 'Sultangazi', 'Şile',
  'Şişli', 'Tuzla', 'Ümraniye', 'Üsküdar', 'Zeytinburnu'];

export const NEIGHBORHOODS = ['Moda', 'Taksim', 'Karaköy', 'Galata', 'Cihangir', 'Nişantaşı', 'Bebek', 'Ortaköy',
  'Etiler', 'Levent', 'Maslak', 'Bomonti', 'Harbiye', 'Mecidiyeköy', 'Kurtuluş', 'Feriköy', 'Tophane', 'Balat',
  'Fener', 'Sultanahmet', 'Eminönü', 'Kuzguncuk', 'Çengelköy', 'Caddebostan', 'Suadiye', 'Bostancı', 'Fenerbahçe',
  'Göztepe', 'Erenköy', 'Yeldeğirmeni', 'Bağdat Caddesi', 'İstiklal', 'Cevahir', 'Kozyatağı', 'Florya', 'Yeşilköy',
  'Emirgan', 'Arnavutköy Köyü', 'Rumelihisarı', 'Anadoluhisarı', 'Kanlıca', 'Tarabya', 'Zorlu', 'Kalamış',
  'Acıbadem', 'Altunizade', 'Teşvikiye', 'Gayrettepe', 'Esentepe', 'Pera', 'Şişhane', 'Tünel', 'Kumkapı',
  'Cağaloğlu', 'Beyazıt', 'Vefa', 'Balmumcu', 'Dolapdere', 'Kasımpaşa', 'Hasköy', 'Sütlüce', 'Kemerburgaz'];

/** Locations that are recognisably outside Istanbul; a requirement here is unsupported. */
export const OUTSIDE_ISTANBUL = ['Ankara', 'İzmir', 'Izmir', 'Bursa', 'Antalya', 'Adana', 'Konya', 'Eskişehir',
  'Trabzon', 'Gaziantep', 'Kocaeli', 'İzmit', 'Sakarya', 'Tekirdağ', 'Edirne', 'Çanakkale', 'Bodrum', 'Muğla',
  'Fethiye', 'Kapadokya', 'Cappadocia', 'Mersin', 'Kayseri', 'Samsun', 'Diyarbakır', 'Mardin', 'Van', 'Erzurum',
  'Bolu', 'Yalova', 'Alaçatı', 'Çeşme', 'Marmaris', 'Kaş', 'Londra', 'London', 'Paris', 'Berlin', 'Roma', 'Rome',
  'New York', 'Amsterdam', 'Atina', 'Athens', 'Barselona', 'Barcelona', 'Viyana', 'Vienna', 'Madrid', 'Milano',
  'Milan', 'Prag', 'Prague', 'Budapeşte', 'Budapest', 'Dubai', 'Tokyo', 'Bakü', 'Baku', 'Sofya', 'Sofia'];

/** Istanbul sides: canonical name → folded surface pattern (inflected Turkish forms included). */
export const SIDES: Record<string, string> = {
  'Avrupa yakası': String.raw`avrupa[\s-]?yakas[a-z']{0,8}|european[\s-]side`,
  'Anadolu yakası': String.raw`anadolu[\s-]?yakas[a-z']{0,8}|(?:asian|anatolian)[\s-]side`,
};

export const NUMBER_WORDS: Record<string, number> = {
  bir: 1, iki: 2, uc: 3, dort: 4, bes: 5, alti: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10, yirmi: 20, otuz: 30,
  kirk: 40, elli: 50, altmis: 60, yetmis: 70, seksen: 80, doksan: 90, yuz: 100, bin: 1000,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000, couple: 2, pair: 2,
};

export const MONTHS: Record<string, number> = {
  ocak: 1, subat: 2, mart: 3, nisan: 4, mayis: 5, haziran: 6, temmuz: 7, agustos: 8, eylul: 9, ekim: 10, kasim: 11, aralik: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** 0 = Sunday, matching Date#getUTCDay. */
export const WEEKDAYS: Record<string, number> = {
  pazar: 0, pazartesi: 1, sali: 2, carsamba: 3, persembe: 4, cuma: 5, cumartesi: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

export const CURRENCIES: Record<string, 'TRY' | 'OTHER'> = {
  tl: 'TRY', lira: 'TRY', try: 'TRY', '₺': 'TRY', 'turk lirasi': 'TRY', 'turkish lira': 'TRY',
  dolar: 'OTHER', dollar: 'OTHER', dollars: 'OTHER', usd: 'OTHER', $: 'OTHER', euro: 'OTHER', euros: 'OTHER', eur: 'OTHER', '€': 'OTHER',
  sterlin: 'OTHER', pound: 'OTHER', pounds: 'OTHER', gbp: 'OTHER', '£': 'OTHER',
};
