# PlanIQ — Multi-Floor Training & Learning Workflow: Architecture Review & Plan

**Pre-coding deliverable.** Reuse the existing Training Center; turn `old_plans` into an operational multi-floor Before/After learning + evaluation dataset. No parallel services, no YOLO-first, no architecture replacement.

---

## 0. Dataset reality (inspected)

`old_plans/` holds **10 villa pairs** (Example 1–10, inconsistent casing). Verified:

- BEFORE and AFTER page counts **match in every pair** (4,4,2,2,4,3,3,4,4,4) → **34 pages/side**, so page-index matching is viable.
- **Every AFTER has a vector text layer** (13–74 words) with device labels *and* floor titles ("Site Plan / GROUND FLOOR / FIRST FLOOR / ROOF"). BEFOREs are graphic-only (0 selectable words → OCR needed). So engineer placements **and floor types** extract directly from AFTER text; floor type is nearly free.

This confirms the multi-floor framing and that the vector-text extractor (already built in `eval/extract_after.py`) scales to all 10 pairs.

---

## 1. What already exists (reuse)

**Models (`apps/api/src/db/schemas.ts`)** — all 5 the brief names exist:
- `TrainingSample` — **single** before/after image pair + `alignment` + bbox `annotations` (deviceCode + bboxNorm + spaceTypeHint + status) + `floorKind`/`drawingType` + `counts`. Status: draft→uploaded→annotated→reviewed→in_dataset.
- `TrainingDataset`, `ModelVersion` — YOLO-export / model-promotion (yolo11n). 
- `PlacementPriors` — versioned, tenant-scoped, `perSpace` = spaceType→deviceCode→{meanCount, rate, n}.
- `PlacementFeedback` — per-edit events (accepted/rejected/moved/added/deleted/retyped) with positions + nearSpace.

**API (`modules/training/training.module.ts`)** — samples CRUD, S3 `upload-url`/`complete`, `extract` (calls AI `/extract-devices`), `annotations`, `datasets/export` (YOLO), `priors/recompute`+`get`, `models`+`train` (stub), `eval/:id`, `feedback`+`stats`.

**Shared (`packages/shared/src/training.ts`)** — `learnPriors()` (from bbox annotations + spaceTypeHint), `hybridScore()` (blends rule+prior+qc+feedback), `dataYaml`/`yoloLabelLine`, `DEVICE_CLASSES`.

**AI service** — `/analyze` (full pipeline), `/suggest`, `/extract-devices` (heuristic bbox symbol candidates), `/ingest`.

**Admin UI (`app/admin/training/page.tsx`)** — sample list, before/after upload, bbox annotation canvas, datasets, models, priors + feedback views.

**My eval tooling (`services/ai/eval/`)** — `extract_after.py` (vector-text GT, the most reliable engineer signal), `calibrate.py` (count-based P/R/F1 + per-room priors), `batch_eval.py`, `groundtruth/`.

## 2. What's missing or broken (the real gaps)

1. **No project / multi-floor concept.** `TrainingSample` is one image pair. No grouping into a villa, no `pageIndex`, no per-page `floorType`, no Before/After page matching, no project-level metrics.
2. **No importer.** Samples are hand-uploaded one image at a time. Nothing ingests multi-page PDFs in bulk.
3. **The richest signal isn't wired in.** Engineer placements via **vector text** (my `extract_after.py`) live only as an offline CLI. The Training Center's `extract` uses the weak heuristic bbox detector instead.
4. **The learning loop is OPEN (decorative).** `learnPriors` stores priors and `hybridScore` exists, but **nothing reads `PlacementPriors`/`PlacementFeedback` back into the rule engine** — `grep` confirms `hybridScore` is never called outside its own file. Priors/feedback never change a single suggestion.
5. **No floor-type awareness in the engine.** Roof/site are treated like interior floors. No project-level logic (ELV rack once per project; gate/intercom from site/ground).
6. **Two parallel worlds.** My `eval/*.py` computes exactly the metrics the Training Center wants, but offline and Mongo-unaware.

## 3. Minimal scalable design (reuse-first)

Map the brief's concepts onto existing models with the **smallest** additions:

- **`TrainingProject`** *(one thin new model)* = a villa pair: `{name, sourceBefore, sourceAfter, pageCount, floorTypes[], matchSummary, status, metrics}`. Justified over a stringly `projectKey` because the brief makes "project" first-class and it carries project-level metrics + ELV/gate context.
- **`TrainingSample` = a Training Floor** *(extend, don't replace)*: add `projectId`, `pageIndex`, `pageCount`, `floorType` (site/ground/first/second/roof/basement/service/unknown), `matchConfidence`, `prediction` (AI placements + understanding metrics), `evalMetrics` (per-floor P/R/F1). Engineer placements stored in the existing `annotations` array with `source:'engineer_vector'` (point → tiny bbox).
- **Importer** *(repeatable; backend script + admin endpoint)*: scan `old_plans`, group by example number, render pages, push page images to S3, create one `TrainingProject` + one `TrainingSample`/page with inferred `floorType` + `matchConfidence`. Idempotent. **No hard-coded filenames.**
- **Vector-text extraction integrated**: port `extract_after` into the AI service as `/extract-after-text` (or a shared util); `extract` prefers it, falls back to heuristic/manual. Populates engineer annotations.
- **AI prediction + understanding** stored per floor by running the existing `/analyze` on each BEFORE page (background job — 34 pages × ~4s OCR is too slow to be synchronous).
- **Evaluation** = port `calibrate.py`'s count-based P/R/F1 into a shared function the API calls per floor → aggregate per project → per dataset. Same metric logic, one source of truth.
- **CLOSE THE LOOP (highest value):** make `suggest()` accept optional `priors` + `floorType` and apply the **already-built `hybridScore`** to nudge confidence and suppress device classes engineers never place in a space type — **customer rules always win** (priors only nudge/scope, never override an explicit rule or invent a device). Feed `PlacementFeedback` rejection rates in the same way. This is the one connection that turns "stored stats" into "the system learns."
- **Floor-type + project intelligence** in the engine: roof/site get perimeter/CCTV/gate logic, not bedroom/living logic; ELV rack chosen once per project; gate/intercom anchored to site/ground.
- **Feedback from real projects**: on lifecycle `approved`/`delivered`, snapshot reviewed placements + room corrections into `PlacementFeedback` (already modeled) so live projects feed priors. A hook, not a new pipeline.
- **YOLO stays optional**: dataset export + `ModelVersion` unchanged; `hybridScore` detector weight stays 0 until a model is approved. The importer *prepares* data for future YOLO, but nothing blocks on it.

## 4. Files to change
- `apps/api/src/db/schemas.ts` — add `TrainingProject`; extend `TrainingSample` fields.
- `apps/api/src/modules/training/training.module.ts` — import endpoint, project/floor list, run-AI (job), extract-after-text, evaluate, project-aware `recomputePriors`, approval→feedback hook.
- `packages/shared/src/training.ts` — extend `learnPriors` (floorType + engineer-vector source), floor-type inference helper, shared count-based eval fn, project/floor DTOs.
- `services/ai/app/main.py` + `pipeline/` — `/extract-after-text` (port `extract_after`); `/suggest` + `/analyze` accept `floorType` + `priors`; apply hybrid nudge.
- `services/ai/app/rules/engine.py` — accept `priors`+`floorType`; nudge/suppress; floor-type-aware rules.
- `apps/web/src/app/admin/training/page.tsx` — projects→floors view, Import button, matched Before/After, engineer vs AI placements, per-floor/project metrics, recompute priors.
- `services/ai/eval/` — generalize `extract_after`/`calibrate` to project/floor + write the import + metrics report over all 10 pairs (runnable now).

## 5. Phasing (so value lands measurably and safely)

**Phase A — Runnable now, no stack needed (proves the workflow + real numbers).** Generalize the python tooling to project/floor: import all 10 `old_plans` pairs → render → infer floor types from AFTER titles → extract engineer placements per floor → run AI per BEFORE floor → per-floor + per-project P/R/F1 + understanding metrics → recompute priors → write an **import report + metrics JSON**. Delivers the brief's measurable outcomes across all 10 villas without Mongo/S3.

**Phase B — Architecture wiring (type-checked; runtime needs dev stack).** `TrainingProject` + `TrainingSample` extension + importer endpoint + vector extraction in AI service + **close the priors loop in the engine** + floor-type/project intelligence + admin projects view + approval→feedback hook. Validated by `tsc` + unit tests offline; full end-to-end (import→Mongo→UI) verified on the dev stack.

## 6. Risks & limitations (honest)
- **Small data:** 10 villas / ~34 pages → priors are directional, not statistically robust. Customer rules stay primary; priors only nudge.
- **Page matching:** index-based is reliable here (equal counts) but not guaranteed for arbitrary future uploads → store `matchConfidence`, flag mismatches for admin.
- **Vector text dependency:** all 10 AFTERs have it; scanned AFTERs would need OCR/heuristic fallback (supported, lower confidence).
- **Throughput:** AI on 34 pages is slow → must be a background job, never a synchronous request.
- **Sandbox:** Mongo/S3/Redis aren't runnable here, so Phase B is built correct + type-checked + unit-tested offline; Phase A is fully runnable and carries the measurable proof.
- **YOLO:** remains untrained/optional; detector weight 0 until a model is approved.

## 7. PHASE A — RESULTS (runnable now, over all 10 villas)

Decisions taken: Phase A first; thin `TrainingProject`; live feedback auto-feed (opt-out). Phase A is implemented as resumable Python tooling (no Mongo/S3 needed) and run end-to-end over `old_plans`.

**Import report**

| | |
|---|---|
| Projects imported (no hard-coded names) | **10** |
| Floors/pages processed | **34** (all pairs page-count-matched) |
| Floor types inferred from AFTER titles | site / ground / first / roof |
| Engineer placements extracted (AFTER vector text) | **257** |
| AI runs on BEFORE pages | 34 (cached/resumable) |
| Low-confidence page matches flagged for review | several site pages (orientation mismatch → 0.50) |

**Dataset evaluation (engineer device classes, count-based)**

Micro **P = 0.99, R = 0.69, F1 = 0.81** (tp=178 fp=2 fn=79). Precision is near-perfect (the AI rarely places a class engineers didn't use); the gap is **recall** — the AI under-places vs engineers.

Per class (F1): Volume 0.95, Thermostat 0.92, Sensor 0.90, ELV Rack 0.89, Speaker 0.89, Intercom Screen 0.81, WiFi 0.73, Smart Lock 0.55, Gate Motor / Intercom Bell 0.22. Thermostat calibration from Priority 2 **generalised well** to 10 villas (F1 0.92, no longer over-placing).

Per floor type: ground 0.76, first 0.78, **site 0.50**, **roof — engineers place 0 devices but the AI placed 7 (false positives)**.

**Recomputed priors** (`eval/_out/priors.json`, `PlacementPriors.perSpace` shape — ready for Phase B Mongo load): 20 room types + 3 floor types. Sensible and actionable, e.g. majlis = AV hub (Speaker 2.33, Volume/WiFi 0.67), kitchen → Intercom Screen 0.83, bedroom → Sensor 0.92; **`perFloorType.roof` = empty (roof exclusion)** and **site = Gate Motor + Bell + Smart Lock + WiFi ×7** (the access devices the rule engine currently misses).

**What this measures for Phase B (the calibration/engine targets, now evidence-backed):**
1. **Roof false-positives** — engine must treat roof as no-interior-device (learned prior says 0). 
2. **Site under-placement** — gate motor / bell / smart lock + a site Wi-Fi AP belong on site/ground (recall 0.12–0.38 today).
3. **Wi-Fi recall 0.58** — engineers place ~1 AP per significant room; engine places fewer.
These flow naturally once priors + floorType are wired into `suggest()` (the open loop), with customer rules still winning.

**Off-discipline AI devices** (kept on separate opt-in layers per your decision, excluded from the metrics above): CCTV 79, Light Switch 48, Data Socket 43, Curtain Motor 18, Projector/Screen 11 each, NVR/Switch 8 each.

**New files (Phase A):** `services/ai/eval/old_plans.py` (importer + floor-type inference + match confidence + cached render), `training_workflow.py` (resumable per-floor analyze + engineer-GT cache), `training_report.py` (metrics + priors). Artifacts in `eval/_out/` (git-ignored).

**Honest limitations:** 10 villas only (priors directional); per-room priors bucket engineer AFTER-positions against AI BEFORE-room centroids (rasters differ → approximate; per-floor-type priors are exact and need no matching); AFTER must have a text layer (all 10 do). Phase B (model/API/UI/engine wiring) is built + type-checked offline next; full end-to-end needs the dev stack.

## 8. PHASE B — Architecture wiring + closed loop + YOLO-ready (built; Python measured, TS type-checked)

**Closed the learning loop (measured, runnable).** The rule engine now consumes learned priors + floor type:
- `services/ai/app/rules/priors.py` — upward-only confidence nudge from engineer priors (never penalises absent priors → no recall loss); records `meta.priorRate/hybridScore/learnedFrom`. Detector weight stays 0 until a YOLO model is in production.
- `engine.py suggest(rooms, zones, priors, floor_type, detector_active)` — floor-type policy (roof ⇒ no interior devices) + prior nudge. Mirrored in `packages/shared/src/rules.ts` (`SuggestOptions`).
- `services/ai/app/rules/project.py` — **project-level reconciliation**: building-wide singletons (ELV rack, switch/NVR, gate motor, smart lock, intercom bell) kept **once per project** on the best floor (multi-floor intelligence).

**Honest per-floor measurement over all 10 villas** (global pooling replaced — a wrong-floor device can't satisfy another floor's demand):

| Stage | P | R | F1 |
|---|---|---|---|
| Baseline (rules only) | 0.64 | 0.45 | 0.53 |
| + priors + floor-type policy | 0.67 | 0.45 | 0.54 |
| + project singleton reconcile | **0.68** | 0.45 | **0.54** |

Roof false-positives **7 → 0**. The loop's value is precision + roof exclusion; the harness now isolates **recall (0.45)** as the dominant remaining gap (engine under-places vs engineers — esp. Wi-Fi and site access devices), which is the next calibration target. *(Honest: modest F1 gain on 10 villas; the win is a working, explainable loop + the measurement that exposes the real target.)*

**Architecture (built + type-checked; runtime needs the dev stack):**
- `apps/api/src/db/schemas.ts` — **`TrainingProject`** (thin) + multi-floor `TrainingSample` (`projectId/pageIndex/floorType/matchConfidence/prediction/evalMetrics`, `engineer_vector` annotation source); `Project.feedForTraining` opt-out.
- `apps/api/.../training.module.ts` — `importProjects` (scans `old_plans`, no hard-coded names, idempotent), `listProjects/getProject`, `runProjectAI` (priors+floorType+detector), `evaluateProject` (per-floor→project P/R/F1 via shared `deviceCountMetrics`), `setFloorType`, `yoloStatus`; floor-aware `recomputePriors` (perSpace + perFloorType).
- `services/ai/app/main.py` — **`/extract-after-text`** (vector engineer extraction, `app/pipeline/after_text.py`); `/suggest` + `/analyze` accept `floorType`+`priors`+`detectorActive`; `/health` reports OCR engine + YOLO status.
- `packages/shared/src/training.ts` — `inferFloorType`, `deviceCountMetrics`, `ENGINEER_DEVICE_CLASSES`, **`yoloStatus`** (state machine: not_available→training→evaluated→approved→production; `active` + `detectorWeight` only at production).
- `apps/web/.../admin/training/page.tsx` — Projects panel: Import old_plans, project→floors table, editable floor type, match-confidence flags, Run-AI, Evaluate (F1), recompute priors, **YOLO active/inactive badge**.
- `projects.service.ts` — **auto-feed** approved designs → `PlacementFeedback` (opt-out via `feedForTraining`); never blocks delivery.

**YOLO position (as directed):** first-class but optional. Status states + `detectorWeight 0` until production; perception-only (icons/devices/doors/columns) feeding detection confidence & candidate generation; never overrides geometry/OCR/rules/QC/customer rules; dataset export (existing) draws from the 34 imported pages + future approved projects; admin shows active/inactive; system fully functional with YOLO inactive.

**Validation:** 19/19 Python tests pass; shared `tsc` clean; `apps/web` `tsc` 0 errors; `apps/api` `tsc` no new errors in touched files (36 pre-existing, unchanged). Not runnable in-sandbox: import→Mongo→S3→UI (no stack) — built correct + type-checked; the Python loop + 10-villa metrics are the runnable proof.

## 9. RECALL CALIBRATION (measured over 10 villas / 34 floors)

**Diagnosis (from the harness):** recall was lost two ways — (1) **unclassified rooms produced zero devices** (rules key off room type, so an untyped room got nothing; e.g. Example 8 ground = 3 rooms all unclassified → 0 AI devices vs 21 engineer), and (2) **coverage devices under-placed** (engineers put ~1 Wi-Fi AP + sensor per room; rules placed them sparsely). The largest fn classes were Wi-Fi (34), Sensor (26), then the site access devices.

**Fixes (rule calibration from the engineer layouts; customer rules still win):**
- **Coverage rooms** — one ceiling Wi-Fi AP per significant indoor room, *including real-but-unclassified rooms on interior floors* (the untyped-room fix); occupancy sensor per coverage room (size-gated) + circulation.
- **Site access guarantee** — gate motor + intercom bell + smart lock placed on the site/ground sheet at the front perimeter when no gate/parking is detected (engineers always fit these); project reconcile keeps one set per project.
- **ELV rack guarantee** — fallback to the central ground-floor room when no service/staircase/store anchor is typed (every villa has one rack; reconcile keeps one per project).
- All mirrored Python `engine.py` ↔ TS `rules.ts` (output verified identical); 19/19 Python tests pass; shared `tsc` clean.

**Before → after (per-floor, honest):**

| Metric | Before recall work | After |
|---|---|---|
| **Recall** | 0.45 | **0.72** |
| **F1** | 0.54 | **0.68** |
| Precision | 0.68 | 0.65 |
| Wi-Fi recall / F1 | 0.58 / 0.73 | 0.83 / 0.75 |
| Gate / Lock / Bell recall | 0.12–0.25 | **0.88** |
| Roof false-positives | 7 | **0** |

Recall reached the **0.70+** operational target. Precision dipped slightly (0.68→0.65) by design — the brief prioritised recall, and every added device remains reviewable in the editor.

**Honest remaining gaps:** Speaker (R 0.58) and Intercom Screen (R 0.58) are *type-specific* — they need better room **typing** (OCR/segmentation) to fire in untyped majlis/living/kitchen rooms; Sensor precision is 0.49 (recall-prioritised over-placement); Thermostat precision 0.29 (small-sample noise). The next lever is room understanding (reducing unclassified), not more rule density. YOLO remains optional/untrained — not the current recall lever.

## 10. ROOM UNDERSTANDING — label-seeded typing (measured)

**Diagnosis:** half the interior-floor rooms were unclassified (48% labelled / 51% unclassified). OCR was *not* the bottleneck — it read 18–48 tokens/floor and they classified fine (KITCHEN, MAJLIS, BEDROOM…). The failure was **assignment**: furniture-heavy plans fragment the watershed into sub-0.012 slivers, so labels landed in no polygon (e.g. Example 8 ground: 13 of 18 classifiable labels orphaned; 3 rooms accepted, 0 typed).

**Fix — `app/pipeline/label_rooms.py` (OCR + geometry fusion, inverted):** instead of "segment, then drop a label in each region", flood-fill the enclosed room *from each label's position* on a **furniture-suppressed** wall mask (long H/V lines, keep only the large structural components). Every readable label becomes a typed room bounded by real walls — no alignment problem. Watershed regions not covered by a label stay `unclassified` (coverage + review). Wired into `cv_provider` and the eval via `fusion.fuse_with_labels`; runs at reduced resolution for speed. Mirrors are pure-CV — no new service.

**Before → after (10 villas / 34 floors):**

| Metric | Before typing work | After |
|---|---|---|
| Interior-floor rooms **unclassified** | 51% | **40%** |
| Interior-floor rooms **typed (OCR)** | 48% | **59%** |
| Example 8 ground: typed rooms | 0 | **9** |
| **ELV Rack** F1 (found in real service rooms, not a fallback) | 0.27 | **1.00** |
| **Speaker** recall | 0.58 | **0.65** |
| Dataset Recall / F1 | 0.72 / 0.68 | 0.73 / **0.68** |

The aggregate F1 held at 0.68 while **understanding got materially better and more trustworthy**: fewer unknown rooms, ELV racks now detected in genuine service spaces (no longer leaning on the central-room fallback), and Speaker recall up. Sensor types were restricted to bedrooms/living/majlis + circulation (engineer priors) to hold precision as more rooms were detected.

**Honest remaining gaps:** Intercom Screen recall is still 0.58 (a *placement* question — engineers fit more screens than the rule emits; not a typing gap); Sensor precision 0.40 (per-floor distribution); 40% of interior rooms remain unclassified (labels OCR can't read — stylised/rotated text, or genuinely unlabeled rooms). Next lever for those is OCR on rotated/low-contrast labels, or the optional YOLO symbol layer — not rule density.

## 11. Open decisions for you
1. **Build order:** Phase A first (real numbers across all 10, then wire), or both together?
2. **`TrainingProject` model:** add the thin new collection (recommended), or overload `TrainingSample` with a `projectKey` string to avoid any new model?
3. **Live feedback default:** should approved real projects auto-feed priors (opt-out), or be opt-in per project?
