# PlanIQ

**Automatic smart-home / ELV / CCTV / Wi-Fi device placement on villa floor plans.**

Upload villa plans (PDF / PNG / JPG, DWG optional). PlanIQ analyzes each floor with a **self-hosted computer-vision pipeline** (YOLOv11 + OpenCV + OCR), suggests engineering-correct device placements via a **deterministic rule engine**, lets you edit everything on a **Figma-lite canvas**, versions your work, and exports a **client-ready PDF**.

> Every AI/CV suggestion is editable. Nothing the engine produces is final — it is always reviewable and correctable by the user.

---

## Repository layout

```
apps/web        Next.js 14 frontend + Konva canvas editor
apps/api        NestJS API (HTTP) + BullMQ worker (same codebase)
services/ai     FastAPI CV pipeline (YOLOv11 + OpenCV + OCR + rule engine)
packages/shared TS types, device library, Zod schemas, client rule-engine mirror
infra           Nginx, Mongo replica-set init, Terraform stub
docs            ARCHITECTURE · DATABASE · API · AI-PIPELINE · DEPLOYMENT · ROADMAP · FOLDER-STRUCTURE
```

Read the design docs first: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/DATABASE.md`](docs/DATABASE.md), [`docs/API.md`](docs/API.md), [`docs/AI-PIPELINE.md`](docs/AI-PIPELINE.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Quick start (Docker — full stack)

```bash
cp .env.example .env          # local defaults work out of the box
docker compose up --build     # web, api, worker, ai, mongo, redis, minio, nginx
docker compose exec api pnpm seed   # device catalog + demo user + sample project
```

- App (via Nginx): **http://localhost**
- API + Swagger docs: **http://localhost/api/v1/docs**
- MinIO console: **http://localhost:9001** (`planiq` / `planiq-secret`)
- Demo login: **demo@planiq.app** / **Password123!**

## Local dev (hybrid: pnpm + infra Docker)

Daily development should run `web` / `api` / `worker` locally (hot reload), with only infra in Docker.

1. Install dependencies:
```bash
pnpm install
```

2. Prepare local env:
```bash
cp .env.local.dev.example .env.local.dev
```
Set at minimum:
- `MONGO_URI` (Atlas)
- `REDIS_URL=redis://localhost:6379`
- `S3_ENDPOINT=http://localhost:9100`
- `S3_PUBLIC_URL=http://localhost:9100`
- `S3_ACCESS_KEY=planiq`
- `S3_SECRET_KEY=planiq-secret`
- `AI_SERVICE_URL=http://localhost:8000`
- `WEB_ORIGIN=http://localhost:3000`
- `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1`

3. Start infra only (Redis + MinIO):
```bash
pnpm dev:infra
```

4. Start AI (choose one):
```bash
pnpm dev:ai:docker
# OR local Python
cd services/ai && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000
```

5. Start API:
```bash
pnpm dev:api
```

6. Start worker:
```bash
pnpm dev:worker
```

7. Start web:
```bash
pnpm dev:web
```

Health check shortcut:
```bash
pnpm dev:check
```

---

## How it works (end to end)

1. **Create a project**, then **upload** a plan. The browser uploads directly to S3 via a presigned URL.
2. On *complete*, the API enqueues a job. The **worker** asks the AI service to rasterize pages (PDF → one floor per page), stores page rasters in S3, and creates floors.
3. For each floor the worker calls the AI service `/analyze`: OpenCV preprocessing → wall/room segmentation → OCR room labels → YOLO symbol detection → semantic fusion → **rule engine**.
4. Detected rooms/zones and **AI-suggested placements** (flagged `source:ai`, `reviewed:false`) are saved. Progress streams to the UI via SSE.
5. Open the **editor**: drag, rotate, add from the device library, delete, duplicate, group, lock/hide, change device type, toggle layers, undo/redo, snap to grid. Changes autosave (debounced batch upsert).
6. **Save versions** (immutable snapshots) and **export a PDF**: cover + one page per floor (plan + device overlay + legend) + device schedule, rendered with Playwright and stored in S3.

### Device placement logic (rule engine)
CCTV on external building corners + gate + parking; gate motor & intercom bell at the gate; smart lock + intercom screen + sensor at entrances; Wi-Fi APs by living-area size; ELV rack/switch/NVR in service/store; thermostats in bedrooms/living; speakers + volume control in entertainment zones; curtain motors on window walls; sensors in corridors/stairs; light switches by doors; data sockets per room; projector/screen in majlis/living. Each placement records a human-readable **rationale**. See [`docs/AI-PIPELINE.md`](docs/AI-PIPELINE.md).

---

## Configuration

All config is environment-variable driven and validated at boot — see [`.env.example`](.env.example). Key vars: `MONGO_URI`, `REDIS_URL`, `S3_*`, `JWT_*`, `AI_SERVICE_URL`.

**Vision-LLM fallback is disabled by default** (`AI_FALLBACK_PROVIDER=disabled`). The self-hosted CV pipeline is the only engine used in the normal flow. OpenAI / Gemini / Claude vision adapters exist solely as an optional, admin-enabled fallback for edge cases and debugging; their output still passes through the same rule engine and validation.

---

## Training the symbol detector

The system runs end-to-end **before** YOLO is trained (the detector gracefully no-ops and the pipeline relies on geometry + OCR). To improve symbol detection:

```bash
# Label plans in YOLO format under services/ai/training/dataset (see training/data.yaml)
cd services/ai/training && python train.py --epochs 100 --imgsz 1280
# produces services/ai/models/plan-symbols.pt — auto-loaded on next AI restart
```

---

## Testing

```bash
pnpm --filter @planiq/shared test     # rule-engine unit tests (vitest)
pnpm --filter @planiq/api test        # NestJS unit + e2e (jest + supertest)
cd services/ai && pytest              # pipeline + rule-engine tests (pytest)
```

The rule engine is mirrored in TypeScript (`packages/shared/src/rules.ts`) and Python (`services/ai/app/rules/engine.py`) with matching tests, so client-side "re-suggest" and server-side analysis stay consistent.

---

## Security & production

Argon2id passwords, JWT access + rotating refresh (httpOnly cookie), global + per-project RBAC guards, Helmet, CORS, Redis-backed rate limiting, Zod/class-validator DTOs on every endpoint, AI-output schema validation before persistence, presigned scoped S3 URLs, MIME/size checks, structured Pino logging, uniform error envelope, audit logs, soft deletes, health/readiness probes. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for cloud deployment (Atlas, S3+CloudFront, ECS/EKS GPU pool, CI/CD, observability).

## License
Proprietary — © PlanIQ.
