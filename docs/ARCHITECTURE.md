# PlanIQ — System Architecture

> **PlanIQ** is a production SaaS platform that ingests villa floor plans, analyzes them with a self-hosted computer-vision pipeline (YOLOv11 + OpenCV + OCR), suggests engineering-correct placements for CCTV / Wi-Fi / ELV / smart-home devices via a deterministic rule engine, lets users edit everything on a Figma-lite canvas, and exports a professional client-ready PDF.

---

## 1. High-level overview

```
                                   ┌──────────────────────────────────────────┐
                                   │                Browser (SPA)               │
                                   │   Next.js 14 App Router + React + Konva     │
                                   │   Auth · Projects · Upload · Canvas Editor  │
                                   └───────────────┬────────────────────────────┘
                                                   │ HTTPS / JSON (REST) + SWR
                                                   ▼
┌──────────────┐   sign/verify   ┌───────────────────────────────────────────────┐
│   AWS S3 /    │◀───────────────▶│              API Gateway (NestJS)              │
│  S3-compatible│   presigned     │  REST · JWT auth · RBAC · validation · rate     │
│   (MinIO dev) │     URLs        │  limit · audit · OpenAPI · BullMQ producer      │
└──────────────┘                 └───┬───────────────┬───────────────┬───────────┘
                                     │               │               │
                              Mongoose│         enqueue│         read/ │
                                     ▼               ▼          write  ▼
                            ┌────────────┐   ┌──────────────┐   ┌────────────┐
                            │  MongoDB    │   │ Redis (BullMQ│   │  Worker(s) │
                            │  (replica   │   │  queues +    │   │  NestJS     │
                            │   set)      │   │  rate limit) │   │  consumers  │
                            └────────────┘   └──────────────┘   └─────┬──────┘
                                                                       │ HTTP (internal)
                                                                       ▼
                                                          ┌──────────────────────────┐
                                                          │   AI/CV Service (FastAPI)  │
                                                          │  PDF→image · OpenCV · YOLO  │
                                                          │  v11 · OCR · Rule Engine    │
                                                          │  (+ optional LLM fallback)  │
                                                          └──────────────────────────┘
```

The system is split into **four deployable units** plus shared infrastructure:

| Unit | Tech | Responsibility |
|------|------|----------------|
| `apps/web` | Next.js 14, React 18, TypeScript, Tailwind, Konva, Zustand | UI, auth flows, project mgmt, the canvas editor, triggering exports |
| `apps/api` | NestJS 10, TypeScript, Mongoose, BullMQ, Passport-JWT | REST API, authn/z, business logic, S3 orchestration, job production, **worker** consumers (same codebase, `--worker` mode) |
| `services/ai` | Python 3.11, FastAPI, Ultralytics YOLOv11, OpenCV, PaddleOCR/Tesseract, NumPy/Shapely | Stateless analysis: plan rasterization, room segmentation, symbol detection, OCR labels, rule-based device placement |
| `infra` | Docker, docker-compose, Nginx, Terraform (prod) | Local + prod orchestration, reverse proxy, TLS |

**Why this split?** The CV pipeline is CPU/GPU-heavy and Python-native; keeping it as a stateless internal HTTP service lets it scale horizontally and be replaced/upgraded independently of the Node API. The API stays the single source of truth for data, auth, and S3.

---

## 2. Technology decisions

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Monorepo | **pnpm workspaces + Turborepo** | Shared TS types between web & api, single install, cached builds |
| Frontend | **Next.js 14 (App Router)** | SSR for marketing/auth pages, RSC, file-based routing, mature |
| Canvas | **Konva + react-konva** | High-performance 2D canvas (zoom/pan/snap/layers/transform) without WebGL complexity |
| Client state | **Zustand + Immer** (editor) / **TanStack Query** (server cache) | Editor needs fast local mutable state + undo/redo; server data needs caching/invalidation |
| Backend | **NestJS** | Modular DI, guards/interceptors/pipes map cleanly to authz/validation/logging, first-class OpenAPI |
| DB | **MongoDB (Mongoose)** | Specified. Flexible nested geometry/placement documents, replica set for transactions |
| Cache/queue | **Redis + BullMQ** | Background jobs (plan processing, exports), distributed rate limiting, pub/sub for progress |
| Object storage | **AWS S3** (MinIO in dev) | Specified. Presigned uploads/downloads, lifecycle policies |
| AI/CV | **YOLOv11 + OpenCV + PaddleOCR** | Self-hosted, no per-request LLM cost, deterministic, trainable on plan symbols |
| Rule engine | **Custom deterministic TS-mirrored Python module** | Engineering placement logic, fully auditable & editable downstream |
| PDF export | **Playwright (HTML→PDF)** in worker | Pixel-perfect, reuses the same rendering components as the editor |
| Auth | **JWT access + rotating refresh (httpOnly cookie)** | Stateless API, revocable refresh sessions in Mongo |
| Observability | **Pino logs + OpenTelemetry traces + Prometheus metrics** | Structured logging, request tracing across api↔ai |

---

## 3. Module map (logical)

```
Authentication ── Users/Roles ── Audit Log
        │              │
        ▼              ▼
     Projects ──── Members/RBAC
        │
        ├── Floors (pages of a plan)
        │      │
        │      ├── PlanAssets (uploaded files in S3)
        │      ├── AnalysisJobs (BullMQ → AI service)
        │      ├── DetectedRooms / DetectedZones (CV output)
        │      └── Placements (devices on canvas) ──┐
        │                                            │
        ├── DeviceLibrary (catalog of device types) ┘
        ├── Versions (immutable snapshots of a floor's placements)
        └── Exports (generated PDFs in S3)

Cross-cutting: RuleEngine · Settings · RateLimit · Logging · Errors · API Docs · Admin Panel
```

See `DATABASE.md` for collection schemas, `API.md` for endpoints, `AI-PIPELINE.md` for the CV flow.

---

## 4. Core request flows

### 4.1 Upload & analyze
1. Web requests `POST /projects/:id/floors/upload-url` → API returns a **presigned S3 PUT** + asset record (`status: pending`).
2. Browser uploads the file **directly to S3** (no large payloads through the API).
3. Web calls `POST /floors/:id/assets/:assetId/complete` → API verifies the object exists, enqueues an `analysis` job in BullMQ.
4. Worker pulls the job, downloads the asset from S3, calls `POST {AI}/analyze` (multipart or S3 URL).
5. AI service: rasterizes PDF pages → detects floors → OpenCV preprocessing → YOLO symbol detection → OCR labels → room segmentation → **rule engine** → returns structured JSON (`rooms[]`, `zones[]`, `placements[]`, `confidence`).
6. Worker persists `DetectedRooms`, `DetectedZones`, and seed `Placements` (flagged `source: "ai"`, `reviewed: false`); emits progress over Redis pub/sub → web shows live status via SSE.

### 4.2 Edit
- Editor loads `GET /floors/:id/placements` + the floor raster (presigned GET).
- All edits are **local-first** in Zustand with an undo/redo command stack.
- Debounced autosave → `PATCH /floors/:id/placements` (batch upsert/delete). Optimistic UI; server validates against the device library and floor bounds.

### 4.3 Version & export
- `POST /floors/:id/versions` snapshots current placements (immutable).
- `POST /projects/:id/export` enqueues an `export` job → worker renders each floor (raster + placement overlay + legend + device schedule + project/client cover) via Playwright → uploads PDF to S3 → returns presigned download.

---

## 5. Security architecture

- **AuthN:** Passport-JWT. Short-lived access token (15 min) in memory; refresh token (7 d, rotating) in `httpOnly`, `Secure`, `SameSite=Strict` cookie. Refresh sessions stored hashed in Mongo and revocable.
- **AuthZ:** Role-based (`superadmin`, `admin`, `manager`, `editor`, `viewer`) global roles + per-project membership roles. Enforced by NestJS guards (`@Roles`, `@ProjectRole`).
- **File safety:** Server-side MIME/magic-byte sniffing, size limits, extension allow-list (`pdf,png,jpg,jpeg,dwg`), per-tenant S3 key prefixes, presigned URLs scoped & expiring, AV scan hook (ClamAV) before analysis.
- **Validation:** `class-validator` DTOs on every endpoint; AI output schema-validated (Zod/Pydantic) before persistence.
- **Rate limiting:** Redis-backed sliding window per IP + per user; stricter buckets for auth and upload endpoints.
- **Secrets:** All via env vars (`.env`), never committed. Prod uses AWS Secrets Manager / SSM.
- **Transport:** TLS terminated at Nginx; HSTS, secure headers via Helmet.
- **Audit:** Every state-changing action writes an `AuditLog` entry (actor, action, target, before/after diff, IP, UA).

---

## 6. Scalability & extensibility

- **Stateless API & AI** → horizontal scale behind a load balancer; sticky sessions not required (SSE uses Redis pub/sub fan-out).
- **Worker autoscaling** on BullMQ queue depth; GPU node pool for the AI service.
- **MongoDB** sharded by `tenantId`/`projectId` when needed; replica set enables multi-doc transactions for version snapshots.
- **Extensibility hooks already modeled** (see `ROADMAP.md`): the placement document carries `meta` for future **BOQ/pricing**, geometry stored as normalized vectors for future **cable routing** and **3D/BIM**, and the AI provider is a pluggable adapter interface so **LLM vision fallback** or **BIM/IFC importers** slot in without touching the core.

---

## 7. Environments

| Env | DB | Storage | AI | Notes |
|-----|----|---------|----|-------|
| **dev** | local Mongo (docker) | MinIO | FastAPI w/ CPU YOLO + mock weights | `docker-compose up` |
| **staging** | Mongo Atlas (M10) | S3 bucket | AI on GPU spot | mirrors prod, seeded sample data |
| **prod** | Mongo Atlas (sharded/replica) | S3 + CloudFront | AI on GPU autoscaling group | Terraform-managed, blue/green |

Configuration is environment-variable driven and validated at boot (`config` module fails fast on missing/invalid vars). See `.env.example` and `DEPLOYMENT.md`.
