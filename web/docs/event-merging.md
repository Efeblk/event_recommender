# Cross-provider event matching

The v1 catalog resolves event identity before it publishes a search snapshot.
Search requests read the prepared sessions. They do not merge source listings.
The collector checkpoint keeps the separate source records.

[`collector/identity/resolve.ts`](../../collector/identity/resolve.ts) is the
identity authority. It resolves venues first. It then resolves sessions.
[`web/lib/materialized-catalog.ts`](../lib/materialized-catalog.ts) converts each
resolved session into one search record with its provider offers.

## Session rules

Listings must have the same city and exact start instant. They must also have
the same resolved venue and a supported title match. A title match can use the
normalized title, a narrow containment rule, or a reviewed title seed.

The resolver blocks a merge when source evidence conflicts. Examples include
different audience limits, workshop and performance formats, or incompatible
adaptations. A resolved session cannot contain two listings from one provider.
Every pair in a multi-listing session must be compatible. Different dates,
times, venues, or supported program identities stay separate.

Reviewed venue and title seeds are in
[`collector/identity/seed-overrides.ts`](../../collector/identity/seed-overrides.ts).
They never bypass the city, time, venue, provider, or policy checks. Examples
include `Cafe Theatre` / `Cafe Theatre Koşuyolu`, `Gökhan Ünver Stand Up` /
`Gökhan Ünver 'Çok Tanıdık'`, and `Operadaki Hayalet` /
`Operadaki Hayalet Tiyatro Oyunu`.

The Ada Bar seeds join reviewed `Kadıköy Stand-up Gecesi` schedule titles only
at the same start instant and resolved venue. The open-microphone titles use a
separate seed. The İnfiniti Sahne open-microphone seed also stays separate from
`Bi Şaka`. These rules do not enable general performer matching or general
suffix removal.

## Published record

The materializer keeps each provider offer with its source ID, URL, price,
currency, category, venue, availability, and check time. It removes duplicate
offer IDs. If an available offer exists, the card uses an available offer. It
selects the lowest comparable known price for the card. The other offers remain
on the session record.

Eligibility runs before the session enters the published catalog. A stale,
cancelled, sold-out, or ambiguous source record cannot make an event bookable.
The source checkpoint still preserves its evidence.

The session ID includes the city, exact start instant, resolved venue, and
title identity. Canonical production and show keys support later shortlist
deduplication. If the representative has no address, the materializer fills it
only when all nonempty session addresses agree after normalization.

Matching is conservative. An unreviewed alias can remain as a separate event.
Add source evidence and positive and negative fixtures before you widen a rule.
The current regression coverage is in
[`collector/tests/identity.test.mjs`](../../collector/tests/identity.test.mjs)
and
[`web/tests/materialized-catalog.test.ts`](../tests/materialized-catalog.test.ts).
