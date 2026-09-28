import type { IntentState } from './input-state.ts';
import type { Requirement } from './requirements.ts';

const labels: Record<string, string> = {
  jazz: 'Caz', blues: 'Blues', rock: 'Rock', electronic: 'Elektronik müzik',
  rap: 'Rap', classical: 'Klasik müzik', comedy: 'Komedi', drama: 'Drama',
  kayaking: 'Kano', rowing: 'Kürek', alcohol_free: 'Alkolsüz ortam',
  quiet: 'Sessiz ortam', seated: 'Oturma yeri', romantic: 'Romantik atmosfer',
  uncrowded: 'Kalabalık olmayan ortam', children: 'Çocuklara uygun',
  family_friendly: 'Ailece uygun', swearing: 'Küfür içermediği belirtilen',
  sexual_content: 'Cinsel içerik içermediği belirtilen',
  step_free: 'Basamaksız / tekerlekli sandalye erişimi',
  accessible_toilet: 'Erişilebilir tuvalet',
};

export function requirementLabel(requirement: Requirement): string {
  const parts = requirement.value.split('|').map((value) =>
    value.startsWith('age:') ? `${value.slice(4)} yaşa uygun` : labels[value] ?? value,
  );
  const joined = parts.join(
    requirement.kind === 'content' || requirement.kind === 'accessibility'
      ? ' ve '
      : ' veya ',
  );
  return requirement.policy === 'exclude_positive_evidence'
    ? `${joined} olanlar hariç`
    : joined;
}

/** Describes the user's plan, never asserts facts about an event. */
export function intentSummary(
  state: IntentState,
  money: (value: number) => string,
): { required: string[]; preferred: string[] } {
  const f = state.filters;
  const required: string[] = [];
  if (f.dateFrom && f.dateFrom === f.dateTo) required.push(f.dateFrom);
  else {
    if (f.dateFrom) required.push(`${f.dateFrom} ve sonrası`);
    if (f.dateTo) required.push(`${f.dateTo} ve öncesi`);
  }
  if (f.startTimeFrom) required.push(`${f.startTimeFrom}${f.startTimeFromExclusive ? ' sonrası' : ' ve sonrası'} (İstanbul)`);
  if (f.startTimeTo) required.push(`${f.startTimeTo}${f.startTimeToExclusive ? ' öncesi' : ' ve öncesi'} (İstanbul)`);
  if (f.partySize !== undefined) required.push(`${f.partySize} kişi`);
  if (f.totalBudget !== undefined) required.push(`Toplam ${f.maxPriceExclusive ? '' : 'en fazla '}${money(f.totalBudget)}${f.maxPriceExclusive ? ' altı' : ''}`);
  if (f.maxPrice !== null) required.push(`Kişi başı ${f.maxPriceExclusive ? '' : 'en fazla '}${money(f.maxPrice)}${f.maxPriceExclusive ? ' altı' : ''}`);
  const categories = f.categories ?? (f.category ? [f.category] : []);
  if (categories.length) required.push(categories.join(' veya '));
  if (f.excludedCategories?.length) required.push(`${f.excludedCategories.join(', ')} hariç`);
  if (f.district) required.push(f.district);
  required.push(...state.requirements.map(requirementLabel));

  const preferred: string[] = [];
  const { mood, companion, interests } = state.preferences;
  if (companion) preferred.push({ partner: 'Partnerle birlikte', friends: 'Arkadaşlarla birlikte', family: 'Aileyle birlikte' }[companion]);
  if (mood) preferred.push({ calm: 'Sakin bir plan', energetic: 'Enerjik bir plan', uplifting: 'Moral yükselten bir plan' }[mood]);
  preferred.push(...interests);
  return { required: [...new Set(required)], preferred: [...new Set(preferred)] };
}
