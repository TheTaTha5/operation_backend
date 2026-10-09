# Deployment guards: what is still open

Built (decided 2026-10-09; `src/domain/deployment-guards.ts`, README → "Deployments"): past dates for
an admin only, a chartered boat stays, a boat held whole stays (`409 boat_held`, 2026-10-10),
`remove_anyway` for a boat with bookings placed on it, and `license_pax` from the boat catalogue.

## Open

1. **The import's mirror delete** removes deployments legacy no longer has, without these guards:
   legacy is the master until cutover.
