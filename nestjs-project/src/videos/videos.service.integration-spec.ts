import { randomBytes, randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { QueueRootModule } from '../video-processing/queue-root.module';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing/video-processing.constants';
import { VideoProcessingQueueService } from '../video-processing/video-processing-queue.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MiB = 1024 * 1024;
const PART_SIZE = 5 * MiB;

async function putPart(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  expect(res.status).toBe(200);
  return res.headers.get('etag')!;
}

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let userId: string;
  const originalPartSize = process.env.VIDEO_UPLOAD_PART_SIZE_BYTES;

  beforeAll(async () => {
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = String(PART_SIZE);
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        QueueRootModule,
        VideosModule,
      ],
    }).compile();
    await module.init();

    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    // Keeps a running video-worker from consuming the jobs under assertion
    await queue.pause();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.resume();
    await module.close();
    if (originalPartSize === undefined) {
      delete process.env.VIDEO_UPLOAD_PART_SIZE_BYTES;
    } else {
      process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = originalPartSize;
    }
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: `owner_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
    userId = user.id;
  });

  async function startUpload(file: Buffer) {
    return service.startUpload(userId, {
      title: 'Integration video',
      filename: 'clip.mp4',
      size: file.length,
      contentType: 'video/mp4',
    });
  }

  async function uploadAllParts(
    file: Buffer,
    parts: { partNumber: number; url: string }[],
  ) {
    return Promise.all(
      parts.map(async ({ partNumber, url }) => ({
        partNumber,
        etag: await putPart(
          url,
          file.subarray((partNumber - 1) * PART_SIZE, partNumber * PART_SIZE),
        ),
      })),
    );
  }

  it('persists the draft with slug, storage key and upload id before any byte', async () => {
    const file = randomBytes(PART_SIZE + 1024);

    const session = await startUpload(file);

    const row = await videoRepository.findOneOrFail({
      where: { id: session.video.id },
      select: [
        'id',
        'slug',
        'status',
        'storage_key',
        'upload_id',
        'size_bytes',
      ],
    });
    expect(row).toMatchObject({
      slug: session.video.slug,
      status: VideoStatus.DRAFT,
      storage_key: `videos/${session.video.id}/original`,
      size_bytes: file.length,
    });
    expect(row.upload_id).toEqual(expect.any(String));
    expect(session.upload.parts).toHaveLength(2);
  });

  it('accepts the parts on the presigned URLs and completes into processing with a job', async () => {
    const file = randomBytes(PART_SIZE + 1024);
    const session = await startUpload(file);
    const parts = await uploadAllParts(file, session.upload.parts);

    const result = await service.completeUpload(
      userId,
      session.video.slug,
      parts,
    );

    expect(result.status).toBe(VideoStatus.PROCESSING);
    const row = await videoRepository.findOneOrFail({
      where: { id: session.video.id },
      select: ['id', 'status', 'upload_id'],
    });
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(row.upload_id).toBeNull();
    const stored = await storage.headObject(`videos/${row.id}/original`);
    expect(stored?.size).toBe(file.length);
    const job = await queue.getJob(session.video.id);
    expect(job?.data).toEqual({ videoId: session.video.id });
    await storage.deleteObject(`videos/${row.id}/original`);
  }, 30000);

  it('reverts to draft when the enqueue fails and completes on retry', async () => {
    const file = randomBytes(1024);
    const session = await startUpload(file);
    const parts = await uploadAllParts(file, session.upload.parts);
    const enqueue = jest
      .spyOn(module.get(VideoProcessingQueueService), 'enqueue')
      .mockRejectedValueOnce(new Error('redis down'));

    await expect(
      service.completeUpload(userId, session.video.slug, parts),
    ).rejects.toMatchObject({ errorCode: 'QUEUE_UNAVAILABLE' });
    expect(
      (await videoRepository.findOneByOrFail({ id: session.video.id })).status,
    ).toBe(VideoStatus.DRAFT);

    await service.completeUpload(userId, session.video.slug, parts);

    expect(
      (await videoRepository.findOneByOrFail({ id: session.video.id })).status,
    ).toBe(VideoStatus.PROCESSING);
    enqueue.mockRestore();
    await storage.deleteObject(`videos/${session.video.id}/original`);
  });

  it('abort removes the row and the multipart upload', async () => {
    const file = randomBytes(1024);
    const session = await startUpload(file);
    const parts = await uploadAllParts(file, session.upload.parts);

    await service.abortUpload(userId, session.video.slug);

    expect(
      await videoRepository.findOneBy({ id: session.video.id }),
    ).toBeNull();
    await expect(
      storage.completeMultipartUpload(
        `videos/${session.video.id}/original`,
        'aborted',
        parts,
      ),
    ).rejects.toThrow();
  });

  it('deletes the draft when the storage refuses the multipart upload', async () => {
    const spy = jest
      .spyOn(storage, 'createMultipartUpload')
      .mockRejectedValueOnce(new Error('storage down'));

    await expect(startUpload(randomBytes(10))).rejects.toThrow('storage down');

    expect(await videoRepository.count()).toBe(0);
    spy.mockRestore();
  });
});
