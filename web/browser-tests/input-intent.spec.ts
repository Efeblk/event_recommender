import { expect, test, type Page } from '@playwright/test';

const emptyFilters = {
  dateFrom: null,
  dateTo: null,
  maxPrice: null,
  category: null,
};

const baseState = {
  version: 1,
  filters: {
    ...emptyFilters,
    dateFrom: '2026-10-03',
    dateTo: '2026-10-03',
    category: 'Konser',
  },
  requirements: [],
  preferences: { mood: 'calm', companion: null, interests: ['caz'] },
};

function event(id: string) {
  return {
    id,
    title: `Etkinlik ${id}`,
    description: 'Canlı müzik gecesi.',
    startsAt: '2026-10-03T17:00:00.000Z',
    venue: 'Sahne İstanbul',
    city: 'İstanbul',
    district: 'Kadıköy',
    address: 'Kadıköy, İstanbul',
    price: 450,
    currency: 'TRY',
    url: `https://tickets.example/${id}`,
    imageUrl: '',
    category: 'Konser',
    availability: 'available',
    source: 'bubilet',
    checkedAt: '2026-09-28T08:00:00.000Z',
    canonicalProductionKey: `production-${id}`,
    canonicalShowKey: `show-${id}`,
  };
}

function response(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    recommendations: [{ event: event('one') }],
    filters: baseState.filters,
    mode: 'jev',
    status: 'results',
    notice: null,
    totalCandidates: 1,
    intentState: baseState,
    ...overrides,
  };
}

async function mockShell(page: Page) {
  await page.route('**/api/**', (route) => {
    throw new Error(`Unexpected API request: ${route.request().url()}`);
  });
  await page.route('**/api/events', (route) =>
    route.fulfill({
      json: {
        events: [event('catalog')],
        total: 1,
        aiEnabled: true,
        catalog: {
          status: 'ready',
          stored: 1,
          eligible: 1,
          lastCheckedAt: '2026-09-28T08:00:00.000Z',
          oldestCheckedAt: '2026-09-28T08:00:00.000Z',
          expiresAt: '2026-09-29T08:00:00.000Z',
        },
      },
    }),
  );
  await page.route('**/api/site', (route) =>
    route.fulfill({ json: { donationUrl: null } }),
  );
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => {
    if (route.request().resourceType() === 'image') return route.abort();
    return route.continue();
  });
}

async function submit(page: Page, message: string) {
  const textarea = page.getByLabel('Planını anlat');
  await textarea.fill(message);
  await textarea.press('Enter');
}

test.describe('versioned input intent protocol', () => {
  test('shows required conditions separately from preferences and edits without another provider call', async ({ page }) => {
    await mockShell(page);
    let calls = 0;
    await page.route('**/api/recommend', (route) => {
      calls += 1;
      return route.fulfill({ json: response({ intentState: {
        ...baseState,
        requirements: [{ kind: 'activity', value: 'seated', policy: 'require_support' }],
        preferences: { mood: 'calm', companion: 'partner', interests: ['Romantik atmosfer'] },
      } }) });
    });
    await page.goto('/');
    await submit(page, 'Oturma yeri şart, mümkünse romantik');
    const plan = page.getByLabel('Anlaşılan plan');
    await expect(plan).toBeVisible();
    await expect(plan.getByRole('group', { name: 'Olmazsa olmazlar' })).toContainText('Oturma yeri');
    await expect(plan.getByRole('group', { name: 'Olmazsa olmazlar' })).not.toContainText('Romantik');
    await expect(plan.getByRole('group', { name: 'Tercihler', exact: true })).toContainText('Romantik atmosfer');
    await page.screenshot({ path: test.info().outputPath('interpreted-plan.png'), fullPage: true });
    await plan.getByRole('button', { name: 'Planı düzelt' }).click();
    await expect(page.getByLabel('Planını anlat')).toBeFocused();
    expect(calls).toBe(1);
    await plan.getByRole('button', { name: 'Planı temizle' }).click();
    await expect(plan).toHaveCount(0);
  });

  test('sends intentVersion 1 and carries returned intentState into the next turn', async ({
    page,
  }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async (route) => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({ json: response() });
    });

    await page.goto('/');
    await submit(page, 'Cumartesi sakin bir caz konseri');
    await submit(page, 'Kadıköy olsun');

    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads[0]).toMatchObject({
      intentVersion: 1,
      message: 'Cumartesi sakin bir caz konseri',
      alternativeIds: [],
    });
    expect(payloads[0].intentState).toBeUndefined();
    expect(payloads[1]).toMatchObject({
      intentVersion: 1,
      message: 'Kadıköy olsun',
      intentState: baseState,
      history: [],
    });
  });

  test('budget clarification choices send a short reply with the unresolved request', async ({
    page,
  }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    const original = '3 kişiyiz, bütçe 1500 TL';
    const totalChoice = 'Bütçe toplam.';
    const perPersonChoice = 'Bütçe kişi başı.';
    await page.route('**/api/recommend', async (route) => {
      payloads.push(route.request().postDataJSON());
      if (payloads.length === 1) {
        await route.fulfill({
          json: response({
            recommendations: [],
            filters: baseState.filters,
            status: 'needs_input',
            notice: '1500 TL toplam mı, kişi başı mı?',
            pendingInput: { message: original, reason: 'budget_ambiguous' },
            totalCandidates: 0,
            intentState: baseState,
            clarification: [
              { label: 'Toplam 1.500 TL', message: totalChoice },
              { label: 'Kişi başı 1.500 TL', message: perPersonChoice },
            ],
          }),
        });
      } else {
        await route.fulfill({ json: response() });
      }
    });

    await page.goto('/');
    await submit(page, original);
    const choices = page.getByLabel('Bütçeyi netleştir');
    await expect(choices.getByRole('button')).toHaveCount(2);
    await choices.getByRole('button', { name: 'Toplam 1.500 TL' }).click();

    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads[1]).toMatchObject({
      intentVersion: 1,
      message: totalChoice,
      intentState: baseState,
      pendingInput: { message: original, reason: 'budget_ambiguous' },
    });
    await expect(
      page.getByRole('heading', {
        name: `${original} (${totalChoice})`,
        exact: true,
      }),
    ).toBeVisible();
  });

  test('retry preserves the exact intent-state request snapshot', async ({
    page,
  }) => {
    await mockShell(page);
    const bodies: string[] = [];
    await page.route('**/api/recommend', async (route) => {
      bodies.push(route.request().postData() ?? '');
      if (bodies.length === 1) {
        await route.fulfill({ json: response() });
      } else if (bodies.length === 2) {
        await route.fulfill({ status: 503, json: { error: 'Geçici hata.' } });
      } else {
        await route.fulfill({ json: response() });
      }
    });

    await page.goto('/');
    await submit(page, 'Cumartesi caz');
    await submit(page, 'Kadıköy olsun');
    await expect(page.getByRole('alert')).toContainText('Geçici hata.');
    await page.getByRole('button', { name: 'Yeniden dene' }).click();

    await expect.poll(() => bodies.length).toBe(3);
    expect(bodies[2]).toBe(bodies[1]);
    expect(JSON.parse(bodies[2])).toMatchObject({
      intentVersion: 1,
      intentState: baseState,
    });
  });

  test('new search clears intent state and accumulated alternative ids', async ({
    page,
  }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async (route) => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({ json: response() });
    });

    await page.goto('/');
    await submit(page, 'Cumartesi caz');
    await page.getByRole('button', { name: 'Başka seçenekler' }).click();
    await expect.poll(() => payloads.length).toBe(2);
    await page.getByRole('button', { name: 'Yeni arama' }).click();
    await submit(page, 'Pazar tiyatro');

    await expect.poll(() => payloads.length).toBe(3);
    expect(payloads[2]).toMatchObject({
      intentVersion: 1,
      message: 'Pazar tiyatro',
      alternativeIds: [],
      excludeIds: [],
    });
    expect(payloads[2].intentState).toBeUndefined();
  });

  test('successive alternative requests carry cumulative alternativeIds', async ({
    page,
  }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async (route) => {
      payloads.push(route.request().postDataJSON());
      const id = ['one', 'two', 'three'][payloads.length - 1];
      await route.fulfill({
        json: response({ recommendations: [{ event: event(id) }] }),
      });
    });

    await page.goto('/');
    await submit(page, 'Cumartesi caz');
    await page.getByRole('button', { name: 'Başka seçenekler' }).click();
    await expect.poll(() => payloads.length).toBe(2);
    await page.getByRole('button', { name: 'Başka seçenekler' }).click();

    await expect.poll(() => payloads.length).toBe(3);
    expect(payloads[1].alternativeIds).toEqual([
      'one',
      'production-one',
      'show-one',
    ]);
    expect(payloads[1].excludeIds).toEqual(payloads[1].alternativeIds);
    expect(payloads[2].alternativeIds).toEqual([
      'one',
      'production-one',
      'show-one',
      'two',
      'production-two',
      'show-two',
    ]);
    expect(payloads[2].excludeIds).toEqual(payloads[2].alternativeIds);
  });
});

test.describe('clarification layout', () => {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 375, height: 812 },
  ]) {
    test(`${viewport.name} keeps both quick choices inside the page`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await mockShell(page);
      await page.route('**/api/recommend', (route) =>
        route.fulfill({
          json: response({
            recommendations: [],
            status: 'needs_input',
            notice: 'Bütçeyi netleştir.',
            totalCandidates: 0,
            clarification: [
              {
                label: 'Toplam bütçe olarak kullan',
                message: 'Bütçe toplam.',
              },
              {
                label: 'Kişi başı bütçe olarak kullan',
                message: 'Bütçe kişi başı.',
              },
            ],
          }),
        }),
      );

      await page.goto('/');
      await submit(page, '3 kişiyiz, bütçe 1500 TL');
      const choices = page.getByLabel('Bütçeyi netleştir');
      await expect(choices.getByRole('button')).toHaveCount(2);
      const dimensions = await page.evaluate(() => ({
        viewport: window.innerWidth,
        page: document.documentElement.scrollWidth,
      }));
      expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);
      for (const button of await choices.getByRole('button').all()) {
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      }
    });
  }
});

test('typed clarification retains pending text and alternative IDs through retry, then clears pending on success', async ({
  page,
}) => {
  await mockShell(page);
  const original = 'Cumartesi 3 ki\u015fiyiz, b\u00fct\u00e7e 1500 TL';
  const pendingInput = { message: original, reason: 'budget_ambiguous' };
  const bodies: string[] = [];
  await page.route('**/api/recommend', async (route) => {
    bodies.push(route.request().postData() ?? '');
    if (bodies.length === 2) {
      return route.fulfill({
        json: response({
          recommendations: [],
          status: 'needs_input',
          totalCandidates: 0,
          notice: 'Toplam m\u0131, ki\u015fi ba\u015f\u0131 m\u0131?',
          pendingInput,
        }),
      });
    }
    if (bodies.length === 3)
      return route.fulfill({
        status: 503,
        json: { error: 'Temporary failure.' },
      });
    return route.fulfill({ json: response({ excludedIds: [] }) });
  });
  await page.goto('/');
  await submit(page, 'Cumartesi caz');
  await expect(
    page.getByRole('button', {
      name: 'Ba\u015fka se\u00e7enekler',
      exact: true,
    }),
  ).toBeVisible();
  await submit(page, original);
  await expect(
    page.getByRole('button', {
      name: 'Aramay\u0131 d\u00fczenle',
      exact: true,
    }),
  ).toBeVisible();
  await submit(page, 'ki\u015fi ba\u015f\u0131');
  await expect(page.getByRole('alert')).toContainText('Temporary failure.');
  expect(JSON.parse(bodies[2])).toMatchObject({
    message: 'ki\u015fi ba\u015f\u0131',
    pendingInput,
    intentState: baseState,
    history: [],
    alternativeIds: ['one', 'production-one', 'show-one'],
  });
  await page.getByRole('button', { name: 'Yeniden dene', exact: true }).click();
  await expect.poll(() => bodies.length).toBe(4);
  expect(bodies[3]).toBe(bodies[2]);
  await expect(
    page.getByRole('button', {
      name: 'Ba\u015fka se\u00e7enekler',
      exact: true,
    }),
  ).toBeVisible();
  await submit(page, 'Pazar olsun');
  await expect.poll(() => bodies.length).toBe(5);
  expect(JSON.parse(bodies[4]).pendingInput).toBeUndefined();
});

test('reset clears unresolved input as well as committed intent', async ({
  page,
}) => {
  await mockShell(page);
  const payloads: Record<string, unknown>[] = [];
  await page.route('**/api/recommend', async (route) => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill({
      json: response({
        recommendations: [],
        filters: {
          dateFrom: null,
          dateTo: null,
          maxPrice: null,
          category: null,
        },
        intentState: {
          version: 1,
          filters: {
            dateFrom: null,
            dateTo: null,
            maxPrice: null,
            category: null,
          },
          requirements: [],
          preferences: { mood: null, companion: null, interests: [] },
        },
        status: 'needs_input',
        totalCandidates: 0,
        pendingInput: {
          message: '3 people, 1500 TL',
          reason: 'budget_ambiguous',
        },
      }),
    });
  });
  await page.goto('/');
  await submit(page, '3 people, 1500 TL');
  await page.getByRole('button', { name: 'Yeni arama', exact: true }).click();
  await submit(page, 'Tiyatro');
  await expect.poll(() => payloads.length).toBe(2);
  expect(payloads[1].pendingInput).toBeUndefined();
  expect(payloads[1].intentState).toBeUndefined();
  expect(payloads[1].alternativeIds).toEqual([]);
});
