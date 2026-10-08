# Importing legacy's approvals, modelled

- **Source:** wt-lk-inbox@658298d — `08-app.js` `bkV2CommitBooking`, `bkV2EnsureApproval`,
  `bkV2ApproveBooking`, `bkV2RejectBooking`, `bkV2FocApprove`, `bkV2FocReject`;
  `os-backend/src/mapping/os_repo.js` `decomposeBlob`, `field_mapping.json` (`sb_bookings`).
- **Already here:** `booking_approvals`, `booking_approval_days` (023), filled only by this service.
  `src/tools/import-legacy.ts` reads no approval at all, so every imported `pending_approval`
  booking has none — read as "holds its seats", and `/approve` sends it to `confirmed`.

## Where legacy keeps them

Columns on `sb_bookings` (no blob):

- `approval_status`, `approval_reason`, `approval_targetstatus`, `approval_totover`,
  `approval_requestedby`, `approval_requestedat`, `approval_approvedby`, `approval_approvedat`,
  `approval_note`, `approval_over` (JSON text: `[{routeId, date, name, need, capFree, overBy, licFree}]`).
- `focapproval_count`, `_reason`, `_status`, `_requestedat`, `_requestedby`, `_approvedat`,
  `_approvedby`.

Lost by legacy itself (no column): `approval.discount`, `approval.saleName`,
`focApproval.rejectReason`.

## Mapping

| Legacy | `booking_approvals` | Note |
|---|---|---|
| `approval_*` row | `kind = 'approval'` | only when `approval_status` is set |
| `focapproval_*` row | `kind = 'foc'` | only when `focapproval_status` is set |
| `*_status` pending/approved/rejected | `status` | anything else → skipped, reported |
| `approval_reason` contains `over_cap` | `over_capacity = true` | also when `approval_over` has days |
| `approval_totover` | `over_total` | |
| — | `discount` | legacy lost it: `NULL` |
| `focapproval_count` | `foc_count` | |
| `approval_targetstatus` | `target_status` | empty → `confirmed`; FOC → `confirmed` |
| `*_requestedby`, `*_requestedat` | `requested_by`, `requested_at` | `requested_at` empty → the booking's `booked_at` |
| `*_approvedby`, `*_approvedat` | `decided_by`, `decided_at` | legacy writes these on reject too |
| `approval_note` | `note` | |
| `approval_over[]` `routeId, date, need, overBy` | `booking_approval_days` | `name`, `capFree`, `licFree` dropped (snapshots) |
| `focapproval_reason` | `bookings.foc_reason` | when the booking has none |
| `approval_reason` (`closed_day`, `b2c_hold`, `discount`, …) | **no home** | see question 1 |

**Effect on seats:** an imported `pending` approval with `over_capacity` makes its booking hold
nothing — what legacy already does (`bkPendHoldsSeat`). Seat counts move to match legacy, not away.

Replace-on-import, like every other imported child: delete the approvals of the bookings being
replaced, insert legacy's. Approvals this service created on bookings it owns are untouched.

## Data check — pending

```sql
SELECT approval_status, approval_reason, count(*) FROM sb_bookings WHERE approval_status IS NOT NULL GROUP BY 1, 2;
SELECT focapproval_status, count(*) FROM sb_bookings WHERE focapproval_status IS NOT NULL GROUP BY 1;
SELECT count(*) FROM sb_bookings WHERE approval_over IS NOT NULL AND approval_over NOT IN ('', '[]');
SELECT status, approval_status, count(*) FROM sb_bookings WHERE status LIKE 'pending%' GROUP BY 1, 2;
```

## Questions

1. **`reason`:** add `booking_approvals.reason TEXT` (nullable, legacy's label, also written by this
   service: `over_capacity`, `discount`, `over_capacity+discount`)? Recommended yes — ops filter the
   approval queue by why. That is the only schema change here.
2. Legacy's FOC `requested_by`/`decided_by` is a hard-coded `'RM'`. Import as is (recommended, it is
   what the record says), or `NULL`?
