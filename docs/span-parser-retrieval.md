# Span parser retrieval integration

The application supports `INPUT_INTERPRETER=span-v2` behind its existing runtime
configuration. The default interpreter is unchanged. `/api/site` advertises the
request version; the UI sends a versioned plan through follow-ups, alternatives,
and retries, shows grouped required and preferred conditions, and clears it on
a new search. Changing interpreter versions requires a new search.

The serving transport imports the pure parser core and makes one bounded
TypeSafe request using server credentials. It does not import the standalone
benchmark cache, key loader, or optional GLiNER service. Invalid provider answers,
ambiguity, and outages preserve the previous plan and require clarification.

Retrieval evaluates the entire hard condition tree against every eligible
catalog event before hybrid lexical/Voyage retrieval selects at most 16 distinct
candidates. The same admitted pool serves fallback search. Jev receives the
exact tree and source evidence; every distinct shortlisted event passing the
existing support threshold may be returned. Query text is not reparsed into
another set of constraints. Existing cached document vectors and conservative
session/offer identity remain in use.

Unknown source evidence cannot satisfy a hard constraint or its negation.
Conflicting positive and negative evidence remains unknown. Required generic
topics without a supported genre mapping, neighborhoods, outdoors/beginner
policies, approximate budgets, nearest ordering without a location, and
conditional party-size logic currently require clarification. Optional wishes
remain preferences. Group budgets require one unambiguous party count.

Offline tests exercise extraction, actual parser composition with supplied model
answers, grouped source admission, initial requests, follow-ups, reset, failure
preservation, full-catalog retrieval, the 16-candidate bound, ranking payloads,
and fallback parity. Browser fixtures mock provider answers. These establish
deterministic integration behavior, not current model interpretation accuracy.
No new paid model calls or deployment were performed. The historical 197/200
development replay does not measure this revision; an independently reviewed,
bounded live language evaluation remains the next gate before activation.

## Verification on October 2

On the uncommitted implementation based on `4d5adca`, Node 22.23.3 passed all
626 web tests, typecheck, lint, the Worker build and compiled smoke checks,
and the isolated Node build and compiled smoke check. Deployment configuration
checks passed, including 31 configuration tests after adding the opt-in setting.
The T3 browser showed `(konser VEYA tiyatro)` separately from the optional
`sakin` preference and verified plan clearing with a mocked response.

Raw local logs are preserved in `web/work/span-retrieval-final-checks.log`,
`span-retrieval-compiled-checks.log`, `span-retrieval-node-checks.log`, and
`span-retrieval-config-checks.log`. The compiled-check log preserves the initial
Node packaging failure; the later Node log records the successful correction.
`web/work/span-retrieval-source-manifest.txt` records the final changed-source
hashes. Later configuration/documentation edits do not change the tested runtime
modules. Linux image verification in exact-revision CI and live interpretation
evaluation remain outstanding; these local checks do not establish deployment
or public-launch readiness.
