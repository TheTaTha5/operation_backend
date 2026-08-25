# railway-deployment: Deploy Operation Backend on Railway

## Input contract

- **Requested outcome:** Add the supplied Operation Backend project to a dedicated worktree, configure Railway deployment, and merge the completed work into `main`.
- **Acceptance criteria:** Repository contains the application source and Railway configuration; Railway builds TypeScript, starts the service, and checks `/api/health`; type checks, tests, and production build pass.
- **Allowed scope:** Application files supplied from the original worktree, `railway.json`, README deployment documentation, and this task handoff.
- **Constraints/invariants:** Preserve the Fastify `PORT` and `0.0.0.0` runtime behavior; do not commit dependencies, build output, or environment secrets.
- **Base branch:** `main`
- **Starting assumptions:** Railway supplies `PORT` and uses the repository root as its service source.

## Output contract

### Observable behavior

| Area | Before | After |
|---|---|---|
| Repository | Only initial README was committed. | Contains the TypeScript Fastify service, tests, package metadata, and deployment documentation. |
| Railway deployment | No Railway deployment contract. | Railpack runs `npm ci && npm run build`, starts `npm start`, and probes `/api/health`. |

### Interfaces and contracts

- **Added:** `railway.json` deployment contract and `/api/health` configured as the deployment health endpoint.
- **Changed:** README documents Railway setup.
- **Removed:** None.
- **Compatibility notes:** Railway provides `PORT`; the server already binds to it on `0.0.0.0`.

### Files changed

```text
added    .env.example
added    .gitignore
added    package-lock.json
added    package.json
modified README.md
added    railway.json
added    src/
added    test/
added    tsconfig.json
added    docs/development/tasks/railway-deployment.md
added    .agent-reports/railway-deployment.json
```

### Data and persistence impact

- **Database/schema:** None. The supplied application continues to use its in-process store.
- **API or mapper:** No API contract changes.
- **Migration required:** No.
- **Rollback effect on data:** Removing the deployment configuration and application commit does not migrate data.

## Verification evidence

| Command/check | Result |
|---|---|
| `npm ci` | Passed; dependencies installed. npm reported one high-severity transitive audit finding and a blocked optional esbuild install script. |
| `npm run check` | Passed. |
| `npm test` | Passed; 4 tests passed. |
| `npm run build` | Passed. |
| JSON parse of `railway.json` | Passed. |

## Decisions, risks, and rollback

- **Decisions:** Use Railpack with an explicit clean install and TypeScript build, then `npm start`; use the existing health route for Railway readiness.
- **Known risks:** The application uses in-process state, so state is not durable across restarts or multiple Railway instances. `npm audit` reports one high-severity dependency vulnerability.
- **Blockers:** None.
- **Dependencies:** Railway project creation and repository connection are performed in the Railway dashboard.
- **Follow-up work:** Replace the in-process store with durable transactional persistence before scaling beyond one instance; review and remediate dependency audit findings.
- **Rollback procedure:** Revert the merge commit or remove the Railway service; no data migration is involved.

## Agent handoff

- **Task:** railway-deployment
- **Branch:** `chore/railway-deployment`
- **Worktree:** `D:/projects/operation-backend-railway-deployment`
- **HEAD at scaffold:** `70b1d375026e1a68c7ba7f09c058b37fd67f3d69`
- **Merge base:** `70b1d375026e1a68c7ba7f09c058b37fd67f3d69`
- **PR:** None (local merge requested).
- **Unrelated changes left untouched:** The original worktree retains the user’s pre-existing uncommitted files; they were copied into this authorized implementation worktree without modifying the originals.
