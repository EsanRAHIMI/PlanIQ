# PlanIQ — Deployment

## Local (one command)
```bash
cp .env.example .env          # fill secrets (defaults work for local)
docker compose up --build     # web:3000 api:4000 ai:8000 mongo:27017 redis:6379 minio:9000 nginx:80
# seed catalog + sample project:
docker compose exec api pnpm seed
```
Open http://localhost (Nginx) → web. Swagger at http://localhost/api/docs. MinIO console at :9001.

## Services in `docker-compose.yml`
| Service | Image/build | Notes |
|---------|-------------|-------|
| web | apps/web Dockerfile | Next.js standalone |
| api | apps/api Dockerfile | HTTP server |
| worker | apps/api Dockerfile (`node worker.js`) | BullMQ consumers, Playwright for PDF |
| ai | services/ai Dockerfile | FastAPI + YOLO/OpenCV/OCR |
| mongo | mongo:7 (replica set) | transactions enabled |
| redis | redis:7 | queues + rate limit |
| minio | minio/minio | S3-compatible dev storage |
| nginx | nginx:alpine | reverse proxy, TLS, routing |

## Production
- **Frontend:** Vercel or container on ECS/Cloud Run; CDN for static + icons.
- **API + worker:** containers on ECS Fargate / EKS / Cloud Run; separate worker service scaled on queue depth.
- **AI:** GPU node group (EKS) or GPU VM autoscaling group; internal-only networking; model weights pulled from S3 at boot.
- **DB:** MongoDB Atlas (replica set, backups, PITR). Sharded by tenant at scale.
- **Storage:** S3 bucket + CloudFront; lifecycle rules (exports expire/transition to IA); SSE-S3/KMS encryption.
- **Cache/queue:** ElastiCache Redis.
- **Secrets:** AWS Secrets Manager / SSM; injected as env at runtime.
- **TLS:** ACM certs on ALB / Nginx; HSTS.
- **CI/CD:** GitHub Actions — lint → typecheck → test → build images → push ECR → deploy (blue/green). `infra/terraform` provisions cloud resources.
- **Observability:** Pino→Loki, OpenTelemetry→Tempo, Prometheus+Grafana, alerting on queue depth, job failures, 5xx rate, AI latency.
- **Backups/DR:** Atlas continuous backups; S3 versioning + cross-region replication for exports.

## Health & rollout
- `/health` (liveness), `/health/ready` (mongo/redis/s3/ai checks) drive container orchestration probes.
- Migrations via a versioned `db/migrations` runner executed pre-deploy.
- Zero-downtime: blue/green with readiness gating; workers drain in-flight jobs on SIGTERM.

## Required environment
See `.env.example`. Critical prod vars: `MONGO_URI`, `REDIS_URL`, `S3_*`, `JWT_*`, `AI_SERVICE_URL`, `WEB_ORIGIN`, `AI_FALLBACK_PROVIDER=disabled`.
