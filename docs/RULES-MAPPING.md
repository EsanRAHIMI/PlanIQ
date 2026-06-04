# PlanIQ — Customer Engineering Rules → Implementation Map (P4/P5)

Source of truth: the customer's "Convert CAD to PDF" engineering document. This maps every device rule to concrete engine logic and states what is implementable **now** (with rooms + zones + polygons + floor composition) vs. what needs **better geometry** (walls, doors, columns, ceiling height, scale, richer space taxonomy).

Input we have today: spaces (`type`, `polygon`, `centroid`, `area`, `reviewStatus`), zones (`gate`/`parking`/`garden`/`driveway`/`entrance` as points), and per-space `meta` (incl. an optional `doubleHeight` flag we now read). Source of truth for placement = **non-rejected (accepted/corrected/manual) spaces** — the re-suggest path already enforces this.

Legend: ✅ now · ◑ partial (heuristic) · ⛔ needs better detection.

## CCTV
| Customer rule | Implementation | Status |
|---|---|---|
| 2 cameras at exterior-wall ends covering the street | Take building bbox; pick the edge nearest the **gate** zone (street side), place 2 angled inward | ◑ (street side inferred from gate, not multi-street) |
| +2 per additional street (corner plot) | needs multiple street/boundary detection | ⛔ |
| Camera at every external door + its corridor | 1 camera per `entrance`/`main_door` space | ◑ (guest/service/seating doors aren't distinct space types) |
| Cover pool / BBQ / play / seating | only `garden`/`parking` exist as zones → 1 general yard cam + parking cam | ◑ (pool/bbq/play/seating not in taxonomy) |
| One general yard-view camera | 1 if `garden` present | ✅ |
| One camera inside each **closed** kitchen | 1 per `kitchen` space | ◑ (can't tell open vs closed; defaults to place) |
| One camera inside each laundry | `laundry` not a space type | ⛔ |
| "Don't exaggerate" (≈2 street + 3–4 yard) | per-device floor cap + only real entrances/zones drive count | ✅ |

## Gate motor & intercom (outdoor)
| Rule | Implementation | Status |
|---|---|---|
| Gate motor at main gate | `GATE_MOTOR` per `gate` zone | ✅ |
| Outdoor intercom unit per pedestrian door | 1 `INTERCOM_BELL` per `gate` zone | ◑ (per-pedestrian-door needs door detection) |

## Intercom screens
| Rule | Implementation | Status |
|---|---|---|
| Service screen in each kitchen (behind door) | 1 `INTERCOM_SCREEN` per `kitchen` | ◑ (centroid, not "behind door") |
| Screen in maid room if far from kitchen | 1 per `maid_room` | ◑ (no distance metric → always if maid room) |
| Screen in main living (dead wall, not column) | 1 in largest `majlis`/`living_room` | ◑ (dead-wall/column placement ⛔) |
| One screen per upper floor near staircase | 1 near `staircase` | ◑ (floor-kind inferred from staircase/composition) |
| Roof needs none unless bedroom | rooms drive it; roofs have no relevant spaces | ✅ |

## ELV rack (+ core switch + NVR)
| Rule | Implementation | Status |
|---|---|---|
| Under staircase → service corridor → store(with AC) → house entrance (near DBs) | priority chain: `staircase` → `service_area` → `store` → `entrance`/`main_door` | ✅ (priority order) |
| Not on a column | column geometry unknown | ⛔ |
| Outdoor stores not acceptable / store must have AC | `store` deprioritised below indoor service; indoor/outdoor + AC unknown | ◑ |

## Wi-Fi (ceiling, preferred method)
| Rule | Implementation | Status |
|---|---|---|
| AP in guest lobby between Majlis & Dining | AP at **midpoint** of majlis+dining centroids | ✅ |
| AP in main living covering outdoor/pool | AP in largest `living_room` | ◑ (can't verify it faces outdoor) |
| AP in service area (kitchen + maid) | AP in `service_area` or `kitchen` | ✅ |
| Upper floor: AP at master-bed entrance (covers bed+dressing), hall, other rooms | AP at `master_bedroom`; AP per ~2 other bedrooms; AP in hall (`sitting`/large `corridor`) | ◑ (dressing not a type; entrance point approximated by centroid) |
| Extra APs for long corridors | AP for any `corridor` with bbox aspect ≥ 3 | ✅ (elongation from polygon) |

## Speakers & volume control
| Rule | Implementation | Status |
|---|---|---|
| 2 in Majlis, 2 in Living, 2 in Dining, 2 per extra upstairs living | 2 speakers (L/R) in **each** `majlis`/`living_room`/`dining`/`sitting_area` | ✅ |
| Wide hall (not corridor) gets 2 | `corridor` with large area treated as hall → 2 | ◑ (area heuristic, no true hall flag) |
| One volume knob per 2 speakers near switches | 1 `VOLUME_CONTROL` per speaker pair, at room edge | ◑ ("near switches/dead wall" ⛔) |

## Motion sensors
| Rule | Implementation | Status |
|---|---|---|
| In corridors, stairs, lobbies, dressing rooms, toilets (ceiling) | 1 per `corridor`/`staircase`/`bathroom`/`entrance`/`lift` | ◑ (dressing/lobby not distinct types) |
| ~4 m coverage each (quantity by area) | large/elongated corridor → 2 sensors; else 1 | ◑ (no scale → area buckets, not metres) |

## Double-height exception
| Rule | Implementation | Status |
|---|---|---|
| No ceiling devices (Wi-Fi/speaker) in 8–10 m double-height areas; place at nearest lowered ceiling | engine reads `space.meta.doubleHeight`; if set, Wi-Fi/speaker relocate to nearest normal space | ◑ (logic ready; **no detector sets the flag yet** → needs ceiling-height detection) |

## Cross-cutting
- **Avoid columns** ⛔ (no column detection) — deliberately *not* faked.
- **Source of truth = corrected/accepted spaces** ✅ (re-suggest feeds only non-rejected spaces; manual adds survive re-analysis).
- **QC becomes a guardrail, not a gate** (P5): the engine now targets the right rooms deliberately, so QC stops re-rejecting by room-type. It keeps: confidence floor, per-device sanity caps (villa-scale), per-**room** cap counting only room-anchored devices (so the 4 perimeter cameras no longer starve a room's budget — the P1 bug), dedup, basis tagging, and the 0-spaces consistency rule from P0.

### Net effect on counts (single-street villa, majlis+living+dining+kitchen+service+stairs+gate)
Old engine: 4 corner CCTV, ≤2 speakers total, ≤2 Wi-Fi, rack only if `service_area`. New engine: ~2 street + entrance/kitchen/yard CCTV, **6 speakers** (2×3 rooms) + 3 volume, **3–4 Wi-Fi** (guest/living/service), rack via priority chain, intercom screens in kitchen/maid/living/stairs, sensors across circulation — matching how the engineers actually design.
