# PlanIQ — UX / UI & Product Architecture Audit (2026 readiness)

_Pre-implementation review. No code changed. Goal: turn a powerful but fragmented set of tools into one coherent, premium SaaS product organized around a clear 10-stage project lifecycle._

This audit is grounded in the actual repository state (routes, pages, components, navigation, schemas), not assumptions.

---

## 1. Product Architecture Review

**What exists (capability is strong).** Auth + multi-tenant RBAC; projects → floors → assets; an S3 upload pipeline; a self-hosted CV/geometry pipeline (walls, rooms, doors, columns, stairs, scale); bilingual room classification; a customer-rule-grounded placement engine mirrored in TS+Python; a QC guardrail with consistency guarantees; an interactive Konva editor (spaces review, device library, properties, layers, versions); PDF export; an admin control center; and a new Training & Feedback Center with learned priors and a YOLO dataset pipeline.

**The core problem is not capability — it's *product coherence*.** The app is organized around **objects** (projects, floors, placements, admin tables) and **engine internals** (runs, QC summaries, fallback chains), not around the **user's journey**. There is no first-class concept of "where this project is in its lifecycle," so the considerable intelligence underneath is invisible, hard to discover, and hard to trust.

Three structural issues:

1. **No lifecycle spine.** `Project.status` (draft/in_progress/review/delivered/archived) and `delivery.status` (draft/ready/exported/delivered) both exist in the schema and are advanced by the worker, but **no screen renders the lifecycle**. The user never sees the 10 stages they think in.
2. **Engine-centric, not user-centric surfaces.** The editor exposes "Run Full AI Analysis," "Re-run Rule Suggestions," QC summaries, fallback chains and provider names — accurate but framed as engine internals rather than "analyze my plan / review what was found / why this device."
3. **Orphaned surfaces.** Real, working features are not reachable or not wired (Training Center, export options, AI summary). The product literally contains finished tools that users cannot find.

---

## 2. UX Audit Report (findings)

### Dead features (in code, referenced by nothing)
- **`components/editor/AiSummaryPanel.tsx`** — imported by zero files. A plan-level AI summary component that never renders. (The editor uses `AiAnalysisDetailsPanel` instead.)
- **`components/delivery/ExportOptionsModal.tsx`** — imported by zero files. A rich export dialog (floors, legend, schedule, client name, prepared-by, notes) exists but the project page exports via a **plain "Export PDF" button with no options**. The good UX is built and disconnected.

### Hidden features (reachable by no navigation)
- **Training & Feedback Center** (`/admin/training`) — not linked from the header, the user menu, or the admin tabs. A whole subsystem is invisible.
- **Project delivery lifecycle** — `delivery.status` transitions happen server-side but are never shown.
- **Version history / restore** — only discoverable via a small button inside the editor.
- **AI traceability** (which engine ran, confidence, QC, fallback) — buried in one editor panel.

### Duplicated / overlapping features
- **Two AI panels**: `AiSummaryPanel` (dead) and `AiAnalysisDetailsPanel` (live) cover overlapping ground.
- **Two "place devices" actions with five names**: "Run Full AI Analysis", "Re-run Rule Suggestions", "Re-suggest devices from spaces", plus "Auto-detect" (training) and "Suggest devices" (landing). Users can't tell what differs (re-read the image vs re-run rules on existing spaces).
- **Status vocabularies**: `Project.status` and `delivery.status` are parallel, overlapping state machines with no unified surface.

### Broken / incomplete workflows
- **Export has no options in the main flow** (the modal is orphaned), so legend/schedule/client metadata can't be chosen where it matters.
- **No "engineer review / approval" step** — placements can be edited but there's no explicit review→approve gate, despite the lifecycle implying one.
- **Feedback loop is one-directional and invisible** — the editor now emits "rejected" feedback on delete, but the user gets no acknowledgement and admins can only see it inside the hidden training page.

### Missing workflows
- Project **lifecycle / stage tracker** (the spine of this whole request).
- **Review queue**: "what needs my attention" across projects (low-confidence spaces, failed analyses, unreviewed AI devices).
- **Onboarding / first-run** (empty states exist for floors, but there's no guided first project).
- **Optimization** stage (re-run with priors/feedback) has no home.
- **Archive** stage has no UI.

### Inconsistent terminology
- "Spaces" vs "Rooms" vs "Detected Spaces" for the same entity.
- "Analysis" vs "Suggestions" vs "Auto-detect" vs "Re-suggest."
- Engine labels ("CV Pipeline + OCR + QC", "Internal Rules + QC") are implementation names shown to end users.
- **Stale copy that contradicts shipped features**: the admin Overview says _"A labelled-sample registry for retraining is planned (not yet collected)"_ — but the Training Center that does exactly that now exists. The product contradicts itself.
- The **landing page over-claims** ("YOLO") although the detector is untrained — a trust risk with paying customers.

### Missing user feedback (action → result)
- **Export PDF**: shows "Exporting…" but the broader flow lacks success/preview affordance in context.
- **Admin/training buttons** (extract, recompute priors, promote model): minimal toast feedback, no progress, no result panel.
- **Delete AI device → feedback recorded**: silent.
- Many actions lack the full **loading → progress → success → warning → error → recovery** set the user explicitly wants.

### Confusing screens
- The **editor** carries four-plus simultaneous panels (Spaces, Device library, Properties, AI Actions bar, AI Analysis Details) with dense engine language — powerful but overwhelming and not staged.
- The **admin** mixes operational dashboards (jobs, errors), configuration (AI settings), governance (users, tenants, audit) and now-missing training in one tab strip.

### Missing progress & status indicators
- Upload has a `ProcessingTimeline` (good) — but it's the **only** real progress surface. Analysis progress streams over SSE yet isn't shown at project level; export has no progress; training jobs have none.
- No per-project or per-floor **status rollup** ("Ground Floor: analyzed · 12 spaces · 27 devices · needs review").

### Missing onboarding & lifecycle visibility
- No welcome, no sample project, no "what to do next" guidance.
- The user's central complaint — _"I don't know where I am / what happened / what's next"_ — is the direct result of having no lifecycle model in the UI.

---

## 3. Information Architecture (proposed)

Reorganize around **three top-level zones**, each with a clear job:

```
PlanIQ
├── Workspace (the daily product)
│   ├── Projects            (list + lifecycle status + "needs attention")
│   ├── Project Overview    (lifecycle tracker — the new home of a project)
│   ├── Editor              (the central workspace: plan + spaces + devices)
│   └── Delivery            (export, client package, deliver)
├── Intelligence (transparency, not internals)
│   ├── AI Activity         (per-project: what ran, confidence, what to review)
│   └── Training & Feedback (samples, annotation, datasets, models, priors)  ← surfaced
└── Settings & Governance (admin)
    ├── Operations          (jobs, errors, health)
    ├── AI Configuration    (settings, model promotion)
    ├── People              (users, roles, tenants)
    └── Audit
```

Principle: **users live in Workspace**; **Intelligence makes the AI explainable**; **Settings & Governance is for admins**. Training moves out of "admin tabs" into a first-class Intelligence area (admin-gated) so it's discoverable.

---

## 4. Screen Inventory (current → target)

| Current route | Role today | Issues | Target |
|---|---|---|---|
| `/` | Marketing landing | Over-claims "YOLO" | Keep; honest copy; clear CTA |
| `/login`, `/register` | Auth | OK | Keep; light polish |
| `/dashboard` | Project list (name + status chip) | No lifecycle, no "needs attention", inline create | **Projects hub**: lifecycle column, attention badges, richer create |
| `/projects/[id]` | Upload + floor list + export button | No stage spine, orphaned export options | **Project Overview**: 10-stage lifecycle tracker + per-floor status + stage actions |
| `/editor/[floorId]` | Canvas + spaces + devices + AI panels | Dense, engine-language, two AI panels (one dead) | **Central workspace**: staged left rail (Spaces → Devices → Review), unified AI panel, explainable results |
| `/admin` | 7-tab control center | Mixed concerns; training missing; stale copy | Split into Operations / AI Config / People / Audit |
| `/admin/training` | Training center | **Orphaned (no nav)** | Promote to **Intelligence › Training**, linked |
| — | (missing) | — | **AI Activity** per-project view |
| — | (missing) | — | **Delivery** view (uses the orphaned ExportOptionsModal) |
| — | (missing) | — | **Review queue** ("needs attention") |

Components to **retire/merge**: `AiSummaryPanel` (fold into the unified AI panel), `AiAnalysisDetailsPanel` (simplify into user-facing + a "details" disclosure). Component to **reconnect**: `ExportOptionsModal` (wire into Delivery).

---

## 5. Workflow Redesign — the 10-stage lifecycle spine

Every project moves through ten stages; each renders **status, progress, outputs, actions, audit, and success/failure**. This becomes the `/projects/[id]` Project Overview and a compact stepper in the editor.

| # | Stage | Status it shows | Visible output | Primary action | Success / failure |
|---|---|---|---|---|---|
| 1 | **Project Creation** | created | name, client, type | Edit details | created ✓ |
| 2 | **Plan Upload** | uploading → processed | floors detected (thumbnails) | Upload / re-upload | per-file ✓ / failed-stage ✗ |
| 3 | **AI Analysis** | queued → running → done/failed | spaces + zones + scale per floor; engine used + confidence | Run / re-run analysis | done ✓ / failed ✗ + retry |
| 4 | **Space Review** | needs review → reviewed | accepted/rejected/corrected spaces | Open editor → Spaces | reviewed ✓ |
| 5 | **Device Placement** | suggested → edited | device count by category + rationale | Open editor → Devices | placed ✓ |
| 6 | **Engineer Review** | pending → approved | approval state per floor | Approve / request changes | approved ✓ |
| 7 | **Optimization** | optional | re-run with priors/feedback; before/after delta | Optimize | improved ✓ |
| 8 | **Client Delivery** | ready → exported → delivered | PDF package + version | Export / deliver | delivered ✓ |
| 9 | **Training & Feedback** | contributes | sample added; feedback captured | Add as training sample | contributed ✓ |
| 10 | **Project Archive** | active → archived | read-only snapshot | Archive / restore | archived ✓ |

Map to existing data so this is **wiring, not new engines**: stages 1–2 ← `Project` + `PlanAsset`; 3 ← `Floor.analysis` + `AnalysisRun`; 4 ← `DetectedRoom.reviewStatus`; 5 ← `Placement`; 6 ← new `Floor.review` field; 7 ← re-suggest + priors; 8 ← `Export` + `delivery.status`; 9 ← `TrainingSample`/`PlacementFeedback`; 10 ← `Project.status='archived'` (soft-delete already exists).

**Always-visible answers** (a persistent status bar / project header): _where am I_ (current stage), _what happened_ (last run + audit), _what's happening_ (live progress), _what needs attention_ (counts of unreviewed/low-confidence/failed), _what the AI used_ (engine + model + fallback), _confidence_ (per floor/space), _what I can approve/correct_ (clear CTAs).

---

## 6. Navigation Redesign

- **Primary nav (everyone):** Projects · (Admin →) — replace with: **Projects · Intelligence · Settings** (Intelligence/Settings gated by role).
- **Project-level nav (tabs within a project):** Overview · Editor · AI Activity · Delivery — so a project is a place with sub-views, not a single page.
- **Editor staged rail:** a left rail that mirrors the lifecycle middle (Spaces → Devices → Review) instead of several competing panels; a single unified **AI panel** on the right with a plain-language summary and a "details" disclosure for engine internals.
- **Global "Needs attention"** entry in the header (count badge) → the review queue.
- **Breadcrumbs** already exist (`AppHeader`) — extend with stage context (e.g. _Projects › Villa A › Analysis_).
- **Surface Training** under Intelligence and remove the contradictory "planned (not collected)" admin copy.

---

## 7. Component System Proposal

A small, consistent primitive set (most already exist informally; formalize them):

- **StatusPill** — one component, one vocabulary, for every status (`none/queued/running/done/failed/needs-review/approved/delivered/archived`) with consistent color + icon. Replaces the ad-hoc badges in dashboard, projects, editor.
- **StageStepper** — the 10-stage tracker (horizontal on overview, compact in editor).
- **ActionButton** with built-in **state machine**: idle → loading → progress → success → warning → error, each with a recovery affordance. Every "major action" the user listed routes through this, killing silent buttons.
- **ProgressStream** — generalize `ProcessingTimeline` to any SSE/polled job (analysis, export, training).
- **AIResultCard** — plain-language "what the AI did, what it used, confidence, what to review," with a details disclosure (fold in `AiSummaryPanel`/`AiAnalysisDetailsPanel`).
- **ConfidenceMeter**, **AttentionBadge**, **EmptyState** (onboarding-aware), **Toast** (already present) standardized to the six states.
- **Terminology lexicon** (single source of truth): "Spaces" (not rooms), "Analyze plan" (read image), "Suggest devices" (rules on spaces), "Engine" with friendly names. Ship as a constants file so labels can't drift.

Visual language: minimal, premium, enterprise — neutral slate base, one brand accent, generous whitespace, status color used **only** for status, no engine jargon in primary surfaces.

---

## 8. Priority Matrix (impact × effort)

| Priority | Item | Impact | Effort | Why |
|---|---|---|---|---|
| **P0 quick wins** | Remove stale/contradictory copy; honest landing (drop "YOLO" claim); surface Training in nav; wire the orphaned **ExportOptionsModal**; delete/merge dead `AiSummaryPanel` | High | Low | Stops the product contradicting itself; recovers built features in hours |
| **P0** | **StatusPill + unified status vocabulary** | High | Low | Foundation for every other screen |
| **P1** | **Project Overview = 10-stage lifecycle tracker** (read existing data) | Very High | Medium | Directly fixes "I don't know where I am / what's next" |
| **P1** | **ActionButton state machine** on all major actions | High | Medium | Fixes silent buttons; the explicit loading/success/error/recovery requirement |
| **P1** | **Unified AI panel** (engine + confidence + what to review) | High | Medium | Makes AI visible & explainable; removes duplication |
| **P2** | **Project sub-nav** (Overview/Editor/AI Activity/Delivery) + editor staged rail | High | Medium | Turns tools into a workflow |
| **P2** | **Needs-attention review queue** | High | Medium | Cross-project triage |
| **P2** | **Engineer Review/Approve** gate (stage 6) | Medium | Medium | Trust + lifecycle completeness |
| **P3** | **Onboarding / first-run + sample project** | Medium | Medium | Activation for new customers |
| **P3** | **Optimization** stage UI (priors/feedback before-after) | Medium | Medium | Showcases the learning loop |
| **P3** | **Archive** UI + IA split of Admin into Operations/AI/People/Audit | Medium | Low–Med | Polish + governance clarity |

---

## 9. Phased implementation plan (after approval)

- **Phase A — Truth & consistency (1 sprint).** Status lexicon + `StatusPill`; remove contradictory/over-claiming copy; surface Training in nav; reconnect `ExportOptionsModal`; retire `AiSummaryPanel`. _Outcome: the product stops lying and recovers hidden features._
- **Phase B — The lifecycle spine (1–2 sprints).** Project Overview with the 10-stage `StageStepper` reading existing data; persistent project status header (where am I / what's next / needs attention); per-floor status rollup. _Outcome: users always know where they are._
- **Phase C — Action integrity (1 sprint).** `ActionButton` state machine across analyze/suggest/export/train; `ProgressStream` for analysis + export + training; feedback acknowledgement. _Outcome: every action has loading→success→error→recovery._
- **Phase D — Explainable AI & unified editor (1–2 sprints).** Single `AIResultCard`; editor staged rail (Spaces → Devices → Review); project sub-nav; AI Activity view. _Outcome: the editor is the central, legible workspace._
- **Phase E — Workflow completeness (1–2 sprints).** Engineer Review/Approve gate; Needs-attention queue; Delivery view; Optimization + Archive stages; Admin IA split; onboarding/first-run. _Outcome: a complete, demoable 2026 SaaS lifecycle._

No engines are rebuilt in any phase — this is **information architecture, state surfacing, and consistency** over the capabilities that already exist. Recommend approving **Phase A + B** first (highest impact, lowest risk) and reviewing before C–E.

---

### One-line diagnosis
PlanIQ has a senior engineering brain and no nervous system: the intelligence is real, but there's no lifecycle spine or consistent status language carrying it to the user. Build the spine (Phases A–B) and most of the "feels unfinished" perception disappears before a single engine is touched.
