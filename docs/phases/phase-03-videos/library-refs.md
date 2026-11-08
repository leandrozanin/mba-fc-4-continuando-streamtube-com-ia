---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    source: "docs.nestjs.com/techniques/queues + npm registry"
    fetched_at: "2026-10-20T12:40:00-03:00"
  bullmq:
    version: "^5.81.5"
    source: "docs.bullmq.io + npm registry"
    fetched_at: "2026-10-20T12:40:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1153.0"
    source: "docs.aws.amazon.com/AWSJavaScriptSDK/v3 + npm registry"
    fetched_at: "2026-10-20T12:40:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1153.0"
    source: "docs.aws.amazon.com/AWSJavaScriptSDK/v3 + npm registry"
    fetched_at: "2026-10-20T12:40:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-20T12:50:00-03:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this phase. Versions confirmed against the npm registry on 2026-10-20. **Note:** the context7 MCP server is not configured in this environment (`.mcp.json` only declares `postgres`); references were taken from the official documentation sites listed in the frontmatter. Re-check with context7 at implementation time, per `CLAUDE.md` → "Library Documentation Lookup", and flag any drift.

## @nestjs/bullmq + bullmq

**Version constraint:** `@nestjs/bullmq@11.0.5` declares peers `@nestjs/common ^10.0.0 || ^11.0.0`, `@nestjs/core ^10.0.0 || ^11.0.0`, `bullmq ^3 || ^4 || ^5 || ^6`. `@nestjs/bullmq@12.x` is for Nest 12 — do not install it. `bullmq` stays on the 5.x line (most recent 5.x: 5.81.5).

### Root connection (once, async, from config)

```typescript
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.redisHost, port: cfg.redisPort },
    defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
  }),
}),
```

`forRootAsync` with `inject` needs a **global** `ConfigModule` in test modules (`.claude/rules/nestjs-testing.md`).

### Queue registration and producer

```typescript
// module
imports: [BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })]

// producer
constructor(@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue<ProcessVideoJob>) {}
await this.queue.add(PROCESS_VIDEO_JOB, { videoId }, {
  jobId: videoId,                // idempotent: re-adding an existing id is a no-op
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
});
```

### Consumer (worker process only)

```typescript
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job<ProcessVideoJob>): Promise<void> { ... }   // throw => retry

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJob>, error: Error): Promise<void> {
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) { /* final failure → mark video failed */ }
  }
}
```

Key contracts:
- A processor class registered in a module that the **API** imports would also start consuming in the API process. Keep `VideoProcessingProcessor` only in `WorkerModule`; the API module registers the queue and produces only.
- `job.attemptsMade` is incremented before `failed` fires; the final failure is `attemptsMade >= opts.attempts`.
- Graceful shutdown: `app.enableShutdownHooks()` in the worker so `WorkerHost` closes the BullMQ worker on SIGTERM.

### Testing notes

- Integration tests use the Compose Redis (`REDIS_HOST=redis`); obliterate the test queue in `afterEach` (`queue.obliterate({ force: true })`).
- A test queue name per suite (`video-processing-test-<suite>`) avoids cross-suite interference while running `--runInBand`.

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

### Client for MinIO

```typescript
new S3Client({
  endpoint: cfg.endpoint,          // http://minio:9000 (internal) or public endpoint (signing client)
  region: cfg.region,              // any string for MinIO, e.g. us-east-1
  forcePathStyle: true,            // MinIO serves bucket in the path, not the subdomain
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
```

### Multipart upload with presigned parts

```typescript
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));
const url = await getSignedUrl(signer, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });
// client: PUT <url> with the part bytes → response header ETag
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: parts.map(p => ({ PartNumber: p.partNumber, ETag: p.etag })) },  // ascending order
}));
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

Limits (S3 and MinIO): parts 5 MiB–5 GiB except the last, max 10,000 parts, max object 5 TiB. Browsers can read the `ETag` response header only if the bucket CORS exposes it (`ExposeHeaders: ["ETag"]`) — relevant for the future frontend.

### Range read for streaming

```typescript
const out = await s3.send(new GetObjectCommand({ Bucket, Key, Range: 'bytes=0-1048575' }));
// out.Body: Readable (Node) — pipe to the response; out.ContentRange, out.ContentLength
```

### Presigned GET for download / FFmpeg input

```typescript
await getSignedUrl(signer, new GetObjectCommand({
  Bucket, Key, ResponseContentDisposition: `attachment; filename="${safeName}"`,
}), { expiresIn: 300 });
```

### Testing notes

- Integration tests talk to the Compose MinIO (`S3_ENDPOINT=http://minio:9000`) with the real bucket and clean `videos/test-*` keys in `afterEach`.
- `HeadObjectCommand` throws `NotFound` (name `'NotFound'`) for missing keys — map to a domain result, not a 500.
