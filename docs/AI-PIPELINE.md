# PlanIQ — AI / Computer-Vision Pipeline Design

The analysis engine is **self-hosted and deterministic-first**. No external Vision LLM is used in the normal production flow. The pipeline is a Python FastAPI service (`services/ai`) composed of staged, independently testable steps. Vision LLMs (OpenAI / Gemini / Claude) exist only as an **optional, admin-enabled fallback adapter**, disabled by default.

```
 source file (pdf/png/jpg/dwg)
        │
        ▼
 [1] Ingest & Rasterize ──► page images @ target DPI (PyMuPDF / Pillow; DWG→DXF→raster via ezdxf+matplotlib)
        │
        ▼
 [2] Preprocess (OpenCV) ──► deskew, denoise, binarize, normalize scale, detect drawing bbox
        │
        ├──────────────► [3a] Wall / line extraction (Hough + morphology) ──► wall mask, structural lines
        │
        ├──────────────► [3b] Room segmentation (contour + watershed on enclosed regions) ──► room polygons
        │
        ├──────────────► [4] OCR (PaddleOCR primary, Tesseract fallback) ──► text boxes → match to rooms
        │
        └──────────────► [5] YOLOv11 detection ──► symbols: doors, gates, windows, stairs, parking, existing devices
        │
        ▼
 [6] Semantic fusion ──► normalized Room{type,label,polygon,confidence} + Zone{gate,parking,entrance,…}
        │
        ▼
 [7] Rule Engine (deterministic) ──► Placement[] with rationale + confidence
        │
        ▼
 [8] Schema-validated AnalysisResult (Pydantic) ──► returned to API worker
```

---

## Stage 1 — Ingest & rasterize
- **PDF:** PyMuPDF renders each page at configurable DPI (default 200). Each page becomes a candidate **floor** (Site Plan, Ground, First, Roof…). Page text is extracted to help name floors.
- **Image (png/jpg):** loaded directly; EXIF-rotation corrected.
- **DWG (optional):** converted via `ODA File Converter`/`ezdxf` → DXF, then rendered to raster. If converter unavailable, return a clear `422` advising PDF/image export. (Feature-flagged: `AI_ENABLE_DWG`.)
- Output: normalized RGB images + per-page metadata.

## Stage 2 — Preprocessing (OpenCV)
Deskew (minAreaRect on text/line mask), grayscale, adaptive threshold/Otsu binarize, median+morphological denoise, detect the **drawing extent bbox** to crop title blocks/margins, compute a working resolution. All later geometry is normalized to `[0,1]` against this extent so output is resolution-independent.

## Stage 3 — Geometry
- **3a Walls/lines:** probabilistic Hough transform + morphological closing → long straight segments classified as walls; gives a wall mask used to bound rooms and to find external building corners (CCTV anchors).
- **3b Rooms:** invert wall mask → connected components / watershed to isolate enclosed regions → contour simplification (Douglas–Peucker) → candidate room polygons with area + centroid.

## Stage 4 — OCR & label matching
PaddleOCR (angle-classifier on) reads all text boxes. A normalizer maps raw strings to canonical room types using a synonym dictionary (e.g. `M.BED`,`MASTER`→`master_bedroom`; `MAJLIS`,`MAJLES`→`majlis`; `PARKING`,`CAR PORCH`,`SHED`→`parking`). Each text box is assigned to the room polygon whose interior contains it (or nearest centroid). Unmatched but meaningful labels (e.g. `GATE`, `MAIN DOOR`) become **zones**.

Canonical types (mirrored in `packages/shared/space-types.ts`):
`bedroom, master_bedroom, maid_room, majlis, living_room, sitting_area, dining, kitchen, corridor, entrance, main_door, outdoor, garden, parking, gate, staircase, lift, bathroom, store, service_area, roof`.

## Stage 5 — YOLOv11 symbol detection
Ultralytics YOLOv11 model trained on architectural plan symbols. Classes:
`door, double_door, window, gate, stair, lift, parking_symbol, north_arrow, existing_camera, existing_ap, sink, wc, tree`.
Used to: locate entrances/main door (door near building boundary), confirm gate/parking zones, find stairs/lift, and avoid placing devices on fixtures. Ships with a **mock/zero-shot fallback** when no trained weights are present (heuristic detections) so the system runs end-to-end before the model is trained. Training pipeline, dataset format (YOLO txt), and `data.yaml` live in `services/ai/training/`.

## Stage 6 — Semantic fusion
Combines geometry + OCR + detections into the final, confidence-scored `rooms[]` and `zones[]`. Conflict resolution: OCR label > detection-implied type > area/shape heuristic. Confidence is a weighted blend; low-confidence items are still returned (flagged) so the user can correct them.

## Stage 7 — Rule engine (deterministic device placement)
Pure, side-effect-free module (`services/ai/rules/`, logic mirrored in `packages/shared/rules.ts` for client-side "re-suggest"). Input: rooms, zones, walls, building bbox, scale, device library config. Output: `Placement[]` each with `position`, `rotation`, `confidence`, and a human-readable `rationale`.

Encoded engineering rules (matching the BEFORE→AFTER samples):

| Device | Placement logic |
|--------|-----------------|
| **CCTV** | External building corners with view to gate/parking/entrance; one per blind-spot quadrant; rotated to face inward/approach. Parking + gate get dedicated cameras. |
| **Wi-Fi AP** | One per ~80–100 m² living area; centroid of large rooms (living, majlis); one per floor minimum; avoid wet areas. Coverage-radius props drive spacing. |
| **ELV Rack / Switch / NVR** | Service area / store / technical room; fallback to corridor near staircase. NVR co-located with rack. |
| **Intercom screen** | Inside near main_door/entrance; **intercom bell + smart lock** at main_door/gate (outdoor side). |
| **Gate motor** | At `gate` zone. |
| **Thermostat** | One per bedroom/master_bedroom/living/majlis, on an interior wall near the door. |
| **Speaker / Volume control** | Living, majlis, dining, entertainment zones; speakers paired, volume control by entrance of the zone. |
| **Curtain motor** | Along window-bearing walls of bedrooms/living/majlis. |
| **Sensor (motion/occupancy)** | Corridors, entrance, staircase, key rooms; ceiling-center. |
| **Light switch / Push button** | Beside room doors (hinge side). |
| **Projector / Screen** | Majlis/living entertainment wall (projector ceiling-center facing screen wall). |
| **Data socket** | Per room near likely desk/TV wall; at rack. |

Spacing, mount heights, and counts are parameterized in `ruleConfig` (overridable per tenant in Settings). Every placement records *why* it was placed.

## Stage 8 — Output & validation
Result validated against the Pydantic `AnalysisResult` model (mirrors the Zod schema in shared). Invalid items are dropped with a warning rather than failing the whole job. The API worker persists rooms/zones/placements as **unreviewed** suggestions.

---

## Optional LLM fallback adapter (disabled by default)
Interface `VisionProvider { analyze(image, context) -> AnalysisResult }` with implementations:
- `CvProvider` (default, the pipeline above)
- `OpenAiVisionProvider`, `GeminiVisionProvider`, `ClaudeVisionProvider` (fallback only)

Enabled only when `AI_FALLBACK_PROVIDER` ≠ `disabled` **and** an admin opts in per-request (`provider:'llm_fallback'`) — intended for edge cases, admin review, or debugging poor CV results. LLM output passes through the **same rule engine and validation**, and is still fully editable. Keys via env; never invoked in the standard flow.

## Performance, scaling, testing
- Models loaded once at startup; warm. Per-page target < 3 s CPU / < 1 s GPU (excluding OCR-heavy pages).
- Horizontally scalable stateless workers; GPU pool for YOLO/OCR.
- Each stage has unit tests with fixture images; golden-file tests assert room/placement counts on the provided sample plans; the rule engine has pure deterministic unit tests.
