# Login and permissions: what is left

Built on `feat/login` (migration 027, `src/domain/users.ts`, `src/auth.ts`; README → "Login and
permissions"). What remains is outside this repo, or a known limit.

## To do when it deploys

1. On Railway: keep `AUTH_JWT_SECRET` and `AUTH_REQUIRED=true`; remove `OIDC_ISSUER`,
   `OIDC_AUDIENCE` and `AUTH_PASSWORD_USERS` (no longer read). Nobody can log in until step 2.
2. `npm run import:users -- --commit` against Railway (after the agents import, so `sales_id`
   resolves). Rerun until cutover: legacy is the master for its users until then.
3. Create Love Kingdom's service user (`POST /v1/users` with `agent_id: "a_b2c"`, area
   `operations`) and give them its password. Their test login from `AUTH_PASSWORD_USERS` stops working.
4. Give `act-approve` to the staff who approve over the allotment and FOC (`PATCH /v1/users/{id}`).
   Today only `admin` and `Tata` can.

## The integration client (legacy's screens)

- Log in with `POST /v1/login` (the same usernames and passwords) and read `GET /v1/me` for
  `view_perms` (legacy's `perms` less the actions), `edit_areas`, `actions`, `sales_id`.
- The Users screen: `GET/POST /v1/users`, `PATCH /v1/users/{id}`, `POST /v1/users/{id}/password`.
  A delete becomes `disabled: true`. It needs an `act-approve` tick box next to `act-capunlock`.
- Approve/reject can now answer `403` with a message to show as it is.

## Known limit

- Failed-login counting is per server instance, in memory: with two instances a username gets up to
  15 tries on each, and a restart forgets the count.
