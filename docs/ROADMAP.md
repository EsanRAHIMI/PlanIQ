# PlanIQ — Implementation Roadmap

Phases are ordered to keep the system runnable end-to-end as early as possible. Each phase has acceptance criteria.

## Phase 0 — Foundations ✅ (this delivery)
Monorepo, shared types, device library, design docs, Docker stack, env config, CI skeleton.
**Done when:** `docker compose up` boots all services and `/health/ready` is green.

## Phase 1 — Auth, tenancy, RBAC
Register/login/refresh/logout, argon2 hashing, JWT + rotating refresh, roles & guards, audit logging, rate limiting.
**Done when:** a user can sign up, log in, and only access their tenant's data; admin endpoints gated.

## Phase 2 — Projects, floors, upload, S3
Project/floor CRUD, presigned upload, asset records, MIME/AV checks, PDF page→floor splitting.
**Done when:** a multi-page PDF uploads and produces ordered floors with rasters in S3.

## Phase 3 — AI/CV analysis
FastAPI pipeline (ingest→preprocess→geometry→OCR→YOLO→fusion→rules), BullMQ analysis jobs, SSE progress, persistence of rooms/zones/placements.
**Done when:** uploading the sample villa plan yields detected rooms and rule-based placements with rationale.

## Phase 4 — Canvas editor
Konva canvas: render raster + placements, zoom/pan/snap/grid, select/drag/rotate/scale, add from device library, delete/duplicate/group/lock/hide, layers panel, properties panel, search, keyboard shortcuts, undo/redo, debounced autosave, floor switcher, accept/edit AI suggestions.
**Done when:** a user can fully edit a floor and changes persist; AI suggestions are reviewable.

## Phase 5 — Versions & PDF export
Snapshot/restore versions; Playwright export of floors + legend + device schedule + cover/notes → S3 → download.
**Done when:** a client-ready multi-page PDF matching the AFTER sample style is produced.

## Phase 6 — Admin, settings, hardening
Admin panel (stats, audit feed, job mgmt, settings incl. AI fallback toggle), tenant settings/branding, full test suite, OpenAPI polish, security review, load test.
**Done when:** test coverage targets met, security checklist passed, staging load test green.

## Phase 7 — Model training
Label dataset from real plans, train YOLOv11 on plan symbols, evaluate, ship weights; tune rule parameters against the BEFORE/AFTER samples.
**Done when:** detection mAP and placement acceptance rate meet targets on a holdout set.

---

## Future-ready extension points (already modeled, not yet built)
- **BOQ / pricing:** `placement.meta` + device `defaultProps` carry cost/SKU; a BOQ module aggregates per project.
- **Cable routing:** normalized geometry + wall graph enable shortest-path conduit runs between placements and the rack.
- **3D / BIM:** room polygons + levels + IFC importer adapter; the AI provider interface accepts BIM sources.
- **Smart-home integration:** device props map to vendor configs (export to KNX/Loxone/Control4 schedules).
- **Vision-LLM fallback:** adapter already defined; enable per-tenant for hard plans.
