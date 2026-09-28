export const EXPERIENCES = {
  laughter: { label: 'Gülmek', meaning: 'A desire to laugh or enjoy humour; this does not require stand-up or a comedy genre.', query: 'laughter comedy humour komedi mizah kahkaha gülmek' },
  learning: { label: 'Yeni şeyler öğrenmek', meaning: 'A desire to learn through educational talks, history, science, or similar events; this does not require a workshop.', query: 'learning educational talks history science öğrenmek eğitim tarih bilim' },
  participation: { label: 'Etkinliğe aktif katılmak', meaning: 'A separately expressed wish for audience interaction or joining an interactive activity. A wish to dance or learn alone does not add this broader preference; retain both only when audience interaction is independently requested.', query: 'interactive audience participation interaktif katılım katılımcı etkileşim' },
  dancing: { label: 'Dans etmek', meaning: 'A desire for the attendee to dance; watching ballet or another dance performance alone does not satisfy it.', query: 'attendee dancing dance floor dans etmek' },
} as const;

export type Experience = keyof typeof EXPERIENCES;
export const EXPERIENCE_VALUES = Object.keys(EXPERIENCES) as Experience[];
