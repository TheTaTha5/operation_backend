# Weather closures, refund and credit

**Status:** built on `feat/weather-closures` (2026-10-09): migrations 060 and 061,
`src/domain/weather.ts`, `src/domain/refunds.ts`, import `src/tools/legacy-weather.ts`. The contract
is README → "Weather closures, refund and credit"; the tables are `docs/schema.md` §8. Decisions of
2026-10-09 (legacy read of wt-lk-inbox@658298d, `08-app.js` `bkV2Weather*`, `acct*Deposit`).

What is left is below; what was decided here without the developer, or behaves differently from
legacy, is under "Flagged".

## Open

1. **Paying a refund out.** A `refund` row is what is owed to the agent; there is no "paid out"
   step (method, date, slip). Legacy had none either (`bk.refund.status` stayed `due` and was lost).
2. **Legacy's manual deposit** ("รับมัดจำ", `acctDepositSubmit`): money received with no invoice.
   It would be a `credit` with no invoice, which `refunds.invoice_id NOT NULL` does not allow yet
   (`money-model.md` open 1).
3. **A partial refund.** The amount is the server's (what the booking paid that its invoice no longer
   needs); a smaller one cannot be sent. Legacy refunded everything paid too.
4. **Restore after a weather cancel** puts the status back only: the booking stays off its old
   invoice (issue a new one), a refund or credit stays, and its follow-up keeps its outcome. Should a
   restore re-open the follow-up, or be refused once money went back?
5. **`reason` on a weather reschedule** is still required; the weather screen sends `"weather"`.
   Default it when the booking leaves a closed trip?

## Flagged

**Behaviour that changed against legacy**

1. `/cancel-weather` **now moves money** (decision 6). Before, it touched no invoice. Now, with the
   default outcome `cancel`, it takes the booking's share off its live booking or prepay invoices:
   a one-booking invoice is voided (`void_reason: "weather"`, as legacy); on a shared one only the
   booking's lines are marked removed and the totals and VAT are worked out again (legacy voided the
   whole invoice: bug 6). Fee invoices stand (a fee for an earlier reschedule is still owed). *Chosen
   here.*
2. **The refund amount on a shared invoice** is what the invoice was paid, less earlier refunds and
   credits, less what it still asks after the share comes off: the bookings still travelling are paid
   first. On a one-booking invoice it is everything paid, as legacy. *Chosen here.*
3. **Refund with nothing paid** is allowed and writes no refund row; the line says `Refund ฿0`
   (legacy). **Credit with nothing paid** is `409 nothing_paid` (legacy greys the option out). A
   credit on an invoice with no agent (a legacy invoice whose agent is not in the catalogue) is
   `409 no_agent`. *`no_agent` chosen here.*
4. **History of `/cancel-weather`:** `Cancelled for weather · No refund · <note>` (or `Refund ฿x`,
   `Kept as credit ฿x`), tag `Cancel`/`Refund`/`Credit`, legacy's resolve tags. It was
   `Cancelled for weather · <note>`, tag `Weather`. Legacy's line also named the route and date.
5. **The weather reschedule is the ordinary reschedule** (decision 5): a full new day is refused,
   lock seats go back, the van and pickup time are cleared, and a reschedule record is written with
   the client's `reason`. Legacy checked nothing and wrote only `bk.rebook`.
6. **Either reschedule body** moving a booking off a closed trip resolves its follow-up (the older
   `{ route_id, service_date }` body too). A `PATCH` move and an ordinary `/cancel` resolve nothing.
   *Chosen here.*
7. **A weather cancel resolves every open follow-up of the booking**, a closure it had already left
   included; a reschedule only the closures it leaves. A follow-up already resolved keeps its first
   outcome. *Chosen here.*
8. **Notify is not required before resolving.** The server records the resolve from `awaiting`
   (no `notified_at`). Legacy's screen showed "Resolve" only after "Notify agent".
9. **The list is worked out on read** (decision 4): a booking that leaves the trip (moved, cancelled)
   before anything was recorded for it drops off the list. Legacy kept the tag (bug 3). With a row it
   stays, with `on_trip: false`.
10. **History on close** goes to every booking on the trip at that moment. A booking sold onto the trip
   later gets none (legacy wrote it when someone opened the panel). **Undo's history** goes to every
   unresolved booking on the list, not only tagged ones.
11. **Undo keeps the closure, reopened** (`reopened_at`, `reopened_by`), so the resolved bookings keep
   their record; legacy deleted the closure. Closing the trip again makes a new closure. A reopened
   closure lists only its rows and refuses notify, `PATCH` and undo (`409 closure_reopened`).
   *Chosen here.*
12. **Charters are on the list** (decision 7); legacy skipped them (bug 5).
13. **A login tied to one agent** sees only its own bookings on a closure's list and its counts.
   *Chosen here.*
14. **Calendars and availability are unchanged:** a closed trip still sells and counts its seats, as
   legacy's seat count did; screens grey it out from `GET /v1/weather-closures`. Legacy's calendars
   skipped the route's seats in their own totals.
15. `reason` on a new closure is accepted only as `weather` (legacy's only value) and not stored.

**Side effects on other areas**

16. **Invoices:** lines carry `removed_at`, `removed_by`, `removed_reason`; the read adds `refunded`,
    `credited` and `refunds`; `status`, `balance` and the overpayment check count
    `paid − refunded − credited`. `PATCH` refuses `refunded`, `credited`, `refunds`.
17. **A booking's `invoice` and `payment_state`** ignore lines taken off: a weather-cancelled booking
    reads `invoice: null`, as after legacy's void, and can be invoiced again after a restore.
18. **Payments:** method `credit` spends the agent's balance (`409 credit_short`). A credit payment
    can be deleted (the balance comes back) but not edited, and a payment cannot become one
    (`409 credit_payment`). *Chosen here.*
19. **Agents:** `GET /v1/agents/{id}` adds `credit_balance: { credited, used, available }`, beside the
    existing `credit` (the credit limit's use). Legacy called it "Deposit held".
20. **Change feed:** new kind `weather_closure`. Migration 060 rewrites `changes_kind_check`; a branch
    merged with another kind must list both. A booking command learns which closures it resolved from
    a note it leaves (`noteWeatherClosure`), not by reading the follow-up rows on every booking write:
    the extra read made the PostgreSQL suite fail a serializable reschedule.
21. **Permissions:** `/v1/weather-closures*` needs `operations`; the refund and credit come through
    `/cancel-weather` (`operations`, decision 10); spending a credit is an invoice payment
    (`accounting`).

**Import**

22. Closures are `lg_<legacy id>` with no `closed_by` (legacy kept none); follow-ups as legacy has
    them, the 3 stale `awaiting` ones included (decision 9). Both are replaced on every run, and so
    are follow-ups made here on imported closures or bookings, and refunds and credits on imported
    invoices. A resolved legacy tag whose closure was undone in legacy would be skipped and listed
    (none today).
23. Rehearsal of 2026-10-09: 5 closures, 40 follow-ups (3 awaiting, 37 resolved: 24 cancel,
    13 reschedule), 13 / 15 / 9 / 1 / 2 per closure, as legacy. The computed lists match them: no
    booking on a closed trip lacked a tag.
