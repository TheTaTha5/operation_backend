# Build status, 2026-10-09: the areas not moved yet

Every area legacy still owned was decided on 2026-10-09 (each `todo/<area>-model.md` has a "Decided"
section) and built by one agent per area on its own branch. The lead merges each branch into `main`
and runs both test suites. Nothing has been pushed.

## Merged into `main`

`main` is at 5f69438 or later. Every merge passed `npm test` and PostgreSQL on a fresh database
(433 tests on both stores after the last merge).

| Area | Branch | Migrations | Note (Flagged list) |
|---|---|---|---|
| B2C push (Love Kingdom books here) | `feat/b2c-push` | 100 | `todo/b2c-sync-model.md` |
| Van job orders | `feat/van-job-orders` | 080 | `todo/van-job-orders-model.md` |
| Weather closures, refund and credit | `feat/weather-closures` | 060, 061 | `todo/weather-closures-model.md` |
| Catalogue editing (routes, boats, day seats) | `feat/catalogue-editing` | 070 | `todo/catalogue-editing-model.md` |
| Seat-lock extras | `feat/seat-lock-extras` | 048 | `todo/seat-lock-extras-model.md` |
| Sales editing | `feat/sales-editing` | 090–093 | `todo/sales-editing-model.md` |

Merge fixes made by the lead (in the merge commits):
- **Change-feed kinds:**
  - 070 restated `changes_kind_check` without `weather_closure`; it now lists it.
  - The final list is booking, seat_lock, deployment, route, invoice, weather_closure, boat and
    b2c_held_order.
  - New migrations must **append** a kind, the way `100_b2c_held_orders.sql` does, never restate
    the list.
- **The agent detail:** sales editing moved the agent routes to `src/routes/sales-editing.ts`. The
  weather credit (`credit_balance`) is passed in as `agentCredit`.
- **Booking writes:** B2C wraps them in `holdOnBadInput`. Weather's `cancel-weather` command sits
  beside it, and the status-command loop skips `cancel-weather`.

## Merged later the same day

| Area | Branch | Migrations | Note (Flagged list) |
|---|---|---|---|
| Money 5–6: partner van bills, money reports | `feat/money-van-bills-and-reports` | 120 | `todo/money-model.md` |
| Fleet A: availability, assets, incidents and jobs | `feat/fleet-availability-and-jobs` | 130 | `todo/fleet-maintenance-model.md` |
| Money 2–4: proforma, pier money, after the trip | `feat/money-pier-and-after-trip` | 110–112 | `todo/money-model.md` |
| Fleet B: stock, memos, Daily Log, projects, safety | `feat/fleet-stock-memos-log-projects` | 140–143 | `todo/fleet-maintenance-model.md` |

The change-kind list holds 10 kinds.

## Follow-up merged

- **The reports** (Travel Summary, Daily Report, dashboard) read pier money and the after-trip
  decisions (`chore/reports-and-flake`).
- **The PostgreSQL flake is fixed:** a serialization retry now runs alone behind a gate (an advisory
  lock held shared by every transaction, taken exclusively by a retry), so a long write can no longer
  run out of retries (`src/domain/postgres-operations.ts` `transaction()`). After the merge: 503 tests,
  PostgreSQL twice on fresh databases with 0 failures.

Nothing is in progress.

## Known issues

- **Still waiting on people** (`todo/developer-checklist.md`):
  - **Ops:** a route with no boat yet; the B2C orphans; projects PRJ-001…007.
  - **Sales:** the add-on catalogue's contents.

## Deploy order

`todo/developer-checklist.md` → "Deploy what is on `main`" lists each step, among them:
- import:attachments, then re-import;
- `--rate-types`;
- the 080 re-import;
- `seed:routes` and `seed:boats` after 070;
- `--sales` before deploying 090;
- the `--b2c` switch-over timing.

## 2026-10-10

Merged into `main`: the deploy runbook (rehearsed end to end on a copy of the import), the
`isIsoDate` fix, `todo/legacy-browser-rules.md` (823 legacy browser rules: 308 still missing), the
pier office (petty cash and the office lists, migrations 170–171) and whole-boat hold commands
(migration 180). 526 tests pass on both stores.

Still on branches in agent worktrees, not merged (check `git log main..<branch>`; finish or merge):

| Task | Branch | Migrations |
|---|---|---|
| Trip P&L, cost model, refund payouts, deposits | `feat/money-remainder` | 160–169 |
| Fleet extras | `feat/fleet-extras` | 190–199 |
| Promo contracts, sales targets, staff quotas, seed-only contracts | `feat/sales-extras` | 200–209 |
| Reschedule fee tops up the invoice; the charter-split seat bug; 8 booking differences written up | `fix/booking-rules` | 210–219 |

Next: the second wave from `todo/legacy-browser-rules.md` "Missing" (pier operations, check-in
counting, required booking fields, deployment checks).
