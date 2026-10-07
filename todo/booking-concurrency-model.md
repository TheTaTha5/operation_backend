# Edit conflicts and safe retries, modelled

- **Source:** wt-lk-inbox@658298d — `01-auth-sync.js` `save`, `laDiffToOps`, `_laTryRefresh`;
  `server.js` `restTxn`, `restApplyOp`; `08-app.js` `bkV2SetEditLock`, `bkV2GenerateBookingCode`,
  `bkV2CommitBooking`, `bkV2FindDuplicateBookings`.
- **Already here:** a duplicate `external_id` is `409 duplicate_external_id` naming the booking
  (fixed 2026-10-07). Nothing else.

## What legacy does

- **Edit conflicts: last write wins, field by field.** A save sends only the fields that changed;
  the server merges them onto its copy. Two people changing different fields both survive; the same
  field, the later save wins. A global `baseVersion` only tells the client it is behind (it still
  writes). An advisory edit lock (`editLock`, 5 minutes) warns the second editor in a dialog they
  can dismiss.
- **Retries are safe because the client makes the id** (`BK-YYMM####-XXXX`, made when the form
  opens). A resent save writes the same id again. Content duplicates (same voucher, or same lead +
  date + route) only warn.

## Proposal

### Conflicts: a version on every booking (validated)

- `bookings.version INTEGER NOT NULL DEFAULT 1`, incremented by every write: `PATCH`, every command,
  every action. Returned as `version` and as the `ETag` header (`"7"`).
- `PATCH` and every command accept `If-Match: "7"` (or `"version": 7` in the body). If the booking
  has moved on: `409 stale_version`, with the current `version`, and nothing written.
- **Optional at first:** a write without it behaves as today (last write wins), so legacy's
  integration and Love Kingdom keep working until they send it.
- Same for seat locks (`seat_locks.version`), which agents and staff both edit.

Field-level merge (legacy's) is not copied: `PATCH` already sends only what changed, so two edits of
different fields already both survive when neither sends `If-Match`.

### Retries: `Idempotency-Key` on the writes without a natural key

`POST /v1/bookings` is covered by `external_id`. The writes that have nothing to dedupe on are
`/partial-cancel`, `/reschedule`, `POST /v1/seat-locks`.

```sql
CREATE TABLE idempotency_keys (
  key          TEXT NOT NULL,
  actor        TEXT NOT NULL DEFAULT '',
  method_path  TEXT NOT NULL,           -- 'POST /v1/seat-locks'
  request_hash TEXT NOT NULL,           -- sha256 of the body
  status_code  INTEGER NOT NULL,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor, key)
);
```

- Same key, same body → the stored response again, nothing written. Same key, different body →
  `409 idempotency_key_reused`. Written in the transaction of the write it protects, so a failed
  write leaves no key. Kept 7 days.
- The in-process store keeps the same map in memory.

## Questions

1. **`If-Match` optional now, required later** (recommended), or required at once? Nothing is live,
   so required is possible; it breaks legacy's integration and Love Kingdom until they send it.
2. **Version on seat locks too?** Recommended yes.
3. **`Idempotency-Key` worth building now?** Love Kingdom's flow (lock → pay → book) retries lock
   create. Recommended: yes for seat-lock create; partial cancel and reschedule can wait.
4. **Content duplicates** (same voucher): legacy warns. Here `GET /v1/bookings?voucher_ref=` already
   lets a client check. Add nothing server-side? Recommended: nothing.
