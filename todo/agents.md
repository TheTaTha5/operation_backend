# Agents: what is still open

Reads and writes are built (README → "Agents"; `todo/sales-editing-model.md` for the design and
what was flagged). Open:

- Read the import's "agent data to check" and "placeholders" sections with sales; they must
  re-enter the demo contract dates the import drops (spec Q6).
- **Agent codes:** 21 legacy codes are shared. Once sales renames them, add `UNIQUE (lower(code))`.
- **Foreign keys** `bookings.agent_id` and `seat_locks.agent_id` → `agents(id)`, and
  `agents.rate_type_id` → `rate_types(id)`: after the seed import has run on the shared database and
  dangling ids are listed.
