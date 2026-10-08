# Login and permissions: what is left

Built on `feat/login` (migration 027, `src/domain/users.ts`, `src/auth.ts`; README → "Login and
permissions"). What remains is outside this repo, or a known limit.

## To do when it deploys

In `todo/developer-checklist.md`.

## The integration client (legacy's screens)

- Log in with `POST /v1/login` (the same usernames and passwords) and read `GET /v1/me` for
  `view_perms` (legacy's `perms` less the actions), `edit_areas`, `actions`, `sales_id`.
- The Users screen: `GET/POST /v1/users`, `PATCH /v1/users/{id}`, `POST /v1/users/{id}/password`.
  A delete becomes `disabled: true`. It needs an `act-approve` tick box next to `act-capunlock`.
- Approve/reject can now answer `403` with a message to show as it is.

## Known limit

- Failed-login counting is per server instance, in memory: with two instances a username gets up to
  15 tries on each, and a restart forgets the count.
