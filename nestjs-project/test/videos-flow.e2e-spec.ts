import { randomUUID } from 'node:crypto';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { NestFactory } from '@nestjs/core';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { thumbnailKey, videoObjectKey } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { generateTestClip } from '../src/test/video-fixture';
import { VIDEO_PROCESSING_QUEUE } from '../src/video-processing/video-processing.constants';
import { WorkerModule } from '../src/worker.module';
import { UploadSessionResponse } from '../src/videos/dto/upload-session.response';
import {
  VideoResponse,
  VideoStatusResponse,
} from '../src/videos/dto/video.response';
import { VideoStatus } from '../src/videos/video-status.enum';
import {
  binaryParser,
  bodyOf,
  createVideosApp,
  registerConfirmAndLogin,
  uploadParts,
} from './videos-e2e.helpers';

const PROCESSING_TIMEOUT_MS = 60000;

describe('Videos flow: upload → processing → ready → stream → download (e2e)', () => {
  let app: INestApplication<App>;
  let worker: INestApplicationContext;
  let clip: Buffer;

  beforeAll(async () => {
    // Over 5 MiB so the upload really goes through 2 multipart parts
    clip = generateTestClip(2, { size: '640x480', noise: true });
    app = await createVideosApp();
    // The real worker entrypoint module, as run by the video-worker container
    worker = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    const queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.obliterate({ force: true });
    await queue.resume();
    await cleanAllTables(app.get(DataSource));
    app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
  }, 60000);

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  it(
    'uploads a real clip, processes it in the worker and serves it',
    async () => {
      const server = app.getHttpServer();
      const token = await registerConfirmAndLogin(
        app,
        `flow_${randomUUID().slice(0, 8)}@example.com`,
      );

      // 1. Start the upload: draft pre-registered with a unique slug
      const started = await request(server)
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Flow clip',
          filename: 'flow.mp4',
          size: clip.length,
          contentType: 'video/mp4',
        })
        .expect(201);
      const { slug, id } = bodyOf<UploadSessionResponse>(started).video;
      const { upload } = bodyOf<UploadSessionResponse>(started);
      expect(upload.partCount).toBe(2);

      // 2. Send the bytes straight to storage, then complete
      const parts = await uploadParts(clip, upload.parts);
      await request(server)
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(202);

      // 3. The worker processes it: poll the owner status until ready
      const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
      let status = VideoStatus.PROCESSING;
      while (status === VideoStatus.PROCESSING && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const res = await request(server)
          .get(`/videos/${slug}/status`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        status = bodyOf<VideoStatusResponse>(res).status;
      }
      expect(status).toBe(VideoStatus.READY);

      const res = await request(server).get(`/videos/${slug}`).expect(200);
      const video = bodyOf<VideoResponse>(res);
      expect(video.durationSeconds).toBeCloseTo(2, 0);
      expect(video.metadata).toMatchObject({
        videoCodec: 'h264',
        width: 640,
        height: 480,
      });

      // 4. Stream a range and download the original
      const range = await request(server)
        .get(video.streamUrl)
        .set('Range', 'bytes=0-1023')
        .buffer(true)
        .parse(binaryParser)
        .expect(206);
      expect((range.body as Buffer).equals(clip.subarray(0, 1024))).toBe(true);

      const download = await request(server).get(video.downloadUrl).expect(302);
      const file = await fetch(download.headers.location);
      expect(Buffer.from(await file.arrayBuffer()).equals(clip)).toBe(true);

      const thumbnail = await request(server)
        .get(video.thumbnailUrl)
        .expect(302);
      const image = await fetch(thumbnail.headers.location);
      expect(image.headers.get('content-type')).toBe('image/jpeg');

      const storage = app.get(StorageService);
      await storage.deleteObject(videoObjectKey(id));
      await storage.deleteObject(thumbnailKey(id));
    },
    PROCESSING_TIMEOUT_MS + 30000,
  );
});
