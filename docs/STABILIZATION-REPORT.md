# PlanIQ — Bug Stabilization & Platform Reliability Report

Static-analysis audit of the full stack (the dev stack — Mongo/S3/Redis — isn't runnable in this environment, so findings are code-level and validated via type-checks + unit tests). No new features; surgical fixes only.

## Bugs found & fixed

### CRITICAL

**C1 — Cross-project data access (broken tenant/membership isolation).**
*Root cause:* the project list is membership-scoped (`ownerId`/`members[]`), but by-id endpoints for `placements`, `floors`, `analysis` rooms, `versions`, and `assets` authorized on **`tenantId` only**. Any authenticated user in a tenant could read, edit, or delete the devices, floors, rooms, versions, and uploaded plans of projects they are not a member of (`exports` already did this correctly via `assertProjectMember`).
*Fix:* applied the existing `assertProjectMember` helper consistently — every by-id/by-floor endpoint now resolves floor→project (or asset→project, room→floor→project) and asserts the required role (**viewer** to read, **editor** to write). Files: placements, floors, analysis, versions, assets, analysis-runs modules.

**C2 — Version restore: destructive data loss + no authorization.**
*Root cause:* `versions.restore` **deletes every placement on the floor** and reinserts a snapshot, authorized on `tenantId` only; `versions.snapshot` did a cross-tenant `findById` and read placements/rooms/zones **without a tenant filter**.
*Fix:* restore now requires **editor** project membership; reads/deletes/inserts are tenant-scoped; the pre-restore auto-snapshot is retained so a restore is itself reversible.

### HIGH

**H1 — Editor data loss on reload/close.**
*Root cause:* autosave is debounced 800 ms and a failed save keeps edits queued, but nothing warned the user if they closed/reloaded the tab with edits still pending → silent loss.
*Fix:* added a `beforeunload` guard that prompts when `dirty`/`deleted` edits are pending. (The existing failed-save `requeueDirty` + toast is good and was left intact.)

**H2 — Batch autosave not scoped to the floor.**
*Root cause:* the editor's batch upsert/delete filtered by `{_id, tenantId}` only, so a crafted batch could move/delete placements belonging to other floors.
*Fix:* added `floorId` to the upsert and delete filters.

### MEDIUM

**M1 — Dead "Group" button.** Set an unused `groupId` (nothing reads it; no ungroup; no selection propagation). *Fix:* disabled with an explanatory tooltip rather than ship a half-working control (per the phase rules). Ungroup was never exposed.

**M2 — Hidden devices hard to recover.** Hidden devices only reappear via the canvas "All" toggle. *Fix:* Hide button tooltip now points to the recovery path. (Recoverable, so not data-loss — but discoverability was poor.)

**M3 — analysis-runs history lacked membership check** (read-only run traces of other projects were visible within a tenant). *Fix:* added `assertProjectMember` (viewer).

**M4 — Unauthenticated SSE analysis stream.** `GET /floors/:id/analysis/stream` takes a floorId with no auth/membership and streams progress %. *Status: documented, not fixed* — `EventSource` can't send auth headers; tightening needs a query-token scheme. Low data sensitivity (progress %), but should be closed before public launch.

**M5 — Admin training import / run-AI block the HTTP request.** `importProjects` and `runProjectAI` loop over PDFs calling the AI service synchronously (minutes for 10 villas). *Status: documented, not fixed* — admin-only, one-time, bounded; recommend moving onto the existing BullMQ queue (the pattern already exists for analysis/export).

### LOW

**L1 — Duplicated lifecycle orchestration.** `ProjectsService.applyStatus` and the delivery `setStatus` both implement the transition. Both validate via the shared `canTransitionProject` + `deliveryMirror` (the real SSOT), so they're consistent — but the orchestration is duplicated. *Recommend* delegating delivery→`ProjectsService.setStatus` (left as-is now to avoid DI-refactor risk).

**L2 — Undo/Redo always enabled** (no-op when stacks empty). *Fix:* disabled when `past`/`future` are empty.

## Verified already-correct (not broken, left intact)
- Failed-save recovery (`requeueDirty` + toast), floor-switch flushes save first.
- `exports` and project approval→feedback already use `assertProjectMember`.
- Lifecycle transitions validate via shared `canTransitionProject`; no impossible transitions found.
- No empty `catch {}` blocks in the API; optional loads use intentional `.catch(()=>{})` for graceful degradation.
- Background analysis/export/process run on BullMQ with attempts/backoff (not blocking HTTP).
- Editor commands undo/redo/duplicate/rotate/lock/delete are wired to real store actions; autosave persists them.

## Changed files
- `apps/api/.../placements.module.ts`, `floors.module.ts`, `analysis.module.ts`, `versions.module.ts`, `assets.module.ts`, `analysis-runs.module.ts` — project-membership authorization + floor-scoped batch + tenant-scoped version snapshot/restore.
- `apps/web/src/app/editor/[floorId]/page.tsx` — `beforeunload` unsaved-changes guard.
- `apps/web/src/components/editor/Toolbar.tsx` — disabled Group, undo/redo disabled-states, action tooltips.

## Commands / gates run
- `packages/shared` `tsc --noEmit` → **0 errors**.
- `apps/web` `tsc --noEmit` → **0 errors**.
- `apps/api` `tsc --noEmit` → **36 → ~13 errors** (all pre-existing `.lean()` union typing in untouched files: seed, auth, guards; **no new errors introduced**).
- Python rule/quality/understanding tests → **19/19 pass**.

## Remaining risks (honest)
- **Not run end-to-end**: Mongo/S3/Redis aren't available here, so these fixes are type-checked and unit-tested but not exercised against a live DB. The membership checks should be smoke-tested on the dev stack (a non-member must get 403 on each by-id endpoint).
- **M4 (SSE auth)** and **M5 (sync admin jobs)** are documented, not fixed.
- **Pre-existing API `.lean()` typing** (~13) remain; harmless (builds via `nest build`), worth a cleanup pass.
- Membership checks add one indexed project lookup per editor request — negligible, but worth confirming under load.

## Reliability validation — smoke tests (written + run)

Three suites exercise the **real** code behind the fixes and were executed here; one HTTP e2e suite is written and run‑ready on the dev stack (it skips cleanly without `API_URL`).

**Commands run** (full runbook: `docs/E2E-RELIABILITY.md`)
- `pnpm smoke` → runs the 3 logic suites (permission + lifecycle + editor-store).
- `npx jest --config apps/api/test/jest-e2e.json reliability` → e2e compiles & skips clean without a stack.
- Dev stack: `API_URL=http://localhost:4000/api/v1 [MONGO_URI=…] pnpm e2e:reliability` ← run on your stack.

**Pass/fail matrix**

| Suite | What it proves | Result |
|---|---|---|
| permission.smoke (real `assertProjectMember`) | non‑member→403; viewer reads, can't write; editor reads+writes, can't manage; manager manages; owner/global‑admin bypass; empty project rejects | **12/12 pass** |
| lifecycle.smoke (real `canTransitionProject`) | intended transitions allowed; impossible (draft→delivered, delivered→draft, unknown) rejected; delivery mirror consistent | **15/15 pass** |
| editor-store.smoke (real Zustand store) | failed autosave keeps dirty (`takeDirty`+`requeueDirty`); delete reversible via undo/redo; requeue ignores ghost ids; locked device not deleted | **8/8 pass** |
| reliability.e2e-spec (HTTP, dev‑stack) | cross‑tenant 403/404 on floors/placements/rooms/versions/analysis‑runs; owner read/write; **viewer reads-not-writes, editor writes, editor-can't-approve, manager approves/delivers** (role grading, `MONGO_URI`); **batch on floor1 can't delete floor2**; **version restore auto‑snapshots + outsider denied**; create→approve→export→deliver + impossible transition rejected | **written + self-seeding + idempotent, 9 tests; compiles & skips clean here; run on dev stack — see docs/E2E-RELIABILITY.md** |
| Python rules/quality/understanding | engine invariants unchanged | **19/19 pass** |

**Bugs found by these tests:** none new — the suites confirm the C1/C2/H1/H2 fixes hold at the logic level. The lifecycle suite did surface a wrong test *assumption* (review→exported is intended per the documented map, not a bug), which was corrected — no product change.

**Not executed here:** the HTTP integration assertions (per‑endpoint 403, batch floor‑scoping at the query, version‑restore snapshot) require Mongo/S3/Redis. They are encoded in `reliability.e2e-spec.ts` and must be run on the dev stack before launch.

## Remaining launch blockers
1. **Run `reliability.e2e-spec.ts` on the dev stack** (`API_URL=…`) — the integration half of C1/C2/H2 is validated by logic + static analysis here, but must be confirmed against a live DB.
2. **M4 — unauthenticated SSE analysis stream** — add a query‑token before public exposure.
3. **M5 — admin training import/run‑AI run synchronously** — move onto BullMQ before multi‑user load.
(Non‑blocking: L1 duplicated lifecycle orchestration; ~13 pre‑existing API `.lean()` typing warnings.)

## Demo-readiness checklist
- [ ] Smoke-test on dev stack: non-member gets 403 on placements/floors/rooms/versions/assets by-id.
- [ ] Editor: make edits, close tab → unsaved-changes prompt appears.
- [ ] Editor: kill API mid-save → "edits kept, will retry" toast; edits persist on recovery.
- [ ] Version restore as editor works; as non-member is rejected; auto-snapshot created.
- [ ] Toolbar: Group is visibly disabled with tooltip; all other actions work + show saved/saving.
- [ ] Hidden device recoverable via the "All" canvas toggle.
- [ ] Confirm M4/M5 acceptable for the demo audience (admin-only import; progress-only SSE).
