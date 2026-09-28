import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryForEvent, hasSupportedEventFormat } from '../lib/event-format.ts';
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
  assert.equal(hasSupportedEventFormat({...gala,category:'Gösteri'}),false);
  assert.equal(hasSupportedEventFormat({...gala,category:'Konser'}),true);
  assert.equal(categoryForEvent('Film Gösterimi','Harry Potter ve Ateş Kadehi In Concert','Film müziği canlı icra edilir.'),'Konser');

  assert.equal(categoryForEvent('Diğer','Çiftlik Macerası Tiyatro Oyunu','Çocuklar için sahneleniyor.'),'Tiyatro');
  assert.equal(categoryForEvent('Diğer','Çizmeli Kedi Çocuk Oyunu','Çocuklar için sahneleniyor.'),'Tiyatro');
  assert.equal(categoryForEvent('Diğer','Kutu Oyunu Etkinliği','Katılımcılar masa oyunu oynar.'),'Diğer');
  assert.equal(categoryForEvent('Diğer','Dostların Dilinden Muammer Karaca Tiyatrosu','Sanatçının yaşamı anlatılır.'),'Diğer');
});
