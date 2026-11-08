---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-20T12:50:00-03:00"
  docs/phases/phase-03-videos/context.md: "2026-10-20T13:05:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-20T13:10:00-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Let an authenticated user upload videos of up to 10GB directly to object storage without holding the API, pre-register each video as a draft with a unique short URL at upload start, process it automatically in a separate worker (duration, metadata, thumbnail) through a queue, and serve it by streaming (HTTP Range) and download.

---

## Step Implementations

### SI-03.1 — Infrastructure: Redis, MinIO and Video Worker in Docker Compose; Config Namespaces

**Description:** Add the three new infrastructure services to `nestjs-project/compose.yaml`, create the config namespaces and env validation for storage, queue and video processing, and install the Phase 03 dependencies.

**Technical actions:**

- Install in `nestjs-project`: `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5`, `@aws-sdk/client-s3@^3.1153.0`, `@aws-sdk/s3-request-presigner@^3.1153.0` (versions from `library-refs.md`)
- `compose.yaml`:
  - `redis` — image `redis:8.6`, command `redis-server --appendonly yes`, volume `redis-data:/data`, healthcheck `redis-cli ping`
  - `minio` — image `bitnamilegacy/minio:2025.7.23-debian-12-r5`, env `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_DEFAULT_BUCKETS=streamtube-media`, ports `9000` (S3) and `9001` (console), volume `minio-data:/bitnami/minio/data`, healthcheck `curl -f http://localhost:9000/minio/health/live`
  - `video-worker` — build `Dockerfile.worker` (same base `node:25.6.0-slim` as `Dockerfile.dev` + `apt install -y ffmpeg`), volume `.:/home/node/app`, command `npm run start:worker:dev`, `depends_on` `db`, `redis`, `minio` healthy
  - `nestjs-api` gets `depends_on` `redis` and `minio` (healthy); `nestjs-api` image also installs `ffmpeg` (`Dockerfile.dev`) so integration tests of the processing service can run in the API container
- `src/config/storage.config.ts` — `registerAs('storage', …)`: `endpoint` (`S3_ENDPOINT`, default `http://minio:9000`), `publicEndpoint` (`S3_PUBLIC_ENDPOINT`, default `http://localhost:9000`), `region` (`S3_REGION`, default `us-east-1`), `accessKey` (`S3_ACCESS_KEY`), `secretKey` (`S3_SECRET_KEY`), `bucket` (`S3_BUCKET`, default `streamtube-media`)
- `src/config/queue.config.ts` — `registerAs('queue', …)`: `redisHost` (`REDIS_HOST`, default `redis`), `redisPort` (`REDIS_PORT`, default `6379`)
- `src/config/video.config.ts` — `registerAs('video', …)`: `maxUploadBytes` (`VIDEO_MAX_UPLOAD_BYTES`, default `10737418240`), `partSizeBytes` (`VIDEO_UPLOAD_PART_SIZE_BYTES`, default `104857600`), `uploadUrlTtlSeconds` (default `3600`), `downloadUrlTtlSeconds` (default `300`), `processingAttempts` (default `3`), `ffmpegTimeoutMs` (default `120000`)
- Extend `src/config/env.validation.ts` (S3 keys required, others with defaults) and `.env.example`; register the three namespaces in `AppModule`'s `ConfigModule.forRoot({ load })`
- Package scripts: `start:worker:dev` (`nest start --watch --entryFile worker`), `start:worker` (`node dist/worker`)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` | Unit (existing suite extended) | S3 credentials required; numeric defaults for video/queue settings |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings up `nestjs-api`, `db`, `mailpit`, `redis`, `minio` and `video-worker`; `docker compose ps` shows all running and `redis`/`minio` healthy
- The bucket `streamtube-media` exists on first start without manual steps
- `docker compose exec video-worker ffmpeg -version` and `ffprobe -version` succeed
- Starting the API without `S3_ACCESS_KEY` fails Joi validation at bootstrap

---

### SI-03.2 — Storage Module (S3/MinIO)

**Description:** Create `StorageModule` with a `StorageService` that is the only place that talks to S3: multipart lifecycle, presigned URLs, object reads with byte ranges, small object writes and metadata.

**Technical actions:**

- `src/storage/storage.module.ts` — provides `StorageService` and two `S3Client` providers built from `storageConfig`: `S3_CLIENT` (internal `endpoint`) and `S3_SIGNING_CLIENT` (`publicEndpoint`), both `forcePathStyle: true`; exports `StorageService`
- `src/storage/storage.service.ts`:
  - `createMultipartUpload(key, contentType): Promise<string>` (returns `UploadId`)
  - `presignUploadPart(key, uploadId, partNumber, ttl): Promise<string>`
  - `completeMultipartUpload(key, uploadId, parts: { partNumber; etag }[]): Promise<void>` — sorts parts ascending
  - `abortMultipartUpload(key, uploadId): Promise<void>`
  - `headObject(key): Promise<{ size: number; contentType?: string } | null>` (null on `NotFound`)
  - `getObjectRange(key, range?: { start; end }): Promise<{ stream: Readable; contentLength; contentRange?; totalSize }>`
  - `presignGetObject(key, ttl, options?: { downloadFilename?: string; internal?: boolean }): Promise<string>` — `internal: true` signs with the internal client (used by the worker for FFmpeg input)
  - `putObject(key, body: Buffer, contentType): Promise<void>`
  - `deleteObject(key): Promise<void>`
- `src/storage/storage.constants.ts` — `S3_CLIENT`, `S3_SIGNING_CLIENT` tokens and key builders `videoObjectKey(videoId)` → `videos/{id}/original`, `thumbnailKey(videoId)` → `thumbnails/{id}.jpg`
- Storage failures from the SDK are wrapped in `StorageUnavailableException` (domain) — except `NotFound` on head, which is a valid `null`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Against Compose MinIO: multipart create → upload 2 parts via presigned URLs (`fetch`) → complete → `headObject` size; abort removes the upload; `getObjectRange` returns exact bytes and `Content-Range`; `presignGetObject` downloads the object; `putObject`/`deleteObject` round-trip |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles with config-driven client providers |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A file uploaded in two presigned parts is assembled by `completeMultipartUpload` and `headObject` reports the summed size
- `getObjectRange(key, { start: 0, end: 9 })` returns exactly 10 bytes and `contentRange = "bytes 0-9/<total>"`
- `headObject` of a missing key returns `null` (no exception)

---

### SI-03.3 — Video Entity, Migration and Slug Generation

**Description:** Create the `Video` entity linked to `Channel`, generate the `CreateVideos` migration, and the slug utility.

**Technical actions:**

- `src/videos/entities/video.entity.ts` — see **Data Model**; `@ManyToOne(() => Channel, (c) => c.videos, { onDelete: 'CASCADE' })` with `@JoinColumn({ name: 'channel_id' })`; `upload_id` with `select: false`
- `src/channels/entities/channel.entity.ts` — add `@OneToMany(() => Video, (v) => v.channel) videos: Video[]`
- `src/videos/video-status.enum.ts` — `VideoStatus { DRAFT = 'draft', PROCESSING = 'processing', READY = 'ready', FAILED = 'failed' }`
- `src/videos/slug.util.ts` — `generateSlug(): string` — 11 chars from `crypto.randomBytes`, alphabet `[0-9A-Za-z]` with rejection sampling (no modulo bias)
- `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`
- Generate `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate`; review enum type, FK, unique index on `slug`, index on `(channel_id, created_at)`
- Update `src/database/migrations.integration-spec.ts` (add the migration and `videos` table; expect 3 migrations) and `src/test/create-test-data-source.ts` `cleanAllTables` (delete `videos` before `channels`)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/slug.util.spec.ts` | Unit | Length 11, only base62 chars, 10,000 generations without duplicates |
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `slug`, default `status = draft`, FK to channel with cascade delete, `upload_id` excluded from default select, `metadata` jsonb round-trip, `size_bytes` bigint beyond 2^31 |
| `src/database/migrations.integration-spec.ts` | Integration | Runs 3 migrations, `videos` table exists; undo removes it |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates `videos` with all columns, the `videos_status_enum` type, unique index on `slug` and FK `channel_id → channels.id`
- Inserting two videos with the same slug fails with a unique violation
- A `size_bytes` of 10737418240 (10GB) is stored and read back exactly

---

### SI-03.4 — Video Domain Exceptions and Processing Queue Producer

**Description:** Add the video domain errors, register BullMQ (root connection + `video-processing` queue) and a producer service used by the API.

**Technical actions:**

- `src/common/exceptions/domain.exception.ts` — add the exceptions of the **Error Catalog**
- `AppModule` — `BullModule.forRootAsync` from `queueConfig` (global infrastructure, like TypeORM)
- `src/video-processing/video-processing.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`
- `src/video-processing/video-processing.types.ts` — `ProcessVideoJob { videoId: string }`
- `src/video-processing/video-processing-queue.service.ts` — `enqueue(videoId): Promise<void>` → `queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId, attempts: video.processingAttempts, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: true, removeOnFail: false })`
- `src/video-processing/video-processing-queue.module.ts` — `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, provides/exports the producer (no processor here)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/video-processing/video-processing-queue.service.integration-spec.ts` | Integration | Against Compose Redis: job added with name, payload, `jobId = videoId`, attempts and backoff; enqueuing the same id twice keeps one job |
| `src/common/filters/domain-exception.filter.spec.ts` | Unit (extended) | New video exceptions map to their status and code |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `enqueue(id)` creates exactly one waiting job `process-video` with `{ videoId: id }` and `opts.attempts = 3`
- Calling `enqueue(id)` twice does not create a second job

---

### SI-03.5 — Start Upload: Draft Pre-registration with Unique URL

**Description:** `POST /videos/uploads` creates the video as `draft` in the caller's channel with a unique slug, opens the S3 multipart upload and returns presigned URLs for every part.

**Technical actions:**

- `src/videos/dto/create-upload.dto.ts` — `title` (`@IsString() @MinLength(1) @MaxLength(100)`), `filename` (`@IsString() @MaxLength(255)`), `size` (`@IsInt() @Min(1) @Max(10737418240)`), `contentType` (`@Matches(/^video\/[\w.+-]+$/)`)
- `src/videos/dto/upload-session.response.ts` — response DTO with `@ApiProperty` (see **API Contracts**)
- `src/videos/videos.service.ts` — `startUpload(userId, dto)`: resolve channel by `user_id` (`ChannelNotFoundException`); `partCount = ceil(size / partSize)`; insert video (`draft`, slug retry up to 5 on unique violation of `slug`); `createMultipartUpload(videoObjectKey(id))`; save `upload_id` and `storage_key`; presign all parts; if S3 fails after insert, delete the draft row and rethrow (compensation)
- `src/videos/videos.controller.ts` — `@ApiTags('videos') @Controller('videos') @SkipThrottle()`; `@Post('uploads') @HttpCode(201) @ApiBearerAuth('access-token')`
- `ChannelsService.findByUserId(userId)` (new method in `ChannelsModule`, exported) — the videos module does not query `channels` directly
- Register `VideosModule` (imports `ChannelsModule`, `StorageModule`, `VideoProcessingQueueModule`) in `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Part count math (exact multiple, remainder, 10GB → 103), slug retry on unique violation, compensation deletes draft when S3 fails |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB + MinIO: draft row persisted with slug, `storage_key`, `upload_id`; presigned URLs accept a PUT |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/uploads` 201 shape; 401 without token; 400 for `size > 10GB`, non-video `contentType`, missing title |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- An authenticated user starting an upload gets 201 with `video.status = "draft"`, an 11-char `video.slug` and `upload.parts` with one presigned URL per part
- The video row exists in the database as `draft` **before** any byte is uploaded (pre-registration)
- `size = 10737418240` is accepted (103 parts of 100 MiB); `size = 10737418241` returns 400
- The API never receives the file bytes (only metadata JSON)

---

### SI-03.6 — Resume, Complete and Abort Upload; Enqueue Processing

**Description:** Endpoints to re-sign part URLs (resume after expiry or connection loss), to complete the upload (which moves the video to `processing` and enqueues the job), and to abort it.

**Technical actions:**

- `src/videos/dto/sign-parts.dto.ts` — `partNumbers: number[]` (`@ArrayMinSize(1) @ArrayMaxSize(10000)`, each `@IsInt() @Min(1)`)
- `src/videos/dto/complete-upload.dto.ts` — `parts: { partNumber: number; etag: string }[]` (`@ValidateNested`)
- `VideosService.signParts(userId, slug, partNumbers)` — owner + `draft` only; part numbers within `partCount`
- `VideosService.completeUpload(userId, slug, parts)`:
  1. owner check (`VideoForbiddenException`), `draft` required (`VideoUploadNotInProgressException`)
  2. `completeMultipartUpload` (S3 `InvalidPart`/`EntityTooSmall` → `VideoUploadIncompleteException`)
  3. `headObject` → size must equal declared `size_bytes` (else `VideoUploadIncompleteException`)
  4. conditional update `UPDATE videos SET status='processing', upload_id=NULL WHERE id=:id AND status='draft'`
  5. `enqueue(videoId)`; on failure revert to `draft` and rethrow
- `VideosService.abortUpload(userId, slug)` — owner + `draft`; `abortMultipartUpload`; delete the video row
- Controller: `POST /videos/:slug/upload/parts` (200), `POST /videos/:slug/upload/complete` (202), `DELETE /videos/:slug/upload` (204)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | State guards, ownership, size mismatch, compensation on enqueue failure |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB + MinIO + Redis: complete moves to `processing` and a job exists with `jobId = video.id`; abort removes row and multipart |
| `test/videos.e2e-spec.ts` | E2E | Full upload through presigned parts then complete → 202; second complete → 409; other user → 403; re-sign returns fresh URLs; abort → 204 then 404 |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- After uploading all parts and calling complete, the response is 202 with `status = "processing"` and a `process-video` job for that video is in the queue
- Completing with a missing part or wrong ETag returns 400 `VIDEO_UPLOAD_INCOMPLETE` and the video stays `draft`
- Completing a video that is not `draft` returns 409 `VIDEO_UPLOAD_NOT_IN_PROGRESS`
- A user who is not the channel owner gets 403 `VIDEO_FORBIDDEN` on parts/complete/abort
- Re-signing parts returns new URLs for exactly the requested part numbers (resume)

---

### SI-03.7 — Video Worker: Metadata, Thumbnail and Status Lifecycle

**Description:** The worker process consumes `process-video` jobs, extracts duration/metadata with ffprobe, generates the thumbnail with ffmpeg, stores it, and moves the video to `ready`; after the last failed attempt the video becomes `failed`.

**Technical actions:**

- `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)`, `enableShutdownHooks()`
- `src/worker.module.ts` — `ConfigModule` (same namespaces), `TypeOrmModule.forRootAsync` (same factory as `AppModule`, extracted to `src/database/typeorm-options.ts`), `BullModule.forRootAsync`, `VideoProcessingModule`
- `src/video-processing/ffmpeg.service.ts` — `probe(url): Promise<ProbeResult>` (spawn `ffprobe -v error -print_format json -show_format -show_streams`), `extractFrame(url, atSeconds): Promise<Buffer>` (spawn `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=640:-2 -f image2pipe -c:v mjpeg pipe:1`); timeout kills the process; non-zero exit → `VideoProcessingError` with stderr tail
- `src/video-processing/video-processing.service.ts` — `process(videoId)`: load video (`processing` required, otherwise skip — idempotent); `presignGetObject(storage_key, internal)`; probe → `duration_seconds = format.duration`, `metadata = { container, videoCodec, audioCodec, width, height, bitrate, fps }`; reject if no video stream; frame at `min(1, duration*0.1)`; `putObject(thumbnailKey)`; conditional update to `ready` with `thumbnail_key`, `processed_at`
- `markFailed(videoId, message)` — conditional update `processing → failed` with `processing_error`
- `src/video-processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extends `WorkerHost`; `process(job)` calls the service (errors propagate → BullMQ retry); `@OnWorkerEvent('failed')` calls `markFailed` only when `attemptsMade >= opts.attempts` (catch-and-log allowed here — background context)
- `src/video-processing/video-processing.module.ts` — imports `StorageModule`, `TypeOrmModule.forFeature([Video])`, registers the queue and the processor (worker only)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/video-processing/ffmpeg.service.integration-spec.ts` | Integration | Real ffmpeg: a 3s clip generated with `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=25` is probed (duration ≈ 3, 320x240, h264) and a JPEG frame is extracted; invalid input raises `VideoProcessingError` |
| `src/video-processing/video-processing.service.integration-spec.ts` | Integration | Real DB + MinIO + ffmpeg: video in `processing` with the clip uploaded becomes `ready` with duration, metadata and thumbnail object; corrupt object throws; `markFailed` moves to `failed` |
| `src/video-processing/video-processing.processor.spec.ts` | Unit | `failed` event marks the video failed only on the final attempt |
| `src/video-processing/video-processing.processor.integration-spec.ts` | Integration | Real Redis: a job enqueued by the producer is consumed by a worker built in the test and the video ends `ready` |

**Dependencies:** SI-03.4, SI-03.6

**Acceptance criteria:**

- With the `video-worker` container running, a completed upload of a valid video reaches `ready` automatically, with `duration_seconds`, `metadata` (codec, resolution) and a `thumbnails/{id}.jpg` object in the bucket
- A corrupt file is retried 3 times and the video ends `failed` with `processing_error` filled
- The API process does not consume jobs (processor registered only in `WorkerModule`)

---

### SI-03.8 — Read Endpoints: Public Video and Owner Status

**Description:** `GET /videos/:slug` returns a ready video by its unique URL; `GET /videos/:slug/status` lets the owner follow the lifecycle of any of their videos.

**Technical actions:**

- `src/videos/dto/video.response.ts` — public shape (see **API Contracts**)
- `VideosService.findReadyBySlug(slug)` — `VideoNotFoundException` unless `ready`
- `VideosService.getStatusForOwner(userId, slug)` — owner only
- Controller: `@Public() @Get(':slug')`, `@Get(':slug/status')` with `@ApiBearerAuth`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | Ready video 200 (anonymous); draft/processing/failed 404 to anonymous; status 200 for owner (any state), 403 other user, 401 anonymous |

**Dependencies:** SI-03.3

**Acceptance criteria:**

- `GET /videos/:slug` for a `ready` video returns 200 without authentication, including `durationSeconds`, `thumbnailUrl`, `streamUrl`, `downloadUrl`
- Non-ready videos are not exposed publicly (404 `VIDEO_NOT_FOUND`)
- The owner sees `draft → processing → ready/failed` in `GET /videos/:slug/status`

---

### SI-03.9 — Streaming with HTTP Range (206 Partial Content)

**Description:** `GET /videos/:slug/stream` serves the video by byte ranges without buffering the file.

**Technical actions:**

- `src/videos/range.util.ts` — `parseRange(header, totalSize)` → `{ start, end } | 'unsatisfiable' | null` (single range; `bytes=a-b`, `bytes=a-`, `bytes=-n`; multiple ranges served as the first)
- `VideosService.openStream(slug, rangeHeader)` — ready only; `headObject` for total size; unsatisfiable → `RangeNotSatisfiableException` (416 with `Content-Range: bytes */total`)
- Controller `@Public() @Get(':slug/stream')` — uses `@Res()` passthrough to set `206`, `Content-Range`, `Accept-Ranges: bytes`, `Content-Length`, `Content-Type`, and `stream.pipe(res)`; `200` with full length when no `Range`; destroys the S3 stream if the client disconnects

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/range.util.spec.ts` | Unit | All range forms, open-ended, suffix, out of bounds, malformed |
| `test/videos.e2e-spec.ts` | E2E | `Range: bytes=0-1023` → 206 with exact 1024 bytes and `Content-Range`; no Range → 200 full body; `bytes=99999999999-` → 416; 15 consecutive range requests all succeed (not throttled) |

**Dependencies:** SI-03.8, SI-03.2

**Acceptance criteria:**

- A request with `Range: bytes=0-1023` returns 206, `Content-Range: bytes 0-1023/<size>` and exactly 1024 bytes matching the stored object
- Playback can seek: any valid range returns 206 with the right bytes without reading the whole object
- An unsatisfiable range returns 416 with `Content-Range: bytes */<size>`

---

### SI-03.10 — Download and Thumbnail

**Description:** Download via redirect to a short-lived presigned URL with `Content-Disposition: attachment`; thumbnail via redirect to a presigned URL.

**Technical actions:**

- `VideosService.getDownloadUrl(slug)` — ready only; `presignGetObject(storage_key, downloadUrlTtl, { downloadFilename: sanitized original filename })`
- `VideosService.getThumbnailUrl(slug)` — ready only
- Controller `@Public() @Get(':slug/download')` and `@Get(':slug/thumbnail')` → `302` with `Location`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | 302 with presigned `Location`; fetching `Location` from the test container returns the full object with `Content-Disposition: attachment`; thumbnail URL returns `image/jpeg`; non-ready → 404 |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- `GET /videos/:slug/download` returns 302 to a URL that downloads the original file as an attachment
- `GET /videos/:slug/thumbnail` returns 302 to the generated JPEG

---

### SI-03.11 — End-to-End Flow, OpenAPI Export and Documentation

**Description:** One e2e test that exercises the whole phase with the real worker, the OpenAPI export, and the CLAUDE.md updates.

**Technical actions:**

- `test/videos-flow.e2e-spec.ts` — register/confirm/login → start upload of the generated clip (2 parts with part size overridden to 5 MiB in the test env) → PUT parts to presigned URLs → complete → poll `GET /videos/:slug/status` until `ready` (worker container) → stream range → download
- `npm run openapi:export` — regenerate `openapi.json` with the videos endpoints
- `CLAUDE.md` (root) — replace "Message Queue (TBD)" with BullMQ/Redis, add a **Videos** section (module, endpoints, worker, storage, status lifecycle)
- `nestjs-project/CLAUDE.md` — services list (`redis`, `minio`, `video-worker`), readiness checks, worker commands, test notes (MinIO/Redis/ffmpeg)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos-flow.e2e-spec.ts` | E2E | Upload → processing → ready → stream → download with real MinIO, Redis and worker |

**Dependencies:** SI-03.7, SI-03.9, SI-03.10

**Acceptance criteria:**

- The full flow passes with the Compose stack running
- `openapi.json` contains every videos endpoint
- CLAUDE.md files describe only files, commands and behaviors that exist

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier; storage keys use it |
| channel_id | uuid | FK → channels.id, not null, ON DELETE CASCADE | Owner channel |
| title | varchar(100) | not null | Given at upload start; editable in Phase 04 |
| slug | varchar(16) | unique, not null | 11-char base62 public identifier (TD-05) |
| status | enum `videos_status_enum` | not null, default `'draft'` | `draft`, `processing`, `ready`, `failed` (TD-07) |
| original_filename | varchar(255) | not null | Used for the download filename |
| content_type | varchar(100) | not null | `video/*` |
| size_bytes | bigint | not null | Declared size, checked against the stored object |
| storage_key | varchar(512) | not null | `videos/{id}/original` |
| upload_id | varchar(1024) | nullable, `select: false` | Open multipart upload id; null after completion |
| thumbnail_key | varchar(512) | nullable | `thumbnails/{id}.jpg` |
| duration_seconds | numeric(10,3) | nullable | From ffprobe `format.duration` |
| metadata | jsonb | nullable | `{ container, videoCodec, audioCodec, width, height, bitrate, fps }` |
| processing_error | text | nullable | Last error after the final attempt |
| processed_at | timestamp | nullable | When it became `ready` |
| created_at | timestamp | not null, auto | |
| updated_at | timestamp | not null, auto | |

**Relations:** Video → Channel (many-to-one); Channel → Video (one-to-many)
**Indexes:** `(slug)` unique; `(channel_id, created_at)`; `(status)`

### API Contracts

All routes are under the `videos` resource. Error bodies use the existing envelope `{ statusCode, error, message }`.

#### POST /videos/uploads (SI-03.5)

**Request headers:** `Authorization: Bearer <access_token>`, `Content-Type: application/json`

**Request body:**
- title: string, required — 1..100
- filename: string, required — ≤ 255
- size: integer, required — 1..10737418240
- contentType: string, required — `video/*`

**Response 201:**
- video: `{ id, slug, title, status: "draft", sizeBytes, createdAt }`
- upload: `{ partSize, partCount, expiresAt, parts: [{ partNumber, url }] }`

**Error responses:**
- 400 VALIDATION_ERROR — invalid body (size above 10GB, non-video content type, missing title)
- 401 — missing/invalid token
- 404 CHANNEL_NOT_FOUND — user has no channel
- 503 STORAGE_UNAVAILABLE — storage refused the multipart creation

#### POST /videos/:slug/upload/parts (SI-03.6)

**Request body:** `partNumbers: integer[]` (1..partCount)

**Response 200:** `{ expiresAt, parts: [{ partNumber, url }] }`

**Error responses:** 400 VALIDATION_ERROR; 401; 403 VIDEO_FORBIDDEN; 404 VIDEO_NOT_FOUND; 409 VIDEO_UPLOAD_NOT_IN_PROGRESS

#### POST /videos/:slug/upload/complete (SI-03.6)

**Request body:** `parts: [{ partNumber: integer, etag: string }]` (all parts)

**Response 202:** `{ slug, status: "processing" }`

**Error responses:** 400 VALIDATION_ERROR / VIDEO_UPLOAD_INCOMPLETE; 401; 403 VIDEO_FORBIDDEN; 404 VIDEO_NOT_FOUND; 409 VIDEO_UPLOAD_NOT_IN_PROGRESS; 503 STORAGE_UNAVAILABLE / QUEUE_UNAVAILABLE

#### DELETE /videos/:slug/upload (SI-03.6)

**Response 204:** No content (multipart aborted, draft removed)

**Error responses:** 401; 403 VIDEO_FORBIDDEN; 404 VIDEO_NOT_FOUND; 409 VIDEO_UPLOAD_NOT_IN_PROGRESS

#### GET /videos/:slug (SI-03.8)

**Response 200:** `{ slug, title, status: "ready", durationSeconds, metadata, sizeBytes, channel: { nickname, name }, thumbnailUrl, streamUrl, downloadUrl, createdAt, processedAt }` — URLs are API paths (`/videos/:slug/thumbnail|stream|download`)

**Error responses:** 404 VIDEO_NOT_FOUND (missing or not ready)

#### GET /videos/:slug/status (SI-03.8)

**Response 200:** `{ slug, status, processingError, durationSeconds, updatedAt }`

**Error responses:** 401; 403 VIDEO_FORBIDDEN; 404 VIDEO_NOT_FOUND

#### GET /videos/:slug/stream (SI-03.9)

**Request headers:** `Range: bytes=<start>-<end>` (optional)

**Response 206:** body = requested bytes; headers `Content-Range: bytes start-end/total`, `Accept-Ranges: bytes`, `Content-Length`, `Content-Type`
**Response 200:** full body when no `Range`

**Error responses:** 404 VIDEO_NOT_FOUND; 416 RANGE_NOT_SATISFIABLE (`Content-Range: bytes */total`)

#### GET /videos/:slug/download (SI-03.10)

**Response 302:** `Location` = presigned GET (5 min) with `Content-Disposition: attachment; filename="<original>"`

**Error responses:** 404 VIDEO_NOT_FOUND

#### GET /videos/:slug/thumbnail (SI-03.10)

**Response 302:** `Location` = presigned GET of `thumbnails/{id}.jpg`

**Error responses:** 404 VIDEO_NOT_FOUND

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner only | Notes |
|----------|--------|---------------|------------|-------|
| POST /videos/uploads | | ✓ | — | Video created in the caller's channel |
| POST /videos/:slug/upload/parts | | ✓ | ✓ | `draft` only |
| POST /videos/:slug/upload/complete | | ✓ | ✓ | `draft` only |
| DELETE /videos/:slug/upload | | ✓ | ✓ | `draft` only |
| GET /videos/:slug/status | | ✓ | ✓ | Any status |
| GET /videos/:slug | ✓ | | | `ready` only |
| GET /videos/:slug/stream | ✓ | | | `ready` only; `@SkipThrottle()` |
| GET /videos/:slug/download | ✓ | | | `ready` only |
| GET /videos/:slug/thumbnail | ✓ | | | `ready` only |

Ownership = `video.channel.user_id === request.user.sub`, checked in `VideosService` (business rule), never in the controller.

### Error Catalog

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown slug; public routes on a non-ready video |
| VIDEO_FORBIDDEN | 403 | You do not own this video | Owner-only route called by another user |
| CHANNEL_NOT_FOUND | 404 | Channel not found | Upload by a user without channel |
| VIDEO_UPLOAD_NOT_IN_PROGRESS | 409 | Video upload is not in progress | parts/complete/abort when status ≠ `draft` |
| VIDEO_UPLOAD_INCOMPLETE | 400 | Uploaded parts are missing or invalid | S3 rejects completion or stored size ≠ declared size |
| RANGE_NOT_SATISFIABLE | 416 | Requested range not satisfiable | Range start beyond object size |
| STORAGE_UNAVAILABLE | 503 | Storage service unavailable | S3/MinIO call failed |
| QUEUE_UNAVAILABLE | 503 | Processing queue unavailable | Enqueue failed (status reverted to `draft`) |

### Events / Messages

**Queue:** `video-processing` (BullMQ on Redis, TD-01)

| Message | Producer | Consumer | Payload | Options |
|---------|----------|----------|---------|---------|
| `process-video` | `VideoProcessingQueueService.enqueue` (API, on upload completion — SI-03.6) | `VideoProcessingProcessor` (worker container — SI-03.7) | `{ videoId: string (uuid) }` | `jobId = videoId` (idempotent), `attempts: 3`, `backoff: { type: 'exponential', delay: 10000 }`, `removeOnComplete: true`, `removeOnFail: false` |

**Consumer contract:**
- Precondition: video in `processing`; otherwise the job completes without effect (idempotent re-delivery).
- Success: video `processing → ready` with `duration_seconds`, `metadata`, `thumbnail_key`, `processed_at`.
- Error: the processor throws → BullMQ retries with backoff; on the final attempt (`attemptsMade >= attempts`) the `failed` handler sets `processing → failed` with `processing_error`. Failed jobs are kept in Redis for inspection.

**State transitions:**

```
POST /videos/uploads ──► draft ──(complete + enqueue)──► processing ──(worker ok)──► ready
                          ▲  │                              │
       enqueue fails ─────┘  └──(abort: row deleted)        └──(3 attempts failed)──► failed
```

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2 (storage)
├── SI-03.3 (entity + migration)
│   └── SI-03.8 (read endpoints)
│       ├── SI-03.9 (streaming)   [+ SI-03.2]
│       └── SI-03.10 (download/thumbnail)
└── SI-03.4 (exceptions + queue producer)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5 (start upload / draft)
    └── SI-03.6 (parts / complete / abort + enqueue)
        └── SI-03.7 (worker)   [+ SI-03.4]

SI-03.7 + SI-03.9 + SI-03.10
└── SI-03.11 (e2e flow + OpenAPI + CLAUDE.md)
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9, SI-03.10 (parallel) → SI-03.11

## Deliverables

- [ ] Redis, MinIO and the video worker running in Docker Compose with the backend — compose files written; `docker compose up` pending (Docker unavailable on the dev host, see `progress.md`)
- [x] `StorageModule` as the single S3 gateway (multipart, presign, range reads)
- [x] `videos` table and `Video` entity linked to `Channel` (migration `CreateVideos`)
- [x] Upload of up to 10GB directly to storage via presigned multipart, with resume and abort
- [x] Video pre-registered as `draft` with a unique 11-char slug at upload start
- [x] `process-video` job enqueued on upload completion (BullMQ, idempotent)
- [x] Worker extracts duration/metadata (ffprobe) and generates the thumbnail (ffmpeg)
- [x] Status lifecycle `draft → processing → ready | failed` persisted in the database
- [x] Streaming with HTTP Range (206) and download via presigned URL
- [x] OpenAPI export and CLAUDE.md updated
- [x] All SI tests pass (`npm test -- --runInBand`, run against native services — see `progress.md`)
- [x] E2E tests pass (`npm run test:e2e`, same environment)
- [x] Type check passes (`npx tsc --noEmit`)
- [x] Lint passes on every file of this phase (`npm run lint` still reports pre-existing errors in older files, out of scope)
