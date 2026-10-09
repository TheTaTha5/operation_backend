# Deployment guards: what is still open

Built (decided 2026-10-09; `src/domain/deployment-guards.ts`, README → "Deployments"): past dates for
an admin only, a chartered boat stays, `remove_anyway` for a boat with bookings placed on it, and
`license_pax` from the boat catalogue.

## Open

1. **A boat held whole for an agent.** Legacy also refuses to pull a boat a seat lock holds whole
   ("Release the hold on the Seat Locks page first"). Seat locks here are per route and day, not
   per boat, so there is nothing to check yet. It comes with boat-held locks, if they are modelled.
2. **Capacity overrides** (`boatCapSet`): raising a boat above its normal seats needs
   `act-capunlock` in legacy, and nothing goes above the licence. Not built: the override write
   endpoint doesn't exist yet (`legacy-replacement.md` §2).
3. **The import's mirror delete** removes deployments legacy no longer has, without these guards:
   legacy is the master until cutover.
