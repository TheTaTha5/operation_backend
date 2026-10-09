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

## In progress (branches in agent worktrees, not merged)

| Area | Branch | Worktree | Migrations |
|---|---|---|---|
| Money 2–4: proforma, pier money, after the trip | `feat/money-pier-and-after-trip` | `.claude/worktrees/agent-a26db3c5646c38553` | 110–119 |
| Money 5–6: partner van bills, money reports | `feat/money-van-bills-and-reports` | `.claude/worktrees/agent-ac9c2fb287e6425bb` | 120–129 |
| Fleet A: availability, assets, incidents and jobs | `feat/fleet-availability-and-jobs` | `.claude/worktrees/agent-ab1c91a3ca99c79cf` | 130–139 |
| Fleet B: stock, memos, Daily Log, projects, safety | `feat/fleet-stock-memos-log-projects` | `.claude/worktrees/agent-abcb4e3e795111d84` | 140–149 |

**If a branch is unfinished:** open its worktree, read `git status` and `git log main..HEAD`, and its
note's "Design" section, then finish the build there.

**To merge one:** `git merge --no-ff <branch>` into `main` (the lead uses the `D:\projects\ob-merge`
worktree, with `node_modules` linked). Then run:
- `npm run check`;
- `npm test`;
- PostgreSQL on a fresh database: create `ob_m_<n>` on localhost:5433, `npm run db:migrate`, then
  `DATABASE_URL=… npm test`, then drop it.

Check `changes_kind_check` after migrating.

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
