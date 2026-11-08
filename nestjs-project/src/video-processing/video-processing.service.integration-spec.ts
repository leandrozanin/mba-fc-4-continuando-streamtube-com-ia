import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { thumbnailKey, videoObjectKey } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
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
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingError } from './video-processing.errors';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration)', () => {
  let module: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelId: string;
  let clip: Buffer;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    clip = generateTestClip(3);
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [FfmpegService, VideoProcessingService],
    }).compile();
    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `processing_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: `owner_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  afterEach(async () => {
    await Promise.all(createdKeys.map((key) => storage.deleteObject(key)));
    createdKeys.length = 0;
  });

  async function createProcessingVideo(
    body: Buffer,
    status = VideoStatus.PROCESSING,
  ): Promise<Video> {
    const id = randomUUID();
    const key = videoObjectKey(id);
    await storage.putObject(key, body, 'video/mp4');
    createdKeys.push(key, thumbnailKey(id));
    return videoRepository.save({
      id,
      channel_id: channelId,
      title: 'Clip',
      slug: generateSlug(),
      status,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: body.length,
      storage_key: key,
    });
  }

  it('turns a processing video into ready with duration, metadata and thumbnail', async () => {
    const video = await createProcessingVideo(clip);

    await service.process(video.id);

    const ready = await videoRepository.findOneByOrFail({ id: video.id });
    expect(ready.status).toBe(VideoStatus.READY);
    expect(ready.duration_seconds).toBeCloseTo(3, 0);
    expect(ready.metadata).toMatchObject({
      videoCodec: 'h264',
      width: 320,
      height: 240,
      fps: 25,
    });
    expect(ready.thumbnail_key).toBe(thumbnailKey(video.id));
    expect(ready.processed_at).toBeInstanceOf(Date);
    const thumbnail = await storage.headObject(thumbnailKey(video.id));
    expect(thumbnail).toMatchObject({ contentType: 'image/jpeg' });
    expect(thumbnail!.size).toBeGreaterThan(0);
  }, 30000);

  it('throws for a corrupt object and leaves the video in processing', async () => {
    const video = await createProcessingVideo(Buffer.from('not a video'));

    await expect(service.process(video.id)).rejects.toThrow(
      VideoProcessingError,
    );

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
  });

  it('skips a video that is not in processing (idempotent re-delivery)', async () => {
    const video = await createProcessingVideo(clip, VideoStatus.READY);

    await service.process(video.id);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.thumbnail_key).toBeNull();
  });

  it('markFailed moves processing to failed with the error message', async () => {
    const video = await createProcessingVideo(clip);

    await service.markFailed(video.id, 'ffprobe exited with code 1');

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.processing_error).toBe('ffprobe exited with code 1');
  });
});
