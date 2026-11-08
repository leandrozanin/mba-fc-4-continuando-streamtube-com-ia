import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class PresignedPartResponse {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ description: 'Presigned PUT URL for this part' })
  url: string;
}

export class SignedPartsResponse {
  @ApiProperty({ format: 'date-time' })
  expiresAt: string;

  @ApiProperty({ type: [PresignedPartResponse] })
  parts: PresignedPartResponse[];
}

export class UploadDetailsResponse extends SignedPartsResponse {
  @ApiProperty({ example: 104857600 })
  partSize: number;

  @ApiProperty({ example: 3 })
  partCount: number;
}

export class DraftVideoResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aZ3kP9xQ2mB' })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 314572800 })
  sizeBytes: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

export class UploadSessionResponse {
  @ApiProperty({ type: DraftVideoResponse })
  video: DraftVideoResponse;

  @ApiProperty({ type: UploadDetailsResponse })
  upload: UploadDetailsResponse;
}

export class CompleteUploadResponse {
  @ApiProperty({ example: 'aZ3kP9xQ2mB' })
  slug: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;
}
