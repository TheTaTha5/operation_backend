# B2C push (Love Kingdom books here)

**Status:** built on `feat/b2c-push` (2026-10-09), from the decisions of 2026-10-09: push, not pull;
bad data held and listed, not refused; a reconciliation read; the version settles edit clashes; the
import stops copying legacy's B2C bookings once the push is live. What it does is in README "Love
Kingdom's push: held orders and B2C issues"; what Love Kingdom must change is
`docs/love-kingdom-integration.md` §6a, §6b, §7; the switch-over is in `developer-checklist.md`.

Legacy, for reference (wt-lk-inbox@658298d): its server **pulled** Love Kingdom's database every
45 s and on every page load, upserting each order line as `b2c_<order>_<line>`, then flagged
oversold and closed days to `pending_approval` and listed post-import checks (`b2cCheckOrders`) in an
orange panel. `/api/b2c/health`, `/raw` and `/reset` watched and rebuilt that pull. None of it is
ported: Love Kingdom pushes to `POST /v1/bookings`, and `/reset` has no equivalent (decision 8).

## Open

1. **The switch-over** (`developer-checklist.md`): `--b2c=pushed` from the day Love Kingdom's push
   goes live, `none` after its back-fill. Until someone runs it, imports keep copying legacy's B2C
   bookings (`all`).
2. **Love Kingdom's side** (its repo): push, back-fill, handle `202`, read `issues`, alert on its own
   failures, reconcile with `updated_since`.
3. **The legacy client's B2C panel** reads `/api/b2c/health`; it should read `GET /v1/b2c/issues`
   once bookings cut over. Its red "can't pull B2C" bar has no equivalent and goes.
4. **Ops (legacy data fix):** cancel the 6 bookings of deleted Love Kingdom orders and the 3 test
   bookings in legacy (`developer-checklist.md`, "Ask ops").
5. **A "B2C stale" signal in `health`:** not built (decision 3 puts health on Love Kingdom's side).
   Ask ops whether they still want one.

## Flagged

Behaviour that differs from legacy, and decisions made here without asking:

- **Held means `202`, not `201` and not `400`** (my choice of status). Love Kingdom must treat it as
  "not booked". Legacy stored such a line as a booking with no route (it held no seats either); here
  it is a held order outside the bookings, so it is in no manifest or availability until ops act.
- **Every `400` from Love Kingdom's login is held,** not a list of "data" errors: also a mapping bug
  (`status` sent on create, a malformed `If-Match`, a wrong field type). Simpler and loses nothing;
  the cost is that ops see Love Kingdom's bugs too.
- **Amend and cancel are held as well as create** (the decision named creates). A lost cancel is
  legacy's bug 2 (seats kept for a gone order), so it is held rather than refused.
- **CS's saves are held too:** Love Kingdom's CS back-office books through the same login, so a CS
  user sees "held" where they saw a `400`. Love Kingdom must show the message. A separate CS login
  not tied to `a_b2c` would keep the `400`; ask Love Kingdom if they want that.
- **Not held:** `409` (sold out, `route_closed`, duplicate, stale version), `403`, `404`, `428`, and
  a body that is not JSON (refused before the handler). Legacy put an oversold or closed-day B2C line
  into `pending_approval`; here over the allotment is still `pending_approval` (201) but past the
  licence or on a closed day is `409`, as for every agent. Love Kingdom's seat lock before payment is
  what prevents it.
- **Staff and unauthenticated callers keep the `400`** even for an `a_b2c` booking: only the login
  tied to `a_b2c` is held.
- **Issues are computed, not stored,** and dismissing them stays in the client (legacy's
  `localStorage` + `issueSig`; `signature` is provided). Legacy's own messages, in Thai.
- **Checks ported and changed:**
  - `nat_unread`: a nationality that is not two letters. Legacy read country names through an alias
    list; Love Kingdom must now send codes.
  - `nat_mix`: Thai-priced seats when more known foreigners are aboard than the other seats. Legacy
    flagged any foreigner when the whole party was priced Thai off the lead and no split was sent;
    this service cannot know whether Love Kingdom sent a split, so it compares counts. Charters are
    skipped. At most one per booking.
  - `money_parts`: only when a price part was sent.
  - `pickup_area`: as legacy.
  - Not ported: `route`, `date`, `pax0` (these are held orders now), `money_total` and `money_order`
    (they compare legacy's mapper with Love Kingdom's own order, which this API never sees),
    `not_imported` (Love Kingdom decides what it sends).
- **The panel checks bookings of agent `a_b2c` with a trip from today on.** Legacy checked travel
  dates from 90 days back, and `b2c_…` ids with no agent (3 legacy rows) are not checked.
- **`updated_since` is inclusive** (at or after) and follows `updated_at`, which every booking write
  bumps. Day-of-operations writes that touch only the trip records (check-in, van parts) do not
  change `updated_at`; Love Kingdom does not need them.
- **Held orders have no `version`:** the only change is open → resolved or dismissed, and a second
  decision is `409 wrong_status`. `status`, `decided_by`, `decided_at` in a resolve body are ignored.
- **A fixed and resent create closes its held order by itself** (resolved, by Love Kingdom's login,
  `Booked as …`). A later successful amend does not close a held amend: it may not carry the same
  change.
- **The change feed has a new kind, `b2c_held_order`.** Migration 100 adds it to whatever
  `changes_kind_check` lists when it runs, so it keeps a kind another branch added before it. A
  branch that later restates the full list (as 045 did) must include `b2c_held_order`, or it is
  dropped and held orders can no longer be written. **Merge check for the lead.**
- **Import:** `--b2c=all|pushed|none`, default `all` (today's behaviour). `b2c_BK-…` test orders are
  skipped in every mode (decision 7). `pushed` matches legacy's `b2c_<order>_<n>` to a booking here
  with `external_id = <order>` that is not an `lg_` row; that is my addition, to take the timing risk
  out of the switch. Rehearsed on a copy of legacy (2026-10-09): `all` writes 5,351 bookings (543
  B2C; 9 test and 13 route-less B2C lines skipped); `pushed` with two orders pushed, 5,344 (7 lines
  skipped); `none`, 4,808. Invoices, vans and locks were unchanged across the three.
- **The login is not widened:** Love Kingdom's login still writes only `/v1/bookings`; it may read
  `/v1/b2c/*` like any login.
