# Every route's operating calendar expires, and nothing warns anyone

A route's calendar is a set of dated windows in `route_seasons`. A route with any open season is
closed outside all of them (legacy's `getDayStatus`), and a closed day refuses bookings
(`409 route_closed`). The windows are finite, and nobody is told when one runs out:

| Last open window ends | Routes | |
| --- | --- | --- |
| **2026-12-31** | r7, r8, r9, r10, r11 | Phi Phi Bamboo ×4 and Krabi + Phang Nga, all Panwa |
| 2027-04-30 | r1784542898734, r1784882390130 | the two Ranong day trips |
| 2027-05-15 | r1–r6, r12 | Similan ×5, Surin, Whale Shark |

The Panwa routes are year-round, with one open window `2026-01-01 → 2026-12-31`: from 2027-01-01
every booking on five of the fourteen routes is refused. Legacy has the same cliff from the same
rows.

## What to do

1. **Get the 2027 operating windows from ops** and enter them with `POST /v1/routes/{id}/seasons`.
   Whether ops has done so is a data question the code cannot answer: check the rows.
2. **Warn well before the edge**: a route whose last open window ends within 90 days, surfaced in a
   health field, a boot-time log warning or an admin view. The query:

```sql
SELECT r.id, r.name, max(s.to_date) AS calendar_ends
FROM routes r JOIN route_seasons s ON s.route_id = r.id AND s.kind = 'open'
GROUP BY r.id, r.name
HAVING max(s.to_date) < current_date + INTERVAL '90 days'
ORDER BY 3;
```

3. **Consider no seasons for a year-round route.** A route with no `route_seasons` rows is open on
   every date and never expires, which is what r7–r11 mean. A data change, not a code change; it
   loses the explicit record of intent.
