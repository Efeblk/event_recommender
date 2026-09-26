import { expect, test, type Page, type Route } from '@playwright/test';

const emptyFilters = {
  dateFrom: null,
  dateTo: null,
  maxPrice: null,
  category: null,
};

const event = {
  id: 'event-1',
  title: 'Gece Cazı',
  description: 'Canlı caz gecesi.',
  startsAt: '2026-10-03T17:00:00.000Z',
  venue: 'Sahne İstanbul',
  city: 'İstanbul',
  district: 'Kadıköy',
  address: 'Kadıköy, İstanbul',
  price: 450,
  currency: 'TRY',
  url: 'https://tickets.example/event-1',
  imageUrl: 'https://images.example/event-1.jpg',
  category: 'Konser',
  availability: 'available',
  source: 'bubilet',
  checkedAt: '2026-09-24T08:00:00.000Z',
  canonicalProductionKey: 'production-jazz',
  canonicalShowKey: 'show-jazz-2026-10-03',
  offers: [
    {
      id: 'offer-bubilet',
      source: 'bubilet',
      url: 'https://tickets.example/bubilet',
      price: 450,
      currency: 'TRY',
      checkedAt: '2026-09-24T08:00:00.000Z',
      category: 'Konser',
      venue: 'Sahne İstanbul',
      availability: 'available',
    },
    {
      id: 'offer-biletix',
      source: 'biletix',
      url: 'https://tickets.example/biletix',
      price: 500,
      currency: 'TRY',
      checkedAt: '2026-09-24T08:00:00.000Z',
      category: 'Konser',
      venue: 'Sahne İstanbul',
      availability: 'available',
    },
  ],
};

const eventsResponse = {
  events: [event],
  total: 1,
  aiEnabled: true,
  catalog: {
    status: 'ready',
    stored: 1,
    eligible: 1,
    lastCheckedAt: '2026-09-24T08:00:00.000Z',
    oldestCheckedAt: '2026-09-24T08:00:00.000Z',
    expiresAt: '2026-09-25T08:00:00.000Z',
  },
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    recommendations: [{ event }],
    filters: emptyFilters,
    mode: 'jev',
    status: 'results',
    notice: null,
    totalCandidates: 1,
    ...overrides,
  };
}

async function mockShell(page: Page, donationUrl: string | null = null) {
  const unhandledRecommendations: string[] = [];
  await page.route('**/api/**', (route) => {
    throw new Error(`Unexpected API request: ${route.request().url()}`);
  });
  await page.route('**/api/events', (route) =>
    route.fulfill({ json: eventsResponse }),
  );
  await page.route('**/api/site', (route) =>
    route.fulfill({ json: { donationUrl } }),
  );
  await page.route('**/api/recommend', async (route) => {
    unhandledRecommendations.push(route.request().postData() || '<empty>');
    await route.fulfill({
      status: 599,
      json: { error: 'Unhandled recommendation request in browser test.' },
    });
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => {
    if (route.request().resourceType() === 'image') return route.abort();
    return route.continue();
  });
  return unhandledRecommendations;
}

test.describe('browser contracts', () => {
  test('hydrates, renders merged ticket offers, privacy, and placeholders', async ({
    page,
  }) => {
    const unhandled = await mockShell(page);
    await page.goto('/');

    const textarea = page.getByLabel('Planını anlat');
    await expect(textarea).toBeEditable();
    await textarea.fill('Cumartesi caz');
    await expect(textarea).toHaveValue('Cumartesi caz');
    await expect(
      page.getByRole('heading', { name: 'Gece Cazı' }),
    ).toBeVisible();
    const offers = page.getByRole('list', {
      name: 'Gece Cazı için bilet seçenekleri',
    });
    await expect(offers.getByRole('link')).toHaveCount(2);
    await expect(offers.getByText('en düşük')).toBeVisible();
    await expect(page.getByText('Destek bağlantısı yakında')).toBeVisible();

    await page.getByText('Veriler nasıl kullanılıyor?').click();
    await expect(page.getByText(/Voyage AI ve TypeSafe AI/)).toBeVisible();
    await expect(
      page.getByText(/ham IP adresi yerine türetilmiş/),
    ).toBeVisible();
    await expect(
      page.getByText(/Etkinlik afişleri bilet sağlayıcılarının/),
    ).toBeVisible();
    expect(unhandled).toEqual([]);
  });

  test('group size and total budget stay visible across a budget waiver', async ({
    page,
  }) => {
    const unhandled = await mockShell(page);
    let call = 0;
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async (route) => {
      call += 1;
      payloads.push(route.request().postDataJSON());
      await route.fulfill({
        json: result({
          filters:
            call === 1
              ? {
                  ...emptyFilters,
                  dateFrom: '2026-10-04',
                  dateTo: '2026-10-04',
                  maxPrice: 450,
                  partySize: 4,
                  totalBudget: 1800,
                  categories: ['Stand-up', 'Tiyatro'],
                }
              : {
                  ...emptyFilters,
                  dateFrom: '2026-10-04',
                  dateTo: '2026-10-04',
                  partySize: 4,
                  categories: ['Stand-up', 'Tiyatro'],
                },
        }),
      });
    });
    await page.goto('/');
    const textarea = page.getByLabel('Planını anlat');
    await textarea.fill(
      '4 kişiyiz, toplam 1800 TL. 4 Ekim komedi veya stand-up.',
    );
    await textarea.press('Enter');

    const filters = page.getByLabel('Etkin filtreler');
    await expect(filters.getByText('4 kişi', { exact: true })).toBeVisible();
    await expect(filters.getByText('Toplam bütçe ₺1.800')).toBeVisible();
    await expect(filters.getByText('En fazla ₺450')).toBeVisible();

    await textarea.fill('Para sınırını kaldır, diğer koşullar aynı.');
    await textarea.press('Enter');
    await expect.poll(() => call).toBe(2);
    expect(payloads[1].filters).toMatchObject({
      partySize: 4,
      totalBudget: 1800,
      maxPrice: 450,
    });
    await expect(filters.getByText('4 kişi', { exact: true })).toBeVisible();
    await expect(filters.getByText(/Toplam bütçe/)).toHaveCount(0);
    await expect(filters.getByText(/En fazla/)).toHaveCount(0);
    expect(unhandled).toEqual([]);
  });

  test('Enter submits, Shift+Enter adds a newline, and follow-up carries history and exclusions', async ({
    page,
  }) => {
    const unhandled = await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async (route) => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({ json: result() });
    });
    await page.goto('/');

    const textarea = page.getByLabel('Planını anlat');
    await textarea.fill('Sakin bir caz gecesi');
    await textarea.press('Shift+Enter');
    await textarea.fill('Sakin bir caz gecesi\nKadıköy olsun');
    await expect(textarea).toHaveValue('Sakin bir caz gecesi\nKadıköy olsun');
    await textarea.press('Enter');
    await expect(
      page.getByRole('heading', { name: /Sakin bir caz/ }),
    ).toBeVisible();

    await page.getByRole('button', { name: /Başka seçenekler/ }).click();
    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads[0]).toMatchObject({
      message: 'Sakin bir caz gecesi\nKadıköy olsun',
      history: [],
      excludeIds: [],
    });
    expect(payloads[1]).toMatchObject({
      message: 'Aynı koşullarda başka etkinlikler bul.',
      history: [
        {
          role: 'user',
          content: 'Sakin bir caz gecesi\nKadıköy olsun',
        },
      ],
    });
    expect(payloads[1].excludeIds).toEqual(
      expect.arrayContaining([
        'event-1',
        'production-jazz',
        'show-jazz-2026-10-03',
      ]),
    );
    expect(unhandled).toEqual([]);
  });

  test('needs-input keeps the query and returns keyboard focus to editing', async ({
    page,
  }) => {
    const unhandled = await mockShell(page);
    await page.route('**/api/recommend', (route) =>
      route.fulfill({
        json: result({
          recommendations: [],
          mode: 'filters',
          status: 'needs_input',
          notice: 'Hangi günü tercih edersin?',
          totalCandidates: 0,
        }),
      }),
    );
    await page.goto('/');
    // The textarea is present in the server-rendered shell before React can
    // handle its key events. The mocked catalog card appears after hydration.
    await expect(page.getByRole('heading', { name: 'Gece Cazı' })).toBeVisible();
    const textarea = page.getByLabel('Planını anlat');
    await textarea.fill('Bir konser bul');
    await textarea.press('Enter');
    await expect(page.getByText('Hangi günü tercih edersin?')).toBeVisible();
    await page.getByRole('button', { name: 'Aramayı düzenle' }).click();
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue('Bir konser bul');
    expect(unhandled).toEqual([]);
  });

  test('503 retry resends the exact request and 429 is presented', async ({
    page,
  }) => {
    const unhandled = await mockShell(page);
    const bodies: string[] = [];
    await page.route('**/api/recommend', async (route) => {
      bodies.push(route.request().postData() || '');
      if (bodies.length === 1) {
        await route.fulfill({
          status: 503,
          json: { error: 'Arama geçici olarak kullanılamıyor.' },
        });
      } else if (bodies.length === 2) {
        await route.fulfill({ json: result() });
      } else {
        await route.fulfill({
          status: 429,
          json: { error: 'Arama sınırına ulaşıldı.' },
        });
      }
    });
    await page.goto('/');
    const textarea = page.getByLabel('Planını anlat');
    await textarea.fill('Bu hafta sonu konser');
    await textarea.press('Enter');
    await expect(page.getByRole('alert')).toContainText(
      'Arama geçici olarak kullanılamıyor.',
    );
    await page.getByRole('button', { name: 'Yeniden dene' }).click();
    await expect(
      page.getByRole('heading', { name: 'Gece Cazı' }),
    ).toBeVisible();
    expect(bodies[1]).toBe(bodies[0]);

    await page.getByRole('button', { name: /Başka seçenekler/ }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Arama sınırına ulaşıldı.',
    );
    await expect(page.getByRole('button', { name: 'Yeniden dene' })).toHaveCount(0);
    expect(unhandled).toEqual([]);
  });

  test('reset prevents a pending response from restoring stale results', async ({
    page,
  }) => {
    const unhandled = await mockShell(page);
    let call = 0;
    let releasePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    await page.route('**/api/recommend', async (route: Route) => {
      call += 1;
      if (call === 1) return route.fulfill({ json: result() });
      await pending;
      await route
        .fulfill({
          json: result({
            recommendations: [{ event: { ...event, title: 'Eski Sonuç' } }],
          }),
        })
        .catch(() => undefined);
    });
    await page.goto('/');
    const textarea = page.getByLabel('Planını anlat');
    await textarea.fill('Caz');
    await textarea.press('Enter');
    await expect(
      page.getByRole('button', { name: /Başka seçenekler/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: /Başka seçenekler/ }).click();
    await expect.poll(() => call).toBe(2);
    await page.getByRole('button', { name: 'Yeni arama' }).click();
    releasePending();
    await expect(
      page.getByRole('heading', { name: 'Şehirde ne var?' }),
    ).toBeVisible();
    await expect(page.getByText('Eski Sonuç')).toHaveCount(0);
    await expect(textarea).toHaveValue('');
    expect(unhandled).toEqual([]);
  });
});

test.describe('mobile accessibility and layout', () => {
  test.skip(
    ({ viewport }) => viewport?.width !== 375,
    'Mobile-project coverage',
  );

  test('375px layout has no page overflow and keeps focus and send affordances usable', async ({
    page,
  }) => {
    const unhandled = await mockShell(page);
    await page.goto('/');
    const textarea = page.getByLabel('Planını anlat');
    await textarea.focus();
    await expect(textarea).toBeFocused();
    const panel = page.locator('.chat-panel');
    expect(
      await panel.evaluate((node) => getComputedStyle(node).outlineStyle),
    ).not.toBe('none');
    const sendBox = await page
      .getByRole('button', { name: 'Planımı bul' })
      .boundingBox();
    expect(sendBox?.width).toBeGreaterThanOrEqual(44);
    expect(sendBox?.height).toBeGreaterThanOrEqual(44);
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);
    expect(unhandled).toEqual([]);
  });
});
