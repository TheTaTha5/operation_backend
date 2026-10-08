# Your to-do list

What only you can do: decisions, pushes, Railway, the other repos. Tick by deleting the line.

## Deploy what is on `main`

1. **Push `main`.** It is about 25 commits ahead of GitHub; Railway runs none of it until then.
2. **Railway variables:** remove `OIDC_ISSUER`, `OIDC_AUDIENCE`, `AUTH_PASSWORD_USERS`; keep
   `AUTH_JWT_SECRET` and `AUTH_REQUIRED=true`; set `B2C_API_KEY` to legacy's value.
3. **Import the users — nobody can log in until you do:**
   `SOURCE_DATABASE_URL=<legacy> TARGET_DATABASE_URL=<railway> npm run import:users -- --commit`,
   after the agents import (so the sales staff's `sales_id` connects). Rerun until cutover.
4. **Create Love Kingdom's service user**: `POST /v1/users` with `agent_id: "a_b2c"`,
   `edit_areas: ["operations"]`. Send them the username and password.
5. **Give `act-approve`** to the staff who approve over the allotment and FOC
   (`PATCH /v1/users/{id}`). Until then only `admin` and `Tata` can.

## Tell the other sides

- **Legacy integration client (the wt handoff):**
  - split the pickup text into `pickup_time`, `pickup_time_end`, `pickup_at_pier` (and join to show);
  - the approval card reads `approvals[].days[].licensed_free`;
  - log in with `POST /v1/login`; Users screen on `/v1/users`, delete becomes `disabled: true`,
    an `act-approve` tick box; show a `403` on approve/reject as it is.
  - send the `version` it read as `If-Match` on every booking and seat-lock save, and show a
    `409 stale_version` as "someone changed this; reload".
- **Love Kingdom:** log in as the service user (the old test login stops); availability may use the
  `X-Api-Key` it already has (`docs/love-kingdom-integration.md` §2). Optionally send `If-Match` on
  amend and cancel.

## Decisions waiting for you

- **Live updates** (`change-feed-model.md`): the 5 questions at the end.
- **Overnight charters** (`ovn-charter-return-model.md`): the importer skips them until decided.
- **Next slice:** pricing (`pricing-model.md`, decided: contracts first) or deployment guards
  (`deployment-guards-model.md`, has questions to answer).
- **Make `If-Match` required** once the integration client and Love Kingdom send it (today it is
  optional: a save without it is last-write-wins).

## Ask ops

- **The 2027 route calendars.** Five Panwa routes close to bookings on 2027-01-01
  (`route-season-calendars-expire.md`).

## Housekeeping

- Docker Desktop is stopped; tests ran on the native PostgreSQL 18 (port 5433).
- Not committed anywhere: `docs/performance/` and the `todo-status` and `railway-deploy-triage`
  skills under `.claude/skills/`. Commit or delete them.
- Unmerged branches to merge or delete: `feat/bulk-seat-locks`, `chore/load-testing`,
  `chore/docker-legacy`, `docs/cleanup` (already in `main` by other commits),
  `docs/login-decisions` (already in `main` through `feat/login`).
