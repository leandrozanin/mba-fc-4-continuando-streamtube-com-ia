import { randomUUID } from 'node:crypto';
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
import { thumbnailKey, videoObjectKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { generateTestClip } from '../test/video-fixture';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { generateSlug } from '../videos/slug.util';
import { VideoStatus } from '../videos/video-status.enum';
import { QueueRootModule } from './queue-root.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingQueueService } from './video-processing-queue.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TIMEOUT_MS = 30000;

async function waitForStatus(
  repository: Repository<Video>,
  id: string,
  status: VideoStatus,
): Promise<Video> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const video = await repository.findOneByOrFail({ id });
    if (video.status === status) return video;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Video ${id} did not reach ${status}`);
}

describe('VideoProcessingProcessor (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingQueueService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let channelId: string;
  const originalBackoff = process.env.VIDEO_PROCESSING_BACKOFF_MS;

  beforeAll(async () => {
    // Fast retries so the 3-attempt failure path fits in the test
    process.env.VIDEO_PROCESSING_BACKOFF_MS = '100';
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
        VideoProcessingQueueModule,
        VideoProcessingModule,
      ],
    }).compile();
    // init() starts the BullMQ worker of the processor
    await module.init();
    producer = module.get(VideoProcessingQueueService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.obliterate({ force: true });
    await queue.resume();
  }, 30000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
    if (originalBackoff === undefined) {
      delete process.env.VIDEO_PROCESSING_BACKOFF_MS;
    } else {
      process.env.VIDEO_PROCESSING_BACKOFF_MS = originalBackoff;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `processor_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: `owner_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  async function createProcessingVideo(body: Buffer): Promise<Video> {
    const id = randomUUID();
    await storage.putObject(videoObjectKey(id), body, 'video/mp4');
    return videoRepository.save({
      id,
      channel_id: channelId,
      title: 'Clip',
      slug: generateSlug(),
      status: VideoStatus.PROCESSING,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: body.length,
      storage_key: videoObjectKey(id),
    });
  }

  async function cleanup(video: Video): Promise<void> {
    await storage.deleteObject(videoObjectKey(video.id));
    await storage.deleteObject(thumbnailKey(video.id));
  }

  it(
    'consumes an enqueued job and the video ends ready',
    async () => {
      const video = await createProcessingVideo(generateTestClip(2));

      await producer.enqueue(video.id);

      const ready = await waitForStatus(
        videoRepository,
        video.id,
        VideoStatus.READY,
      );
      expect(ready.duration_seconds).toBeCloseTo(2, 0);
      expect(ready.thumbnail_key).toBe(thumbnailKey(video.id));
      await cleanup(video);
    },
    TIMEOUT_MS + 5000,
  );

  it(
    'retries a corrupt video 3 times and then marks it failed',
    async () => {
      const video = await createProcessingVideo(Buffer.from('corrupt'));

      await producer.enqueue(video.id);

      const failed = await waitForStatus(
        videoRepository,
        video.id,
        VideoStatus.FAILED,
      );
      expect(failed.processing_error).toEqual(expect.any(String));
      const job = await queue.getJob(video.id);
      expect(job!.attemptsMade).toBe(3);
      expect(await job!.getState()).toBe('failed');
      await cleanup(video);
    },
    TIMEOUT_MS + 5000,
  );
});
