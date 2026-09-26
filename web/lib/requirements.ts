import type { EventRecord, Message } from './types.ts';

export type RequirementKind =
  | 'genre'
  | 'activity'
  | 'audience'
  | 'content'
  | 'accessibility';
export type RequirementPolicy = 'require_support' | 'exclude_positive_evidence';

export interface Requirement {
  kind: RequirementKind;
  /** Canonical value. A pipe separates explicitly requested alternatives. */
  value: string;
  policy: RequirementPolicy;
}

export type RequirementStatus = 'supported' | 'contradicted' | 'unknown';

export interface RequirementCheck {
  requirement: Requirement;
  status: RequirementStatus;
  evidence: string[];
}

type Term = { positive: RegExp; negative?: RegExp };

const terms: Record<string, Term> = {
  jazz: {
    positive: /\b(?:jazz|caz)\b/,
    negative:
      /\b(?:not|no|without|degil|olmayan)\s+(?:a\s+)?(?:jazz|caz)\b|\b(?:jazz|caz)\b[^.!?]{0,24}\b(?:degil(?:dir)?|yok)\b/,
  },
  blues: {
    positive: /\bblues\b/,
    negative:
      /\b(?:not|no|without)\s+blues\b|\bblues\s+(?:degil(?:dir)?|yok)\b/,
  },
  rock: {
    positive: /\brock\b/,
    negative: /\b(?:not|no|without)\s+rock\b|\brock\s+(?:degil(?:dir)?|yok)\b/,
  },
  electronic: {
    positive:
      /\b(?:electronic music|elektronik muzik|techno|house music|house muzik)\b/,
    negative:
      /\b(?:not|no|without)\s+(?:electronic music|techno)|\belektronik muzik\s+(?:degil|yok)\b/,
  },
  rap: {
    positive: /\b(?:rap|hip[ -]?hop)\b/,
    negative:
      /\b(?:not|no|without)\s+(?:rap|hip[ -]?hop)\b|\brap\s+(?:degil|yok)\b/,
  },
  alcohol_free: {
    positive:
      /\b(?:alcohol[ -]free (?:venue|event|setting)|no alcohol (?:is )?(?:served|sold|permitted)|alkolsuz (?:mekan|etkinlik|ortam)|alkol (?:servisi|satisi) (?:yok|yapilmaz)|alkol yasak)\b/,
    negative:
      /\b(?:alcohol (?:is )?(?:served|sold)|alkollu (?:mekan|etkinlik)|alkol (?:servisi|satisi) (?:var|yapilir))\b/,
  },
  classical: {
    positive: /\b(?:classical|klasik\s+(?:muzik|muzig|repertuvar)[a-z]*)\b/,
    negative:
      /\b(?:not|no|without)\s+classical\b|\bklasik\s+(?:degil(?:dir)?|yok)\b/,
  },
  comedy: {
    positive: /\b(?:comedy|komedi|stand[ -]?up)\b/,
    negative:
      /\b(?:not|no|without)\s+(?:comedy|stand[ -]?up)\b|\b(?:komedi|stand[ -]?up)\s+(?:degil(?:dir)?|yok)\b/,
  },
  drama: {
    positive: /\b(?:drama|dramatic|dramatik|dram(?:dir)?)\b/,
    negative:
      /\b(?:not|no|without)\s+(?:drama|dramatic)\b|\bdramatik\s+(?:degil(?:dir)?|yok)\b/,
  },
  kayaking: {
    positive: /\b(?:kayak(?:ing)?|kano)\b/,
    negative:
      /\b(?:not|no|without)\s+kayak(?:ing)?\b|\b(?:kayak|kano)\s+(?:degil(?:dir)?|yok)\b/,
  },
  rowing: {
    positive: /\b(?:rowing|kurek)\b/,
    negative:
      /\b(?:not|no|without)\s+rowing\b|\bkurek\s+(?:degil(?:dir)?|yok)\b/,
  },
  children: {
    positive:
      /\b(?:(?:for|aimed at|suitable for)\s+(?:child(?:ren)?|kids?)|child(?:ren)?'?s\s+(?:event|show|theatre|theater)|kids?\s+(?:event|show)|cocuklar ve aileleri icin|cocuk(?:lar|lara|larin)?\s+(?:icin|oyunu|tiyatrosu|uygun)|cocuklara\s+(?:yonelik|uygun)|cocuk etkinligi)\b/,
    negative:
      /\b(?:adults? only|yetiskin(?:lere)? ozel|cocuk(?:lar)? (?:icin )?(?:degil|uygun degil))\b/,
  },
  family_friendly: {
    positive:
      /\b(?:family[ -]?friendly|suitable for (?:the whole )?famil(?:y|ies)|all[ -]?ages|aile(?:ler|ye)? uygun|ailece(?: keyifle)? izlen(?:ebilecek|ebilir)|ailenizle[^.!?]{0,50}katilabileceginiz|ailelerin birlikte[^.!?]{0,80}cocuklar[^.!?]{0,80}yetiskinler)\b/,
    negative:
      /(?:\b(?:not family[ -]?friendly|adults? only|18 yas ve uzeri|yetiskin(?:lere)? ozel|aile(?:ler|ye)? uygun degil|ailece izlenemez)\b|\b18\s*\+(?!\w))/,
  },
  swearing: {
    positive:
      /\b(?:swear(?:ing)?|profanity|explicit language|curse words?|kufur(?:lu)?|argo)\b/,
    negative:
      /\b(?:no|without|free (?:of|from))\s+(?:swearing|profanity|explicit language|curse words?)\b|\b(?:kufur|argo)\s+(?:yok|icermez)|\bkufursuz\b/,
  },
  sexual_content: {
    positive:
      /\b(?:sexual content|sexual humour|sexual humor|sex jokes?|adult themes?|cinsellik|cinsel (?:icerik|mizah|espri))\b/,
    negative:
      /\b(?:no|without|free (?:of|from))\s+(?:sexual content|sexual humour|sexual humor|sex jokes?)\b|\b(?:cinsel (?:icerik|mizah|espri)|cinsellik)\s+(?:yok|icermez)|\bcinsellik icermeyen\b/,
  },
  step_free: {
    positive:
      /\b(?:step[ -]?free|barrier[ -]?free|wheelchair access(?:ible)?|basamaksiz|engelsiz erisim|tekerlekli sandalye erisimi)\b/,
    negative:
      /\b(?:not|isn't|is not)\s+(?:step[ -]?free|wheelchair access(?:ible)?)|\b(?:basamaksiz|engelsiz erisim|tekerlekli sandalye erisimi)\s+(?:degil(?:dir)?|yok|bulunmuyor|bulunmamaktadir|saglanmiyor)\b/,
  },
  accessible_toilet: {
    positive:
      /\b(?:accessible (?:toilet|restroom|bathroom)|disabled (?:toilet|restroom)|engelli tuvaleti|erisilebilir tuvalet(?:i)?)\b/,
    negative:
      /\b(?:no|without)\s+(?:accessible|disabled)\s+(?:toilet|restroom|bathroom)|\b(?:engelli|erisilebilir) tuvalet(?:i)?\s+yok\b/,
  },
  quiet: {
    positive: /\b(?:quiet|sessiz|sakin)\b/,
    negative: /\b(?:not quiet|loud|gurultulu|sessiz degil)\b/,
  },
  seated: {
    positive:
      /\b(?:seated|assigned seating|seats? provided|oturmalı|oturmali|numarali koltuk)\b/,
    negative: /\b(?:standing only|ayakta|oturmasiz)\b/,
  },
  romantic: {
    positive:
      /\b(?:romantic|romantik)\b[^.!?]{0,36}\b(?:atmosphere|ambience|setting|evening|experience|place|venue|ortam|atmosfer|ambiyans|aksam|mekan|yer|deneyim)\b|\b(?:atmosphere|ambience|setting|evening|experience|place|venue|ortam|atmosfer|ambiyans|aksam|mekan|yer|deneyim)\b[^.!?]{0,36}\b(?:romantic|romantik)\b/,
    negative:
      /\b(?:not|isn't|is not)\s+romantic\b|\bromantik\s+(?:degil(?:dir)?|olmayan)\b/,
  },
  uncrowded: {
    positive:
      /\b(?:uncrowded|not crowded|isn't crowded|is not crowded|tenha|kalabalik (?:degil(?:dir)?|olmayan))\b/,
    negative:
      /(?<!not )(?<!isn't )(?<!is not )\bcrowded\b|\bkalabalik\b(?!\s+(?:degil(?:dir)?|olmayan))|\b(?:cok yogun|tiklim tiklim)\b/,
  },
};

const genreEntries: Array<[string, RegExp]> = [
  ['jazz', /\b(?:jazz|caz)\b/],
  ['blues', /\bblues\b/],
  ['rock', /\brock\b/],
  ['electronic', /\b(?:electronic music|elektronik muzik|techno)\b/],
  ['rap', /\b(?:rap|hip[ -]?hop)\b/],
  ['classical', /\b(?:classical|klasik)\b/],
  ['comedy', /\b(?:comedy|komedi|stand[ -]?up)\b/],
  ['drama', /\b(?:drama|dramatic|dramatik|dram(?:dir)?)\b/],
];
const activityEntries: Array<[string, RegExp]> = [
  ['kayaking', /\b(?:kayak(?:ing)?|kano)\b/],
  ['rowing', /\b(?:rowing|kurek)\b/],
];

function normalize(value: string) {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[’']/g, "'");
}

function isNegated(text: string, matchIndex: number, matchLength: number) {
  const boundary = /[,.!?;]|\b(?:but|ama|fakat|ancak)\b/;
  const before = text.slice(0, matchIndex).split(boundary).at(-1) ?? '';
  const after = text
    .slice(matchIndex + matchLength)
    .split(boundary)[0]
    .slice(0, 80);
  const coordinatedEnglish =
    /\b(?:no|not|without|excluding?)\s+(?:(?:jazz|caz|rock|blues|classical|klasik|comedy|komedi|stand[ -]?up)\s+(?:or|and)\s+)*$/;
  const genreList =
    '(?:jazz|caz|rock|blues|classical|klasik|comedy|komedi|stand[ -]?up)';
  const trailingListNegation = new RegExp(
    `^\\s*,\\s*${genreList}(?:\\s*(?:,|ve|veya|ya da|or|and)\\s*${genreList})*\\s+(?:istemiyorum|istemem|olmasin|haric)\\b`,
  );
  return (
    trailingListNegation.test(text.slice(matchIndex + matchLength)) ||
    coordinatedEnglish.test(before) ||
    /^\s*(?:degil|olmasin|istemiyorum|istemem|haric|to\b)/.test(after) ||
    /^[^.!?]{0,50}\b(?:istemiyorum|istemem|olmasin|haric)\b/.test(after)
  );
}

function mentionedValues(text: string, entries: Array<[string, RegExp]>) {
  return entries.flatMap(([value, pattern]) => {
    const match = pattern.exec(text);
    return match && !isNegated(text, match.index, match[0].length)
      ? [value]
      : [];
  });
}

function upsert(requirements: Requirement[], requirement: Requirement) {
  const index = requirements.findIndex(
    (item) =>
      item.kind === requirement.kind && item.policy === requirement.policy,
  );
  if (index >= 0) requirements.splice(index, 1, requirement);
  else requirements.push(requirement);
}

function removeExcludedValues(
  requirements: Requirement[],
  kind: RequirementKind,
  values: string[],
) {
  const exclusion = requirements.find(
    (item) => item.kind === kind && item.policy === 'exclude_positive_evidence',
  );
  if (!exclusion) return;
  const retained = exclusion.value
    .split('|')
    .filter((value) => !values.includes(value));
  if (retained.length) exclusion.value = retained.join('|');
  else requirements.splice(requirements.indexOf(exclusion), 1);
}

function removeRequiredValues(
  requirements: Requirement[],
  kind: RequirementKind,
  values: string[],
) {
  for (let i = requirements.length - 1; i >= 0; i--) {
    const requirement = requirements[i];
    if (requirement.kind !== kind || requirement.policy !== 'require_support')
      continue;
    const retained = requirement.value
      .split('|')
      .filter((value) => !values.includes(value));
    if (retained.length) requirement.value = retained.join('|');
    else requirements.splice(i, 1);
  }
}

function addIndependentRequirement(
  requirements: Requirement[],
  requirement: Requirement,
) {
  if (
    !requirements.some(
      (item) =>
        item.kind === requirement.kind &&
        item.value === requirement.value &&
        item.policy === requirement.policy,
    )
  )
    requirements.push(requirement);
}

function strictContentRequested(text: string) {
  return /\b(?:omit|exclude|skip|leave out|onerme|onermeyin|oneri yapma|ele|cikar)\b[^.!?]{0,80}\b(?:uncertain|unverified|unknown|emin olmad[a-z]*|emin degil[a-z]*|dogrulanmam|belirsiz)\b|\b(?:uncertain|unverified|unknown|emin olmad[a-z]*|emin degil[a-z]*|dogrulanmam|belirsiz)\b[^.!?]{0,80}\b(?:omit|exclude|skip|onerme|onermeyin|ele|cikar)\b/.test(
    text,
  );
}

function requestedChildAge(text: string) {
  const patterns = [
    /\b(\d{1,2})\s*yas(?:inda|indaki)?\s+(?:kizim|oglum|cocugum|cocuk(?:la|larla)?)/,
    /\b(?:my\s+)?(\d{1,2})[ -]year[ -]old\s+(?:child|daughter|son|kid)/,
    /\b(?:child|daughter|son|kid)\s+(?:aged?|age)\s+(\d{1,2})\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const age = Number(match[1]);
      if (age >= 0 && age <= 17) return age;
    }
  }
  return null;
}

function explicitAgeSuitability(text: string, requestedAge: number) {
  const findings: RequirementStatus[] = [];
  const negated = (index: number, length: number) => {
    const before = text.slice(0, index);
    const clauseStart = Math.max(
      before.lastIndexOf('.'),
      before.lastIndexOf('!'),
      before.lastIndexOf('?'),
      before.lastIndexOf(';'),
    );
    const after = text.slice(index + length);
    const boundary = after.search(/[.!?;]/);
    const clause = text.slice(
      clauseStart + 1,
      boundary < 0 ? text.length : index + length + boundary,
    );
    return /\b(?:uygun degil(?:dir)?|onerilmez|giremez|kabul edilmez|not suitable|not allowed)\b/.test(
      clause,
    );
  };
  const ranges = [
    /\b(\d{1,2})\s*(?:-|–|—|ile)\s*(\d{1,2})\s*yas\s*(?:(?:cocuklar|grubu)\b[^.!?;]{0,30}\b(?:icin|uygun|onerilir)|(?:icin|uygun|onerilir)\b)/g,
    /\byas\s+grubu\s*(\d{1,2})\s*(?:-|–|—|ile)\s*(\d{1,2})\b/g,
    /\b(?:recommended\s+for\s+|for\s+(?:children|kids)\s+)?ages?\s*(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\b/g,
  ];
  for (const pattern of ranges) {
    for (const match of text.matchAll(pattern)) {
      const low = Number(match[1]);
      const high = Number(match[2]);
      const included = low <= requestedAge && requestedAge <= high;
      if (negated(match.index, match[0].length)) {
        if (included) findings.push('contradicted');
      } else {
        findings.push(included ? 'supported' : 'contradicted');
      }
    }
  }

  const minimums = [
    /\b(\d{1,2})\s*\+\s*yas\b/g,
    /\byas\s+siniri\s*:?\s*(\d{1,2})\s*\+/g,
    /\bages?\s*(\d{1,2})\s*\+/g,
    /\b(\d{1,2})\s*yas\s+ve\s+uzeri\b/g,
    /\b(?:ages?\s+)(\d{1,2})\s+(?:and\s+)?(?:up|over|older)\b/g,
  ];
  for (const pattern of minimums) {
    for (const match of text.matchAll(pattern)) {
      const included = requestedAge >= Number(match[1]);
      if (negated(match.index, match[0].length)) {
        if (included) findings.push('contradicted');
      } else {
        findings.push(included ? 'supported' : 'contradicted');
      }
    }
  }

  if (/\b18\s*\+/.test(text) && requestedAge < 18)
    findings.push('contradicted');

  const exactAges = [
    /\b(\d{1,2})\s*yas\s+(?:grubu|icin)\b/g,
    /\b(?:recommended\s+for|suitable\s+for)\s+(\d{1,2})[ -]year[ -]olds?\b/g,
  ];
  for (const pattern of exactAges) {
    for (const match of text.matchAll(pattern)) {
      if (
        /\d\s*(?:-|–|—|ile)\s*$/.test(
          text.slice(Math.max(0, match.index - 8), match.index),
        )
      )
        continue;
      const included = requestedAge === Number(match[1]);
      if (negated(match.index, match[0].length)) {
        if (included) findings.push('contradicted');
      } else {
        findings.push(included ? 'supported' : 'contradicted');
      }
    }
  }

  const excludedBelow = text.matchAll(
    /\b(\d{1,2})\s*yas\s+alti\s+(?:giremez|kabul edilmez)\b/g,
  );
  for (const match of excludedBelow)
    findings.push(
      requestedAge < Number(match[1]) ? 'contradicted' : 'supported',
    );

  return findings.includes('contradicted')
    ? 'contradicted'
    : findings.includes('supported')
      ? 'supported'
      : 'unknown';
}

/** Derives only requirements that must be decided from source evidence. */
export function deriveRequirements(
  message: string,
  effectiveHistory: Message[],
): Requirement[] {
  const turns = effectiveHistory
    .filter((item) => item.role === 'user')
    .map((item) => item.content);
  if (turns.at(-1) !== message) turns.push(message);
  const requirements: Requirement[] = [];

  for (const raw of turns) {
    const text = normalize(raw);
    const childAge = requestedChildAge(text);
    const genres = mentionedValues(text, genreEntries);
    const excludedGenres = genreEntries.flatMap(([value, pattern]) => {
      const match = pattern.exec(text);
      return match && isNegated(text, match.index, match[0].length)
        ? [value]
        : [];
    });
    const activities = mentionedValues(text, activityEntries);
    if (genres.length) {
      removeExcludedValues(requirements, 'genre', genres);
      upsert(requirements, {
        kind: 'genre',
        value: genres.join('|'),
        policy: 'require_support',
      });
    }
    if (excludedGenres.length) {
      removeRequiredValues(requirements, 'genre', excludedGenres);
      upsert(requirements, {
        kind: 'genre',
        value: excludedGenres.join('|'),
        policy: 'exclude_positive_evidence',
      });
    }
    if (activities.length)
      upsert(requirements, {
        kind: 'activity',
        value: activities.join('|'),
        policy: 'require_support',
      });

    if (
      /\b(?:no|without)\b[^.!?]{0,40}\b(?:children|kids?)\b|\bcocuk(?:lar| etkinligi| oyunu)?\b[^.!?]{0,50}\b(?:olmasin|istemiyorum|istemem|haric)\b/.test(
        text,
      )
    )
      upsert(requirements, {
        kind: 'audience',
        value: 'children',
        policy: 'exclude_positive_evidence',
      });

    const familySuitability = text.match(
      /\b(?:family[ -]?friendly|suitable for (?:the whole )?famil(?:y|ies)|all[ -]?ages|aile(?:ler|ye)? uygun|ailece(?: keyifle)? izlen(?:ebilecek|ebilir)|ailemle izleyebilecegim)\b/,
    );
    if (familySuitability) {
      const negated = isNegated(
        text,
        familySuitability.index!,
        familySuitability[0].length,
      );
      if (negated)
        removeRequiredValues(requirements, 'audience', ['family_friendly']);
      else
        addIndependentRequirement(requirements, {
          kind: 'audience',
          value: 'family_friendly',
          policy: 'require_support',
        });
    }

    const childSuitability = text.match(
      /\b(?:suitable for (?:children|kids?)|cocuk(?:lar|lara)?\s+(?:icin|uygun)|cocuklara\s+yonelik|cocuk etkinligi)\b/,
    );
    if (
      childAge !== null ||
      (childSuitability &&
        !isNegated(text, childSuitability.index!, childSuitability[0].length))
    )
      addIndependentRequirement(requirements, {
        kind: 'audience',
        value: 'children',
        policy: 'require_support',
      });
    if (childAge !== null)
      addIndependentRequirement(requirements, {
        kind: 'audience',
        value: `age:${childAge}`,
        policy: 'require_support',
      });

    const sharedContentProhibition =
      /\b(?:swearing|profanity|explicit language|kufur|argo)\b[^.!?]{0,50}\b(?:sexual (?:content|humou?r)|sex jokes?|cinsel (?:icerik|mizah|espri)|cinsellik)\b[^.!?]{0,24}(?:\b(?:olmasin|istemiyorum|istemem|yok)\b|;|$)/.test(
        text,
      );
    const noSwearing =
      /\b(?:no|without)\s+(?:swearing|profanity|explicit language)|\b(?:kufur|argo)\s+(?:olmasin|istemiyorum|istemem|yok)|\bkufursuz\b/.test(
        text,
      ) || sharedContentProhibition;
    const noSexual =
      /\b(?:no|without)\s+(?:sexual content|sexual humour|sexual humor|sex jokes?)|\b(?:cinsel (?:icerik|mizah|espri)|cinsellik)\s+(?:olmasin|istemiyorum|istemem|yok)|\bcinsellik icermesin\b/.test(
        text,
      ) || sharedContentProhibition;
    if (noSwearing)
      upsert(requirements, {
        kind: 'content',
        value: 'swearing',
        policy: strictContentRequested(text)
          ? 'require_support'
          : 'exclude_positive_evidence',
      });
    if (noSexual) {
      const existing = requirements.find(
        (item) =>
          item.kind === 'content' &&
          item.policy ===
            (strictContentRequested(text)
              ? 'require_support'
              : 'exclude_positive_evidence'),
      );
      const next = existing
        ? `${existing.value}|sexual_content`
        : 'sexual_content';
      upsert(requirements, {
        kind: 'content',
        value: next,
        policy: strictContentRequested(text)
          ? 'require_support'
          : 'exclude_positive_evidence',
      });
    }

    const contentWaiverClauses = text.split(
      /[,.!?;]|\b(?:ama|fakat|ancak|but)\b/,
    );
    const swearingWaived = contentWaiverClauses.some((clause) =>
      /\b(?:swearing|profanity|kufur|argo)\b[^.!?;]{0,30}\b(?:sorun degil|olabilir|serbest|okay|ok|fine|allowed|doesn't matter|does not matter)\b/.test(
        clause,
      ),
    );
    const sexualContentWaived = contentWaiverClauses.some((clause) =>
      /\b(?:sexual content|sexual humou?r|cinsel (?:icerik|mizah|espri)|cinsellik)\b[^.!?;]{0,30}\b(?:sorun degil|olabilir|serbest|okay|ok|fine|allowed|doesn't matter|does not matter)\b/.test(
        clause,
      ),
    );
    if (swearingWaived) {
      removeRequiredValues(requirements, 'content', ['swearing']);
      removeExcludedValues(requirements, 'content', ['swearing']);
    }
    if (sexualContentWaived) {
      removeRequiredValues(requirements, 'content', ['sexual_content']);
      removeExcludedValues(requirements, 'content', ['sexual_content']);
    }

    const waiverClauses = text.split(/[,.!?;]|\b(?:ama|fakat|ancak|but)\b/);
    const stepFreeWaived = waiverClauses.some((clause) =>
      /\b(?:step[ -]?free|basamaksiz(?: giris)?|engelsiz erisim|tekerlekli sandalye erisimi|wheelchair access(?:ible)?)\b[^.!?;]{0,24}\b(?:sart degil|gerekli degil|zorunlu degil|not required|not necessary)\b/.test(
        clause,
      ),
    );
    const toiletWaived = waiverClauses.some((clause) =>
      /\b(?:accessible (?:toilet|restroom)|erisilebilir tuvalet(?:i)?)\b[^.!?;]{0,24}\b(?:sart degil|gerekli degil|zorunlu degil|not required|not necessary)\b/.test(
        clause,
      ),
    );
    if (stepFreeWaived)
      removeRequiredValues(requirements, 'accessibility', ['step_free']);
    if (toiletWaived)
      removeRequiredValues(requirements, 'accessibility', [
        'accessible_toilet',
      ]);
    if (
      !stepFreeWaived &&
      /\b(?:step[ -]?free|basamaksiz|engelsiz erisim|tekerlekli sandalye erisimi|wheelchair access(?:ible)?)\b/.test(
        text,
      )
    )
      upsert(requirements, {
        kind: 'accessibility',
        value: 'step_free',
        policy: 'require_support',
      });
    if (
      !toiletWaived &&
      /\b(?:accessible (?:toilet|restroom|bathroom)|disabled (?:toilet|restroom)|engelli tuvaleti|erisilebilir tuvalet(?:i)?)\b/.test(
        text,
      )
    ) {
      const existing = requirements.find(
        (item) => item.kind === 'accessibility',
      );
      upsert(requirements, {
        kind: 'accessibility',
        value: existing
          ? `${existing.value}|accessible_toilet`
          : 'accessible_toilet',
        policy: 'require_support',
      });
    }

    const alcoholWaived =
      /\b(?:alkolsuz|alcohol[ -]free)\b[^.!?;]{0,36}\b(?:sart(?:ini)? kaldir|sart degil|not required|not necessary)\b/.test(
        text,
      );
    if (alcoholWaived)
      removeRequiredValues(requirements, 'activity', ['alcohol_free']);
    else if (/\b(?:alkolsuz|alcohol[ -]free|no alcohol)\b/.test(text))
      addIndependentRequirement(requirements, {
        kind: 'activity',
        value: 'alcohol_free',
        policy: 'require_support',
      });

    const explicitlyMandatory =
      /\b(?:must|has to|only|strictly|mutlaka|sart|olmak zorunda)\b/.test(text);
    if (explicitlyMandatory && /\b(?:quiet|sessiz|sakin)\b/.test(text))
      addIndependentRequirement(requirements, {
        kind: 'activity',
        value: 'quiet',
        policy: 'require_support',
      });
    if (
      explicitlyMandatory &&
      /\b(?:seated|oturmali|numarali koltuk)\b/.test(text)
    )
      addIndependentRequirement(requirements, {
        kind: 'activity',
        value: 'seated',
        policy: 'require_support',
      });

    const mandatoryExperience =
      /\b(?:kesin(?:likle)?|mutlaka|must|required|guaranteed|definitely|sart|olmak zorunda)\b/.test(
        text,
      );
    if (
      mandatoryExperience &&
      /\b(?:romantic|romantik)\b/.test(text) &&
      !/\b(?:not|isn't|is not)\s+romantic\b|\bromantik\s+(?:degil(?:dir)?|olmasin)\b/.test(
        text,
      )
    )
      addIndependentRequirement(requirements, {
        kind: 'activity',
        value: 'romantic',
        policy: 'require_support',
      });
    if (
      mandatoryExperience &&
      /\b(?:uncrowded|not crowded|isn't crowded|is not crowded|tenha|kalabalik (?:degil|olmayan|olmasin))\b/.test(
        text,
      )
    )
      addIndependentRequirement(requirements, {
        kind: 'activity',
        value: 'uncrowded',
        policy: 'require_support',
      });

    const experienceWaiverClauses = text.split(
      /[,.!?;]|\b(?:ama|fakat|ancak|but)\b/,
    );
    const romanticWaived = experienceWaiverClauses.some((clause) =>
      /\b(?:romantik(?: olmasi)?|romantic)\b[^.!?;]{0,24}\b(?:sart degil|gerekli degil|zorunlu degil|not required|not necessary)\b/.test(
        clause,
      ),
    );
    const uncrowdedWaived = experienceWaiverClauses.some((clause) =>
      /\b(?:uncrowded|not crowded|kalabalik olmamasi|kalabalik olmayan)\b[^.!?;]{0,24}\b(?:sart degil|gerekli degil|zorunlu degil|not required|not necessary)\b|\bkalabalik(?: da)? sorun degil\b|\bcrowds? (?:are|is) fine\b/.test(
        clause,
      ),
    );
    if (romanticWaived)
      removeRequiredValues(requirements, 'activity', ['romantic']);
    if (uncrowdedWaived)
      removeRequiredValues(requirements, 'activity', ['uncrowded']);
  }
  return requirements;
}

function evidenceText(event: EventRecord, kind: RequirementKind) {
  const fields =
    kind === 'accessibility'
      ? [event.title, event.description, event.venue, event.address]
      : [event.title, event.description, event.category];
  return normalize(fields.filter(Boolean).join('. '));
}

function evidenceFor(text: string, pattern: RegExp) {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((part) => pattern.test(part))
    .slice(0, 3)
    .map((part) => part.slice(0, 240));
}

export function checkRequirements(
  event: EventRecord,
  requirements: Requirement[],
): RequirementCheck[] {
  return requirements.map((requirement) => {
    const text = evidenceText(event, requirement.kind);
    if (
      requirement.kind === 'audience' &&
      requirement.value.startsWith('age:')
    ) {
      const requestedAge = Number(requirement.value.slice(4));
      const status = explicitAgeSuitability(text, requestedAge);
      return {
        requirement,
        status,
        evidence:
          status === 'unknown'
            ? []
            : text
                .split(/(?<=[.!?])\s+/)
                .filter((part) => /\b\d{1,2}\b/.test(part))
                .slice(0, 3),
      };
    }
    const values = requirement.value.split('|');
    const findings = values.map((value) => {
      const term = terms[value];
      if (!term)
        return { positive: false, negative: false, evidence: [] as string[] };
      const negativeEvidence = term.negative
        ? evidenceFor(text, term.negative)
        : [];
      const positiveEvidence = evidenceFor(text, term.positive).filter(
        (line) => !term.negative?.test(line),
      );
      return {
        positive:
          positiveEvidence.length > 0 &&
          (!(
            requirement.policy === 'require_support' &&
            (requirement.kind === 'genre' ||
              requirement.kind === 'accessibility' ||
              requirement.kind === 'audience')
          ) ||
            negativeEvidence.length === 0),
        negative: negativeEvidence.length > 0,
        evidence: [...negativeEvidence, ...positiveEvidence],
      };
    });
    const evidence = [
      ...new Set(findings.flatMap((finding) => finding.evidence)),
    ];
    if (requirement.policy === 'exclude_positive_evidence') {
      return {
        requirement,
        status: findings.some((item) => item.positive)
          ? 'contradicted'
          : 'supported',
        evidence,
      };
    }
    const conjunctive =
      requirement.kind === 'content' || requirement.kind === 'accessibility';
    if (requirement.kind === 'content') {
      return {
        requirement,
        status: findings.some((item) => item.positive)
          ? 'contradicted'
          : findings.every((item) => item.negative)
            ? 'supported'
            : 'unknown',
        evidence,
      };
    }
    if (
      requirement.value === 'romantic' ||
      requirement.value === 'uncrowded' ||
      requirement.value === 'alcohol_free'
    ) {
      return {
        requirement,
        status: findings.some((item) => item.negative)
          ? 'contradicted'
          : findings.some((item) => item.positive)
            ? 'supported'
            : 'unknown',
        evidence,
      };
    }
    return {
      requirement,
      status: (
        conjunctive
          ? findings.every((item) => item.positive)
          : findings.some((item) => item.positive)
      )
        ? 'supported'
        : findings.some((item) => item.negative)
          ? 'contradicted'
          : 'unknown',
      evidence,
    };
  });
}

export function meetsRequirements(
  event: EventRecord,
  requirements: Requirement[],
) {
  return checkRequirements(event, requirements).every(
    (check) => check.status === 'supported',
  );
}
