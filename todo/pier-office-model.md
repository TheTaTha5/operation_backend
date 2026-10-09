# Pier office: what is still open

Built on `feat/pier-office` (migrations 170–171): petty cash per pier (legacy §poCash: the ledger
with its carried balance, the longtail and park-fee sheets, pull, the month table, the
receipt-substitute certificate, the company name) and the seven office lists (equipment kinds and
items, roster codes and groups, staff, licence types and classes). README → "Pier office: petty
cash", "Pier office lists"; handoff §6.8. The legacy read (wt-lk-inbox@658298d) and the design are in
git history (`docs: pier office design`). Writes need `pier` or `operations` (legacy `poCanEdit`);
petty cash is not linked to pier payments or the hand-over, as in legacy.

## Open

1. **The read side of the two sheets.** Legacy shows, beside what the pier keys: booked join heads
   and charter boats per boat (`pxLongtail`, via `bkLtState` and `pckOnBoard`), on-board heads by
   nationality and age (`pcPax`: check-in, `ckLostByType`, the trip's real nationality `t.nat`), the
   expected park fee from the cost plan's park line (`pcParkRate`; INF 0, FOC at the adult price),
   the difference paid − expected, and the "fill from bookings" panel. They need the cost model
   (cost plans are not here; `money-reports.ts` leaves trip costs out) and a port of legacy's
   on-board count. Meanwhile a client may fill the 8 counts itself and send `filled_from`.
2. **The park tickets page** (`pok-<pier>`, §pkTk) reads the same heads (`pcPax`) and writes
   `pier_cfg.parkTypes`, `parkFix`, `parkName`: not built.
3. **The rest of the Pier Office data** has no home yet: `pier_moves` (1,177 stock moves),
   `pier_sheet` (84 sign-out sheets, with deposits), `pier_shift` (1,151 roster cells), `pier_duty`
   (81), `pier_job` (239 job sheets), `pier_team` (1), `pier_licenses` (29), `pier_cfg` (19 keys:
   pay rate per person, pay rules, roster settings, licence warning days, park ticket types). Until
   they move, deleting a roster code, group or licence class does not check them (legacy asks when
   one is used), and the import replaces the lists whole, so a code or group legacy deleted goes.
4. **Legacy's item seed** (7 sample lines per pier) is not seeded: a fresh pier starts with none.

## Flagged

Changes against legacy, and decisions made here (legacy followed where it could be):

- **A deleted petty cash row is kept**, out of every total (as pier payments, decided 2026-10-09);
  legacy removes it. Pull may then run again for that category.
- **Amounts keep satang**; legacy rounds to whole baht (`pcNum`). The certificate's Thai words add
  "…สตางค์"; legacy's data is all whole baht.
- **`source` is the server's**: a client cannot write a "pulled" row by hand (`400`).
- **A sheet cell for a boat not in the catalogue is `404`**; legacy stores any id. All 8 boats in
  legacy's cells are in the catalogue.
- **The sheets also list a boat with a cell but no deployment that day**, so nothing typed is hidden;
  legacy showed only the boats running that day while still counting the hidden money. Legacy also
  listed a boat named by a booking's dispatch without a deployment; here only deployments count.
- **A roster code must be unique, any case** (`409 code_taken`); legacy matched the first.
- **Refused where legacy let it through:** a negative item total (`parseInt`), a kind name, English
  name or unit over 40 characters (legacy cut it), a group of another pier.
- **`bg` follows `color`** on every colour change (legacy `paTint`, which legacy also applied only on
  a colour pick); legacy's "use standard colours" palette reset is not here.
- **A person moved to another pier leaves their group and goes last**; legacy kept the group id and
  the place number. Moved into another group, last in it, as legacy.
- **Staff `sort`** is set for everyone on import: legacy's unordered Tub Lamu staff keep legacy's
  row order after the ordered ones.
- **Reads are for staff logins**: an agent's login gets `403`. Legacy's per-pier view rights
  (`pop-<pier>`, `po-<pier>` …) are returned in `view_perms` and not enforced, as everywhere here.
- **Error messages are English**, as the rest of the API; legacy's Thai alerts are named beside them
  in README.
