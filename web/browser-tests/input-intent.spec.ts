import { expect, test, type Page } from '@playwright/test';
import { EXPERIENCES } from '../lib/input-experiences.ts';

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
        preferences: { mood: 'calm', companion: 'partner', interests: ['Romantik atmosfer'], experiences: ['learning'] },
      } }) });
    });
    await page.goto('/');
    await submit(page, 'Oturma yeri şart, mümkünse romantik');
    const plan = page.getByLabel('Anlaşılan plan');
    await expect(plan).toBeVisible();
    await expect(plan.getByRole('group', { name: 'Olmazsa olmazlar' })).toContainText('Oturma yeri');
    await expect(plan.getByRole('group', { name: 'Olmazsa olmazlar' })).not.toContainText('Romantik');
    await expect(plan.getByRole('group', { name: 'Tercihler', exact: true })).toContainText('Romantik atmosfer');
    await expect(plan.getByRole('group', { name: 'Tercihler', exact: true })).toContainText(EXPERIENCES.learning.label);
    await expect(plan.getByRole('group', { name: 'Olmazsa olmazlar' })).not.toContainText(EXPERIENCES.learning.label);
    await page.screenshot({ path: test.info().outputPath('interpreted-plan.png'), fullPage: true });
    await plan.getByRole('button', { name: 'Planı düzelt' }).click();
    await expect(page.getByLabel('Planını anlat')).toBeFocused();
    expect(calls).toBe(1);
    await plan.getByRole('button', { name: 'Planı temizle' }).click();
    await expect(plan).toHaveCount(0);
  });

  test('ignores returned legacy intent state on the next request', async ({ page }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async route => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({ json: response() });
    });
    await page.goto('/');
    await submit(page, 'Sakin bir konser');
    await expect(page.getByLabel('Anlaşılan plan')).toBeVisible();
    await submit(page, 'Tiyatro bul');
    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads).toEqual([{ message: 'Sakin bir konser' }, { message: 'Tiyatro bul' }]);
  });

  test('clarification edits the whole message and never sends a hidden pending request', async ({ page }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    const original = '3 kişiyiz, bütçe 1500 TL';
    await page.route('**/api/recommend', async route => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({ json: payloads.length === 1 ? response({
        recommendations: [], status: 'needs_input', notice: 'Bütçeyi netleştir.',
        pendingInput: { message: original, reason: 'budget_ambiguous' },
        clarification: [{ label: 'Toplam bütçe olarak kullan', message: 'Bütçe toplam.' }],
      }) : response() });
    });
    await page.goto('/');
    await submit(page, original);
    await expect(page.getByRole('heading', { name: 'Aramanı biraz netleştir.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toplam bütçe olarak kullan' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Aramayı düzenle' }).click();
    await expect(page.getByLabel('Planını anlat')).toHaveValue(original);
    await submit(page, 'Theatre tomorrow');
    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads[1]).toEqual({ message: 'Theatre tomorrow' });
    await expect(page.getByRole('heading', { name: 'Theatre tomorrow', exact: true })).toBeVisible();
  });

  test('empty input cannot search with the previous filters', async ({ page }) => {
    await mockShell(page);
    const payloads: Record<string, unknown>[] = [];
    await page.route('**/api/recommend', async route => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({ json: response() });
    });
    await page.goto('/');
    await submit(page, 'Yarın konser');
    const textarea = page.getByLabel('Planını anlat');
    await expect(textarea).toHaveValue('');
    await page.getByRole('button', { name: 'Planımı bul' }).click();
    await expect(textarea).toBeFocused();
    expect(payloads).toEqual([{ message: 'Yarın konser' }]);
  });
});
