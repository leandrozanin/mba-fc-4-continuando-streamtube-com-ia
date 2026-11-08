import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../src/channels/entities/channel.entity';
import { thumbnailKey, videoObjectKey } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../src/video-processing/video-processing.constants';
import { Video } from '../src/videos/entities/video.entity';
import { generateSlug } from '../src/videos/slug.util';
import { VideoStatus } from '../src/videos/video-status.enum';
import { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import {
  SignedPartsResponse,
  UploadSessionResponse,
} from '../src/videos/dto/upload-session.response';
import { VideoResponse } from '../src/videos/dto/video.response';
import {
  binaryParser,
  bodyOf,
  createVideosApp,
  E2E_PART_SIZE,
  registerConfirmAndLogin,
  uploadParts,
} from './videos-e2e.helpers';

const TEN_GB = 10737418240;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let ownerEmail: string;
  let ownerToken: string;
  let otherToken: string;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    app = await createVideosApp();
    dataSource = app.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = app.get(StorageService);
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);
    // No worker runs in this suite's assertions: completed videos stay queued
    await queue.pause();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.resume();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    ownerEmail = `owner_${randomUUID().slice(0, 8)}@example.com`;
    ownerToken = await registerConfirmAndLogin(app, ownerEmail);
    otherToken = await registerConfirmAndLogin(
      app,
      `other_${randomUUID().slice(0, 8)}@example.com`,
    );
  });

  afterEach(async () => {
    await Promise.all(createdKeys.map((key) => storage.deleteObject(key)));
    createdKeys.length = 0;
  });

  const server = () => app.getHttpServer();

  function startUpload(
    token: string,
    body: Record<string, unknown> = {
      title: 'My video',
      filename: 'clip.mp4',
      size: E2E_PART_SIZE + 2048,
      contentType: 'video/mp4',
    },
  ) {
    return request(server())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function startAndUpload(file: Buffer) {
    const res = await startUpload(ownerToken, {
      title: 'My video',
      filename: 'clip.mp4',
      size: file.length,
      contentType: 'video/mp4',
    }).expect(201);
    createdKeys.push(
      videoObjectKey(bodyOf<UploadSessionResponse>(res).video.id),
    );
    const parts = await uploadParts(
      file,
      bodyOf<UploadSessionResponse>(res).upload.parts,
    );
    return {
      slug: bodyOf<UploadSessionResponse>(res).video.slug,
      id: bodyOf<UploadSessionResponse>(res).video.id,
      parts,
    };
  }

  async function createReadyVideo(body: Buffer): Promise<Video> {
    const channel = await dataSource
      .getRepository(Channel)
      .findOneOrFail({ where: { user: { email: ownerEmail } } });
    const id = randomUUID();
    await storage.putObject(videoObjectKey(id), body, 'video/mp4');
    await storage.putObject(thumbnailKey(id), JPEG, 'image/jpeg');
    createdKeys.push(videoObjectKey(id), thumbnailKey(id));
    return videoRepository.save({
      id,
      channel_id: channel.id,
      title: 'Ready video',
      slug: generateSlug(),
      status: VideoStatus.READY,
      original_filename: 'my "clip".mp4',
      content_type: 'video/mp4',
      size_bytes: body.length,
      storage_key: videoObjectKey(id),
      thumbnail_key: thumbnailKey(id),
      duration_seconds: 3,
      metadata: {
        container: 'mp4',
        videoCodec: 'h264',
        audioCodec: null,
        width: 320,
        height: 240,
        bitrate: 1000,
        fps: 25,
      },
      processed_at: new Date(),
    });
  }

  describe('POST /videos/uploads', () => {
    it('returns 201 with the draft video and one presigned URL per part', async () => {
      const res = await startUpload(ownerToken).expect(201);
      createdKeys.push(
        videoObjectKey(bodyOf<UploadSessionResponse>(res).video.id),
      );

      expect(bodyOf<UploadSessionResponse>(res).video).toMatchObject({
        status: 'draft',
        title: 'My video',
        sizeBytes: E2E_PART_SIZE + 2048,
      });
      expect(bodyOf<UploadSessionResponse>(res).video.slug).toMatch(
        /^[0-9A-Za-z]{11}$/,
      );
      expect(bodyOf<UploadSessionResponse>(res).upload).toMatchObject({
        partSize: E2E_PART_SIZE,
        partCount: 2,
      });
      expect(bodyOf<UploadSessionResponse>(res).upload.parts).toHaveLength(2);
      expect(bodyOf<UploadSessionResponse>(res).upload.parts[0].url).toMatch(
        /^http/,
      );
      const row = await videoRepository.findOneByOrFail({
        slug: bodyOf<UploadSessionResponse>(res).video.slug,
      });
      expect(row.status).toBe(VideoStatus.DRAFT);
    });

    it('accepts exactly 10GB', async () => {
      const res = await startUpload(ownerToken, {
        title: 'Big',
        filename: 'big.mp4',
        size: TEN_GB,
        contentType: 'video/mp4',
      }).expect(201);

      expect(bodyOf<UploadSessionResponse>(res).upload.partCount).toBe(
        Math.ceil(TEN_GB / E2E_PART_SIZE),
      );
      await request(server())
        .delete(
          `/videos/${bodyOf<UploadSessionResponse>(res).video.slug}/upload`,
        )
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(204);
    });

    it('returns 401 without a token', async () => {
      await request(server()).post('/videos/uploads').send({}).expect(401);
    });

    it.each([
      ['size above 10GB', { size: TEN_GB + 1 }],
      ['a non-video content type', { contentType: 'image/png' }],
      ['a missing title', { title: undefined }],
    ])('returns 400 for %s', async (_case, override) => {
      const res = await startUpload(ownerToken, {
        title: 'My video',
        filename: 'clip.mp4',
        size: 1024,
        contentType: 'video/mp4',
        ...override,
      }).expect(400);

      expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('VALIDATION_ERROR');
    });
  });

  describe('upload parts, complete and abort', () => {
    it('completes an upload sent through the presigned parts with 202', async () => {
      const file = randomBytes(E2E_PART_SIZE + 2048);
      const { slug, id, parts } = await startAndUpload(file);

      const res = await request(server())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts })
        .expect(202);

      expect(res.body).toEqual({ slug, status: 'processing' });
      expect((await queue.getJob(id))?.name).toBe('process-video');
    }, 30000);

    it('returns 409 on a second complete', async () => {
      const file = randomBytes(1024);
      const { slug, parts } = await startAndUpload(file);
      await request(server())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts })
        .expect(202);

      const res = await request(server())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts })
        .expect(409);

      expect(bodyOf<ApiErrorEnvelope>(res).error).toBe(
        'VIDEO_UPLOAD_NOT_IN_PROGRESS',
      );
    });

    it('returns 400 VIDEO_UPLOAD_INCOMPLETE for a missing part and keeps the draft', async () => {
      const file = randomBytes(E2E_PART_SIZE + 2048);
      const { slug, parts } = await startAndUpload(file);

      const res = await request(server())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts: parts.slice(0, 1) })
        .expect(400);

      expect(bodyOf<ApiErrorEnvelope>(res).error).toBe(
        'VIDEO_UPLOAD_INCOMPLETE',
      );
      expect((await videoRepository.findOneByOrFail({ slug })).status).toBe(
        VideoStatus.DRAFT,
      );
    }, 30000);

    it('returns 400 VIDEO_UPLOAD_INCOMPLETE for a wrong ETag', async () => {
      const { slug, parts } = await startAndUpload(randomBytes(1024));

      const res = await request(server())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts: [{ partNumber: parts[0].partNumber, etag: '"bad"' }] })
        .expect(400);

      expect(bodyOf<ApiErrorEnvelope>(res).error).toBe(
        'VIDEO_UPLOAD_INCOMPLETE',
      );
    });

    it.each([
      ['post', '/upload/parts', { partNumbers: [1] }],
      ['post', '/upload/complete', { parts: [{ partNumber: 1, etag: 'x' }] }],
      ['delete', '/upload', undefined],
    ] as const)(
      'returns 403 VIDEO_FORBIDDEN for another user on %s %s',
      async (method, path, body) => {
        const created = await startUpload(ownerToken).expect(201);
        createdKeys.push(
          videoObjectKey(bodyOf<UploadSessionResponse>(created).video.id),
        );

        const res = await request(server())
          [method](
            `/videos/${bodyOf<UploadSessionResponse>(created).video.slug}${path}`,
          )
          .set('Authorization', `Bearer ${otherToken}`)
          .send(body)
          .expect(403);

        expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('VIDEO_FORBIDDEN');
      },
    );

    it('re-signs exactly the requested parts (resume)', async () => {
      const created = await startUpload(ownerToken).expect(201);
      createdKeys.push(
        videoObjectKey(bodyOf<UploadSessionResponse>(created).video.id),
      );

      const res = await request(server())
        .post(
          `/videos/${bodyOf<UploadSessionResponse>(created).video.slug}/upload/parts`,
        )
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ partNumbers: [2] })
        .expect(200);

      expect(bodyOf<SignedPartsResponse>(res).parts).toHaveLength(1);
      expect(bodyOf<SignedPartsResponse>(res).parts[0].partNumber).toBe(2);
      expect(bodyOf<SignedPartsResponse>(res).parts[0].url).toContain(
        'partNumber=2',
      );
      expect(bodyOf<SignedPartsResponse>(res).expiresAt).toEqual(
        expect.any(String),
      );
    });

    it('aborts with 204 and the video is gone afterwards', async () => {
      const created = await startUpload(ownerToken).expect(201);
      const slug = bodyOf<UploadSessionResponse>(created).video.slug;

      await request(server())
        .delete(`/videos/${slug}/upload`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(204);

      const res = await request(server())
        .get(`/videos/${slug}/status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:slug and /status', () => {
    it('returns a ready video to anonymous users', async () => {
      const video = await createReadyVideo(randomBytes(4096));

      const res = await request(server())
        .get(`/videos/${video.slug}`)
        .expect(200);

      expect(res.body).toMatchObject({
        slug: video.slug,
        status: 'ready',
        durationSeconds: 3,
        sizeBytes: 4096,
        thumbnailUrl: `/videos/${video.slug}/thumbnail`,
        streamUrl: `/videos/${video.slug}/stream`,
        downloadUrl: `/videos/${video.slug}/download`,
      });
      expect(bodyOf<VideoResponse>(res).metadata?.videoCodec).toBe('h264');
      expect(bodyOf<VideoResponse>(res).channel.nickname).toEqual(
        expect.any(String),
      );
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'hides a %s video from anonymous users',
      async (status) => {
        const video = await createReadyVideo(randomBytes(16));
        await videoRepository.update({ id: video.id }, { status });

        const res = await request(server())
          .get(`/videos/${video.slug}`)
          .expect(404);
        expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('VIDEO_NOT_FOUND');
      },
    );

    it('returns the status of any state to the owner', async () => {
      const created = await startUpload(ownerToken).expect(201);
      createdKeys.push(
        videoObjectKey(bodyOf<UploadSessionResponse>(created).video.id),
      );

      const res = await request(server())
        .get(
          `/videos/${bodyOf<UploadSessionResponse>(created).video.slug}/status`,
        )
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect(res.body).toMatchObject({
        slug: bodyOf<UploadSessionResponse>(created).video.slug,
        status: 'draft',
        processingError: null,
      });
    });

    it('returns 403 to another user and 401 to anonymous on /status', async () => {
      const created = await startUpload(ownerToken).expect(201);
      createdKeys.push(
        videoObjectKey(bodyOf<UploadSessionResponse>(created).video.id),
      );
      const slug = bodyOf<UploadSessionResponse>(created).video.slug;

      await request(server())
        .get(`/videos/${slug}/status`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);
      await request(server()).get(`/videos/${slug}/status`).expect(401);
    });
  });

  describe('GET /videos/:slug/stream', () => {
    it('returns 206 with exactly the requested bytes', async () => {
      const body = randomBytes(64 * 1024);
      const video = await createReadyVideo(body);

      const res = await request(server())
        .get(`/videos/${video.slug}/stream`)
        .set('Range', 'bytes=0-1023')
        .buffer(true)
        .parse(binaryParser)
        .expect(206);

      expect(res.headers['content-range']).toBe(`bytes 0-1023/${body.length}`);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(Number(res.headers['content-length'])).toBe(1024);
      expect((res.body as Buffer).equals(body.subarray(0, 1024))).toBe(true);
    });

    it('seeks to a range in the middle of the file', async () => {
      const body = randomBytes(64 * 1024);
      const video = await createReadyVideo(body);

      const res = await request(server())
        .get(`/videos/${video.slug}/stream`)
        .set('Range', 'bytes=40000-40999')
        .buffer(true)
        .parse(binaryParser)
        .expect(206);

      expect((res.body as Buffer).equals(body.subarray(40000, 41000))).toBe(
        true,
      );
    });

    it('returns 200 with the full body without Range', async () => {
      const body = randomBytes(8 * 1024);
      const video = await createReadyVideo(body);

      const res = await request(server())
        .get(`/videos/${video.slug}/stream`)
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect((res.body as Buffer).equals(body)).toBe(true);
    });

    it('returns 416 with Content-Range for an unsatisfiable range', async () => {
      const body = randomBytes(1024);
      const video = await createReadyVideo(body);

      const res = await request(server())
        .get(`/videos/${video.slug}/stream`)
        .set('Range', 'bytes=99999999999-')
        .expect(416);

      expect(res.headers['content-range']).toBe(`bytes */${body.length}`);
      expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('RANGE_NOT_SATISFIABLE');
    });

    it('serves 15 consecutive range requests without throttling', async () => {
      const video = await createReadyVideo(randomBytes(32 * 1024));

      for (let i = 0; i < 15; i++) {
        await request(server())
          .get(`/videos/${video.slug}/stream`)
          .set('Range', `bytes=${i * 1024}-${i * 1024 + 1023}`)
          .buffer(true)
          .parse(binaryParser)
          .expect(206);
      }
    });

    it('returns 404 for a video that is not ready', async () => {
      const created = await startUpload(ownerToken).expect(201);
      createdKeys.push(
        videoObjectKey(bodyOf<UploadSessionResponse>(created).video.id),
      );

      await request(server())
        .get(
          `/videos/${bodyOf<UploadSessionResponse>(created).video.slug}/stream`,
        )
        .expect(404);
    });
  });

  describe('GET /videos/:slug/download and /thumbnail', () => {
    it('redirects to a presigned URL that downloads the file as an attachment', async () => {
      const body = randomBytes(4096);
      const video = await createReadyVideo(body);

      const res = await request(server())
        .get(`/videos/${video.slug}/download`)
        .expect(302);
      const file = await fetch(res.headers.location);

      expect(file.status).toBe(200);
      expect(file.headers.get('content-disposition')).toBe(
        'attachment; filename="my _clip_.mp4"',
      );
      expect(Buffer.from(await file.arrayBuffer()).equals(body)).toBe(true);
    });

    it('redirects to the JPEG thumbnail', async () => {
      const video = await createReadyVideo(randomBytes(16));

      const res = await request(server())
        .get(`/videos/${video.slug}/thumbnail`)
        .expect(302);
      const image = await fetch(res.headers.location);

      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/jpeg');
    });

    it.each(['download', 'thumbnail'])(
      'returns 404 on /%s for a video that is not ready',
      async (path) => {
        const video = await createReadyVideo(randomBytes(16));
        await videoRepository.update(
          { id: video.id },
          { status: VideoStatus.PROCESSING },
        );

        await request(server())
          .get(`/videos/${video.slug}/${path}`)
          .expect(404);
      },
    );
  });
});
