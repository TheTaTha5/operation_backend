# Live updates: a change feed, pushed over SSE

**Approved 2026-10-09.** Nothing is built. Answers:
1. ordering by an advisory lock at commit;
2. the stream logs in with the Bearer header (a fetch-based reader);
3. changes are **kept forever**: no `410`, and the list doubles as an audit trail;
4. the heartbeat's `health` holds `migrations_pending` at first;
5. first kinds: booking, seat lock, deployment, route calendar, boat capacity override.

How a screen learns that someone else changed something, without reloading everything.

## What legacy does (wt-lk-inbox `server.js`, `allotment_v2/js/01-auth-sync.js`)

- **One version for everything:** `app_state.version`, bumped by every write, B2C sync included.
- **SSE push:** `GET /api/events` sends `{version, updated_by, source}` on each bump, `retry: 5000`,
  and a heartbeat every 25 s as a *named* event `hb` (a `:` comment never reaches `EventSource`,
  so a dead stream once went unnoticed for ~8 minutes). Logged-in cookie only.
- **Polling too:** every tab asks `GET /api/version` every 10 s. It carries the health that bumps no
  version: B2C sync failing or stale, migrations pending, mapping drift. That is why legacy keeps
  the poll beside the push: an event channel is silent during exactly those outages.
- **Client:** a higher version marks data stale, and the tab reloads the **whole state**
  (`/api/load`, ~20 MB) when the user is idle.
- **What went wrong (2026-09-11):** rapid saves → a broadcast each → every tab reloaded at once →
  132 queries per load on a 20-connection pool → `/api/load` answered 500. The event said *that*
  something changed, not *what*, so every client fetched everything.

## Proposal

The server records **what** changed, per record, in a numbered list. Clients catch up from the
last number they saw, by push (SSE) or by asking, and refetch only the records named.

### Schema

```sql
CREATE TABLE changes (
  version     BIGINT PRIMARY KEY,           -- from changes_version_seq, see "Ordering"
  kind        TEXT NOT NULL,                -- booking, seat_lock, deployment, route, boat, rate_type, …
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  route_days  JSONB,                        -- [{route_id, service_date}] whose seats this touched
  changed_by  TEXT,                         -- the token's user, as writes are signed today
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE changes_version_seq;
```

All fields are **computed** by the server; no client writes them.

- **Written in the same transaction as the change**, so a write that rolls back never appears and a
  committed one always does.
- `route_days` lets an availability grid refetch only the cells that moved. A booking edit lists
  its days before *and* after (a moved trip frees one day and fills another).
- One pure function decides which change rows a write produces (`src/domain/changes.ts`). Both
  stores call it: the in-process store keeps an array and an in-memory event emitter.
- A test sends each write endpoint once and expects its change row, so a new endpoint cannot forget.

### Ordering: a client must never skip a change

A sequence alone is not enough: write A takes version 10, write B takes 11 and commits first, a
client reads up to 11 and moves its cursor past 10, then A commits and is never seen. So the last
step before commit takes `pg_advisory_xact_lock` on one fixed key, *then* takes the next version and
inserts the rows. The lock is held until commit, so version order is commit order. Only that final
step is serialized (milliseconds); a sequence and an advisory lock raise no `40001` under the
store's SERIALIZABLE transactions, where a single counter row would.

### Contract

- `GET /v1/changes?since=N[&limit=500]` →
  `{ "version": 4530, "changes": [{ "version": 4521, "kind": "booking", "entity_id": "BK-…", "action": "updated", "route_days": [...], "changed_by": "ops1", "changed_at": "…" }] }`.
  Without `since`: `{version}` only, the starting point. A `since` older than what is kept →
  `410 resync_required`: reload, then continue from the version given.
- `GET /v1/changes/stream` (SSE). Starts after `Last-Event-ID` (the browser sends it on reconnect)
  or `?since=N`, first sending anything missed, then each change as it commits:
  `id: 4521` / `event: change` / `data: {…}`. A heartbeat `event: hb` every 25 s carries
  `{version, health}`. `retry: 5000`.
- Both need the read scope (`booking:read` or `operations:read`). Love Kingdom's API key: no.
- **Health rides on the heartbeat and on `GET /v1/changes`**, for legacy's reason: today
  `{migrations_pending}`; B2C sync health joins it when the sync moves here.

### Across servers

Each server instance keeps one connection on `LISTEN changes`. A write's transaction calls
`pg_notify('changes', version)`, which PostgreSQL delivers only on commit. Each instance then reads
the new rows once and writes them to its open streams. Nothing is shared in memory, so it works with
any number of instances.

### Clients

On a change: refetch that booking, lock or deployment, or the `route_days` named, never the whole
state. On `410`, or after a long disconnect, reload. Legacy's integration client and the Vue app
work the same way; Love Kingdom (server to server) does not need the stream.

## Questions

1. **Ordering** by an advisory lock at commit (proposed), or something else?
2. **Stream login:** the browser's `EventSource` cannot send `Authorization`. Proposed: clients use a
   fetch-based SSE reader that sends the Bearer header. Alternative: a short-lived token in the URL
   (ends up in logs).
3. **How long to keep changes:** 30 days (proposed), then `410`.
4. **What the heartbeat's `health` holds** at first: only `migrations_pending` (proposed)?
5. **Kinds in the first slice:** booking, seat_lock, deployment, route (calendar), boat capacity
   override (proposed), then rate_type and agent as their writes arrive?
