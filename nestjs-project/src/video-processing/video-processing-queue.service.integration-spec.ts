import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import videoConfig from '../config/video.config';
import { QueueRootModule } from './queue-root.module';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingQueueService } from './video-processing-queue.service';

describe('VideoProcessingQueueService (integration)', () => {
  let module: TestingModule;
  let service: VideoProcessingQueueService;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, videoConfig],
        }),
        QueueRootModule,
        VideoProcessingQueueModule,
      ],
    }).compile();
    service = module.get(VideoProcessingQueueService);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    // Keeps a running video-worker from consuming the jobs under assertion
    await queue.pause();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.resume();
    await module.close();
  });

  it('adds a process-video job keyed by the video id', async () => {
    const videoId = randomUUID();

    await service.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 10000 });
    expect(['waiting', 'paused']).toContain(await job!.getState());
  });

  it('keeps a single job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await service.enqueue(videoId);
    await service.enqueue(videoId);

    const counts = await queue.getJobCounts('waiting', 'paused');
    expect(counts.waiting + counts.paused).toBe(1);
  });
});
