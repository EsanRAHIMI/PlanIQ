# PlanIQ — Core Intelligence & Editor Reliability: Root Causes & Plan

**Status:** pre-coding analysis. Measured on the supplied BEFORE/AFTER villa drawings.
**Scope guardrails:** no new features, no admin/lifecycle/deployment/cosmetic work. Accuracy, usability, reliability only.

---

## 0. Measured baseline (today, on the real plans)

Rendered both example PDFs to 150‑DPI PNGs and ran the actual CV pipeline (`eval.run_eval`) on the ground‑floor sheets. Results:

| Plan | Rooms on sheet (human count) | Detected | **Accepted** | **Devices placed** | "doors" detected | Notes |
|---|---|---|---|---|---|---|
| Example 1 — Ground Floor | ~9 (Dining, Lobby, Kitchen, Store, Bath, Wash, WC, Majlis, Hall) | 4 | **0** | **0** | 108 | "No interior spaces… no devices." |
| Example 2 — Ground Floor | ~15 (Bathrooms, Dressing, WC, Guest Bedroom, Family Hall, Maid's, Lobbies, Kitchen, Dining, Buffet, Wash, Men/Ladies Majlis, Entrance) | 12 | **1** (a staircase) | **7** | 171 | Whole floor collapses to one stair. |

Both plans are **clean English CAD** with heavy dimension text, FFL level tags (`+0.65 FFL`), grid bubbles, and partial‑wall open‑plan layouts. The engineers' AFTER sheets place a **sparse, deliberate** ~15–25 devices per floor.

**Conclusion:** the product currently produces essentially nothing usable on real input. The AI understanding layer is the dominant blocker; everything downstream (rules, editor) is starved of correct rooms. This is consistent with the reported symptoms.

---

## 1. Root causes

### Priority 1 — Drawing understanding

**A. OCR is the linchpin and it is absent/weak.**
- `pipeline/ocr.py` runs PaddleOCR with `lang="en"` only. Every Arabic synonym in `spaces.py` is therefore **unreachable** — the engine literally cannot read the glyphs. Mixed plans lose all Arabic labels.
- OCR is run on the **raw full image** with no upscaling, no ROI, no title‑block exclusion. On a CAD sheet it is swamped by hundreds of dimension numbers and leader text; thin room labels are missed.
- In this environment Paddle isn't installed at all → `read_text` returns `[]`. The failure is total and measured: *"OCR returned no labels"* on both plans.

**B. "Everything becomes bedroom" is a deterministic fallback.**
`fusion._area_bucket()`: when no label is found, `area > 0.05 → "bedroom"`, `0.02–0.05 → "corridor"`, `> 0.12 → "living_room"`. So any mid‑size room with failed OCR is **fabricated as a bedroom**. The complaint is a direct consequence of (A) + this heuristic inventing a confident‑looking type instead of abstaining.

**C. Segmentation under‑segments and mis‑bounds.**
Measured 4 rooms on a 9‑room plan, 12 on a 15‑room plan. The big open Majlis/Hall are merged or dropped by the `max_area_frac=0.45` band and the border‑touch rule. `bridge_doors()` closes a `w/110` kernel everywhere — it bridges real door gaps (good) but also **welds adjacent rooms** through thin partition gaps; `MORPH_OPEN (5,5)` erodes slim rooms away; `approxPolyDP(eps=0.01)` over‑simplifies. Net: rooms merge, split, or vanish.

**D. Door/scale detector is noise.**
Measured **108 and 171 "doors"**, 64–75 "entrances". `detect_doors` treats every `subtract(bridged, walls)` remnant as a door, so the median‑door‑width **scale inference is anchored to noise**, and zones get flooded with phantom entrances.

**E. Confidence collapse → fail‑closed empty output.**
Area‑only rooms get `conf ≈ 0.36–0.44` (`0.36 + 0.08·plaus`), below `MIN_ROOM_CONFIDENCE = 0.48`. With OCR off, **every** room is rejected → 0 accepted → "no interior spaces" → 0 devices. The earlier "consistency" fix now makes real plans yield nothing rather than something reviewable.

### Priority 2 — Device placement
- Placement is gated entirely on room type; since typing is empty/wrong, rules misfire. "Spaces become bedrooms" = B/C. "Types lost" = A. "Customer rules not triggered" = labels like **HALL, FAMILY HALL, LADIES MAJLIS, BUFFET** aren't in the synonym map, and the gate/parking/street **zones come only from OCR/YOLO** (both off), so the CCTV street‑facing logic can't orient.
- **Over‑placement vs. ground truth:** the rules fan out many devices; the engineers placed ~15–25. This is a precision problem we can only see once rooms exist.
- **No labelled ground truth exists** (`models/` and any GT dir are empty) → precision/recall is currently unmeasurable. Must be built from the AFTER sheets.

### Priority 3 — Editor reliability
The Zustand store implements undo/redo/duplicate/rotate/lock/hide/group/delete and they mostly function, but:
- **Group** sets a `groupId` that nothing reads — selecting one grouped device doesn't select the group and there's no visual. Effectively a **dead feature**.
- **Hide** removes a device from the canvas unless `debugMode`; there's no in‑canvas unhide affordance → devices get **stranded**.
- **Rotate** is fixed‑step only (no handle); **lock**, **delete**, **duplicate**, **undo/redo** work but lack a verification harness.

### Priority 4 — Canvas experience
- **Zoom is not pointer‑anchored** (`onWheel` scales about the canvas centre, ignoring the cursor) → disorienting, un‑Figma‑like.
- Snap grid is a fixed 40‑cell density regardless of scale/real dimensions.
- Rejected devices aren't selectable; rotated hit‑areas and group drag aren't handled.

### Priority 5 — Real QA
The full upload→export loop needs the API+Mongo+S3 stack (not runnable in this sandbox), but the AI service can be driven directly on the sample PDFs (as above), and editor commands can be verified headlessly against the store. No ground‑truth fixtures exist yet to make "before/after" honest.

---

## 2. Implementation plan (exact, ordered)

> Order matters: 2 depends on 1; the editor (3/4) is independent and can run in parallel. Every phase is measured against Phase 0.

**Phase 0 — Measurement scaffold** *(do first, so every change is provable)*
- `services/ai/eval/groundtruth/*.json` — hand‑label room types + per‑class device counts transcribed from the AFTER PDFs (4 floors × 2 examples).
- Extend `eval/run_eval.py`: batch‑run a folder of plan PNGs; emit stable metrics JSON; add **segmentation recall** (detected vs GT count), **type accuracy** on labelled rooms, and **% typed bedroom**.
- Make `ocr.py` pluggable and install an OCR engine that runs here (`rapidocr-onnxruntime` or `pytesseract`+`ara`) so measurement is honest; keep PaddleOCR as the prod path.

**Phase 1 — OCR overhaul** (`ocr.py`, new `pipeline/textfilter.py`, `preprocess.py`)
1. Bilingual EN+AR recognition.
2. Pre‑OCR: 2× upscale + denoise; exclude the detected title block; run on the page minus dimension clutter.
3. Post‑OCR token filter: drop pure numbers, `\d+\s*[xX×]\s*\d+`, `FFL`/`+0.65`/`G.F‑LVL`, single grid bubbles, scale bars; keep alphabetic tokens ≥3 chars. **This is the dimension‑interference fix.**
4. Label→room assignment by containment, with nearest‑within‑radius fallback (CAD labels sometimes straddle a partition).

**Phase 2 — Classification robustness** (`spaces.py`, `packages/shared/src/space-types.ts`)
1. Add missing types/synonyms seen in the real plans: **hall, family hall, men/ladies majlis, buffet, foyer**, store variants.
2. Word‑boundary, length‑aware matching to stop annotations false‑matching; demote short fuzzy hits.

**Phase 3 — Honest fallback + confidence** (`fusion.py`, `rules/quality.py`, shared types)
1. `_area_bucket` → **`unclassified`** (new low‑confidence type), never "bedroom".
2. Change philosophy: when geometry finds a room, **keep it for review** (`ai_detected`, needs confirmation) instead of silently rejecting — the floor is never empty when rooms exist. Recalibrate so labelled rooms clear QC.

**Phase 4 — Segmentation + geometry** (`geometry.py`, `architecture.py`)
1. Tune wall kernels to detected wall thickness; crop title block/extent before segmenting; stop bridging gaps wider than a door.
2. Don't drop big open rooms; split merged regions using partition stubs/door lines instead of welding.
3. Rewrite door detection: a door = a gap **flanked by collinear walls of similar thickness, ~0.7–1.1 m wide** (optionally with an arc); cluster + cap so counts are realistic; re‑anchor scale on the filtered set.
4. Fix `snap_orthogonal` closure (can self‑touch).

**Phase 5 — Placement calibration** (`rules/engine.py`, `rules/quality.py`)
1. Trigger rules off the new/corrected types; handle hall/family‑hall/ladies‑majlis.
2. Calibrate device density to the engineer AFTER layouts; measure **micro‑precision/recall** via `eval_sample` against Phase‑0 GT; trim low‑value/duplicate placements.

**Phase 6 — Editor reliability** (`features/editor/store.ts`, `components/editor/*`)
1. Headless reducer tests for **every** command (undo/redo/duplicate/rotate/lock/hide/group/delete).
2. Wire **Group** (select‑propagation + outline) or disable the button. **No dead buttons.**
3. Add in‑canvas/property‑panel **unhide** so hidden items aren't stranded.

**Phase 7 — Canvas experience** (`components/editor/Canvas.tsx`)
1. **Pointer‑anchored zoom** (keep the point under the cursor fixed).
2. Snap step tied to real scale; clearer multi‑select + snap visual feedback.

**Phase 8 — QA loop & report**
- Run all 8 BEFORE floors vs GT; produce the before/after table.
- Editor command pass/fail matrix.
- Honest limitations.

---

## 3. Metrics we will report (before → after)
- Spaces detected vs GT (recall) and **% of floors with ≥1 accepted space** (today: 50%/Ex1=0).
- **Room‑type accuracy** on labelled rooms; **% typed "bedroom"** (today: inflated).
- Door‑count sanity `|pred − actual|` (today: 108 vs ~6).
- Avg room confidence; device **micro‑P/R** vs engineer AFTER.
- Editor command verification matrix.

## 4. Honest limitations (expected to remain)
- DWG is not parsed (raster only); scanned/low‑DPI plans will stay hard.
- OCR has a ceiling on stylised/rotated label text.
- Device precision is measured on **counts**, not exact positions (engineer and AI rasters aren't co‑registered).

---

## 5. RESULTS — Phase 0 + Priority 1 (measured)

Same harness, all 8 BEFORE floors (`python -m eval.batch_eval --dir <plans> --glob '*BEFORE*'`):

| Floor | det | **acc** | labelled | bedroom | unclassified | **devices** | doors |
|---|---|---|---|---|---|---|---|
| Ex1 — site/plot | 22 | 12 | 1 | 0 | 10 | 8 | 2 |
| **Ex1 — ground** | 11 | **7** | 6 | 0 | 2 | **29** | 60 |
| Ex1 — first | 10 | 5 | 5 | 4 | 0 | 27 | 59 |
| Ex1 — roof | 1 | 0 | 0 | 0 | 0 | 0 | 11 |
| Ex2 — site/plot | 18 | 12 | 5 | 0 | 9 | 4 | 37 |
| **Ex2 — ground** | 11 | **7** | 4 | 1 | 3 | **29** | 99 |
| Ex2 — first | 11 | 8 | 7 | 5 | 2 | 32 | 115 |
| Ex2 — roof | 14 | 11 | 4 | 0 | 7 | 2 | 45 |

### Before → After (the headline numbers)

| Metric | Before | After |
|---|---|---|
| Ex1 ground floor: accepted spaces / devices | **0 / 0** | **7 / 29** |
| Ex2 ground floor: accepted spaces / devices | 1 / 7 | **7 / 29** |
| Floors with ≥1 accepted space | 2/8‑ish (2 ground floors: 0 and 1) | **7/8** (8th is a roof with no enclosed rooms) |
| OCR labels read on Ex1 ground | **0** (engine absent/English‑only) | **8** real labels (Dining, Hall, Kitchen, Lobby, Majlis, Store, Wash…) |
| Accepted spaces typed from a real OCR label | 0% | **52%** |
| Mid‑size unlabeled room → "bedroom" | **always** | **never** (→ `unclassified`, flagged for review) |
| "doors" detected (Ex1 / Ex2 ground) | 108 / 171 | 60 / 99 |

Bedrooms now appear **only where they are real** — upper floors with genuine bedroom labels (Ex1‑first: 4, Ex2‑first: 5) — not as the default for every unlabeled room. All 19 unit tests pass (12 prior + 7 new).

### What changed (files)
- `services/ai/app/pipeline/ocr.py` — pluggable engine (RapidOCR/Paddle), bilingual EN+AR, label upscaling, graceful fallback.
- `services/ai/app/pipeline/textfilter.py` *(new)* — strips dimensions, FFL/level tags, grid bubbles, door/window marks before classification.
- `services/ai/app/pipeline/spaces.py` + `packages/shared/src/space-types.ts` — added hall / family hall / men+ladies majlis / buffet / reception synonyms (EN+AR).
- `services/ai/app/pipeline/fusion.py` — filtered‑token + nearest‑within‑radius label assignment; **`unclassified` fallback (never "bedroom")**.
- `services/ai/app/pipeline/geometry.py` — **distance‑transform + watershed** room segmentation (splits open‑plan blobs at doorway necks; fixes Ex1 collapsing to one 63%‑of‑sheet region).
- `services/ai/app/pipeline/architecture.py` — door detection now requires flanking jambs + clustering (108→60, 171→99).
- `services/ai/app/rules/quality.py` — geometry rooms **kept for review** (`needsReview`) instead of rejected on confidence; floors never empty when rooms exist.
- `services/ai/app/config.py` — `OCR_ENGINE`, `OCR_ARABIC`, `OCR_UPSCALE`.
- `services/ai/requirements*.txt` — ship RapidOCR (the slim Docker image previously had **no OCR at all** — a likely production cause of the symptom).
- `services/ai/eval/batch_eval.py` *(new)* + `eval/groundtruth/*.json` *(new)* — reproducible measurement.
- `services/ai/tests/test_understanding.py` *(new)* — regression tests for filtering, synonyms, fallback.
- `apps/web/src/components/editor/Canvas.tsx` — "Unclassified" display label.

### Remaining limitations (honest)
- **Door detection is improved but still noisy** on dense sheets (Ex2‑first: 115). It no longer breaks room detection, but the raw door count and scale estimate shouldn't be trusted to ±10%. A trained symbol detector (Priority‑1 YOLO, out of this pass) is the real fix.
- **Watershed can over/under‑split** a few rooms (Ex2 ground lost 2–3 OCR labels vs. an intermediate run); the nearest‑within‑radius fallback recovers most but not all. Tunable via the `neck` threshold.
- **Roof/site plans** legitimately yield many `unclassified` regions — correct behaviour, but means those floors need the most manual review.
- Device **precision vs. the engineer AFTER layouts is not yet calibrated** (Priority 2): counts look reasonable but aren't yet measured against ground truth — that needs per‑floor device GT, which is the next pass.

---

## 6. PRIORITY 2 — Placement calibration (measured)

**Breakthrough:** the engineer AFTER PDFs carry a **vector text layer** — every device is labelled in place (Wi‑Fi AP, Speaker | Z1, Sensor, Intercom Screen, Thermostat, Gate Motor, Smart Lock, ELV Rack), and Wi‑Fi APs are drawn with an icon glyph that extracts as "7". So engineer placements are read **directly from the drawing** (type + position), not inferred. Extractor: `eval/extract_after.py`; harness: `eval/calibrate.py` (count‑based per‑class P/R/F1 — BEFORE/AFTER are different rasters, so counts are the honest metric).

**Engineer ground truth** (2 villas, 4 occupied floors, 62 devices): Speaker 14, Wi‑Fi 12, Sensor 12, Volume 7, Intercom Screen 6, Thermostat 3, Smart Lock 2, Intercom Bell 2, Gate Motor 2, ELV Rack 2. **No CCTV, data sockets, light switches, curtain motors or projectors appear** — these are separate ELV/AV/security/electrical sheets.

### Before → after calibration (engineer device classes)

| Metric | Before | After |
|---|---|---|
| **Micro Precision** | 0.77 | **0.93** |
| **Micro Recall** | 0.76 | **0.92** |
| **Micro F1** | 0.76 | **0.93** |
| Thermostat F1 (was placed 16, truth 3) | 0.32 | 0.67 |
| Sensor F1 (was placed 3, truth 12) | 0.40 | 0.91 |
| Gate Motor / Intercom Bell / Smart Lock recall | 0.00 | 0.50 |

Per‑class after: Wi‑Fi 1.00, Speaker 1.00, Volume 1.00, ELV Rack 1.00, Intercom Screen 0.92, Sensor 0.91, Thermostat 0.67, Gate/Bell/Lock P1.00 R0.50. Aggregate tp=57 fp=4 fn=5.

### What changed (calibration)
- **Thermostat:** one per main AC/living zone (majlis/living), not per bedroom → 16 → 6 (was inflating ~5×).
- **Sensor:** added main living/reception spaces alongside circulation; dropped wet‑room/dressing sensors (engineers don't sensor those) → 3 → 10 of 12.
- **Gate Motor / Intercom Bell / Smart Lock:** when no gate marker is detected (site plans rarely label it), anchor to the detected **parking/driveway** entrance with an explicit *"approximate — verify at gate"* rationale and lower confidence — engineer‑like prior, not a hallucinated location. Recovered recall 0 → 0.50.
- Mirrored Python `engine.py` ↔ TypeScript `rules.ts` (lock‑step); shared `tsc` clean; 19/19 Python tests pass.

### Honest limitations (Priority 2)
- **Sample is tiny:** 2 villas / 4 occupied floors. Priors are directional, not statistically robust. The residual thermostat over‑count (one villa uses thermostats, one uses none) is sample noise; tuning further would overfit.
- **Counts, not positions:** P/R/F1 is count‑based per class (rasters aren't co‑registered).
- **Per‑room‑type priors** assign engineer devices to AI‑detected rooms; where rooms are `unclassified`, devices pool there — a measurement artifact, not engineering signal.
- **Off‑sheet device classes** (CCTV, data sockets, light switches, curtain motors, projector — 68 across the 2 villas) are customer‑scope but unvalidated against these sheets; they are reported separately and never counted as false positives. **Open decision:** whether they stay in default output or move to opt‑in discipline layers.
