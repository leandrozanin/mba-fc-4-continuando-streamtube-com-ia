import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import videoConfig from '../config/video.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import type { ProcessVideoJob } from './video-processing.types';

@Injectable()
export class VideoProcessingQueueService {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJob>,
    @Inject(videoConfig.KEY)
    private readonly video: ConfigType<typeof videoConfig>,
  ) {}

  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      {
        // Same id twice is a no-op in BullMQ: re-delivery stays idempotent
        jobId: videoId,
        attempts: this.video.processingAttempts,
        backoff: { type: 'exponential', delay: this.video.processingBackoffMs },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}
