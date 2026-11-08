import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { thumbnailKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/video-status.enum';
import { THUMBNAIL_CONTENT_TYPE } from '../videos/videos.constants';
import type { VideoMetadata } from '../videos/videos.types';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingError } from './video-processing.errors';
import type { ProbeResult } from './video-processing.types';

// ffmpeg reads the original through this URL (range reads, no full download)
const INPUT_URL_TTL_SECONDS = 3600;
const THUMBNAIL_MAX_SECONDS = 1;
const THUMBNAIL_DURATION_RATIO = 0.1;

function toNumber(value: string | number | undefined): number | null {
  const n = Number(value);
  return value === undefined || !Number.isFinite(n) ? null : n;
}

function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (!den || !Number.isFinite(num)) return null;
  return Math.round((num / den) * 100) / 100;
}

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      // Re-delivered or stale job: nothing to do (idempotent consumer)
      this.logger.warn(`Skipping video ${videoId}: not in processing`);
      return;
    }

    const input = await this.storageService.presignGetObject(
      video.storage_key,
      INPUT_URL_TTL_SECONDS,
      { internal: true },
    );
    const probe = await this.ffmpegService.probe(input);
    const { durationSeconds, metadata } = this.readProbe(probe);

    const frameAt = Math.min(
      THUMBNAIL_MAX_SECONDS,
      durationSeconds * THUMBNAIL_DURATION_RATIO,
    );
    const jpeg = await this.ffmpegService.extractFrame(input, frameAt);
    const key = thumbnailKey(video.id);
    await this.storageService.putObject(key, jpeg, THUMBNAIL_CONTENT_TYPE);

    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: durationSeconds,
        metadata,
        thumbnail_key: key,
        processed_at: new Date(),
        processing_error: null,
      },
    );
    this.logger.log(`Video ${video.id} is ready (${durationSeconds}s)`);
  }

  async markFailed(videoId: string, message: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, processing_error: message },
    );
  }

  private readProbe(probe: ProbeResult): {
    durationSeconds: number;
    metadata: VideoMetadata;
  } {
    const streams = probe.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    if (!video) {
      throw new VideoProcessingError('The file has no video stream');
    }
    const durationSeconds = toNumber(probe.format?.duration);
    if (durationSeconds === null || durationSeconds <= 0) {
      throw new VideoProcessingError('Could not read the video duration');
    }
    const audio = streams.find((s) => s.codec_type === 'audio');

    return {
      durationSeconds: Math.round(durationSeconds * 1000) / 1000,
      metadata: {
        container: probe.format?.format_name ?? null,
        videoCodec: video.codec_name ?? null,
        audioCodec: audio?.codec_name ?? null,
        width: video.width ?? null,
        height: video.height ?? null,
        bitrate: toNumber(probe.format?.bit_rate),
        fps: parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate),
      },
    };
  }
}
