import { normalizeIdentityText } from "../normalize/identity.ts";
import type { IdentityListing } from "./types.ts";

export const IDENTITY_SEED_VERSION = "identity-seeds.2026-10-02.v1" as const;

// Source-reviewed aliases migrated from web/lib/event-merge.ts. These seeds
// never bypass city, instant, provider, venue, or policy guards.
const VENUE_ALIAS_GROUPS = [
  ["Cafe Theatre", "Cafe Theatre Koşuyolu"],
  ["Ada Bar Kadıköy", "Ada Bar"],
  ["HoP Sahne", "House of Performance - HoP"],
  ["Biletinial Torium Sahne", "Torium Sahne"],
  ["Kartal Sanat Tiyatrosu", "Kartal Sanat Tiyatro Salonu"],
  ["Maltepe Dragos Sahne", "Sahne Dragos"],
  [
    "Watergarden Performans Merkezi Duru Tiyatro [Ataşehir]",
    "Duru Tiyatro Watergarden Performans Merkezi",
  ],
  ["İnal Aydınoğlu KM", "İnal Aydınoğlu Kültür Merkezi"],
  ["Lütfi Kırdar Anadolu Auditorium", "İstanbul Lütfi Kirdar Anadolu Oditoryum Salonu"],
  ["Paribu Vadi Açıkhava", "Paribu Vadi Açık Hava"],
  ["Jolly Joker Kartal", "Jolly Joker Kartal İstMarina"],
  ["JJ Arena", "JJ Arena Ataşehir"],
  ["Dorock XL Kadıköy", "Dorock XL"],
  ["AKM Türk Telekom Opera Salonu", "Türk Telekom Opera Salonu"],
  ["Mall Of İstanbul Biletinial Moi Sahne", "Mall of İstanbul MOİ Sahne"],
] as const;

const venueSeeds = new Map<string, string>();
for (const group of VENUE_ALIAS_GROUPS) {
  const key = `venue:${normalizeIdentityText(group[0])}`;
  for (const alias of group) venueSeeds.set(normalizeIdentityText(alias), key);
}

const FABRIKAFA_ADDRESS = normalizeIdentityText(
  "Aziz Mahmut Hüdayi, Gülfem Sk. No:15, 34672 Üsküdar/İstanbul",
);
const WORKSHOP_VENUES = [
  {
    key: "venue:reviewed:fabrikafa",
    names: ["Fabrikafa Make & Coffee", "İstanbul Workshops - Fabrikafa Make & Coffee"],
    genericName: "İstanbul Workshops",
    address: FABRIKAFA_ADDRESS,
  },
  {
    key: "venue:reviewed:bagimsiz-sanat-vakfi",
    names: ["Bağımsız Sanat Vakfı"],
    genericName: undefined,
    address: normalizeIdentityText("Hobyar, Ankara Cd. No;3, 34110 Fatih/İstanbul"),
  },
  {
    key: "venue:reviewed:atolye-sahi",
    names: ["Atölye Sahi"],
    genericName: undefined,
    address: normalizeIdentityText(
      "Aziz Mahmut Hüdayi Caddesi, Gülfem Sk. No:17A, 34762 Üsküdar/İstanbul",
    ),
  },
] as const;

export function venueSeedIdentity(listing: IdentityListing): string | undefined {
  if (normalizeIdentityText(listing.city ?? "İstanbul") !== "istanbul") return undefined;
  const name = normalizeIdentityText(listing.venue.name);
  const address = normalizeIdentityText(listing.venue.address);
  for (const seed of WORKSHOP_VENUES) {
    if (seed.names.some((candidate) => normalizeIdentityText(candidate) === name)) {
      if (address && address !== seed.address) return undefined;
      return seed.key;
    }
    if (seed.genericName && normalizeIdentityText(seed.genericName) === name)
      return address === seed.address ? seed.key : undefined;
  }
  return venueSeeds.get(name);
}

const TITLE_ALIAS_GROUPS = [
  [
    "Kadıköy Açık Mikrofon Stand-up - Comedy Lab",
    "Kadıköy Açık Mikrofon Stand-up - Comedy Lab Istanbul",
  ],
  [
    "STAND UP GECESİ Taksim- Pera- Beyoğlu",
    "Beyoğlu- Taksim- Stand Up Gecesi",
    "Stand Up Gecesi - Taksim & Beyoğlu",
    "Beyoğlu- Taksim- Pera Stand Up Gecesi",
  ],
  [
    "Stand up Taksim / Beyoğlu Gecesi | İnfiniti Sahne",
    "Stand Up Taksim / Beyoğlu Gecesi - Cuma 20:30",
    "Stand Up Taksim - Beyoğlu Gecesi - Cuma 20:30",
    "Stand Up Taksim / Beyoğlu Gecesi - Cuma 22:30",
    "Stand Up Taksim - Beyoğlu Gecesi - Cuma 22:30",
    "Stand Up Taksim / Beyoğlu Gecesi - Cumartesi 19:00",
    "Stand Up Taksim / Beyoğlu Gecesi - Cumartesi 20:30",
    "Stand Up Taksim / Beyoğlu Gecesi - Pazar 19:00",
    "Stand Up Taksim / Beyoğlu Gecesi - Pazar 20:30",
  ],
  [
    "Boğaziçi Komedi Kulübü: Kadıköy Açık Mikrofon Stand-up Gecesi",
    "Boğaziçi Komedi Kulübü - Kadıköy Açık Mikrofon Stand-up",
  ],
  ["Gökhan Ünver Stand Up", "Gökhan Ünver 'Çok Tanıdık'"],
  ["Mustafa Boz - Tek Kişilik Stand Up", "Mustafa Boz Stand Up"],
  ["Operadaki Hayalet", "Operadaki Hayalet Tiyatro Oyunu"],
  ["Kütüphanedeki Ceset", "Kütüphanedeki Ceset Tiyatro Oyunu"],
  ["Suç ve Ceza", "Suç ve Ceza Oyunu"],
  ["Çiftler Çiftler", "Çiftler Çiftler Oyunu"],
  ["Sesler - Salih Bademci", "Salih Bademci - Sesler"],
  ["Tek Hücreliler - Aşkım Kapışmak", "Aşkım Kapışmak - Tek Hücreliler"],
  ["Memleket Kumaşı – Sunay Akın", "Sunay Akın - Memleket Kumaşı"],
  [
    "Aleksandrov Rus Kızılordu Korosu ve Dans Topluluğu İle Hayko Cepkin Konserleri",
    "Aleksandrov Rus Kızılordu Korosu ve Dans Topluluğu İle Hayko Cepkin",
  ],
  ["Bir İdam Mahkumunun Son Günü", "Bir İdam Mahkumunun Son Günü Oyunu"],
  ["Kasımpaşa Mevlevihanesi Semazen Töreni", "Kasımpaşa Mevlevihanesi'nde Semazen Töreni"],
  [
    "Ölü'n Bizi Ayırana Dek",
    "Ölün Bizi Ayırana Dek",
    "Ölü’n Bizi Ayırana Dek",
    "Ölü'n Bizi Ayırana Dek Oyunu",
  ],
  ["Mahşer-i Cümbüş", "Mahşer-i Cümbüş Oyunu"],
  ["Haybeden Gerçeküstü Aşk", "Haybeden Gerçeküstü Aşk Oyunu"],
  ["Aşk Hikayen Düşmüş", "Aşk Hikayen Düşmüş Oyunu"],
  ["Bi Şaka Stand up Programı", "Bi Şaka Stand Up"],
  ["Fırat Tanış ile Gelin Tanış Olalım", "Fırat Tanış ile Gelin Tanış Olalım Oyunu"],
  ["Anna Karenina", "Anna Karenina Tiyatro Oyunu"],
  ["Berkay Konseri", "Berkay"],
  ["Ozbi Konseri", "Ozbi"],
  ["Kolpa", "Kolpa Konseri"],
  ["Duman Konseri", "Duman"],
  ["Simge", "Simge Konseri"],
  ["Mavi", "Mavi Konseri"],
  ["Jakuzi", "Jakuzi Konseri"],
  ["Malleus", "Malleus Oyunu"],
  ["Ahududu", "Ahududu Oyunu"],
  ["Alpay Erdem - Geçenlerde", "Alpay Erdem - Geçenlerde Stand Up"],
  [
    "Kadıköy Stand-up Gecesi",
    "Kadıköy Stand Up Gecesi Cuma 20:00",
    "Kadıköy Stand Up Gecesi Cuma 21:45",
    "Kadıköy Stand Up Gecesi Cumartesi 19:00",
    "Kadıköy Stand up Gecesi Pazar 19:00",
    "Kadıköy Stand Up Gecesi Çarşamba 20:30",
    "Kadıköy Stand up Gecesi Cumartesi 21:45",
  ],
  [
    "Kadıköy Stand Up Gecesi Açık Mikrofon",
    "Kadıköy Stand Up Gecesi Pazartesi Açık Mikrofon",
    "Kadıköy Stand Up Gecesi Salı Açık Mikrofon",
  ],
  [
    "Hikayeden Adamlar 'Mahalle' - Youtube Çekimi - 3.sezon",
    "Hikayeden Adamlar - Mahalle - Youtube Çekimi",
  ],
  [
    "XI. Gastromasa Istanbul Uluslararası Gastronomi Konferansı & Fuarı",
    "Gastromasa İstanbul Uluslararası Gastronomi Konferansı & Fuarı",
  ],
  ["Burak Altuni Akustik Flamenko Konser", "Burak Altuni Akustik Flamenko Konseri"],
  ["Benyunusyılmaz - Olay Yeri İnceleme Stand Up", "Yunus Yılmaz - Olay Yeri İnceleme Stand Up"],
  ["Lumera Trio Sezen Aksu Şarkıları", "Lumera - Sezen Aksu Şarkıları"],
  ["Celile (Nazım Hikmet'in Annesi) Oyunu", "Celile (Nazım Hikmet'in Annesi)"],
  ["Çocuklar İçin Yaratıcı Drama Eğitimi", "Çocuklar için Yaratıcı Drama Eğitim"],
  ["Güncel Gürsel Artıktay Konseri", "Güncel Gürsel Artıktay"],
] as const;

const titleSeeds = new Map<string, string>();
for (const group of TITLE_ALIAS_GROUPS) {
  const key = `title:${normalizeIdentityText(group[0])}`;
  for (const alias of group) titleSeeds.set(normalizeIdentityText(alias), key);
}

const WORKSHOP_PROGRAMS = [
  [
    "hat",
    "İstanbul Workshops Hat Sanatı Atölyesi",
    "Hat Sanatı Atölyesi",
    "Pirinç Çerçeveli Cam Üzerine Hat/Kaligrafi Sanatı Atölyesi",
  ],
  ["tezhip", "İstanbul Workshops Tezhip Atölyesi", "Tezhip Atölyesi"],
  ["cini", "İstanbul Workshops Çini Atölyesi", "Çini Atölyesi", "Türk Çini Resim Sanatı Atölyesi"],
  ["vitray", "İstanbul Workshops Vitray Atölyesi", "Vitray Atölyesi"],
  ["parfum", "İstanbul Workshops Parfüm Atölyesi", "Parfüm Atölyesi", "Parfüm Tasarımı Atölyesi"],
  ["deri", "İstanbul Workshops Deri İşçiliği Atölyesi", "Deri İşçiliği Atölyesi"],
  [
    "ebru",
    "İstanbul Workshops Ebru ile Bez Çanta Tasarım Atölyesi",
    "Ebru Bez Çanta Sanat Atölyesi",
    "Ebru ile Bez Çanta Tasarım Atölyesi",
  ],
] as const;
const workshopTitles = new Map<string, string>();
for (const [program, ...titles] of WORKSHOP_PROGRAMS)
  for (const title of titles) workshopTitles.set(normalizeIdentityText(title), program);

export function titleSeedIdentity(
  listing: IdentityListing,
  venueSeed: string | undefined,
): string | undefined {
  const normalized = normalizeIdentityText(listing.title);
  if (venueSeed === "venue:reviewed:fabrikafa") {
    const program = workshopTitles.get(normalized);
    if (program) return `title:reviewed:fabrikafa:${program}`;
  }
  if (
    venueSeed === "venue:reviewed:bagimsiz-sanat-vakfi" &&
    ["istanbul workshops mozaik lamba atolyesi", "mozaik lamba atolyesi"].includes(normalized)
  )
    return "title:reviewed:mozaik-lamba";
  if (
    venueSeed === "venue:reviewed:atolye-sahi" &&
    [
      "istanbul workshops seramik atolyesi tek seans workshop",
      "seramik atolyesi tek seans workshop",
      "seramik atolyesi",
    ].includes(normalized)
  ) {
    const description = normalizeIdentityText(listing.description);
    if (
      normalized === "seramik atolyesi" &&
      (!description.includes("tek oturumluk deneyim") || description.includes("aylik kurs"))
    )
      return undefined;
    return "title:reviewed:seramik-tek-seans";
  }
  return titleSeeds.get(normalized);
}
