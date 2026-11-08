import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';
import type { ProcessVideoJob } from './video-processing.types';

function makeJob(attemptsMade: number, attempts = 3): Job<ProcessVideoJob> {
  return {
    data: { videoId: 'video-id' },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<ProcessVideoJob>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let service: { process: jest.Mock; markFailed: jest.Mock };

  beforeEach(async () => {
    service = {
      process: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: VideoProcessingService, useValue: service },
      ],
    }).compile();
    processor = module.get(VideoProcessingProcessor);
  });

  it('should process the video of the job', async () => {
    await processor.process(makeJob(0));

    expect(service.process).toHaveBeenCalledWith('video-id');
  });

  it('should propagate processing errors so BullMQ retries', async () => {
    service.process.mockRejectedValue(new Error('ffprobe failed'));

    await expect(processor.process(makeJob(0))).rejects.toThrow(
      'ffprobe failed',
    );
  });

  it.each([1, 2])(
    'should not mark the video failed after attempt %d of 3',
    async (attemptsMade) => {
      await processor.onFailed(makeJob(attemptsMade), new Error('boom'));

      expect(service.markFailed).not.toHaveBeenCalled();
    },
  );

  it('should mark the video failed after the last attempt', async () => {
    await processor.onFailed(makeJob(3), new Error('boom'));

    expect(service.markFailed).toHaveBeenCalledWith('video-id', 'boom');
  });

  it('should not throw when marking the video failed fails', async () => {
    service.markFailed.mockRejectedValue(new Error('db down'));

    await expect(
      processor.onFailed(makeJob(3), new Error('boom')),
    ).resolves.toBeUndefined();
  });
});
