# PlanIQ — Phase 1 Technical Diagnosis

_Prepared 2026-06-03. No code changed. This is the pre-implementation review requested before Phase 2._

This document maps the system as it exists, traces the data flow end-to-end, separates production-ready parts from placeholders, and explains the **root cause** of each problem the team is observing. It closes with a prioritized Phase 2 plan that fixes the architecture rather than adding features.

> Working tree note: the repo currently has **uncommitted changes** in `apps/api` and `apps/web` (see `git status`). The findings below describe the code as it sits on disk today.

---

## 1. System map

| Layer | Tech | Responsibility | State |
|---|---|---|---|
| `apps/web` | Next.js 14, Zustand, Konva | Auth UI, projects, upload, Figma-lite editor, export modal, admin | Functional, but editor hides the most important capability (see §6) |
| `apps/api` | NestJS | HTTP API, auth/RBAC, projects/floors/placements/exports/admin, AI client | Solid, production-grade scaffolding |
| `apps/api` worker | BullMQ (`worker.ts`) | `process` (raster→floors), `analyze` (call AI, persist), `export` (Playwright PDF) | Orchestration is sound; persists both accepted + rejected placements |
| `services/ai` | FastAPI, OpenCV, PaddleOCR, YOLOv11 | `/ingest`, `/analyze`, `/suggest` — the CV pipeline + rule engine + QC | **Does not boot** (§2.1); pipeline logic is the core weakness |
| `packages/shared` | TS | Zod contract, device library, rule-engine mirror, types | Good; rule mirror drifts from Python (§5) |
| Infra | MongoDB Atlas, S3/MinIO, Redis, CloudFront, Nginx | Storage, queue, CDN | Production-wired |

**End-to-end flow (verified):**
upload → S3 (presigned) → API enqueues `process` → worker calls AI `/ingest` (PDF→page PNGs) → creates `Floor` per page + default layers → enqueues `analyze` → worker calls AI `/analyze` → CV pipeline (`preprocess → extract_walls → segment_rooms → OCR → YOLO → fuse → rule engine → QC`) → worker persists `DetectedRoom` / `DetectedZone` / `Placement` (accepted **and** rejected-hidden) and writes an `AnalysisRun` → SSE progress → editor loads **placements + layers only** → autosave → versions → `export` renders PDF (cover + per-floor + legend + schedule), filtering hidden/rejected.

Architecturally this is a **real production design**, not a demo: multi-tenant, soft-delete, audit logs, RBAC, analysis-run traceability, immutable versions, schema validation of AI output before persistence. The problems are concentrated in the **CV pipeline, the rule engine, the QC layer, and what the editor exposes** — not in the plumbing.

---

## 2. Critical defects (system-down / correctness)

### 2.1 The AI service cannot start — missing imports
`services/ai/app/main.py` calls `logging.basicConfig(...)` and `logging.getLogger(...)` at module top level (lines 15–16) and `time.time()` (lines 58, 76), but **never imports `logging` or `time`**. Top-level imports are only `os, numpy, requests, fastapi` + local modules (verified by AST scan).

Effect: `uvicorn app.main:app` raises `NameError: name 'logging' is not defined` at import — `/health`, `/analyze`, `/ingest` are all unreachable on a clean start. This was introduced in the latest commit (`3e37c7c`), not the initial baseline. **Any analysis quality discussion is moot until this is fixed**, because a fresh deployment of the current code has no working AI service. This is fix #0.

### 2.2 "Devices appear even when accepted spaces are zero"
This reported symptom is real and the mechanism is now pinned down:

- In `rules/engine.py`, **CCTV perimeter cameras** are derived from the bounding box of `rooms` (`_bbox`), and **gate/parking/intercom/gate-motor** devices are derived from `zones` — neither is gated on _accepted rooms existing_.
- When OCR is unavailable, `fuse()` assigns every room a flat `confidence = 0.42` (area fallback). QC's `MIN_ROOM_CONFIDENCE = 0.48` then **rejects all of them** → `acceptedSpaces = 0`.
- But zone-derived and bbox-derived devices survive QC: `apply_placement_qc` uses `_nearest_room`, which returns `None` when there are no rooms, so `space_category = "unknown"` and those devices are **not** caught by any room-type rule.

Result: a floor with **0 accepted spaces but several accepted devices** — exactly the inconsistency that destroys user trust. The counts shown to the user (`detectedSpaces`, `acceptedSpaces`, `acceptedPlacements`) are individually correct but **mutually contradictory** because spaces and several device classes are computed from different inputs.

---

## 3. Space detection — the root weakness

Everything downstream inherits the quality of `geometry.segment_rooms`, and today it is a naïve heuristic:

- **Walls** = one morphological close (`kernel = width/200`) over an adaptive threshold. It cannot distinguish walls from furniture, hatching, dimension lines, text, title blocks, or the drawing border.
- **Rooms** = connected white components of the inverted wall mask. Consequences: open-plan areas merge into one blob; rooms joined by doorways merge (no door-gap closing); furniture/text _inside_ a room splinter it into fragments.
- **Thresholds** (`min_area_frac 0.012`, `max 0.6`) are arbitrary fractions of the _whole image_, so real small rooms (baths, stores) are dropped and the whole-floor blob is dropped, while the threshold's meaning shifts with every crop/zoom.
- **No scale.** Everything is normalized 0–1; `Floor.scale` exists in the schema but is never populated. So "area > 0.04 ⇒ bedroom" is meaningless across plans of different extents.
- **No title-block/legend removal**, no door/opening detection, no wall vectorization, no interior-vs-exterior separation. The "drawing extent" crop is the whole binary, including title blocks and north arrows.

This is why detection is "unreliable" and "too many spaces are rejected": the detector produces blobby, low-confidence regions and QC then discards most of them.

---

## 4. Room classification — collapses when OCR fails

`fusion.fuse` types a room by: OCR label whose centroid falls inside the polygon → else a 3-bucket **area heuristic** (`>0.08 living, >0.04 bedroom, >0.02 corridor, else corridor`).

- **PaddleOCR frequently returns nothing** (heavy dep, `lang="en"` hard-coded, no Arabic — and Gulf villa plans are routinely bilingual, with _Majlis_ etc. in Arabic). The pipeline emits the warning "OCR returned no labels" and then **every room is typed by area alone**, so the entire taxonomy collapses to only `living_room / bedroom / corridor`. That is the "weak classification" complaint precisely.
- **Lossy synonym mapping**: substring matching maps `hall → living_room` and `lobby → corridor`, but the customer rules explicitly warn _not_ to confuse halls with corridors, and treat the guest **lobby** between majlis and dining as a living area. `pantry → kitchen` erases a distinction the rules depend on (screen/Wi-Fi in pantry).
- **Flat confidence** (0.42 / 0.45) means a real classification and a pure guess look identical to QC, which then rejects both.

---

## 5. Placement realism vs. the customer's engineering rules

I read the attached customer document (the business source of truth) and compared it to `rules/engine.py` + `rules/quality.py`. The engine is **generic and contradicts the customer's actual method in most device classes.** Highlights:

| Device | Customer rule (source of truth) | Current code | Gap |
|---|---|---|---|
| **ELV rack** | Under-staircase (not on a column) → service corridor → store _with AC_ → house entrance near electrical/Etisalat DBs | Only `service_area` centroid; nothing if absent | Priority chain absent; rack+switch+NVR vanish if no `service_area` |
| **Intercom** | Outdoor unit per pedestrian door; screens in each kitchen (behind door), service lobby, maid room (if far), main living dead-wall, pantry, one per upper floor near stair | One screen at entrance + one bell at gate | Massively under-placed; ignores doors, kitchens, maid, per-floor logic |
| **CCTV** | 2 at street ends (+2 per extra street); a camera at _every_ external door; outdoor facilities (pool, BBQ, play, seating); one yard overview; one inside each **closed kitchen** and each **laundry** | 4 geometric building corners + gate + parking + 1 corridor | Ignores doors, outdoor facilities, kitchens, laundries; corners ≠ street logic |
| **Speakers** | 2 in Majlis **and** 2 in main living **and** 2 in dining **and** 2 per upstairs living; a volume knob per pair near switches | 2 in the single largest majlis/living only | Dining/extra rooms get none — **and `quality.py` caps `SPEAKER = 2` per floor**, so a villa can never exceed 2 speakers. Direct conflict |
| **Wi-Fi** | Ceiling APs: guest lobby (majlis↔dining), main living (covering outdoor/pool), service area (kitchen/maid); upstairs master-entrance + hall + others; extra APs for long corridors; **double-height exception** | Max 2 APs in largest living/majlis/sitting | Caps at 2; ignores service area, lobby, per-floor and double-height logic |
| **Sensors** | Corridors, stairs, lobbies, **dressing rooms, toilets**; ~4 m coverage each (quantity by area) | 2 in corridor/stair/entrance | Ignores dressing/toilets; no coverage math |

Compounding contradiction: `quality.py` `SKIP_PLACEMENT` rejects devices in `store`, `roof`, **`bathroom`** — but the customer explicitly wants a **camera in each closed kitchen and laundry** and **sensors in toilets**. The engine, QC, and the customer rules disagree with each other. There is also **no geometry to reason over** for "dead wall vs main wall," "not on columns," "near electrical switches," or "double-height avoidance," because walls/openings/columns are never extracted.

The TS mirror (`packages/shared/src/rules.ts`) and Python engine are claimed to match but have already drifted (e.g. synonyms, caps), so client "re-suggest" and server analysis can diverge.

---

## 6. Editor & transparency — the trust gap

- **The editor never shows detected spaces.** `editor/[floorId]/page.tsx` loads `/floors/:id/placements` + layers only. A `GET /floors/:floorId/rooms` endpoint **exists** but is never called. So the user cannot _see or correct_ room detection/classification — yet "understand spaces correctly" and "correct the AI" are the #1 success criteria. The most important review surface is missing.
- **The AI panel shows internals, not meaning.** `AiAnalysisDetailsPanel` surfaces provider, fallback chain, `durationMs`, raw QC counts and rejection strings — "highly technical, not meaningful to users." Per-placement `rationale` strings exist but are not assembled into a plan-level narrative or grouped by room. No coverage overlays (Wi-Fi radius, CCTV cones).
- **No structured link from a device to its justification.** `rationale` is a free-text string, not a reference to the room/zone that caused it, so the system cannot reliably explain, re-derive, or audit a placement.
- Magic thresholds are duplicated: `pdf-html.ts` independently hard-codes `confidence < 0.62` to hide devices, so an admin who changes `minDeviceConfidence` gets an export that disagrees with the editor.

---

## 7. Data model assessment

Strong overall (multi-tenant, soft-delete, audit, runs, versions, validated AI output). Gaps that block Phase 2:

- `Floor.scale` is defined but never calibrated → no real-world units.
- No `Wall` / `Opening(Door/Window)` / `Column` entities → geometry-aware placement is impossible.
- `Placement` has no reference to the justifying room/zone (only a string `rationale`).
- Taxonomy missing types the customer needs: `pantry`, `laundry`, `dressing`, guest `lobby` (distinct from corridor), `pool`, `bbq`, `play_area`, `seating`, `service_lobby`.
- `DetectedRoom` ids are not surfaced to the editor for correction.

Minor: `llm_fallback` uses outdated model ids (`gpt-4o`, `claude-3-5-sonnet-20240620`, `gemini-1.5-pro`) — harmless while disabled, but should be refreshed before enabling.

---

## 8. What is production-ready vs. placeholder

- **Production-ready:** auth/RBAC, project/floor/asset lifecycle, S3 presigned upload, BullMQ orchestration, analysis-run traceability, versions, PDF export rendering + hidden-filtering, multi-tenant data model, config/env validation, Docker/compose.
- **Partially implemented:** rule engine (works but generic and contradicts customer rules), QC (works but gate-keeps instead of guiding, with contradictory caps), editor (full canvas, but no room review), transparency panel (data present, presentation wrong).
- **Placeholder / weak:** **space segmentation** (heuristic), **room classification** (OCR-or-bust), scale calibration (absent), YOLO detector (untrained, no-ops), Arabic OCR (absent), DWG (off by default).

---

## 9. Phase 2 plan — fix the architecture, in priority order

**P0 — Unbreak & make results self-consistent (days)**
1. Add `import logging` / `import time` to `main.py`; add a CI smoke test that imports `app.main` and hits `/health` so this can never regress.
2. Reconcile the counts so the system can never show "0 spaces, N devices": treat zone-scoped devices (gate/CCTV-perimeter) as explicitly _zone-derived_ and report them separately, and suppress room-derived devices when accepted rooms is 0. One source of truth shared by `floor.counts`, `qcSummary`, stored placements, editor, and export. Remove the duplicated `0.62` literal in `pdf-html.ts`.

**P1 — Make the system explainable & correctable (the trust fix)**
3. Load `DetectedRoom`/`DetectedZone` into the editor as an editable "Spaces" layer; let users fix type/label and **re-run rules from corrected spaces** via the existing `/suggest`. This directly satisfies "understand & correct."
4. Give each placement a structured reason (reason-code + ref to the room/zone that justified it), and replace the technical panel with a plan-level narrative + per-room "why," plus coverage overlays.

**P2 — Rebuild space detection**
5. Real pipeline: title-block/legend removal → line vectorization (LSD/Hough) for wall segments → door-gap closing → region partition (watershed / contour hierarchy) so adjoining rooms separate → furniture/text suppression. Emit a clean **{walls, openings, spaces}** contract so any detector (CV now, trained YOLO or vision-LLM later) is swappable behind it.
6. Add scale calibration (scale-bar detection / known-dimension / 2-point user calibration); persist `Floor.scale`; convert all area thresholds to m².

**P3 — Rebuild classification**
7. Multi-signal typing: bilingual OCR (en+ar) → fixture cues (toilet/kitchen symbols via YOLO) → area/shape/adjacency priors; blended confidence instead of flat 0.42. Expand the taxonomy (§7). When unknown, mark `unknown` for user confirmation instead of forcing living/bedroom/corridor.

**P4 — Rewrite the rule engine to the customer document**
8. Encode each device exactly as the doc specifies (ELV rack priority chain; intercom per door/kitchen/maid/floor; CCTV per door + outdoor facilities + closed kitchen + laundry + street logic; speakers per entertainment room incl. dining + per-floor + volume-per-pair; Wi-Fi lobby/living/service + upstairs + corridor extras + double-height; sensors with 4 m coverage incl. dressing/toilets). Make geometry-aware placements (dead wall, avoid columns, double-height) where walls/openings from P2 allow. Single rule source mirrored to TS with parity tests.

**P5 — QC as a guardrail, not a gate**
9. QC should _flag and explain_ and default to **showing** suggestions for review (the brief: always reviewable). Hard-reject only true nonsense (indoor device outdoors, off-canvas). Remove policy caps that belong in the rules (e.g. `SPEAKER = 2`). Reconcile `SKIP_PLACEMENT` with the customer rules.

**P6 — Evaluation & quality reports**
10. Build an eval harness using the provided **Example 1/2 BEFORE→AFTER PDFs as ground truth**: room-detection IoU, classification accuracy, and device-count deltas vs. the human design; emit a per-floor quality report. Tune thresholds against these real deliverables, not guesses.

The ordering is deliberate: P0–P1 restore _trust and consistency_ on the current detector (fast, high value); P2–P4 raise the _ceiling_ on quality; P5–P6 keep it honest and measurable. We do not add new product surface until detection, classification, placement, and QC are consistent and explainable.
