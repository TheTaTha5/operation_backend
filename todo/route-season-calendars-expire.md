# Every route's operating calendar expires, and nothing warns anyone

A route's open/closed calendar is a set of dated windows in `route_seasons`. Once a date falls
past the last window, the resolution rule reports the route **closed** — because a route that
declares any open season is treated as closed outside all of them. That rule is correct and
matches the legacy frontend (`getDayStatus`, added 2026-07-24 precisely so off-season routes
stopped showing year-round). The problem is that the windows are finite and nobody is told when
one is about to run out.

Seeded from the legacy production database on 2026-08-26, every route already has an end date:

| Last open window ends | Routes | |
| --- | --- | --- |
| **2026-12-31** | r7, r8, r9, r10, r11 | Phi Phi Bamboo ×4 and Krabi + Phang Nga, all Panwa |
| 2027-04-30 | r1784542898734, r1784882390130 | the two Ranong day trips |
| 2027-05-15 | r1–r6, r12 | Similan ×5, Surin, Whale Shark |

The five Panwa routes are the near one: **127 days from the export date.** They are the
year-round programmes, so their single open window is `2026-01-01 → 2026-12-31` with no closed
season at all — the calendar was written for a year, not a season, and simply stops.

## What happens if nothing is done

From 2027-01-01, any date on r7–r11 resolves to closed. Whatever the service does with a closed
day — refuse the booking, mark it pending approval, hide it from the calendar — starts happening
to five of the fourteen routes at once, on New Year's Day.

Legacy has the identical cliff today, from the same rows. It is not a defect this service
introduced, and extending the windows there fixes both.

Decision on 2026-08-26 was to leave the data as it is rather than invent seasons on the
company's behalf. Extending them is an operational call about when those programmes run in
2027, not something to guess from a migration.

## What to do

1. Ask ops for the 2027 operating windows and extend `route_seasons` — through the frontend if
   it stays authoritative, otherwise as a migration here.
2. Add a check that fails loudly well before the edge, rather than discovering it from a refused
   booking. A route whose last open window ends within, say, 90 days should be surfaced
   somewhere someone reads — a health endpoint field, a log warning at boot, or a row in the
   admin view. The cheapest useful version is a query:

```sql
SELECT r.id, r.name, max(s.to_date) AS calendar_ends
FROM routes r JOIN route_seasons s ON s.route_id = r.id AND s.kind = 'open'
GROUP BY r.id, r.name
HAVING max(s.to_date) < current_date + INTERVAL '90 days'
ORDER BY 3;
```

3. Consider whether "no seasons at all" is the better model for a genuinely year-round route.
   A route with zero rows in `route_seasons` resolves to open on every date and never expires,
   which is arguably what r7–r11 actually mean. That is a data change, not a code change, and it
   trades the cliff for the loss of an explicit record of intent.
