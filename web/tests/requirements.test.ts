import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRequirements,
  deriveRequirements,
  meetsRequirements,
} from '../lib/requirements.ts';
import type { EventRecord, Message } from '../lib/types.ts';

function event(description: string, title = 'Etkinlik'): EventRecord {
  return {
    id: 'e',
    title,
    description,
    category: 'Konser',
    startsAt: '2026-09-26T18:00:00Z',
    checkedAt: '2026-09-23',
    venue: 'Sahne',
    city: 'İstanbul',
    district: '',
    address: '',
    price: 200,
    currency: 'TRY',
    url: 'https://example.test',
    imageUrl: '',
    availability: 'available',
  };
}

await test('requested jazz needs actual jazz source evidence', () => {
  const requirements = deriveRequirements('Only jazz, please', []);
  assert.deepEqual(requirements, [
    { kind: 'genre', value: 'jazz', policy: 'require_support' },
  ]);
  assert.equal(
    checkRequirements(event('A candlelight concert.'), requirements)[0].status,
    'unknown',
  );
  assert.equal(
    meetsRequirements(event('Caz ve blues parçaları.'), requirements),
    true,
  );
  assert.equal(
    checkRequirements(event('Bu bir caz konseri değildir.'), requirements)[0]
      .status,
    'contradicted',
  );
});

await test('same-kind follow-up replaces genre and explicit alternatives use OR', () => {
  const history: Message[] = [
    { role: 'user', content: 'Weekend stand-up' },
    { role: 'assistant', content: 'Anything else?' },
  ];
  const switched = deriveRequirements('Switch from stand-up to jazz', history);
  assert.deepEqual(
    switched.filter((item) => item.kind === 'genre'),
    [
      { kind: 'genre', value: 'jazz', policy: 'require_support' },
      {
        kind: 'genre',
        value: 'comedy',
        policy: 'exclude_positive_evidence',
      },
    ],
  );
  const alternatives = deriveRequirements('Jazz or blues is required', []);
  assert.equal(alternatives[0].value, 'jazz|blues');
  assert.equal(meetsRequirements(event('Blues gecesi.'), alternatives), true);
});

await test('a current positive genre removes the matching stale exclusion', () => {
  assert.deepEqual(
    deriveRequirements('Caz olsun', [
      { role: 'user', content: 'Caz istemiyorum' },
    ]),
    [{ kind: 'genre', value: 'jazz', policy: 'require_support' }],
  );
});

await test('a coordinated genre negation excludes every alternative', () => {
  assert.deepEqual(deriveRequirements('Rock veya jazz istemiyorum', []), [
    {
      kind: 'genre',
      value: 'jazz|rock',
      policy: 'exclude_positive_evidence',
    },
  ]);
});

await test('ordinary child exclusion rejects only positive child evidence', () => {
  const requirements = deriveRequirements('No concerts or children', []);
  assert.deepEqual(requirements, [
    {
      kind: 'audience',
      value: 'children',
      policy: 'exclude_positive_evidence',
    },
  ]);
  assert.equal(
    meetsRequirements(event('Çocuklar için aile dostu gösteri.'), requirements),
    false,
  );
  assert.equal(
    meetsRequirements(event('Yeni bir komedi gösterisi.'), requirements),
    true,
  );
});

await test('family-friendly requests require explicit suitability evidence', () => {
  const requirements = deriveRequirements(
    'Ailece izlenebilecek bir etkinlik istiyorum',
    [],
  );
  assert.deepEqual(requirements, [
    {
      kind: 'audience',
      value: 'family_friendly',
      policy: 'require_support',
    },
  ]);
  for (const description of [
    'Türk ahlak yapısına uygun, ailece keyifle izlenebilecek gösteri.',
    'Ailenizle, arkadaşlarınızla ya da tek başınıza katılabileceğiniz etkinlik.',
    'A family-friendly comedy suitable for the whole family.',
  ])
    assert.equal(meetsRequirements(event(description), requirements), true);
  assert.equal(
    checkRequirements(
      event('Aile meselelerini anlatan popüler bir komedi.'),
      requirements,
    )[0].status,
    'unknown',
  );
  assert.equal(
    checkRequirements(event('Yalnızca yetişkinlere özel.'), requirements)[0]
      .status,
    'contradicted',
  );
  for (const description of [
    'Family-friendly comedy. Adults only.',
    'Ailece keyifle izlenebilecek. 18+.',
    'Aileye uygun gösteri. Yaş sınırı: 18+ ',
  ])
    assert.equal(
      checkRequirements(event(description), requirements)[0].status,
      'contradicted',
      description,
    );
  assert.deepEqual(
    deriveRequirements('Annemle komediye gitmek istiyorum', []),
    [],
  );
  assert.deepEqual(
    deriveRequirements('Family-friendly olmasın, yetişkin gösterisi olsun', []),
    [],
  );
  assert.deepEqual(
    deriveRequirements('Family-friendly olmasın', [
      { role: 'user', content: 'Family-friendly comedy' },
    ]),
    [{ kind: 'genre', value: 'comedy', policy: 'require_support' }],
  );
});

await test('strict content constraints require exact positive absence evidence', () => {
  const requirements = deriveRequirements(
    'No swearing or sexual humour; omit uncertain matches',
    [],
  );
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].policy, 'require_support');
  assert.equal(
    meetsRequirements(
      event('Ailece izlenebilecek family-friendly comedy.'),
      requirements,
    ),
    false,
  );
  assert.equal(
    meetsRequirements(event('No swearing and no sexual humour.'), requirements),
    true,
  );
  assert.equal(
    checkRequirements(event('Includes sexual humour.'), requirements)[0].status,
    'contradicted',
  );
});

await test('Turkish coordinated content prohibitions and uncertainty policy are recognized', () => {
  const requirements = deriveRequirements(
    'Küfür ya da cinsel mizah olmasın; emin değilsen önerme',
    [],
  );
  assert.equal(requirements[0].value, 'swearing|sexual_content');
  assert.equal(requirements[0].policy, 'require_support');
});

await test('a bounded content waiver removes only the waived prohibition', () => {
  const requirements = deriveRequirements(
    'Küfür sorun değil ama cinsellik yine olmasın',
    [
      {
        role: 'user',
        content: 'Küfür ve cinsellik olmasın',
      },
    ],
  );
  assert.deepEqual(requirements, [
    {
      kind: 'content',
      value: 'sexual_content',
      policy: 'exclude_positive_evidence',
    },
  ]);
  assert.equal(
    meetsRequirements(
      event('Küfürlü fakat cinsellik içermeyen gösteri.'),
      requirements,
    ),
    true,
  );
  assert.equal(
    meetsRequirements(event('Cinsel mizah içeren gösteri.'), requirements),
    false,
  );
});

await test('a stated child age requires child suitability and explicit age coverage', () => {
  const requirements = deriveRequirements(
    '5 yaşındaki kızımla pazar günü bir etkinliğe gitmek istiyorum. İkimiz için toplam 1000 TL, çocuklara uygun olsun.',
    [],
  );
  assert.deepEqual(requirements, [
    {
      kind: 'audience',
      value: 'children',
      policy: 'require_support',
    },
    { kind: 'audience', value: 'age:5', policy: 'require_support' },
  ]);
  assert.deepEqual(deriveRequirements('5 yaşındaki kızımla gideceğim', []), [
    {
      kind: 'audience',
      value: 'children',
      policy: 'require_support',
    },
    { kind: 'audience', value: 'age:5', policy: 'require_support' },
  ]);

  assert.equal(
    meetsRequirements(
      event('Çocuklara uygun gösteri. 4-8 yaş için.'),
      requirements,
    ),
    true,
  );
  assert.equal(
    meetsRequirements(
      event('4–8 yaş çocuklar ve aileleri için kukla tiyatrosu.'),
      requirements,
    ),
    true,
  );
  assert.equal(
    meetsRequirements(
      event('Çocuklara uygun gösteri. 5 yaş ve üzeri.'),
      requirements,
    ),
    true,
  );
  assert.equal(
    meetsRequirements(event('Çocuklara uygun gösteri.'), requirements),
    false,
  );
  assert.equal(
    checkRequirements(event('Çocuklara uygun gösteri.'), requirements)[1]
      .status,
    'unknown',
  );
  assert.equal(
    meetsRequirements(
      event('Çocuklara uygun gösteri. 6 yaş ve üzeri.'),
      requirements,
    ),
    false,
  );
  assert.equal(
    meetsRequirements(event('Yetişkinlere özel stand-up. 18+.'), requirements),
    false,
  );
  assert.equal(
    meetsRequirements(
      event('Ailece izlenebilecek gösteri. 4-8 yaş.'),
      requirements,
    ),
    false,
  );
});

await test('age evidence ignores unrelated numbers and aggregates conflicting restrictions', () => {
  const requirements = deriveRequirements(
    '5 yaşındaki kızımla çocuklara uygun bir etkinlik istiyorum',
    [],
  );
  for (const description of [
    'Çocuklara uygun gösteri. Oyundaki karakter 5 yaşında.',
    'Çocuklara uygun atölye. Eğitmenin 5+ years experience geçmişi var.',
    'Çocuklara uygun gösteri. 5 yaş altı bilet ücretsizdir.',
    'Çocuklara uygun gösteri. Salon 500 kişilik, yapım yılı 2025.',
    'Çocuklara uygun gösteri. Toplam 20+ ödül kazandı.',
    'Çocuklara uygun festivalde 5+ gösteri var.',
    'Çocuklara uygun oyun, 4-8 yaş çocukların macerasını anlatıyor.',
  ]) {
    const checks = checkRequirements(event(description), requirements);
    assert.equal(checks[1].status, 'unknown', description);
  }
  const storyOnly = checkRequirements(
    event('4-8 yaş çocukların ve ailelerin macerasını anlatıyor.'),
    requirements,
  );
  assert.deepEqual(
    storyOnly.map((check) => check.status),
    ['unknown', 'unknown'],
  );

  assert.equal(
    checkRequirements(
      event('Çocuklara uygun. 4-8 yaş için önerilir. Yaş sınırı: 18+.'),
      requirements,
    )[1].status,
    'contradicted',
  );
  assert.equal(
    checkRequirements(
      event('Çocuklara uygun. 5 yaş için uygun değil.'),
      requirements,
    )[1].status,
    'contradicted',
  );
  assert.equal(
    checkRequirements(
      event('Çocuklara uygun. 4-8 yaş için uygun değildir.'),
      requirements,
    )[1].status,
    'contradicted',
  );
  assert.equal(
    checkRequirements(
      event('Çocuklara uygun. 6 yaş altı giremez.'),
      requirements,
    )[1].status,
    'contradicted',
  );
  assert.equal(
    checkRequirements(event('Çocuklara uygun. Yaş grubu 4-8.'), requirements)[1]
      .status,
    'supported',
  );
  assert.equal(
    checkRequirements(event('Çocuklara uygun. 18+.'), requirements)[1].status,
    'contradicted',
  );
});

await test('venue names do not prove genre and family-friendly does not mean a child event', () => {
  const jazz = deriveRequirements('Jazz istiyorum', []);
  assert.equal(
    meetsRequirements(
      { ...event('Stand-up gösterisi.', 'Comedy Night'), venue: 'Jazz Club' },
      jazz,
    ),
    false,
  );
  const noChildren = deriveRequirements('Çocuk etkinliği olmasın', []);
  assert.equal(
    meetsRequirements(event('Ailece izlenebilecek komedi.'), noChildren),
    true,
  );
});

await test('both accessibility facts must be explicitly supported', () => {
  const requirements = deriveRequirements(
    'Must have step-free entry and an accessible toilet',
    [],
  );
  assert.deepEqual(requirements, [
    {
      kind: 'accessibility',
      value: 'step_free|accessible_toilet',
      policy: 'require_support',
    },
  ]);
  assert.equal(
    meetsRequirements(event('Wheelchair accessible venue.'), requirements),
    false,
  );
  assert.equal(
    meetsRequirements(
      event('Wheelchair accessible venue with an accessible toilet.'),
      requirements,
    ),
    true,
  );
});

await test('Turkish accessibility inflection is retained as a required fact', () => {
  assert.deepEqual(
    deriveRequirements('Basamaksız giriş ve erişilebilir tuvaleti olmalı', []),
    [
      {
        kind: 'accessibility',
        value: 'step_free|accessible_toilet',
        policy: 'require_support',
      },
    ],
  );
});

await test('mood remains soft unless explicitly mandatory', () => {
  assert.deepEqual(
    deriveRequirements('I feel tired and want something quiet and seated', []),
    [],
  );
  assert.deepEqual(deriveRequirements('It must be quiet', []), [
    { kind: 'activity', value: 'quiet', policy: 'require_support' },
  ]);
  assert.deepEqual(deriveRequirements('Mutlaka sakin ve oturmalı olsun', []), [
    { kind: 'activity', value: 'quiet', policy: 'require_support' },
    { kind: 'activity', value: 'seated', policy: 'require_support' },
  ]);
});

await test('mandatory romance and crowd level require explicit source evidence', () => {
  const requirements = deriveRequirements(
    'Kesin romantik ve kalabalık olmayan bir yer istiyorum.',
    [],
  );
  assert.deepEqual(requirements, [
    { kind: 'activity', value: 'romantic', policy: 'require_support' },
    { kind: 'activity', value: 'uncrowded', policy: 'require_support' },
  ]);
  assert.equal(
    meetsRequirements(
      event('Romantik ve kalabalık olmayan bir akşam deneyimi.'),
      requirements,
    ),
    true,
  );
  assert.equal(
    meetsRequirements(
      event('Akustik gitar ve mum ışığında bir performans.'),
      requirements,
    ),
    false,
  );
  assert.deepEqual(
    checkRequirements(
      event('Akustik gitar ve mum ışığında bir performans.'),
      requirements,
    ).map((check) => check.status),
    ['unknown', 'unknown'],
  );

  const english = deriveRequirements('It must be romantic and uncrowded.', []);
  assert.deepEqual(english, requirements);
  assert.deepEqual(
    deriveRequirements('A guaranteed romantic place that is not crowded.', []),
    requirements,
  );
  assert.deepEqual(deriveRequirements('Romantik şart', []), [
    { kind: 'activity', value: 'romantic', policy: 'require_support' },
  ]);
  assert.deepEqual(deriveRequirements('Romantic atmosphere required', []), [
    { kind: 'activity', value: 'romantic', policy: 'require_support' },
  ]);
  assert.deepEqual(
    deriveRequirements('Partnerimle sakin, romantik bir akşam istiyorum', []),
    [],
  );
  assert.equal(
    checkRequirements(event('Ödüllü bir romantik komedi.'), requirements)[0]
      .status,
    'unknown',
  );
  assert.equal(
    checkRequirements(
      event('Romantik bir aşk hikâyesini anlatan oyun.'),
      requirements,
    )[0].status,
    'unknown',
  );
});

await test('explicit romance and crowd contradictions take priority', () => {
  const requirements = deriveRequirements(
    'Definitely romantic and uncrowded.',
    [],
  );
  assert.deepEqual(
    checkRequirements(
      event('Romantic atmosphere, but it is not romantic. Uncrowded.'),
      requirements,
    ).map((check) => check.status),
    ['contradicted', 'supported'],
  );
  assert.deepEqual(
    checkRequirements(
      event('Romantic atmosphere. Uncrowded earlier, but crowded now.'),
      requirements,
    ).map((check) => check.status),
    ['supported', 'contradicted'],
  );
});

await test('experience waivers remove only the scoped mandatory condition', () => {
  const history: Message[] = [
    {
      role: 'user',
      content: 'Kesin romantik ve kalabalık olmayan bir yer istiyorum.',
    },
  ];
  assert.deepEqual(deriveRequirements('Romantik olması şart değil', history), [
    { kind: 'activity', value: 'uncrowded', policy: 'require_support' },
  ]);
  assert.deepEqual(deriveRequirements('Uncrowded is not required', history), [
    { kind: 'activity', value: 'romantic', policy: 'require_support' },
  ]);
  assert.deepEqual(
    deriveRequirements(
      'Romantik olması şart değil, kalabalık da sorun değil. Kişi başı 900 TL olsun.',
      history,
    ),
    [],
  );
  assert.deepEqual(
    deriveRequirements('Romantic is not required, crowds are fine.', history),
    [],
  );
  assert.deepEqual(
    deriveRequirements(
      'Romantik olması şart değil ama kalabalık olmasın',
      history,
    ),
    [{ kind: 'activity', value: 'uncrowded', policy: 'require_support' }],
  );
});

await test('inflected source negation and contradictory genre titles cannot become evidence', () => {
  const noComedy = deriveRequirements('Komedi istemiyorum', []);
  assert.equal(
    meetsRequirements(event('Yetişkin tiyatrosu. Komedi değildir.'), noComedy),
    true,
  );
  const jazz = deriveRequirements('Caz istiyorum', []);
  assert.equal(
    meetsRequirements(
      event('Bu bir caz konseri değildir.', 'Jazz Night'),
      jazz,
    ),
    false,
  );
  const choice = deriveRequirements('Jazz or blues', []);
  assert.equal(
    meetsRequirements(
      event('Caz değildir. Blues konseri.', 'Jazz Night'),
      choice,
    ),
    true,
  );
});

await test('fresh coordinated English exclusion leaves only the requested classical genre', () => {
  assert.deepEqual(
    deriveRequirements(
      'No jazz or rock, please. A classical concert would help me unwind',
      [],
    ),
    [
      { kind: 'genre', value: 'classical', policy: 'require_support' },
      {
        kind: 'genre',
        value: 'jazz|rock',
        policy: 'exclude_positive_evidence',
      },
    ],
  );
  assert.equal(
    deriveRequirements('Rock olsun, jazz istemiyorum', [])[0].value,
    'rock',
  );
});

await test('dramatic requests require explicit drama evidence without matching dramaturgy', () => {
  const requirements = deriveRequirements(
    'Something dramatic, not comedy.',
    [],
  );
  assert.deepEqual(requirements, [
    { kind: 'genre', value: 'drama', policy: 'require_support' },
    {
      kind: 'genre',
      value: 'comedy',
      policy: 'exclude_positive_evidence',
    },
  ]);
  assert.equal(
    meetsRequirements(
      event('Yetişkinlere yönelik dramatik bir sahne oyunu.'),
      requirements,
    ),
    true,
  );
  assert.equal(
    meetsRequirements(
      event('Dramaturg söyleşisi ve komedi gösterisi.'),
      requirements,
    ),
    false,
  );
  assert.equal(
    checkRequirements(event('Bir dramaturg ile söyleşi.'), requirements)[0]
      .status,
    'unknown',
  );
});

await test('strict uncertainty recognizes Turkish inflections in both orders', () => {
  for (const phrase of [
    'emin olmadıklarını önerme',
    'önerme emin olmadıklarını',
  ]) {
    const requirements = deriveRequirements(
      `Küfür ve cinsel içerik olmasın; ${phrase}`,
      [],
    );
    assert.equal(requirements[0].policy, 'require_support');
    assert.equal(
      meetsRequirements(event('Ailece izlenebilir.'), requirements),
      false,
    );
  }
});

await test('waived accessibility and newly rejected genres remove earlier requirements', () => {
  const requirements = deriveRequirements(
    'Basamaksız giriş şart değil. Caz olsun',
    [
      {
        role: 'user',
        content: 'Basamaksız giriş ve erişilebilir tuvalet şart',
      },
    ],
  );
  assert.equal(
    requirements.find((x) => x.kind === 'accessibility')?.value,
    'accessible_toilet',
  );
  assert.deepEqual(
    deriveRequirements('Caz istemiyorum', [
      { role: 'user', content: 'Caz olsun' },
    ]),
    [{ kind: 'genre', value: 'jazz', policy: 'exclude_positive_evidence' }],
  );
});

await test('pure comma-separated genre lists share negation but accessibility clauses do not', () => {
  const genres = deriveRequirements('Caz, rock istemiyorum; klasik olsun.', []);
  assert.equal(
    genres.find((x) => x.policy === 'require_support')?.value,
    'classical',
  );
  assert.equal(
    genres.find((x) => x.policy === 'exclude_positive_evidence')?.value,
    'jazz|rock',
  );
  for (const separator of [',', ' ama']) {
    assert.deepEqual(
      deriveRequirements(
        `Basamaksız giriş şart${separator} tuvalet şart değil.`,
        [],
      ),
      [
        {
          kind: 'accessibility',
          value: 'step_free',
          policy: 'require_support',
        },
      ],
    );
  }
});

await test('classical music evidence excludes generic classic-concert wording', () => {
  const requirements = deriveRequirements(
    'A classical concert, no jazz or rock',
    [],
  );
  assert.equal(
    meetsRequirements(
      event(
        'Klasik bir konser gecesinin ötesinde bir festival; pop ve elektronik müzik.',
      ),
      requirements,
    ),
    false,
  );
  assert.equal(
    meetsRequirements(event('Klasik müziğin seçkin eserleri.'), requirements),
    true,
  );
  assert.equal(
    meetsRequirements(event('Klasik repertuvar eserleri.'), requirements),
    true,
  );
  assert.equal(
    meetsRequirements(event('A classical music concert.'), requirements),
    true,
  );
});
