import { expect, test, type Page } from '@playwright/test';

const emptyFilters = {
  dateFrom: null,
  dateTo: null,
  maxPrice: null,
  category: null,
};

const planState = {
  version: 2 as const,
  revision: 1,
  plan: {
    hard: {
      type: 'all' as const,
      children: [
        {
          type: 'atom' as const,
          atom: { kind: 'category' as const, value: 'concert' as const },
        },
      ],
    },
    preferences: [
      {
        type: 'atom' as const,
        atom: { kind: 'experience' as const, value: 'quiet' as const },
      },
    ],
    order: 'none' as const,
  },
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
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    recommendations: [{ event: event('one') }],
    filters: emptyFilters,
    mode: 'jev',
    status: 'results',
    notice: null,
    totalCandidates: 1,
    planState,
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
        catalog: { status: 'ready', stored: 1, eligible: 1 },
      },
    }),
  );
  await page.route('**/api/site', (route) =>
    route.fulfill({ json: { donationUrl: null, intentVersion: 2 } }),
  );
}

async function submit(page: Page, message: string) {
  const textarea = page.getByLabel('Planını anlat');
  await textarea.fill(message);
  await textarea.press('Enter');
}

test.describe('span plan protocol', () => {
  test('carries the grouped plan through follow-ups and clears it for a new search', async ({
    page,
  }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async (route) => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({ json: response() });
    });

    const siteResponse = page.waitForResponse('**/api/site');
    await page.goto('/');
    await siteResponse;
    await submit(page, 'Konser olsun, sakin olursa iyi olur');

    const summary = page.getByLabel('Anlaşılan plan');
    await expect(
      summary.getByRole('group', { name: 'Olmazsa olmazlar' }),
    ).toContainText('konser');
    await expect(
      summary.getByRole('group', { name: 'Tercihler', exact: true }),
    ).toContainText('sakin');
    await submit(page, 'Kadıköy olsun');
    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads[0]).toMatchObject({ intentVersion: 2, history: [] });
    expect(payloads[0].planState).toBeUndefined();
    expect(payloads[0].intentState).toBeUndefined();
    expect(payloads[1]).toMatchObject({
      intentVersion: 2,
      history: [],
      planState,
    });

    await page.getByRole('button', { name: 'Yeni arama' }).click();
    await expect(summary).toHaveCount(0);
    await submit(page, 'Tiyatro bul');
    await expect.poll(() => payloads.length).toBe(3);
    expect(payloads[2].planState).toBeUndefined();
  });

  test('retries an unavailable interpretation with the same plan and pending input', async ({
    page,
  }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async (route) => {
      payloads.push(route.request().postDataJSON());
      if (payloads.length === 2) {
        await route.fulfill({
          json: response({
            recommendations: [],
            notice: 'Araman şu anda yorumlanamadı.',
            pendingInput: {
              message: 'Kadıköy olsun',
              reason: 'interpreter_unavailable',
            },
          }),
        });
        return;
      }
      await route.fulfill({ json: response() });
    });

    const siteResponse = page.waitForResponse('**/api/site');
    await page.goto('/');
    await siteResponse;
    await submit(page, 'Sakin bir konser');
    await submit(page, 'Kadıköy olsun');
    await expect(page.getByRole('alert')).toContainText('yorumlanamadı');
    await page.getByRole('button', { name: 'Yeniden dene' }).click();
    await expect.poll(() => payloads.length).toBe(3);
    expect(payloads[2]).toEqual(payloads[1]);
    expect(payloads[2]).toMatchObject({ intentVersion: 2, planState });
  });
});
