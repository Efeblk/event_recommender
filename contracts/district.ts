export const normalize = (value: string) => value.toLocaleLowerCase('tr-TR')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');

export const ISTANBUL_DISTRICTS = [
  'adalar','arnavutkoy','atasehir','avcilar','bagcilar','bahcelievler','bakirkoy','basaksehir',
  'bayrampasa','besiktas','beykoz','beylikduzu','beyoglu','buyukcekmece','catalca','cekmekoy',
  'esenler','esenyurt','eyupsultan','fatih','gaziosmanpasa','gungoren','kadikoy','kagithane',
  'kartal','kucukcekmece','maltepe','pendik','sancaktepe','sariyer','silivri','sultanbeyli',
  'sultangazi','sile','sisli','tuzla','umraniye','uskudar','zeytinburnu',
] as const;
const districtSet = new Set<string>(ISTANBUL_DISTRICTS);
const addressPatterns = ISTANBUL_DISTRICTS.map((district) => [district, new RegExp(`\\b${district}\\b\\s*(?:(?:/|,)\\s*istanbul\\b|$)`)] as const);

export const isIstanbulDistrict = (normalized: string) => districtSet.has(normalized);

/** The single district written before /Istanbul (or at the end). */
export function addressDistrict(address: string): string | null {
  const normalizedAddress = normalize(address);
  const matches = addressPatterns.filter(([, pattern]) => pattern.test(normalizedAddress)).map(([district]) => district);
  return matches.length === 1 ? matches[0] : null;
}
