import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generateSlug } from '../slug.util';
import { VideoStatus } from '../video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GB = 10737418240;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `video_entity_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: `owner_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
  });

  function buildVideo(overrides: Partial<Video> = {}): Partial<Video> {
    const id = randomUUID();
    return {
      id,
      channel_id: channel.id,
      title: 'My video',
      slug: generateSlug(),
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: `videos/${id}/original`,
      ...overrides,
    };
  }

  it('defaults status to draft', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('rejects two videos with the same slug', async () => {
    const slug = generateSlug();
    await videoRepository.save(buildVideo({ slug }));

    await expect(videoRepository.save(buildVideo({ slug }))).rejects.toThrow(
      QueryFailedError,
    );
  });

  it('is deleted with its channel (cascade)', async () => {
    const saved = await videoRepository.save(buildVideo());

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    expect(await videoRepository.findOneBy({ id: saved.id })).toBeNull();
  });

  it('rejects a video for an unknown channel', async () => {
    await expect(
      videoRepository.save(buildVideo({ channel_id: randomUUID() })),
    ).rejects.toThrow(QueryFailedError);
  });

  it('excludes upload_id from the default select', async () => {
    const saved = await videoRepository.save(
      buildVideo({ upload_id: 'upload-123' }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    const withUploadId = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      select: ['id', 'upload_id'],
    });

    expect(found.upload_id).toBeUndefined();
    expect(withUploadId.upload_id).toBe('upload-123');
  });

  it('round-trips metadata as jsonb and duration as a number', async () => {
    const metadata = {
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      videoCodec: 'h264',
      audioCodec: null,
      width: 320,
      height: 240,
      bitrate: 120000,
      fps: 25,
    };
    const saved = await videoRepository.save(
      buildVideo({ metadata, duration_seconds: 3.04 }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual(metadata);
    expect(found.duration_seconds).toBe(3.04);
  });

  it('stores a 10GB size_bytes beyond 2^31 exactly', async () => {
    const saved = await videoRepository.save(
      buildVideo({ size_bytes: TEN_GB }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(TEN_GB);
  });
});
