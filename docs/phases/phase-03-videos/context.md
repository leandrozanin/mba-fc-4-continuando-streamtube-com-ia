---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-20T12:50:00-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-05-12T12:23:19-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-05-12T12:21:12-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-05-12T13:36:17-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** edição de informações do vídeo, categorias, visibilidade público/unlisted, fluxo rascunho → publicação, painel do canal (Fase 04); player e página de visualização (Fase 05); transcodificação/HLS.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — interface de upload e player ficam para fases futuras (o desafio da Fase 03 é de backend).

**Sequencing notes:** Depends on Fase 01 — Configuração Base e Fase 02 — Autenticação (o vídeo pertence ao canal do usuário autenticado; reusa guard JWT global, filtro de exceções de domínio e ValidationPipe).

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.0.5, bullmq@^5.81.5 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Upload Strategy for 10GB | decided | C (S3 multipart, presigned parts) | @aws-sdk/client-s3@^3.1153.0, @aws-sdk/s3-request-presigner@^3.1153.0 |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Video Worker Runtime | decided | A (same codebase, separate entrypoint/container) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Metadata Extraction and Thumbnail | decided | B (spawn ffprobe/ffmpeg over presigned URL) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Cross-layer | Unique Video URL Strategy | decided | B (11-char base62 slug, unique index, retry) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Cross-layer | Streaming and Download Strategy | decided | A + B (stream 206 via API; download 302 presigned) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Status Lifecycle and Failure Handling | decided | A (draft → processing → ready/failed; attempts 3) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend/Infra | Object Storage Organization and Local Image | decided | A (bitnamilegacy/minio pinned, bucket streamtube-media) | @aws-sdk/client-s3 |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-08, phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07, phase-03-videos/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis) — official Nest integration; attempts, exponential backoff, idempotent `jobId` and failed-job retention out of the box; one lightweight container (Redis with AOF).

**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5`

### phase-03-videos/TD-02

**Recommendation:** Option C (S3 multipart with presigned part URLs) — API never touches the bytes, supports 10GB (single PUT caps at 5GB) and resume per part. Part size 100 MiB; URLs valid 1h and re-issuable; explicit abort endpoint.

**Libraries:** `@aws-sdk/client-s3@^3.1153.0`, `@aws-sdk/s3-request-presigner@^3.1153.0`

### phase-03-videos/TD-03

**Recommendation:** Option A — `src/worker.ts` with `NestFactory.createApplicationContext`, dedicated `video-worker` container with FFmpeg; reuses entities, config and storage module.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Option B — spawn `ffprobe`/`ffmpeg` reading through a short-lived presigned GET URL (range reads, no full download); thumbnail at `min(1s, 10% duration)`, JPEG 640px; per-call timeout. `fluent-ffmpeg` is deprecated on npm.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Option B — 11-char base62 slug from `crypto.randomBytes`, unique index, retry on collision; generated at draft creation.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Stream proxied by the API with `Range` → `206 Partial Content` (one canonical URL, rules stay in the API, testable); download via `302` to a presigned GET with `Content-Disposition: attachment`.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-07

**Recommendation:** Option A — `draft → processing → ready | failed`; conditional `UPDATE … WHERE status = :expected` per transition; job `attempts: 3`, exponential backoff 10s; `failed` only after the last attempt; enqueue failure reverts `processing → draft`.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Option A — `bitnamilegacy/minio:2025.7.23-debian-12-r5` (official `minio/minio` images are no longer published), bucket `streamtube-media` bootstrapped by `MINIO_DEFAULT_BUCKETS`, keys `videos/{id}/original` and `thumbnails/{id}.jpg`; internal S3 client on `http://minio:9000` and a signing client on the public endpoint.

**Libraries:** `@aws-sdk/client-s3@^3.1153.0`

## Inherited Decisions Detail

### phase-02-auth/TD-02

**Recommendation (as decided):** Custom guards with `@nestjs/jwt` — `JwtAuthGuard` registered globally as `APP_GUARD`; `@Public()` opts out.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer with global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — services throw `DomainException` subclasses; the filter renders `{ statusCode, error, message }`.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** `@nestjs/throttler` registered as `APP_GUARD` in `AuthModule` (10 req/min). Note: an `APP_GUARD` is global regardless of the module that declares it, so every new controller is throttled unless it opts out with `@SkipThrottle()`.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-01-configuracao-base/TD-01 … TD-04

**Recommendation:** `@nestjs/config` with namespaced `registerAs` factories, Joi validation, typed injection via `ConfigType`, shared factory in `data-source.ts`.

**Libraries:** `@nestjs/config@^4.x`, `joi`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`; env validated by the Joi schema in `src/config/env.validation.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; schema changes only via generated migrations. _(from phase 01)_
- All endpoints are protected by the global `JwtAuthGuard`; public routes use `@Public()`; protected routes document `@ApiBearerAuth('access-token')`. _(from phase 02)_
- Services throw `DomainException` subclasses (`src/common/exceptions/domain.exception.ts`), never Nest HTTP exceptions; the global `DomainExceptionFilter` renders `{ statusCode, error, message }`. _(from phase 02)_
- Every controller is documented with `@nestjs/swagger` (`ApiTags`, `ApiOperation`, `ApiResponse` per status, `ApiErrorEnvelope` for errors). _(from phase 02 / task-openapi-docs-nestjs)_
- Each user owns exactly one channel (`channels.user_id` unique); channel creation lives in `ChannelsModule`. _(from phase 02)_
- Tests: `*.spec.ts` unit, `*.integration-spec.ts` against real Compose services, `*.e2e-spec.ts` via supertest in `test/`; integration and e2e run `--runInBand`. _(from phase 01/02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Interface de upload e player | deferred | `next-frontend/` fora do escopo da Fase 03 (desafio de backend); a API expõe os contratos que a UI usará. | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill. Phase 03 adds infrastructure services (MinIO, Redis, worker) that must be exercised for real: storage operations are integration-tested against the Compose MinIO, queue producer/processor against the Compose Redis, FFmpeg processing against a small video generated by `ffmpeg -f lavfi` inside the worker image, and the upload → process → stream flow end-to-end with supertest. Specific layer coverage by SI is recorded in `progress.md`.
