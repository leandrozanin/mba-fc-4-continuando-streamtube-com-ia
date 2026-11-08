import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class VideoMetadataResponse {
  @ApiProperty({ nullable: true, example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  container: string | null;

  @ApiProperty({ nullable: true, example: 'h264' })
  videoCodec: string | null;

  @ApiProperty({ nullable: true, example: 'aac' })
  audioCodec: string | null;

  @ApiProperty({ nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ nullable: true, example: 4500000 })
  bitrate: number | null;

  @ApiProperty({ nullable: true, example: 29.97 })
  fps: number | null;
}

export class VideoChannelResponse {
  @ApiProperty({ example: 'johndoe' })
  nickname: string;

  @ApiProperty({ example: 'johndoe' })
  name: string;
}

export class VideoResponse {
  @ApiProperty({ example: 'aZ3kP9xQ2mB' })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ nullable: true, example: 63.48 })
  durationSeconds: number | null;

  @ApiProperty({ type: VideoMetadataResponse, nullable: true })
  metadata: VideoMetadataResponse | null;

  @ApiProperty({ example: 314572800 })
  sizeBytes: number;

  @ApiProperty({ type: VideoChannelResponse })
  channel: VideoChannelResponse;

  @ApiProperty({ example: '/videos/aZ3kP9xQ2mB/thumbnail' })
  thumbnailUrl: string;

  @ApiProperty({ example: '/videos/aZ3kP9xQ2mB/stream' })
  streamUrl: string;

  @ApiProperty({ example: '/videos/aZ3kP9xQ2mB/download' })
  downloadUrl: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  processedAt: Date | null;
}

export class VideoStatusResponse {
  @ApiProperty({ example: 'aZ3kP9xQ2mB' })
  slug: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ nullable: true })
  processingError: string | null;

  @ApiProperty({ nullable: true, example: 63.48 })
  durationSeconds: number | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
