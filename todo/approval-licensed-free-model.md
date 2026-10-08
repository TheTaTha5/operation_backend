# "Real seats left": licensed seats on approval days and availability

**Approved 2026-10-08.** Built on `feat/approval-licensed-free` (migration 025).

## Why

Legacy's approval card (`bkV2RenderApprovals`) has a **Real seats left** column: for each day a
booking is over the allotment, how many registered (licence) seats the boats still have. Legacy
records it on the request (`approval.over[].licFree`, from `getAllotment().licenseAvailable`,
licence capacity − seats consumed, the booking's own seats excluded when editing). This service's
approval days carried `need` and `over_by` only, so the card fell back to counting in the browser.

The number already exists here: `weighDay` (`src/domain/capacity.ts`) computes the licensed seats
left before deciding a day is over the allotment but within the licence. It was not returned.

## Fields

| Field | Where | Authority | Meaning |
|---|---|---|---|
| `licensed_free` | `approvals[].days[]`, stored in `booking_approval_days.licensed_free` | Computed | Registered passenger seats left on that day when the approval was asked for, the booking's own seats not counted. Always ≥ `need`: past the licence the booking is refused, not sent for approval. `null` on a day recorded before migration 025. |
| `licensed_free` | each `GET /v1/availability` range entry and single-day answer | Computed | The same number, now: registered passenger seats left on the day's unchartered boats, locks not subtracted. `0` when no boat is deployed or on a land route. |

Both are read-only. A snapshot on the approval matches legacy (the card shows what was true when the
approval was asked for); availability gives the live figure for a manager who wants it.

## Schema

`ALTER TABLE booking_approval_days ADD COLUMN licensed_free INTEGER`, with
`CHECK (licensed_free >= need)`. Nullable, because rows written before it have no recorded value
and none can be reconstructed.

## Contract change

Additive: two new read-only fields. Clients change nothing to keep working; legacy's approval card
reads `days[].licensed_free` instead of its own count.
