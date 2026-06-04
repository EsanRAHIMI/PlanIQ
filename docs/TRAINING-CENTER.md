# PlanIQ — Training & Feedback Center (technical design)

**Principle: extend, don't replace.** The Geometry Intelligence, Room Classification, Rule Engine, QC, Evaluation Harness, Editor, Mongo models and AWS architecture stay exactly as they are. The Training Center is a new, additive module that (a) captures BEFORE/AFTER engineer samples and editor feedback as ground truth, (b) learns from them, and (c) feeds a **hybrid decision engine** that *augments* the rule engine — it never overrides it by default.

---

## 1. Where it plugs into the current system

| Existing piece | How the Training Center uses it (no changes to it) |
|---|---|
| `StorageService` (S3 presign/put/get) | stores BEFORE/AFTER rasters, YOLO datasets, model artifacts under `…/training/…` keys |
| `MODELS` registry + Mongoose | new collections added alongside the existing ones |
| `@Roles('admin')` + `RolesGuard` | every training endpoint is admin-only and tenant-scoped |
| AI service `/analyze` + `architecture.py` | reused to analyze the BEFORE plan (spaces/zones) for evaluation |
| Rule engine + QC (`engine.py`/`rules.ts`, `quality.*`) | produce the baseline placement compared against engineer ground truth |
| Eval harness (`services/ai/eval/run_eval.py`) | extended with a sample-level comparison (rule output vs AFTER annotations) |
| Editor autosave | emits accept/reject/move events → `PlacementFeedback` |
| AI `/health` weightsLoaded | reports the **approved** production model |

---

## 2. Data model (new collections, all tenant-scoped + soft-delete)

- **TrainingSample** — one BEFORE/AFTER pair. `{tenantId, name, projectType, floorKind, drawingType, engineer, date, notes, before:{s3Key,width,height}, after:{s3Key,width,height}, alignment:{scale,dx,dy,rotation,sameScale,sameOrientation}, status:'draft'|'uploaded'|'annotated'|'reviewed'|'in_dataset', split:'train'|'val', counts:{devices}}`
- **TrainingAnnotation** — device boxes on the AFTER plan. Embedded array on the sample (small N) or its own collection for scale. `{sampleId, deviceCode, bboxNorm:[x,y,w,h], spaceTypeHint?, source:'heuristic'|'human', status:'pending'|'confirmed'|'false_positive', reviewedBy, reviewedAt}`. False-negatives are just human-added boxes.
- **TrainingDataset** — an immutable export version. `{tenantId, version, sampleIds[], split:{train,val}, classCounts:{code:n}, yoloKey(s3), dataYamlKey, manifestKey, createdBy}`
- **ModelVersion** — `{tenantId, version, datasetId, status, artifactKey(s3), baseModel:'yolo11n'|…, metrics:{mAP50,mAP5095,precision,recall,perClass:{code:{p,r,ap}},lossCurve[]}, trainedBy, approvedBy, notes}` with `status ∈ draft|training|trained|evaluated|approved|production|archived`.
- **PlacementPriors** — learned statistics, recomputed from confirmed annotations. `{tenantId, version, perSpace:{spaceType:{deviceCode:{ratePerRoom, meanCount, n}}}, perimeter:{deviceCode:rate}, sampleN}`.
- **PlacementFeedback** — `{tenantId, projectId, floorId, deviceCode, action:'accepted'|'rejected'|'moved'|'added'|'deleted'|'retyped', fromPos?, toPos?, nearSpace?, runId?, userId, at}`.

---

## 3. API endpoints (all `@Roles('admin')`, tenant-scoped)

```
# Samples
POST   /training/samples                 create (metadata)
GET    /training/samples                 list (+counts, status)
GET    /training/samples/:id             detail (+presigned before/after URLs + annotations)
PATCH  /training/samples/:id             edit metadata / split
DELETE /training/samples/:id             soft delete
POST   /training/samples/:id/upload-url  {role:'before'|'after', mime} → presigned PUT
POST   /training/samples/:id/complete    {role} verify in S3 + read dims + (optional) align
POST   /training/samples/:id/extract     run heuristic device extraction on AFTER → annotations(source:heuristic)

# Annotations
PUT    /training/samples/:id/annotations replace/save the reviewed boxes
POST   /training/samples/:id/annotations add one box (false-negative)
PATCH  /training/annotations/:aid        correct label/box/status
DELETE /training/annotations/:aid

# Dataset + priors
POST   /training/datasets/export         {sampleIds?, valRatio} → YOLO dataset to S3 + classCounts
GET    /training/datasets                 list versions
POST   /training/priors/recompute         learn placement priors from confirmed annotations
GET    /training/priors                    current priors

# Models
POST   /training/models                   register a model version (draft)
GET    /training/models                    list + metrics
PATCH  /training/models/:id/status        promote/demote (status workflow + guards)
POST   /training/models/:id/train         enqueue a training job (GPU worker)

# Evaluation
POST   /training/eval/:sampleId           rule-engine output vs AFTER ground truth → per-class/space metrics
GET    /training/eval                      aggregate latest eval

# Feedback
POST   /training/feedback                  editor emits accept/reject/move/…
GET    /training/feedback/stats            per-device accept/reject rates, top corrections
```

---

## 4. Admin UI (`/admin/training`, no new top-level product surface)

A single admin page with three tabs:
1. **Samples** — table (name, type, floor, engineer, status, device count) + "New sample" + BEFORE/AFTER upload.
2. **Review** — BEFORE and AFTER side by side; detected device boxes overlaid on AFTER (Konva); admin can move/resize/relabel a box, delete a false positive, add a missed device, and Save. Class palette = the 15 supported codes.
3. **Models & Datasets** — export a YOLO dataset, view class counts, register/compare model versions and their metrics, and promote a model through the status workflow. Plus a **Feedback** panel with accept/reject rates per device.

---

## 5. Training workflow (end to end)

```
upload BEFORE+AFTER → align → extract (heuristic) → human review (confirm/fix/add)
   → save clean labels → export YOLO dataset (train/val split) to S3
   → train YOLO on GPU → store artifact + metrics → evaluate on held-out val
   → admin approves → mark 'production' → AI service loads approved weights
                         ↘ recompute placement priors from confirmed labels
editor feedback (accept/reject/move) ─────────────────────────────────────┘ (continuous)
```

The **hybrid decision engine** (`packages/shared/src/hybrid.ts`, additive) computes a final score per candidate placement:
`score = w_rule·ruleConfidence + w_prior·priorRate + w_detector·detectorAgreement + w_qc·qcPass − w_feedback·rejectionRate`.
With no model yet, `w_detector = 0` and the rule engine's output is unchanged except for prior/feedback nudges (which are opt-in). This guarantees we *extend* the rule engine.

---

## 6. What is buildable NOW (10 samples, no GPU) vs needs more data/GPU

**Now (this first version):**
- Samples CRUD + BEFORE/AFTER S3 upload + metadata + status.
- Raster normalization + a simple same-scale/orientation check + stored alignment transform.
- Heuristic device extraction (template/blob) to seed annotations for review.
- Human review UI: confirm / fix / add / mark false-positive; clean labels saved.
- YOLO dataset export (images + `labels/*.txt` + `data.yaml`) to S3 with per-class counts.
- **Learned placement priors** from the 10 AFTER samples — real statistics (e.g. "majlis → 2 speakers in 90% of samples") that nudge confidence today, no GPU.
- Sample-level evaluation: rule-engine output vs AFTER ground truth → per-class precision/recall.
- Feedback capture from the editor + accept/reject stats.

**Needs more data / GPU:**
- Actual YOLO/YOLO26 training (ultralytics + GPU) — 10 samples is far below what's needed for a robust detector (rule of thumb: hundreds–thousands of boxes/class). The export + `services/ai/training/train.py` + job queue are ready; training runs on a GPU box.
- High-recall **column/symbol** detection (heuristics are precision-first today).
- Reliable automatic BEFORE↔AFTER registration for plans at different scales/crops (current check is coarse).
- Model promotion auto-loading in a live GPU AI pool.

With 10 samples, the **priors + evaluation + feedback** loop already improves and *measures* placement quality; the trained detector is a later unlock as the dataset grows (every reviewed sample and every editor correction adds labels).

---

## 7. How we evaluate improvement

For each held-out validation sample: take the BEFORE plan, run the current pipeline (geometry → classification → rules → QC → hybrid), and compare the resulting devices to the engineer's AFTER annotations (ground truth) using greedy nearest-match within a tolerance, per device class and per space type. Report **precision, recall, F1 per class**, count deltas, and "missed/extra" lists. Track these across model/prior versions so every change is measured, not asserted. The existing `run_eval.py` is extended with this sample-level comparison.
