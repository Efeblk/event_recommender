import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryForEvent, hasSupportedEventFormat } from '../lib/event-format.ts';
import { categoryForEvent as contractCategoryForEvent } from '../../contracts/category.ts';
import { CATEGORIES, emptyFilters } from '../lib/types.ts';
import { isEligible } from '../lib/search.ts';

await test('all source formats can enter the eligible catalog, including unmapped formats', () => {
  const now=new Date('2026-09-28T12:00:00Z');
  for(const category of CATEGORIES){
    const event={id:category,title:'Program',description:'Etkinlik açıklaması',startsAt:'2026-10-01T12:00:00Z',checkedAt:now.toISOString(),venue:'Mekan',city:'İstanbul',district:'',address:'',price:1500,currency:'TRY',url:'https://www.biletix.com/etkinlik/X1/ISTANBUL/tr',imageUrl:'',category,availability:'available' as const};
    assert.equal(isEligible(event,{...emptyFilters,maxPrice:2000},now),true,category);
  }
  assert.equal(categoryForEvent('Yeni kaynak türü','Program',''), 'Diğer');
});

await test('atelier biography and venue wording do not relabel or quarantine a performance', () => {
  const biography = {
    title: 'Yaz Konseri',
    description: 'Sanatçı kendi atölyesinde uzun yıllar çalıştı. Bu canlı konser yeni albümünü sahneye taşıyor.',
  };
  assert.equal(categoryForEvent('Konser', biography.title, biography.description), 'Konser');
  assert.equal(hasSupportedEventFormat({ ...biography, category: 'Konser' }), true);
  const venue = {
    title: 'Caz Gecesi',
    description: 'Workshop Sahne adlı mekânda canlı konser gerçekleşecektir.',
  };
  assert.equal(categoryForEvent('Konser', venue.title, venue.description), 'Konser');
  assert.equal(hasSupportedEventFormat({ ...venue, category: 'Konser' }), true);
});

await test('workshops are reclassified on refresh, while mislabeled old concerts require refresh', () => {
  const workshop={title:'Seramik Atölyesi',description:'Bu atölyede katılımcılar kil ile üretir.'};
  assert.equal(categoryForEvent('Konser',workshop.title,workshop.description),'Workshop');
  assert.equal(hasSupportedEventFormat({...workshop,category:'Workshop'}),true);
  assert.equal(hasSupportedEventFormat({...workshop,category:'Konser'}),false);
  assert.equal(categoryForEvent('Tiyatro','Oyun','Tiyatro oyunu, bir yazarlık atölyesinin üretimidir.'),'Tiyatro');
});

await test('explicit concert and theatre titles override broad provider categories', () => {
  const gala={title:'Gala Konser - İstanbul DOB',description:'İstanbul Devlet Opera ve Balesi Gala Konser'};
  assert.equal(categoryForEvent('Gösteri',gala.title,gala.description),'Konser');
  assert.equal(categoryForEvent('Gösteri',gala.title,'Canlı konser İstanbul Devlet Opera ve Balesi tarafından sunulur.'),'Konser');
  assert.equal(hasSupportedEventFormat({...gala,category:'Gösteri'}),false);
  assert.equal(hasSupportedEventFormat({...gala,category:'Konser'}),true);
  assert.equal(categoryForEvent('Film Gösterimi','Harry Potter ve Ateş Kadehi In Concert','Film müziği canlı icra edilir.'),'Konser');

  assert.equal(categoryForEvent('Diğer','Çiftlik Macerası Tiyatro Oyunu','Çocuklar için sahneleniyor.'),'Tiyatro');
  assert.equal(categoryForEvent('Diğer','Çizmeli Kedi Çocuk Oyunu','Çocuklar için sahneleniyor.'),'Tiyatro');
  assert.equal(categoryForEvent('Diğer','Çizmeli Kedi Çocuk Oyunu','Tiyatro oyunu çocuklar için sahneleniyor.'),'Tiyatro');
  assert.equal(categoryForEvent('Diğer','Kutu Oyunu Etkinliği','Katılımcılar masa oyunu oynar.'),'Diğer');
  assert.equal(categoryForEvent('Diğer','Dostların Dilinden Muammer Karaca Tiyatrosu','Sanatçının yaşamı anlatılır.'),'Diğer');
});

await test('an explicitly described stand-up programme overrides provider theatre without absorbing plays about comedians', () => {
  const standup = {
    title: "Tuz Biber 6'lı",
    description:
      "Tuz Biber 6'lı Stand Up Gösterisi TuzBiber’in en iyi komedyenlerinin 15’er dakika sahne aldığı TuzBiber 6’lı şovu; JJ Pub Kanyon’da!",
  };
  for (const classify of [categoryForEvent, contractCategoryForEvent])
    assert.equal(classify('tiyatro', standup.title, standup.description), 'Stand-up');
  assert.equal(hasSupportedEventFormat({ ...standup, category: 'Stand-up' }), true);
  assert.equal(hasSupportedEventFormat({ ...standup, category: 'Tiyatro' }), false);

  const play = {
    title: 'Komedyenin Oyunu',
    description:
      'Stand up gösterisiyle tanınan komedyenin yazdığı bu tiyatro oyunu, iki kardeşin hikâyesini anlatır.',
  };
  for (const classify of [categoryForEvent, contractCategoryForEvent])
    assert.equal(classify('tiyatro', play.title, play.description), 'Tiyatro');
  assert.equal(hasSupportedEventFormat({ ...play, category: 'Tiyatro' }), true);
  for (const classify of [categoryForEvent, contractCategoryForEvent])
    assert.equal(
      classify(
        'tiyatro',
        "Bir Stand Up'çının Tiyatro Oyunu",
        'Bir komedyenin sahne dışındaki hayatını anlatan iki perdelik oyun.',
      ),
      'Tiyatro',
    );

  const englishHeader = {
    title: 'Canan Tuğaner - Korkacak Neyin Var',
    description:
      'Canan Tuğaner - Korkacak Neyin Var Stand-Up Show Hayat zaten yeterince ciddi. Canan Tuğaner ilişkilerden yola çıkarak sahnede.',
  };
  for (const classify of [categoryForEvent, contractCategoryForEvent])
    assert.equal(
      classify('tiyatro', englishHeader.title, englishHeader.description),
      'Stand-up',
    );
});

await test('an unmistakable guided multi-stop programme overrides a provider exhibition label', () => {
  const tour = {
    title: "Katedralde Noel Şarkıları ile İstanbul'da Noel",
    description: "Program boyunca farklı cemaatlere ait kiliseleri ziyaret edecek, yapıların tarihini Antonina'nın uzman rehberlerinden dinleyeceğiz. Tur boyunca özel araçla ulaşım sağlanır. Günün sonunda özel Noel Şarkıları Konseri'ne katılacağız.",
  };
  for (const classify of [categoryForEvent, contractCategoryForEvent])
    assert.equal(classify('Sergi', tour.title, tour.description), 'Gezi');
  assert.equal(hasSupportedEventFormat({ ...tour, category: 'Gezi' }), true);
  assert.equal(hasSupportedEventFormat({ ...tour, category: 'Sergi' }), false);

  const exhibition = {
    title: 'Kiliseler Fotoğraf Sergisi',
    description: 'Sergi, uzman rehber eşliğinde ziyaret edilebilir. Fotoğraflar farklı kiliseleri anlatır.',
  };
  for (const classify of [categoryForEvent, contractCategoryForEvent])
    assert.equal(classify('Sergi', exhibition.title, exhibition.description), 'Sergi');
  const concert = {
    title: 'Katedralde Noel Konseri',
    description: 'Profesyonel rehber Ayşe, farklı kiliseleri ziyaret ettiği çalışmalarından önce canlı konser verir.',
  };
  for (const classify of [categoryForEvent, contractCategoryForEvent])
    assert.equal(classify('Konser', concert.title, concert.description), 'Konser');
});
