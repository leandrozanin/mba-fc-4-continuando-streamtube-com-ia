import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

// Consumer side: imported only by WorkerModule, so the API never consumes jobs
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
  ],
  providers: [FfmpegService, VideoProcessingService, VideoProcessingProcessor],
})
export class VideoProcessingModule {}
