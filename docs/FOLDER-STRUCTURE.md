# PlanIQ — Folder Structure

```
mapai/
├── docs/                       # Architecture, schema, API, AI, deployment, roadmap
├── apps/
│   ├── web/                    # Next.js 14 (App Router) frontend
│   │   ├── src/
│   │   │   ├── app/            # routes: (auth), (dashboard), projects/[id], editor/[floorId], admin
│   │   │   ├── components/     # ui/, editor/ (Konva canvas, toolbar, panels), library/
│   │   │   ├── features/       # auth, projects, floors, editor (Zustand stores, hooks)
│   │   │   ├── lib/            # api client, sse, query client, utils
│   │   │   └── styles/
│   │   ├── public/icons/       # device SVG icons (legend symbols)
│   │   ├── next.config.mjs · tailwind.config.ts · Dockerfile
│   │
│   └── api/                    # NestJS backend (API + worker modes)
│       ├── src/
│       │   ├── main.ts · worker.ts        # http server / queue worker entrypoints
│       │   ├── config/        # env validation, config service
│       │   ├── common/        # guards, interceptors, pipes, filters, decorators, logger
│       │   ├── modules/
│       │   │   ├── auth/  users/  tenants/
│       │   │   ├── projects/  floors/  assets/   # upload + S3
│       │   │   ├── analysis/  placements/  layers/
│       │   │   ├── devices/   versions/  exports/
│       │   │   ├── admin/     audit/    settings/
│       │   │   ├── ai/        # client to services/ai
│       │   │   ├── storage/   # S3 service (presign, put, get, scan)
│       │   │   ├── queue/     # BullMQ producers + processors
│       │   │   └── health/
│       │   └── db/            # mongoose schemas, seeders
│       ├── test/              # e2e (jest + supertest)
│       └── Dockerfile
│
├── services/
│   └── ai/                    # FastAPI CV pipeline
│       ├── app/
│       │   ├── main.py        # FastAPI app, /analyze /suggest /health
│       │   ├── pipeline/      # ingest, preprocess, geometry, ocr, detect, fusion
│       │   ├── rules/         # deterministic placement engine
│       │   ├── providers/     # cv (default) + llm fallback adapters
│       │   ├── schemas.py     # Pydantic models (mirror shared)
│       │   └── config.py
│       ├── models/            # YOLOv11 weights (.pt) — gitignored, downloaded
│       ├── training/          # dataset format, data.yaml, train.py
│       ├── tests/             # pytest + fixture plans
│       ├── requirements.txt · Dockerfile
│
├── packages/
│   └── shared/                # TS package shared by web + api
│       └── src/
│           ├── device-library.ts   # seed catalog (codes, categories, colors, icons)
│           ├── space-types.ts      # room type enum + synonyms
│           ├── rules.ts            # client mirror of rule engine (re-suggest)
│           ├── schemas.ts          # Zod: AnalysisResult, DTOs
│           └── types.ts            # shared TS types
│
├── infra/
│   ├── nginx/                 # reverse proxy + TLS config
│   ├── mongo/                 # replica-set init
│   └── terraform/             # prod IaC (S3, Atlas, ECS/EKS) — stub
│
├── docker-compose.yml         # full local stack: web, api, worker, ai, mongo, redis, minio, nginx
├── docker-compose.prod.yml
├── .env.example
├── pnpm-workspace.yaml · turbo.json · package.json
└── README.md
```

Conventions: feature-first modules, DTO+schema validation at every boundary, no business logic in controllers, shared types are the single source of truth across the TS apps and mirrored in Python via the Zod↔Pydantic contract.
