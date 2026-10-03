# Event preparation correction, September 29

The live input audit exposed duplicate concert cards and museum timestamps that
were not necessarily appointment times. Preparation now normalizes a terminal
generic `Konser`/`Konseri` label only for concerts. Matching session time, city,
specific venue and compatible policies still gate merging. Meaningful qualifiers
(including acoustic and tribute variants) remain part of identity. All provider
offers, prices, URLs and raw IDs are retained.

The frozen 13,423-record collection finished at 2026-09-29T06:23:48.107Z. Its
concert-suffix audit covers 143 exact-session families / 380 source records;
126 were newly covered and 17 already used literal aliases. The whole Dorock XL
family contains 79 records, with all 17 shorthand records identifying Kadıköy.
The prepared catalog changes from 7,846 to 7,719 groups and from 4,062 to 3,999
distinct embedding documents. No new document text is introduced by this fix.
The separate 150-document backlog came from the newer collection.

Biletix preparation preserves explicit admission validity windows separately
from source-proven timed sessions. Ambiguous museum/exhibition times remain
unknown. Cards no longer display validity boundaries or unknown visit times as
appointment times; hard start-time filters reject these uncertain values.
Conflicting timing evidence also becomes unknown. Original source timestamps
and embedding text are unchanged. Validity bounds are not daily opening hours.
Full date-range/opening-day eligibility and natural-language “after work”
interpretation are separate remaining work; this change does not claim them fixed.

Local evidence is preserved under `web/work/event-preparation-20260929/`:
`concert-suffix-family-audit.json`, `time-audit.md`, `timing-enrichment.json`,
`rebuild-receipt.json`, and deployment/activation receipts when executed.
Timing enrichment requires exact checkpoint, raw-event and saved-provider-HTML
hashes; it does not refresh collection timestamps. Public-launch gates remain
open. This is a correction to event preparation, not a new conversational-input
evaluation or authorization to publish production.
