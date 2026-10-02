# Learned semantic extractor diagnostic

Isolated prototype: code prepares exact values; Gemini 3.1 Flash-Lite proposes a source-referenced constraint tree and state operations; code validates references, Boolean scope, explicit budget basis and atomic transitions. It imports the shared experiment contract/reducer, never the application search path. No dependency installation, app integration, database change or deployment occurred.

**Current result: blocked and incomplete.** One known complex request was truncated; all three completed fresh Turkish clear requests were rejected. The next request returned Vertex HTTP 429, stopping the run without retries. English, ambiguity and unsupported controls were not measured. This is not evidence of general model incapability or measured 0/16 clear accuracy.

The protocol itself needs redesign: universal node/operation records require irrelevant fields and leave reference namespaces unconstrained. Responses put literals where candidate IDs were required, add targets where none were allowed, and invalid fields on reset/connectives. Prepared values omit ordinary named-month dates; source guards mishandle Turkish grammatical attachment. One returned response also omits an explicit attendee count, a genuine semantic omission beyond format problems. Read the [reviewed evidence and next design boundary](../../../docs/response-quality-validation-2026-09-30.md#learned-extractor-diagnostic-october-1).

Offline inspection, from `web/` with Node 22.13+:

```powershell
node --experimental-strip-types --test experiments/semantic-learned/compiler.test.ts
node --experimental-strip-types experiments/semantic-learned/cli.mjs request.json
```

The CLI emits a provider request without inference by default. Input JSON contains `utterance`, `language` (`tr`/`en`), `referenceDate` (ISO date), `timezone` (`Europe/Istanbul`) and `previousState` (null or the shared typed state). `--call --id=unique-id` requires the finite ignored authorization ledger; the preserved failed ledger blocks further calls. Never delete failures or reset the budget to resume.

`run.mjs freeze` snapshots runtime sources and validates independently authored gold before inference. `run.mjs run` carries actual accepted state across chains, records original requests/raw provider responses, scores full meanings, and stops on a provider failure. Historical freezes prevent silently rerunning changed code as the original experiment. A post-evaluation lint cleanup removed one unused provider helper; original evaluated sources remain preserved, with equivalence recorded in the final receipt.

The independent author froze 40 constructed cases. Metadata-only selection retained 24 (12 Turkish/12 English, 16 clear/4 ambiguous/4 unsupported, six chained turns); four calls were reserved for final confirmation. Only three fresh cases completed. Labels are agent-authored, not external human annotation. The compiler implementation worker did not read fresh gold until source freeze. Provider inputs never contain gold.

The first attempt received HTTP 400 because Vertex rejects empty enum members. The second freeze maps those inapplicable transport strings reversibly to `__none__`, with no semantic-rule or corpus changes before model output. Both attempt receipts and reservations remain cumulative. Four inference responses contain usage: list-price estimate **USD 0.00518275**, excluding hosting and unverified billing/credits. Two failed generation requests supplied no usage metadata; their reservations remain counted. No Jev or Voyage calls occurred.

Raw ignored evidence lives in `web/work/semantic-learned-20261001/`; the corrected attempt is under `schema-corrected/`. The corpus, policies, freezes, source snapshots, every response, ledger, summary and final review are retained there. No automatic retries, prompt tuning against outputs, model hopping or production readiness claim follows this experiment.
