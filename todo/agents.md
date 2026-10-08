# Agents: what is still open

The read slice exists: migration 017, `src/domain/agents.ts`, both stores, the import, and
`GET /v1/agents`, `/v1/agents/{id}`, `/v1/agents/{id}/activity`, `/v1/markets`, `/v1/sales`
(README). The contract is the frontend porting spec "Agent List (`data-view="agents"`)", §3.

## To do

- Apply 017 on the shared database and run the import there. Read its "agent data to check" and
  "placeholders" sections with sales; they must re-enter the demo contract dates the import drops
  (spec Q6).
- **Writes** (spec phase 2): `POST /v1/agents`, `PATCH /v1/agents/{id}`,
  `PUT /v1/agents/{id}/programs`, deactivate/activate. Activity rows stamped from `request.user`.
  Who may write: the `sales` area (`todo/login-permissions-model.md`).
- **Later:** rate seasons (`todo/pricing-model.md`), add-on prices, credit used.

## Open questions (from the spec)

- **Q2, sales scoping.** Needs the caller's salesperson: `users.sales_id` in
  `todo/login-permissions-model.md`. Until then every `booking:read` caller sees every agent.
- **Q4, credit used.** No invoices or payments here yet, so the detail has no `credit` block.
- **Foreign keys** `bookings.agent_id` and `seat_locks.agent_id` → `agents(id)`: after the import has
  run on the shared database and dangling ids are listed.
