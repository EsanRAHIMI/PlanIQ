# PlanIQ — Reliability Test Runbook

How to run the reliability validation for the stabilization fixes (permissions, data-safety,
version restore, lifecycle). Two layers:

1. **Logic smoke tests** — run anywhere with Node ≥ 22, no stack needed.
2. **e2e suite** — runs against a live dev stack and reports PASS/FAIL per case.

The e2e suite is **self-seeding, idempotent, and safe to re-run**: every run creates a unique
`qa-e2e-<id>` tenant + users and (when `MONGO_URI` is set) deletes everything it created on
exit. It only ever touches data it created — never real customer data.

---

## 1. Logic smoke tests (no stack)

```bash
pnpm smoke
# runs, against the REAL code:
#   apps/api/test/permission.smoke.ts      → assertProjectMember        (12 checks)
#   apps/api/test/lifecycle.smoke.ts       → canTransitionProject       (15 checks)
#   apps/web/test/editor-store.smoke.ts    → editor store data-safety   (8 checks)
```
Expected: each prints `N passed, 0 failed`.

---

## 2. e2e suite (dev stack)

### 2a. Start the stack

```bash
# infra: Redis + MinIO (S3). Mongo: Atlas via root .env, OR local single-node replica set:
pnpm dev:infra
docker compose --profile local-mongo up -d mongo     # only if not using Atlas

# app processes (separate terminals, or use `pnpm dev`):
pnpm dev:api        # http://localhost:4000  (prefix /api/v1)
pnpm dev:worker     # background jobs (BullMQ)
pnpm dev:ai:docker  # optional — only needed for real analysis, not for these tests

# sanity:
pnpm dev:check      # all services healthy
```

### 2b. Run the tests

```bash
# Minimum — isolation, owner read/write, batch floor-scoping, version restore, lifecycle:
API_URL=http://localhost:4000/api/v1 pnpm e2e:reliability

# Full — also verifies viewer / editor / manager role grading. Needs DB access to seed
# same-tenant NON-admin members (the API has no "invite into tenant" endpoint, and a
# registered user is a tenant-admin who bypasses project membership by design):
API_URL=http://localhost:4000/api/v1 \
MONGO_URI=mongodb://localhost:27017/planiq \
  pnpm e2e:reliability
```

> `MONGO_URI` must point at the **same** database the API uses. The 3 role tests `skip`
> (not fail) when it's absent, so the minimum run stays green.

> Without `API_URL` the whole suite skips cleanly — CI without a stack stays green.

### 2c. Required env

| Var | Required | Purpose |
|---|---|---|
| `API_URL` | yes (else suite skips) | API base **including** `/api/v1` |
| `MONGO_URI` | for role tests + cleanup | seeds viewer/editor/manager members; deletes run data on exit |

---

## 3. What it verifies (case → fix)

| Case | Fix |
|---|---|
| outsider gets 403/404 reading floors/placements/rooms/versions/analysis-runs | C1 |
| outsider cannot write placements | C1 |
| owner can read + write | C1 |
| **viewer** can read but not write *(MONGO_URI)* | C1 (role grading) |
| **editor** can write *(MONGO_URI)* | C1 |
| **editor cannot approve; manager can approve/export/deliver** *(MONGO_URI)* | C1 + lifecycle |
| batch save on floor1 cannot delete floor2 placements | H2 |
| version restore creates an auto-snapshot; outsider cannot restore | C2 |
| create → approve → export → deliver works; impossible transition rejected | lifecycle |

## 4. Interpreting output
- `Tests: N passed` with `0 failed` → reliability suite green.
- Role tests showing `skipped` → you ran without `MONGO_URI` (expected for the minimum run).
- `Test Suites: 1 skipped` → you ran without `API_URL` (no stack).

## 5. Safety / idempotency notes
- Unique `qa-e2e-<timestamp>` namespace per run → no collisions on re-run.
- With `MONGO_URI`, `afterAll` deletes the run's tenants + all their projects/floors/placements/
  versions/users. Without it, the run leaves a single clearly-marked QA tenant (harmless; delete
  manually if desired). Either way, no real data is touched.
- The seed creates members directly in Mongo **only** because the API lacks a same-tenant invite
  endpoint — a known gap (see STABILIZATION-REPORT.md). It is test-only and does not change product code.
