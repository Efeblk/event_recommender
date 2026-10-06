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
  requests: ['sakin bir konser'],
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

test.describe('independent span requests', () => {
  test('shows the current plan and sends only each new message', async ({ page }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async route => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({ json: response() });
    });
    const siteResponse = page.waitForResponse('**/api/site');
    await page.goto('/'); await siteResponse;
    await submit(page, 'Sakin bir konser');
    const summary = page.getByLabel('Anlaşılan plan');
    await expect(summary.getByRole('group', { name: 'Olmazsa olmazlar' })).toContainText('konser');
    await expect(summary.getByRole('group', { name: 'Tercihler', exact: true })).toContainText('sakin');
    await expect(page.getByRole('button', { name: 'Başka seçenekler' })).toHaveCount(0);
    await summary.getByRole('button', { name: 'Planı düzelt' }).click();
    await expect(page.getByLabel('Planını anlat')).toHaveValue('Sakin bir konser');
    await expect.poll(() => payloads.length).toBe(1);
    await submit(page, 'Kadıköy tiyatro');
    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads).toEqual([{ message: 'Sakin bir konser' }, { message: 'Kadıköy tiyatro' }]);
    await page.getByRole('button', { name: 'Yeni arama', exact: true }).click();
    await expect(summary).toHaveCount(0);
    await submit(page, 'Tiyatro bul');
    await expect.poll(() => payloads.length).toBe(3);
    expect(payloads[2]).toEqual({ message: 'Tiyatro bul' });
  });

  test('prompt chips start a new request after a result', async ({ page }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async route => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({ json: response() });
    });
    await page.goto('/');
    await submit(page, '600 TL altında konser');
    await expect(page.getByLabel('Anlaşılan plan')).toBeVisible();
    await page.getByRole('button', { name: 'İki kişilik tiyatro akşamı' }).click();
    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads[1]).toEqual({ message: 'İki kişilik tiyatro akşamı' });
  });

  test('retries the exact current message after an interpreter outage', async ({ page }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async route => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({ json: payloads.length === 2 ? response({
        recommendations: [], status: 'needs_input', notice: 'Araman şu anda yorumlanamadı.',
        pendingInput: { message: 'Kadıköy tiyatro', reason: 'interpreter_unavailable' },
      }) : response() });
    });
    await page.goto('/');
    await submit(page, 'Sakin bir konser');
    await expect(page.getByLabel('Anlaşılan plan')).toBeVisible();
    await submit(page, 'Kadıköy tiyatro');
    await expect(page.getByRole('alert')).toContainText('yorumlanamadı');
    await page.getByRole('button', { name: 'Yeniden dene' }).click();
    await expect.poll(() => payloads.length).toBe(3);
    expect(payloads[2]).toEqual({ message: 'Kadıköy tiyatro' });
    expect(payloads[2]).toEqual(payloads[1]);
  });
});
