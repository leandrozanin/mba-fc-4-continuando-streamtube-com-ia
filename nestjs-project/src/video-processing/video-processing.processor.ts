import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingService } from './video-processing.service';
import type { ProcessVideoJob } from './video-processing.types';

@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(private readonly processingService: VideoProcessingService) {
    super();
  }

  // Errors propagate so BullMQ retries the job with backoff
  async process(job: Job<ProcessVideoJob>): Promise<void> {
    await this.processingService.process(job.data.videoId);
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJob> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    this.logger.warn(
      `Video ${job.data.videoId} attempt ${job.attemptsMade}/${attempts} failed: ${error.message}`,
    );
    if (job.attemptsMade < attempts) return;

    // Background handler: log instead of rethrowing, which would crash the worker
    try {
      await this.processingService.markFailed(job.data.videoId, error.message);
    } catch (err) {
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed: ${String(err)}`,
      );
    }
  }
}
