# Live updates: what is still open

Built (decided 2026-10-09; migration 044, `src/domain/changes.ts`, `src/routes/change-tracking.ts`;
README → "Live updates"). Git history has the design.

## Open

1. **More kinds**, as their screens need them: vans and van days, van stops, pickup areas and times,
   agents and rate types, users. Each is a path pattern in `change-tracking.ts` and a kind in the
   `changes` CHECK.
2. **Boat capacity overrides** have no write endpoint yet; they join the feed with it.
3. **The legacy import writes no changes.** Until cutover, clients reload after an import (or the
   import could write one `resync` row).
4. **Health:** B2C sync health joins `migrations_pending` when the sync moves here.
5. **Clients:** legacy's integration client and the Vue app switch from reloading everything to
   refetching what the feed names (`developer-checklist.md`).
