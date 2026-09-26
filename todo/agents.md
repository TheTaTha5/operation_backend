# Agents

Agents (resellers), markets and salespeople for the Agent List screen. The contract comes from the
frontend porting spec "Agent List (`data-view="agents"`)", §3 "Missing endpoints".

## Where it stands

- **Read-only slice.** Done: migration 017, `src/domain/agents.ts`, both stores, the import.
  - Endpoints: `GET /v1/agents`, `/v1/agents/:id`, `/v1/agents/:id/activity`, `/v1/markets`, `/v1/sales`.
  - `GET /v1/bookings` gained `agent_id` and `order=desc`.
  - Still open: apply 017 on the shared database and run the import there. Read its "agent data to
    check" and "placeholders" sections with sales.
- **Writes** (spec phase 2) are not started: `POST /v1/agents`, `PATCH /v1/agents/:id`,
  `PUT /v1/agents/:id/programs`, deactivate/activate. With them come activity rows stamped from
  `request.user`, and a decision on a `sales:write` scope.
- **Later:** `GET /v1/rate-types` (Rate Types port), rate seasons, add-on prices, credit used.

## Decisions made, and why

- **The spec's constraints were loosened where legacy data breaks them.**
  - `code` is neither NOT NULL nor UNIQUE, because legacy never checked codes. The import lists
    shared codes.
  - `pay_type` is nullable, because a missing one is a legacy "incomplete" flag, not an error.
  - `vat_mode` defaults to `none`, because that is how legacy reads a blank.
- **Programme membership comes from `programs[]`, and dates from `programPeriods`.** The spec
  suggested their union. But the list, the incomplete flag and the header counts all read
  `programs[]`, and the drift came from screens that edited only `programs[]`. A period whose route
  is not in `programs[]` is therefore a leftover, so it is dropped and counted.
- **Legacy's demo contract dates are dropped, not imported.** `_seedContractExpiryVariety` rewrote
  these on every load and the values were persisted, so the real dates are gone from legacy:
  - `contract_end` for a01/a10/a30 (2026-09-27) and a40 (2026-08-28)
  - a40's `expired` status

  The import drops a value only when it matches the demo exactly, and lists it. Sales must re-enter
  these (spec Q6).
- **Unknown market or salesperson ids get a placeholder row, not a null.** Examples: `b2c` for
  a_b2c, or a salesperson removed from `sb_sales`. The foreign key holds, the id survives, and the
  report lists each placeholder so it can be renamed.
- **Lists are filtered and sorted in `selectAgents`, not in SQL.** There are about 130 agents, so
  PostgreSQL reads them whole. A SQL copy of the search and A–Z rules would be the second copy that
  drifts.

## Open questions (from the spec)

- **Q2, sales scoping.** It needs the caller's salesperson id: a token claim, or a user →
  salesperson mapping here. Until then every `booking:read` caller sees every agent.
- **Q4, credit used.** There are no invoices or payments here, so the detail has no `credit` block.
- **Q3 (deactivate instead of delete) and Q8 (house agents visible).** The schema already follows
  the spec's recommendation for both: `active`, `house`.
- **Foreign keys from bookings.** `bookings.agent_id` and `seat_locks.agent_id` → `agents(id)` wait
  until the import has run on the shared database and dangling ids are listed.
