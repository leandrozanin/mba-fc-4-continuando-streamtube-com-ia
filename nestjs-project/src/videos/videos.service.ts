import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  QueueUnavailableException,
  RangeNotSatisfiableException,
  VideoForbiddenException,
  VideoNotFoundException,
  VideoTooLargeException,
  VideoUploadIncompleteException,
  VideoUploadNotInProgressException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { videoObjectKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import type { UploadedPart } from '../storage/storage.types';
import { VideoProcessingQueueService } from '../video-processing/video-processing-queue.service';
import { CreateUploadDto } from './dto/create-upload.dto';
import {
  CompleteUploadResponse,
  PresignedPartResponse,
  SignedPartsResponse,
  UploadSessionResponse,
} from './dto/upload-session.response';
import { VideoResponse, VideoStatusResponse } from './dto/video.response';
import { Video } from './entities/video.entity';
import { parseRange } from './range.util';
import { generateSlug } from './slug.util';
import { VideoStatus } from './video-status.enum';
import {
  SLUG_MAX_ATTEMPTS,
  THUMBNAIL_URL_TTL_SECONDS,
} from './videos.constants';
import type { VideoStream } from './videos.types';

const PG_UNIQUE_VIOLATION = '23505';

function isSlugUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes('slug')
  );
}

// Keeps the Content-Disposition header valid: quotes, backslashes, control and
// non-ASCII characters are replaced
function sanitizeFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly queueService: VideoProcessingQueueService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async startUpload(
    userId: string,
    dto: CreateUploadDto,
  ): Promise<UploadSessionResponse> {
    if (dto.size > this.config.maxUploadBytes) {
      throw new VideoTooLargeException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.insertDraft(channel.id, dto);
    try {
      const uploadId = await this.storageService.createMultipartUpload(
        video.storage_key,
        video.content_type,
      );
      await this.videoRepository.update(
        { id: video.id },
        { upload_id: uploadId },
      );
      const partCount = this.partCount(video.size_bytes);
      const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
      const signed = await this.signUploadParts(video, uploadId, partNumbers);

      return {
        video: {
          id: video.id,
          slug: video.slug,
          title: video.title,
          status: video.status,
          sizeBytes: video.size_bytes,
          createdAt: video.created_at,
        },
        upload: {
          partSize: this.config.partSizeBytes,
          partCount,
          ...signed,
        },
      };
    } catch (err) {
      // Compensation: no draft may exist without an open upload
      await this.videoRepository.delete({ id: video.id });
      throw err;
    }
  }

  async signParts(
    userId: string,
    slug: string,
    partNumbers: number[],
  ): Promise<SignedPartsResponse> {
    const video = await this.findOwnedDraft(userId, slug);
    const partCount = this.partCount(video.size_bytes);
    if (!video.upload_id || partNumbers.some((n) => n > partCount)) {
      throw new VideoUploadIncompleteException();
    }
    return this.signUploadParts(video, video.upload_id, [
      ...new Set(partNumbers),
    ]);
  }

  async completeUpload(
    userId: string,
    slug: string,
    parts: UploadedPart[],
  ): Promise<CompleteUploadResponse> {
    const video = await this.findOwnedDraft(userId, slug);

    // upload_id is null when a previous completion assembled the object but
    // enqueueing failed: the object is already there, only the enqueue retries
    if (video.upload_id) {
      this.assertAllPartsPresent(video, parts);
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id,
        parts,
      );
    }

    const head = await this.storageService.headObject(video.storage_key);
    if (!head || head.size !== video.size_bytes) {
      await this.restartUpload(video);
      throw new VideoUploadIncompleteException();
    }

    const moved = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING, upload_id: null },
    );
    if (!moved.affected) {
      throw new VideoUploadNotInProgressException();
    }

    try {
      await this.queueService.enqueue(video.id);
    } catch (err) {
      this.logger.error(`Enqueue failed for video ${video.id}: ${String(err)}`);
      await this.videoRepository.update(
        { id: video.id, status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
      throw new QueueUnavailableException();
    }

    return { slug: video.slug, status: VideoStatus.PROCESSING };
  }

  async abortUpload(userId: string, slug: string): Promise<void> {
    const video = await this.findOwnedDraft(userId, slug);
    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id,
      );
    } else {
      await this.storageService.deleteObject(video.storage_key);
    }
    await this.videoRepository.delete({ id: video.id });
  }

  async findReadyBySlug(slug: string): Promise<VideoResponse> {
    const video = await this.findReady(slug);
    return {
      slug: video.slug,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      sizeBytes: video.size_bytes,
      channel: { nickname: video.channel.nickname, name: video.channel.name },
      thumbnailUrl: `/videos/${video.slug}/thumbnail`,
      streamUrl: `/videos/${video.slug}/stream`,
      downloadUrl: `/videos/${video.slug}/download`,
      createdAt: video.created_at,
      processedAt: video.processed_at,
    };
  }

  async getStatusForOwner(
    userId: string,
    slug: string,
  ): Promise<VideoStatusResponse> {
    const video = await this.findOwned(userId, slug);
    return {
      slug: video.slug,
      status: video.status,
      processingError: video.processing_error,
      durationSeconds: video.duration_seconds,
      updatedAt: video.updated_at,
    };
  }

  async openStream(
    slug: string,
    rangeHeader: string | undefined,
  ): Promise<VideoStream> {
    const video = await this.findReady(slug);
    const head = await this.storageService.headObject(video.storage_key);
    if (!head) {
      throw new VideoNotFoundException();
    }

    const range = parseRange(rangeHeader, head.size);
    if (range === 'unsatisfiable') {
      throw new RangeNotSatisfiableException(head.size);
    }
    const object = await this.storageService.getObjectRange(
      video.storage_key,
      range ?? undefined,
    );
    return {
      stream: object.stream,
      partial: range !== null,
      start: range?.start ?? 0,
      end: range?.end ?? head.size - 1,
      totalSize: head.size,
      contentLength: object.contentLength,
      contentType: video.content_type,
    };
  }

  async getDownloadUrl(slug: string): Promise<string> {
    const video = await this.findReady(slug);
    return this.storageService.presignGetObject(
      video.storage_key,
      this.config.downloadUrlTtlSeconds,
      { downloadFilename: sanitizeFilename(video.original_filename) },
    );
  }

  async getThumbnailUrl(slug: string): Promise<string> {
    const video = await this.findReady(slug);
    if (!video.thumbnail_key) {
      throw new VideoNotFoundException();
    }
    return this.storageService.presignGetObject(
      video.thumbnail_key,
      THUMBNAIL_URL_TTL_SECONDS,
    );
  }

  private async insertDraft(
    channelId: string,
    dto: CreateUploadDto,
  ): Promise<Video> {
    const id = randomUUID();
    for (let attempt = 1; ; attempt++) {
      const video = this.videoRepository.create({
        id,
        channel_id: channelId,
        title: dto.title,
        slug: generateSlug(),
        status: VideoStatus.DRAFT,
        original_filename: dto.filename,
        content_type: dto.contentType,
        size_bytes: dto.size,
        storage_key: videoObjectKey(id),
      });
      try {
        return await this.videoRepository.save(video);
      } catch (err) {
        if (!isSlugUniqueViolation(err) || attempt >= SLUG_MAX_ATTEMPTS) {
          throw err;
        }
      }
    }
  }

  private partCount(sizeBytes: number): number {
    return Math.ceil(sizeBytes / this.config.partSizeBytes);
  }

  private async signUploadParts(
    video: Video,
    uploadId: string,
    partNumbers: number[],
  ): Promise<SignedPartsResponse> {
    const ttl = this.config.uploadUrlTtlSeconds;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const parts: PresignedPartResponse[] = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          uploadId,
          partNumber,
          ttl,
        ),
      })),
    );
    return { expiresAt, parts };
  }

  // S3 accepts completing with a subset of the parts, which would silently
  // produce a truncated object; every part 1..partCount must be listed
  private assertAllPartsPresent(video: Video, parts: UploadedPart[]): void {
    const partCount = this.partCount(video.size_bytes);
    const numbers = new Set(parts.map((p) => p.partNumber));
    const complete =
      numbers.size === partCount &&
      parts.length === partCount &&
      parts.every((p) => p.partNumber <= partCount);
    if (!complete) {
      throw new VideoUploadIncompleteException();
    }
  }

  // The assembled object does not match the declared size: discard it and open
  // a new multipart upload so the client can re-sign and re-send the parts
  private async restartUpload(video: Video): Promise<void> {
    await this.storageService.deleteObject(video.storage_key);
    const uploadId = await this.storageService.createMultipartUpload(
      video.storage_key,
      video.content_type,
    );
    await this.videoRepository.update(
      { id: video.id },
      { upload_id: uploadId },
    );
  }

  private async findOwned(userId: string, slug: string): Promise<Video> {
    const video = await this.videoRepository
      .createQueryBuilder('video')
      .innerJoinAndSelect('video.channel', 'channel')
      .addSelect('video.upload_id')
      .where('video.slug = :slug', { slug })
      .getOne();
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new VideoForbiddenException();
    }
    return video;
  }

  private async findOwnedDraft(userId: string, slug: string): Promise<Video> {
    const video = await this.findOwned(userId, slug);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoUploadNotInProgressException();
    }
    return video;
  }

  private async findReady(slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug, status: VideoStatus.READY },
      relations: { channel: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }
}
