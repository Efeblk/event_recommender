import type { Atom, Category } from './contract.ts';

export const normalize = (value: string): string => value
  .toLocaleLowerCase('tr-TR')
  .normalize('NFKC')
  .replace(/[’']/gu, '')
  .replace(/[ıİ]/gu, 'i')
  .replace(/[çÇ]/gu, 'c')
  .replace(/[ğĞ]/gu, 'g')
  .replace(/[öÖ]/gu, 'o')
  .replace(/[şŞ]/gu, 's')
  .replace(/[üÜ]/gu, 'u');

export const CATEGORIES = new Map<string, Category>([
  ['concert', 'concert'], ['concerts', 'concert'], ['konser', 'concert'], ['konserler', 'concert'],
  ['theatre', 'theatre'], ['theater', 'theatre'], ['tiyatro', 'theatre'],
  ['standup', 'standup'], ['stand-up', 'standup'], ['standup', 'standup'], ['komedi', 'standup'],
  ['workshop', 'workshop'], ['workshops', 'workshop'], ['atolye', 'workshop'],
  ['exhibition', 'exhibition'], ['sergi', 'exhibition'],
  ['festival', 'festival'], ['sport', 'sport'], ['sports', 'sport'], ['spor', 'sport'],
  ['cinema', 'cinema'], ['movie', 'cinema'], ['film', 'cinema'], ['sinema', 'cinema'],
  ['talk', 'talk'], ['talks', 'talk'], ['soylesi', 'talk'],
  ['dance', 'dance'], ['dans', 'dance'], ['show', 'show'], ['gosteri', 'show'],
  ['course', 'course'], ['kurs', 'course'], ['tour', 'tour'], ['tur', 'tour'],
  ['museum', 'museum'], ['muze', 'museum'],
]);

export const TOPICS = new Map<string, string>([
  ['photography', 'photography'], ['fotograf', 'photography'], ['fotografcilik', 'photography'],
  ['ceramics', 'ceramics'], ['ceramic', 'ceramics'], ['seramik', 'ceramics'],
  ['jazz', 'jazz'], ['caz', 'jazz'],
  ['gardening', 'gardening'], ['bahcecilik', 'gardening'],
  ['history', 'history'], ['tarih', 'history'],
  ['classical', 'classical'], ['klasik', 'classical'],
]);

export const EXPERIENCES = new Map<string, Atom['kind'] extends never ? never : Extract<Atom, { kind: 'experience' }>['value']>([
  ['quiet', 'quiet'], ['sessiz', 'quiet'], ['sakin', 'quiet'],
  ['seated', 'seated'], ['oturarak', 'seated'], ['oturmali', 'seated'],
  ['outdoors', 'outdoors'], ['outdoor', 'outdoors'], ['acikhava', 'outdoors'],
  ['wheelchair-accessible', 'wheelchair_accessible'], ['accessible', 'wheelchair_accessible'], ['engelsiz', 'wheelchair_accessible'],
  ['family-friendly', 'family_friendly'], ['aileuygun', 'family_friendly'],
  ['uncrowded', 'uncrowded'], ['kalabalikolmayan', 'uncrowded'],
  ['romantic', 'romantic'], ['romantik', 'romantic'],
  ['beginner-friendly', 'beginner_friendly'], ['başlangıçuygun', 'beginner_friendly'], ['baslangicuygun', 'beginner_friendly'],
]);

export const LOCATIONS = new Map<string, { name: string; precision: 'district' | 'neighborhood' }>([
  ['kadikoy', { name: 'Kadıköy', precision: 'district' }],
  ['besiktas', { name: 'Beşiktaş', precision: 'district' }],
  ['sisli', { name: 'Şişli', precision: 'district' }],
  ['uskudar', { name: 'Üsküdar', precision: 'district' }],
  ['beyoglu', { name: 'Beyoğlu', precision: 'district' }],
  ['bakirkoy', { name: 'Bakırköy', precision: 'district' }],
  ['fatih', { name: 'Fatih', precision: 'district' }],
  ['sariyer', { name: 'Sarıyer', precision: 'district' }],
  ['atasehir', { name: 'Ataşehir', precision: 'district' }],
  ['maltepe', { name: 'Maltepe', precision: 'district' }],
  ['taksim', { name: 'Taksim', precision: 'neighborhood' }],
  ['moda', { name: 'Moda', precision: 'neighborhood' }],
  ['cihangir', { name: 'Cihangir', precision: 'neighborhood' }],
  ['nisantasi', { name: 'Nişantaşı', precision: 'neighborhood' }],
]);

export const COMPANIONS = new Map<string, Extract<Atom, { kind: 'companion' }>['value']>([
  ['partner', 'partner'], ['girlfriend', 'partner'], ['boyfriend', 'partner'], ['spouse', 'partner'],
  ['sevgilimle', 'partner'], ['sevgili', 'partner'], ['kizarkadasimla', 'partner'], ['erkekarkadasimla', 'partner'], ['esimle', 'partner'],
  ['friends', 'friends'], ['friend', 'friends'], ['arkadaslarimla', 'friends'], ['arkadasimla', 'friends'],
  ['family', 'family'], ['ailemle', 'family'], ['children', 'children'], ['kids', 'children'], ['cocuklarla', 'children'],
]);

export const NUMBER_WORDS = new Map<string, number>([
  ['one', 1], ['bir', 1], ['two', 2], ['iki', 2], ['three', 3], ['uc', 3], ['four', 4], ['dort', 4],
  ['five', 5], ['bes', 5], ['six', 6], ['alti', 6], ['seven', 7], ['yedi', 7], ['eight', 8], ['sekiz', 8],
]);

export const DISCOURSE = new Set([
  'i', 'we', 'want', 'would', 'like', 'looking', 'for', 'find', 'show', 'me', 'us', 'please', 'something', 'event', 'events',
  'an', 'a', 'the', 'that', 'which', 'is', 'are', 'be', 'can', 'could', 'with', 'my', 'our', 'in', 'at', 'on', 'of', 'to',
  'istiyorum', 'isterim', 'ariyorum', 'bul', 'bulurmusun', 'lutfen', 'bir', 'etkinlik', 'etkinlikler', 'olsun', 'olan', 'ile',
  'icin', 'bana', 'bize', 'ben', 'biz', 'benim', 'bizim', 'da', 'de', 'ki', 've', 'or', 'and', 'veya', 'ya', 'either',
]);

export const STRUCTURAL = new Set([
  'not', 'no', 'dont', 'without', 'except', 'excluding', 'excluded', 'exclude', 'outside', 'degil', 'olmasin', 'istemiyorum', 'istemem', 'haric', 'disinda', 'disi',
  'optional', 'optionally', 'maybe', 'prefer', 'preferably', 'preferred', 'olabilir', 'tercihen', 'tercih', 'mumkunse',
  'must', 'required', 'need', 'mutlaka', 'sart', 'en', 'most', 'maximum', 'max', 'maksimum', 'maks', 'minimum', 'min',
  'under', 'below', 'less', 'over', 'above', 'more', 'than', 'atleast', 'atmost', 'altinda', 'alti', 'uzeri', 'ustunde',
  'yaklasik', 'around', 'about', 'roughly', 'per', 'person', 'ticket', 'each', 'kisi', 'basi', 'bilet', 'toplam', 'total', 'group',
  'try', 'tl', 'lira', 'between', 'from', 'until', 'before', 'after', 'once', 'onceki', 'instead', 'but', 'ama', 'yerine',
  'cancel', 'remove', 'delete', 'iptal', 'kaldir', 'reset', 'start', 'over', 'forget', 'everything', 'sifirla', 'bastan', 'basla', 'her', 'seyi', 'new', 'yeni',
  'soonest', 'earliest', 'nearest', 'closest', 'cheapest', 'yakin', 'ucuz', 'erken', 'tarih', 'date',
  'people', 'persons', 'people', 'kisiyiz', 'kisi', 'only', 'sadece', 'between', 'arası', 'arasi', 'evening', 'morning',
  'afternoon', 'night', 'aksam', 'sabah', 'ogle', 'gece', 'today', 'tomorrow', 'tonight', 'bugun', 'yarin', 'bu',
  'next', 'gelecek', 'week', 'hafta', 'weekend', 'haftasonu', 'cumartesi', 'pazar', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'pazartesi', 'sali', 'carsamba', 'persembe', 'cuma',
  'topic', 'about', 'konulu', 'hakkinda', 'activity', 'aktivite', 'venue', 'district', 'neighborhood', 'semt', 'ilce',
]);
