import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  QueueUnavailableException,
  StorageUnavailableException,
  VideoForbiddenException,
  VideoNotFoundException,
  VideoTooLargeException,
  VideoUploadIncompleteException,
  VideoUploadNotInProgressException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingQueueService } from '../video-processing/video-processing-queue.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

const MiB = 1024 * 1024;
const PART_SIZE = 100 * MiB;
const TEN_GB = 10737418240;
const OWNER_ID = 'owner-id';

function makeUniqueSlugError(): QueryFailedError {
  return Object.assign(new QueryFailedError('INSERT', [], new Error()), {
    code: '23505',
    detail: 'Key (slug)=(abc) already exists.',
  });
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: 'video-id',
    channel_id: 'channel-id',
    title: 'Title',
    slug: 'aZ3kP9xQ2mB',
    status: VideoStatus.DRAFT,
    original_filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 250 * MiB,
    storage_key: 'videos/video-id/original',
    upload_id: 'upload-id',
    created_at: new Date(),
    updated_at: new Date(),
    channel: { user_id: OWNER_ID, nickname: 'owner', name: 'owner' },
    ...overrides,
  });
}

describe('VideosService', () => {
  let service: VideosService;
  let repository: Record<string, jest.Mock>;
  let queryBuilder: Record<string, jest.Mock>;
  let channelsService: { findByUserId: jest.Mock };
  let storage: Record<string, jest.Mock>;
  let queue: { enqueue: jest.Mock };

  beforeEach(async () => {
    queryBuilder = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };
    repository = {
      create: jest.fn((data: Partial<Video>) => makeVideo(data)),
      save: jest.fn((video: Video) => Promise.resolve(video)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => queryBuilder),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-id' }),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
      presignUploadPart: jest.fn(
        (_key: string, _id: string, n: number) => `https://s3/part-${n}`,
      ),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn(),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingQueueService, useValue: queue },
        {
          provide: videoConfig.KEY,
          useValue: {
            maxUploadBytes: TEN_GB,
            partSizeBytes: PART_SIZE,
            uploadUrlTtlSeconds: 3600,
            downloadUrlTtlSeconds: 300,
          },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  const uploadDto = (size: number) => ({
    title: 'My video',
    filename: 'clip.mp4',
    size,
    contentType: 'video/mp4',
  });

  describe('startUpload', () => {
    it.each([
      [200 * MiB, 2],
      [250 * MiB, 3],
      [1, 1],
      [TEN_GB, 103],
    ])(
      'should split %d bytes into %d presigned parts',
      async (size, expected) => {
        const result = await service.startUpload(OWNER_ID, uploadDto(size));

        expect(result.upload.partCount).toBe(expected);
        expect(result.upload.parts).toHaveLength(expected);
        expect(result.upload.parts[expected - 1]).toEqual({
          partNumber: expected,
          url: `https://s3/part-${expected}`,
        });
        expect(result.video.status).toBe(VideoStatus.DRAFT);
      },
    );

    it('should save the draft before opening the multipart upload', async () => {
      await service.startUpload(OWNER_ID, uploadDto(MiB));

      expect(repository.save.mock.invocationCallOrder[0]).toBeLessThan(
        storage.createMultipartUpload.mock.invocationCallOrder[0],
      );
      const [[criteria, changes]] = repository.update.mock.calls as [
        [{ id: string }, Partial<Video>],
      ];
      expect(typeof criteria.id).toBe('string');
      expect(changes).toEqual({ upload_id: 'upload-id' });
    });

    it('should retry with a new slug on a slug unique violation', async () => {
      repository.save
        .mockRejectedValueOnce(makeUniqueSlugError())
        .mockImplementationOnce((video: Video) => Promise.resolve(video));

      await service.startUpload(OWNER_ID, uploadDto(MiB));

      expect(repository.save).toHaveBeenCalledTimes(2);
      const calls = repository.create.mock.calls as [Partial<Video>][];
      const [first, second] = calls.map(([data]) => data.slug);
      expect(first).not.toBe(second);
    });

    it('should give up after 5 slug collisions', async () => {
      repository.save.mockRejectedValue(makeUniqueSlugError());

      await expect(
        service.startUpload(OWNER_ID, uploadDto(MiB)),
      ).rejects.toThrow(QueryFailedError);
      expect(repository.save).toHaveBeenCalledTimes(5);
    });

    it('should delete the draft when the storage fails (compensation)', async () => {
      storage.createMultipartUpload.mockRejectedValue(
        new StorageUnavailableException(),
      );

      await expect(
        service.startUpload(OWNER_ID, uploadDto(MiB)),
      ).rejects.toThrow(StorageUnavailableException);
      const savedId = (repository.save.mock.calls as [Video][])[0][0].id;
      expect(repository.delete).toHaveBeenCalledWith({ id: savedId });
    });

    it('should reject a user without channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.startUpload(OWNER_ID, uploadDto(MiB)),
      ).rejects.toThrow(ChannelNotFoundException);
    });

    it('should reject a size above the configured maximum', async () => {
      await expect(
        service.startUpload(OWNER_ID, uploadDto(TEN_GB + 1)),
      ).rejects.toThrow(VideoTooLargeException);
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('ownership and state guards', () => {
    it.each([
      ['signParts', (s: VideosService) => s.signParts('other', 'slug', [1])],
      [
        'completeUpload',
        (s: VideosService) => s.completeUpload('other', 'slug', []),
      ],
      ['abortUpload', (s: VideosService) => s.abortUpload('other', 'slug')],
      [
        'getStatusForOwner',
        (s: VideosService) => s.getStatusForOwner('other', 'slug'),
      ],
    ])(
      '%s should reject a user who does not own the video',
      async (_n, call) => {
        queryBuilder.getOne.mockResolvedValue(makeVideo());

        await expect(call(service)).rejects.toThrow(VideoForbiddenException);
      },
    );

    it.each([
      ['signParts', (s: VideosService) => s.signParts(OWNER_ID, 'slug', [1])],
      [
        'completeUpload',
        (s: VideosService) => s.completeUpload(OWNER_ID, 'slug', []),
      ],
      ['abortUpload', (s: VideosService) => s.abortUpload(OWNER_ID, 'slug')],
    ])('%s should reject a video that is not in draft', async (_n, call) => {
      queryBuilder.getOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(call(service)).rejects.toThrow(
        VideoUploadNotInProgressException,
      );
    });

    it('should report an unknown slug as not found', async () => {
      queryBuilder.getOne.mockResolvedValue(null);

      await expect(
        service.getStatusForOwner(OWNER_ID, 'missing'),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('signParts', () => {
    it('should sign exactly the requested parts', async () => {
      queryBuilder.getOne.mockResolvedValue(makeVideo());

      const result = await service.signParts(OWNER_ID, 'slug', [3, 1]);

      expect(result.parts.map((p) => p.partNumber)).toEqual([3, 1]);
    });

    it('should reject a part number beyond the part count', async () => {
      queryBuilder.getOne.mockResolvedValue(makeVideo());

      await expect(service.signParts(OWNER_ID, 'slug', [4])).rejects.toThrow(
        VideoUploadIncompleteException,
      );
    });
  });

  describe('completeUpload', () => {
    const allParts = [1, 2, 3].map((n) => ({ partNumber: n, etag: `e${n}` }));

    beforeEach(() => {
      queryBuilder.getOne.mockResolvedValue(makeVideo());
      storage.headObject.mockResolvedValue({ size: 250 * MiB });
    });

    it('should move the video to processing and enqueue it', async () => {
      const result = await service.completeUpload(OWNER_ID, 'slug', allParts);

      expect(result).toEqual({ slug: 'aZ3kP9xQ2mB', status: 'processing' });
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-id', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );
      expect(queue.enqueue).toHaveBeenCalledWith('video-id');
    });

    it('should reject a missing part without completing the upload', async () => {
      await expect(
        service.completeUpload(OWNER_ID, 'slug', allParts.slice(0, 2)),
      ).rejects.toThrow(VideoUploadIncompleteException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject a stored size different from the declared one and reopen the upload', async () => {
      storage.headObject.mockResolvedValue({ size: 10 });

      await expect(
        service.completeUpload(OWNER_ID, 'slug', allParts),
      ).rejects.toThrow(VideoUploadIncompleteException);
      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-id/original',
      );
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-id' },
        { upload_id: 'upload-id' },
      );
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('should revert to draft when enqueueing fails (compensation)', async () => {
      queue.enqueue.mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload(OWNER_ID, 'slug', allParts),
      ).rejects.toThrow(QueueUnavailableException);
      expect(repository.update).toHaveBeenLastCalledWith(
        { id: 'video-id', status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
    });

    it('should only retry the enqueue when the object was already assembled', async () => {
      queryBuilder.getOne.mockResolvedValue(makeVideo({ upload_id: null }));

      await service.completeUpload(OWNER_ID, 'slug', allParts);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.enqueue).toHaveBeenCalledWith('video-id');
    });

    it('should reject a concurrent completion that already moved the video', async () => {
      repository.update.mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.completeUpload(OWNER_ID, 'slug', allParts),
      ).rejects.toThrow(VideoUploadNotInProgressException);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('abortUpload', () => {
    it('should abort the multipart upload and delete the draft', async () => {
      queryBuilder.getOne.mockResolvedValue(makeVideo());

      await service.abortUpload(OWNER_ID, 'slug');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/original',
        'upload-id',
      );
      expect(repository.delete).toHaveBeenCalledWith({ id: 'video-id' });
    });
  });

  describe('public reads', () => {
    it('should hide videos that are not ready', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.findReadyBySlug('slug')).rejects.toThrow(
        VideoNotFoundException,
      );
      expect(repository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: 'slug', status: VideoStatus.READY },
        }),
      );
    });
  });
});
