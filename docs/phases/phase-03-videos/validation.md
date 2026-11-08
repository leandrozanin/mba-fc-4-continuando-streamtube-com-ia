---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-20T13:05:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-20T12:50:00-03:00"
issues: []
advisories:
  - "bitnamilegacy/minio is frozen (no security updates). Acceptable for local development only; production targets AWS S3 through the same StorageService."
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

Issues raised in the first validation pass (status `dirty`, 6 issues) and resolved by `plan-resolve` before this clean pass:

| # | Category | Issue | Resolution |
|---|----------|-------|------------|
| 1 | Dependency Gaps | The TD set assumed the `minio/minio` image. It is no longer published on Docker Hub and the Quay mirror requires authentication — `docker compose up` would fail. | TD-08 updated: pinned `bitnamilegacy/minio:2025.7.23-debian-12-r5` (publicly pullable), bucket bootstrapped via `MINIO_DEFAULT_BUCKETS`; SeaweedFS recorded as alternative. |
| 2 | Dependency Gaps | Latest `@nestjs/bullmq` (12.x) targets Nest 12; the project runs Nest 11. | TD-01 pins `@nestjs/bullmq@^11.0.5` (peer `@nestjs/common ^10 \|\| ^11`) with `bullmq@^5.81.5`; recorded in `library-refs.md`. |
| 3 | Inherited Constraint Conflicts | `ThrottlerGuard` is registered as `APP_GUARD` (phase-02-auth/TD-08) and therefore applies to every controller: a 100-part upload or a video player issuing Range requests would hit 10 req/min. | Plan requires `@SkipThrottle()` on the videos controller (SI-03.5) and a test asserting more than 10 consecutive Range requests succeed (SI-03.9). |
| 4 | Ambiguities | Presigned URLs embed the host in the signature; URLs signed for `minio:9000` are unusable from the host browser, and URLs signed for `localhost:9000` are unusable from inside the API container (e2e). | TD-08: two S3 clients — internal (`S3_ENDPOINT=http://minio:9000`) for server calls and a signing client (`S3_PUBLIC_ENDPOINT`). The e2e suite sets `S3_PUBLIC_ENDPOINT=http://minio:9000` so presigned parts are uploadable from the test container. |
| 5 | Missing Decisions | Status lifecycle did not define what happens when enqueueing fails after the upload is completed (video stuck in `processing` without a job). | TD-07: enqueue with `jobId = videoId`; on enqueue failure the service reverts `processing → draft` (compensation) and the client may call complete again (idempotent). |
| 6 | Ambiguities | "URL única" did not state whether owner-only operations use the id or the slug. | TD-05/plan: the slug is the single public identifier for all video routes (`/videos/:slug/...`); the UUID stays internal. |
