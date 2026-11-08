---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-20
scope_description: "Upload e processamento de vídeos: fila de processamento, estratégia de upload de até 10GB, worker de vídeo (FFmpeg), uso do object storage S3/MinIO, URL única, streaming, download e ciclo de status do vídeo."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — módulo de vídeos (API), módulo de storage S3, fila de processamento, worker de vídeo (FFmpeg) e infraestrutura nova no `compose.yaml`.
- `next-frontend/` — Frontend deferred: a interface de upload/player não faz parte da Fase 03 (escopo do desafio é backend). No open decision in this document.

**Fixed by the project (not an open decision):** the object storage is S3-compatible (`docs/diagrams/software-arch.mermaid`: "Object Storage (S3/MinIO)"). Locally we run MinIO; in production it would be AWS S3. TD-08 decides *how* to use it, not *which* storage.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the queue as "Message Queue (TBD)". The API must publish a processing job when an upload completes and a separate Video Worker must consume it, with retries and failure visibility. The team is small, the stack is NestJS 11 + PostgreSQL 17, and everything runs in Docker Compose.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq`)
- Redis-backed job queue with first-class NestJS integration (`BullModule.forRootAsync`, `registerQueue`, `@Processor` + `WorkerHost`).
- **Pros:** Official Nest recipe and package; jobs have attempts, exponential backoff, `jobId` de-duplication, delayed jobs and a persisted failed set out of the box; worker concurrency is one option; Redis is a single small container; easy to exercise in integration tests against the Compose Redis.
- **Cons:** Adds Redis as a new stateful service; Redis persistence must be configured (AOF) to avoid losing queued jobs on restart; not a general-purpose event bus.

### Option B: RabbitMQ (`@nestjs/microservices` RMQ transport or `amqplib`)
- AMQP broker with exchanges, routing keys and dead-letter exchanges.
- **Pros:** Mature broker, flexible routing, DLX semantics, language-agnostic consumers.
- **Cons:** Heavier container and operational surface; retries with backoff need manual DLX/TTL plumbing; the Nest microservices transport is message-pattern oriented, not job oriented (no built-in job state, attempts, or failed-job inspection).

### Option C: pg-boss (queue inside PostgreSQL)
- Job queue implemented with PostgreSQL tables and `SKIP LOCKED`.
- **Pros:** No new infrastructure (PostgreSQL already in the stack); transactional enqueue in the same DB transaction as the video status update.
- **Cons:** No official Nest module; polling-based; puts queue load on the primary database that also serves the API; smaller ecosystem.

### Option D: SQS (ElasticMQ/LocalStack locally)
- Managed queue in AWS, emulated locally.
- **Pros:** Natural pair with S3 in production; fully managed.
- **Cons:** Vendor lock-in; local emulator differs from the real service; retries/backoff via visibility timeout and redrive policy only; extra emulator container just for dev.

**Recommendation:** **Option A (BullMQ + Redis)** — It is the queue NestJS documents and supports through `@nestjs/bullmq`, and it gives exactly what video processing needs (attempts with exponential backoff, idempotent `jobId`, failed-job retention) with one lightweight container. RabbitMQ's routing power is unnecessary for a single job type; pg-boss would load the primary DB; SQS emulation adds lock-in and dev/prod drift. Redis runs with AOF enabled so queued jobs survive a restart.

**Decision:** A (BullMQ + Redis)

**Libraries:** `@nestjs/bullmq@^11.0.5` (Nest 11 line — `12.x` targets Nest 12), `bullmq@^5.81.5`; image `redis:8.6`.

---

## TD-02: Upload Strategy for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `docs/project-plan.md` requires 10GB uploads "sem impactar a performance do sistema" and, in "Pontos de Atenção", that the upload "permita retomar em caso de falha de conexão". Streaming 10GB through the NestJS process would hold a connection and memory/IO on the API for the whole transfer.

**Options:**

### Option A: Proxy upload through the API (multipart/form-data or raw stream to S3)
- Client sends the file to NestJS; NestJS pipes it to S3.
- **Pros:** Simple client; API sees every byte (can validate on the fly).
- **Cons:** The API holds the transfer for its full duration — exactly what the requirement forbids; no resume; ties API scaling to upload bandwidth.

### Option B: Single presigned PUT URL
- API issues one presigned `PutObject` URL; client uploads directly to storage.
- **Pros:** API is out of the data path; trivial client.
- **Cons:** S3 caps a single PUT at **5GB**, so it cannot satisfy 10GB; no resume — a dropped connection restarts from zero.

### Option C: S3 multipart upload with presigned part URLs (direct to storage)
- API calls `CreateMultipartUpload`, returns presigned `UploadPart` URLs; client uploads parts directly to storage and reports the ETags; API calls `CompleteMultipartUpload`.
- **Pros:** API never touches the bytes; supports objects up to 5TB; parts are retried individually, so a dropped connection resumes from the last missing part; parallel parts speed up large files; same protocol on MinIO and AWS S3.
- **Cons:** More client logic (split, upload parts, collect ETags); needs an endpoint to re-sign part URLs when they expire; abandoned multipart uploads must be aborted (lifecycle rule or explicit abort).

### Option D: tus resumable protocol through the API
- tus server inside NestJS receives chunks and writes to S3.
- **Pros:** Standard resumable protocol with client libraries.
- **Cons:** Bytes still flow through the API (same problem as A); extra dependency and state.

**Recommendation:** **Option C (S3 multipart, presigned parts)** — The only option that keeps the API out of the data path *and* supports 10GB *and* resume. Part size fixed at **100 MiB** (10GB ⇒ ~103 parts, well under the 10,000-part limit and above the 5 MiB minimum). The video row is created as `draft` when the upload starts (pre-registration), presigned URLs expire in 1 hour and can be re-issued per part, and an explicit abort endpoint cleans up.

**Decision:** C (S3 multipart upload with presigned part URLs)

**Libraries:** `@aws-sdk/client-s3@^3.1153.0`, `@aws-sdk/s3-request-presigner@^3.1153.0`.

---

## TD-03: Video Worker Runtime

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The diagram defines "Video Worker (FFmpeg)" as a container separate from the API that "consumes jobs from queue, processes videos, updates DB and storage". FFmpeg is CPU-heavy; it must not compete with request handling.

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and container
- `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server); a `video-worker` Compose service built from an image with FFmpeg runs it.
- **Pros:** Reuses entities, config namespaces, TypeORM setup and the storage module; one test toolchain; independent scaling and restarts; FFmpeg only in the worker image.
- **Cons:** Two entrypoints to keep in sync; the worker image is larger (FFmpeg).

### Option B: BullMQ processor inside the API process
- **Pros:** Zero new process.
- **Cons:** FFmpeg CPU spikes degrade API latency; an API restart kills in-flight jobs; contradicts the target architecture.

### Option C: Separate project/repository for the worker
- **Pros:** Full isolation.
- **Cons:** Duplicates entities, config and DB access; two codebases for one domain.

**Recommendation:** **Option A** — matches the architecture diagram, isolates CPU-heavy work, and keeps one codebase.

**Decision:** A (same codebase, `src/worker.ts`, dedicated `video-worker` container with FFmpeg)

**Libraries:** — (FFmpeg/ffprobe installed via `apt` in the worker image)

---

## TD-04: Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker needs duration and technical metadata and one frame as thumbnail. Downloading a 10GB object to local disk before probing would be slow and needs large scratch space.

**Options:**

### Option A: `fluent-ffmpeg` wrapper
- **Pros:** Fluent API.
- **Cons:** The npm package is **deprecated** ("Package no longer supported"); another abstraction over the CLI.

### Option B: Spawn `ffprobe`/`ffmpeg` directly (`node:child_process`) reading the object through a short-lived presigned GET URL
- `ffprobe -v error -print_format json -show_format -show_streams <url>`; thumbnail with `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=640:-2 -f image2pipe -c:v mjpeg pipe:1`.
- **Pros:** No dependency; FFmpeg's HTTP input uses range requests, so probing and seeking read only the needed bytes instead of the whole file; output captured from stdout and uploaded straight to storage.
- **Cons:** Must handle process exit codes, stderr and timeouts explicitly.

### Option C: Download the full object to a temp volume, then run FFmpeg locally
- **Pros:** Simplest FFmpeg invocation.
- **Cons:** 10GB of disk and transfer per job just to read metadata and one frame.

**Recommendation:** **Option B** — dependency-free and avoids copying 10GB. Thumbnail frame at `min(1s, duration × 10%)` (avoids black first frame on short clips), JPEG 640px wide. Each FFmpeg call has a timeout; a non-zero exit fails the job (TD-07 handles retries).

**Decision:** B (spawn ffprobe/ffmpeg over presigned GET URL)

**Libraries:** —

---

## TD-05: Unique Video URL Strategy

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** "Pontos de Atenção": each video needs "uma URL curta e única que nunca conflite com outro vídeo".

**Options:**

### Option A: Use the UUID primary key in the URL
- **Pros:** Already unique.
- **Cons:** 36 characters — not short; exposes the internal id.

### Option B: Random base62 slug (11 chars) with a unique constraint and retry on collision
- `crypto.randomBytes` mapped to `[0-9A-Za-z]`; ~65 bits of entropy; DB unique index guarantees no conflict, a collision retries.
- **Pros:** Short (YouTube-like), unguessable, no dependency; uniqueness enforced by the database, not by luck.
- **Cons:** Needs the retry loop (same pattern as channel nickname, `src/channels/channels.service.ts`).

### Option C: Hashids/Sqids of a sequential number
- **Pros:** Short and deterministic.
- **Cons:** Requires a sequence and a library; reversible (enumerable) with the alphabet.

**Recommendation:** **Option B** — short, not enumerable, dependency-free, and the unique index makes conflicts impossible. The slug is generated at upload start (draft) so the URL exists from the first moment.

**Decision:** B (11-char base62 slug, unique index, retry)

**Libraries:** —

---

## TD-06: Streaming and Download Strategy

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file. HTML5 `<video>` uses HTTP Range requests. Videos are stored as the original upload (no transcoding in this phase).

**Options:**

### Option A: API proxies byte ranges from storage (`206 Partial Content`)
- `GET /videos/:slug/stream` parses `Range`, calls `GetObject` with the same range and pipes the stream; replies `206` with `Content-Range`/`Accept-Ranges`, `200` without `Range`, `416` when unsatisfiable.
- **Pros:** One stable URL per video; authorization and future visibility rules (unlisted/private, Phase 04) stay in the API; storage stays private; fully testable with supertest.
- **Cons:** Playback bytes pass through the API (streamed, not buffered — no event-loop blocking, but bandwidth counts against the API).

### Option B: Redirect to a presigned GET URL (storage serves ranges)
- **Pros:** Zero API bandwidth; storage handles ranges natively.
- **Cons:** URL changes on every request and expires; the presign must use the public storage host; harder to apply per-request rules.

### Option C: HLS/DASH transcoding (segmented adaptive streaming)
- **Pros:** Adaptive bitrate, CDN-friendly.
- **Cons:** Full transcoding pipeline — far beyond Phase 03 scope ("extração de duração e metadados").

**Recommendation:** **A for streaming, B for download.** Streaming via the API keeps one canonical URL and the access rules in one place, with real `206` semantics. Download — a single long sequential read — is redirected (`302`) to a presigned GET URL with `response-content-disposition=attachment`, so large downloads do not hold the API. HLS is deferred.

**Decision:** A + B (stream proxied with Range/206; download via 302 to presigned URL)

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (same as TD-02)

---

## TD-07: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload

**Context:** The video exists before its file is complete and goes through asynchronous processing that may fail (corrupt file, FFmpeg error, storage outage).

**Options:**

### Option A: Four states — `draft → processing → ready | failed`, retries in the queue
- `draft`: created at upload start (slug assigned, multipart open). `processing`: upload completed, job enqueued. `ready`: metadata + thumbnail stored. `failed`: processing exhausted retries (error message persisted).
- Job options: `attempts: 3`, `backoff: exponential 10s`, `jobId = videoId` (re-enqueue is idempotent). The DB status changes to `failed` only on the final attempt.
- **Pros:** Mirrors the business language of the phase ("rascunho → processando → pronto/erro"); transient errors are retried automatically; permanent errors are visible.
- **Cons:** No separate "uploading" state — an abandoned draft stays `draft` until aborted (abort endpoint + bucket lifecycle rule).

### Option B: Add `uploading` and `queued` states
- **Pros:** Finer-grained visibility.
- **Cons:** More transitions to keep consistent; no product requirement for them.

### Option C: No automatic retries; any failure → `failed`
- **Cons:** Transient storage/network errors become permanent failures.

**Recommendation:** **Option A.** Transitions are guarded in the service (`draft→processing` only on upload completion; `processing→ready|failed` only by the worker), each one a single conditional `UPDATE … WHERE status = :expected` so concurrent attempts cannot regress the state. If enqueueing fails after `draft→processing`, the service reverts to `draft` (compensation) so the client can retry completion.

**Decision:** A (`draft → processing → ready | failed`; BullMQ attempts 3, exponential backoff)

**Libraries:** —

---

## TD-08: Object Storage Organization and Local Image

**Scope:** Backend / Infra

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage is S3-compatible by project decision. Research finding: the `minio/minio` image is **no longer published on Docker Hub** (MinIO stopped distributing community images in October 2025) and the Quay mirror requires authentication. A pinned, publicly pullable MinIO build is still available as `bitnamilegacy/minio:2025.7.23-debian-12-r5` (frozen, no further updates).

**Options:**

### Option A: Pinned `bitnamilegacy/minio`, single bucket with key prefixes
- One bucket `streamtube-media` created by the image (`MINIO_DEFAULT_BUCKETS`); keys `videos/{videoId}/original` and `thumbnails/{videoId}.jpg`.
- **Pros:** Keeps MinIO as the architecture states; bucket bootstrap built into the image; prefixes keep one policy/lifecycle per kind.
- **Cons:** Frozen image (acceptable for local dev only — production uses AWS S3).

### Option B: SeaweedFS (S3 gateway) as local storage
- **Pros:** Actively maintained.
- **Cons:** Diverges from the MinIO named in the architecture; extra configuration for the S3 gateway.

### Option C: Two buckets (videos, thumbnails)
- **Cons:** Two bootstraps and two sets of credentials/policies for no benefit at this scale.

**Recommendation:** **Option A.** S3 access goes through one `StorageService` (AWS SDK v3, `forcePathStyle: true`) so swapping the local image or moving to AWS S3 is configuration only. Two S3 clients: an internal one (`http://minio:9000`, Compose service name) for server-side calls and a signing-only one configured with the public endpoint for URLs handed to clients (presigned URLs embed the host in the signature).

**Decision:** A (`bitnamilegacy/minio:2025.7.23-debian-12-r5`, bucket `streamtube-media`, prefixes per kind)

**Libraries:** `@aws-sdk/client-s3@^3.1153.0`
