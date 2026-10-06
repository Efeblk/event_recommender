// Realistic first-turn requests, written after the field reader and never used
// to tune it. Reference date: 2026-10-06 (Tuesday). Each case lists the exact
// required (hard) conditions; extra hard conditions are over-inference and fail.
// `prefer` lists preferences that must also appear; other preferences are ignored.
const atom = (a) => ({ type: 'atom', atom: a });
const date = (from, to = from) => atom({ kind: 'date', from, to });
const district = (name) => atom({ kind: 'location', name, precision: 'district' });
const hood = (name) => atom({ kind: 'location', name, precision: 'neighborhood' });
const side = (name) => atom({ kind: 'location', name, precision: 'side' });
const cat = (value) => atom({ kind: 'category', value });
const topic = (value) => atom({ kind: 'topic', value });
const party = (count) => atom({ kind: 'party', count });
const comp = (value) => atom({ kind: 'companion', value });
const exp = (value) => atom({ kind: 'experience', value });
const budget = (comparison, amount, basis) => atom({ kind: 'budget', comparison, amount, currency: 'TRY', basis });
const time = (t) => atom({ kind: 'time', ...t });
const any = (...children) => ({ type: 'any', children });
const not = (child) => ({ type: 'not', child });
const evening = time({ from: '18:00', to: '23:59' });
const afternoon = time({ from: '12:00', to: '17:59' });

export const referenceDate = '2026-10-06';
export const cases = [
  { id: 'r01', text: 'yarın akşam kadıköyde bi konser var mı', hard: [date('2026-10-07'), evening, district('Kadıköy'), cat('concert')] },
  { id: 'r02', text: "cumartesi sevgilimle tiyatroya gitmek istiyoruz, kişi başı 500 tl'yi geçmesin", hard: [date('2026-10-10'), comp('partner'), cat('theatre'), budget('lte', 500, 'per_person')] },
  { id: 'r03', text: 'bu hafta sonu çocuklar için bir etkinlik, beşiktaş veya şişli', hard: [date('2026-10-10', '2026-10-11'), comp('children'), any(district('Beşiktaş'), district('Şişli'))] },
  { id: 'r04', text: '3 gün sonra stand up', hard: [date('2026-10-09'), cat('standup')] },
  { id: 'r05', text: 'önümüzdeki hafta caz', hard: [date('2026-10-12', '2026-10-18'), topic('jazz')] },
  { id: 'r06', text: '16 ekim cuma bostancı civarı', hard: [date('2026-10-16'), district('Kadıköy')], prefer: [hood('Bostancı')] },
  { id: 'r07', text: 'ucuz bir şeyler arıyorum bu akşam, max 200 lira', hard: [date('2026-10-06'), evening, budget('lte', 200, 'per_ticket')] },
  { id: 'r08', text: 'arkadaşlarla 5 kişiyiz, cuma gecesi bi yerlere gidelim ama konser olmasın', hard: [date('2026-10-09'), evening, party(5), comp('friends'), not(cat('concert'))] },
  { id: 'r09', text: 'anadolu yakasında ücretsiz sergi', hard: [side('Anadolu yakası'), cat('exhibition'), budget('lte', 0, 'per_person')] },
  { id: 'r10', text: 'iki hafta içinde müze', hard: [date('2026-10-06', '2026-10-20'), cat('museum')] },
  { id: 'r11', text: "galatada akşam 9'dan sonra başlayan bir şey", hard: [district('Beyoğlu'), time({ from: '21:00', fromExclusive: true })], prefer: [hood('Galata')] },
  { id: 'r12', text: 'moda sahilinde açık hava etkinliği', hard: [district('Kadıköy'), exp('outdoors')], prefer: [hood('Moda')] },
  { id: 'r13', text: 'bugün 18:00 ile 20:00 arası başlayan bir atölye', hard: [date('2026-10-06'), time({ from: '18:00', to: '20:00' }), cat('workshop')] },
  { id: 'r14', text: 'ankarada tiyatro', status: 'unsupported' },
  { id: 'r15', text: 'puanı yüksek olan stand up gösterileri', status: 'unsupported' },
  { id: 'r16', text: 'perşembe veya cuma rock konseri', hard: [any(date('2026-10-08'), date('2026-10-09')), topic('rock'), cat('concert')] },
  { id: 'r17', text: 'kız arkadaşımla film izlemek istiyoruz yarın', hard: [date('2026-10-07'), comp('partner'), cat('cinema')] },
  { id: 'r18', text: "ayın 20'sinde bale", hard: [date('2026-10-20'), cat('dance')] },
  { id: 'r19', text: 'kasım başında bir söyleşi', hard: [date('2026-11-01', '2026-11-10'), cat('talk')] },
  { id: 'r20', text: '4 kişilik aile, 2 çocuk, pazar günü, toplam bütçe 2000', hard: [date('2026-10-11'), party(4), comp('family'), comp('children'), budget('lte', 2000, 'group_total')], allowMissing: ['companion'] },
  { id: 'r21', text: 'tek başıma gidebileceğim sakin bir şey, yarından sonra', hard: [date('2026-10-08'), party(1)] },
  { id: 'r22', text: 'beyoğlunda bu cuma ve cumartesi standup', hard: [any(date('2026-10-09'), date('2026-10-10')), district('Beyoğlu'), cat('standup')] },
  { id: 'r23', text: 'bu ay en ucuz konserler', hard: [date('2026-10-06', '2026-10-31'), cat('concert')], order: 'cheapest' },
  { id: 'r24', text: 'çarşamba akşamı kadıköy veya üsküdarda caz konseri 300-600 tl arası', hard: [date('2026-10-07'), evening, any(district('Kadıköy'), district('Üsküdar')), topic('jazz'), cat('concert'), budget('gte', 300, 'per_ticket'), budget('lte', 600, 'per_ticket')] },
  { id: 'r25', text: 'Things to do in Karaköy this weekend under 400 TL per person', hard: [date('2026-10-10', '2026-10-11'), district('Beyoğlu'), budget('lt', 400, 'per_person')], prefer: [hood('Karaköy')] },
  { id: 'r26', text: 'a classical music concert tomorrow evening', hard: [date('2026-10-07'), evening, topic('classical'), cat('concert')] },
  { id: 'r27', text: '5 gün sonra ataşehirde çocuk tiyatrosu', hard: [date('2026-10-11'), district('Ataşehir'), cat('theatre')], allowExtra: ['companion', 'experience', 'age'] },
  { id: 'r28', text: 'fenerbahçe maçı', hard: [cat('sport')], allowExtra: ['topic'] },
  { id: 'r29', text: 'bugün öğleden sonra sultanahmet civarı müze', hard: [date('2026-10-06'), afternoon, district('Fatih'), cat('museum')], prefer: [hood('Sultanahmet')] },
  { id: 'r30', text: 'salı günü beşiktaşta seramik atölyesi', hard: [date('2026-10-06'), district('Beşiktaş'), topic('ceramics'), cat('workshop')] },
  { id: 'r31', text: 'with my parents next week, a classical concert in Nişantaşı', hard: [date('2026-10-12', '2026-10-18'), comp('family'), topic('classical'), cat('concert'), district('Şişli')], prefer: [hood('Nişantaşı')] },
  { id: 'r32', text: 'yarin taksimde konser', hard: [date('2026-10-07'), district('Beyoğlu'), cat('concert')], prefer: [hood('Taksim')] },
  { id: 'r33', text: 'stendap izlemek istiyorum hafta sonu', hard: [date('2026-10-10', '2026-10-11'), cat('standup')] },
  { id: 'r34', text: '50 dolardan ucuz bir konser', status: 'unsupported' },
  { id: 'r35', text: 'cocuklarla gidilecek ucretsiz bir sey bu pazar', hard: [date('2026-10-11'), comp('children'), budget('lte', 0, 'per_person')] },
  { id: 'r36', text: 'sevgilimle 4 gün sonra kadıköyde bir yerlere gitmek istiyoruz 1000 tl toplam bütçe', hard: [date('2026-10-10'), comp('partner'), district('Kadıköy'), budget('lte', 1000, 'group_total')] },
  { id: 'r37', text: 'otoparkı olan bir mekanda tiyatro', status: 'unsupported' },
  { id: 'r38', text: 'pazartesi akşamı opera', hard: [date('2026-10-12'), evening, topic('opera')], allowExtra: ['category'] },
  { id: 'r39', text: 'yarın ya da öbür gün sarıyerde doğa yürüyüşü', hard: [any(date('2026-10-07'), date('2026-10-08')), district('Sarıyer'), cat('tour')], allowExtra: ['experience', 'topic'] },
  { id: 'r40', text: 'ekim sonunda üç kişilik bir fotoğraf atölyesi', hard: [date('2026-10-21', '2026-10-31'), party(3), topic('photography'), cat('workshop')] },
];
