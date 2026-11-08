import { registerAs } from '@nestjs/config';

export default registerAs('video', () => ({
  maxUploadBytes: parseInt(
    process.env.VIDEO_MAX_UPLOAD_BYTES || '10737418240',
    10,
  ),
  partSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || '104857600',
    10,
  ),
  uploadUrlTtlSeconds: parseInt(
    process.env.VIDEO_UPLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
  downloadUrlTtlSeconds: parseInt(
    process.env.VIDEO_DOWNLOAD_URL_TTL_SECONDS || '300',
    10,
  ),
  processingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
  processingBackoffMs: parseInt(
    process.env.VIDEO_PROCESSING_BACKOFF_MS || '10000',
    10,
  ),
  ffmpegTimeoutMs: parseInt(process.env.FFMPEG_TIMEOUT_MS || '120000', 10),
}));
