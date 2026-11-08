import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingQueueService } from './video-processing-queue.service';

// Producer side only: the processor lives in VideoProcessingModule (worker)
@Module({
  imports: [BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })],
  providers: [VideoProcessingQueueService],
  exports: [VideoProcessingQueueService],
})
export class VideoProcessingQueueModule {}
