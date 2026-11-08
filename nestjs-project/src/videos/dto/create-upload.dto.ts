import {
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  MAX_VIDEO_SIZE_BYTES,
  VIDEO_CONTENT_TYPE_PATTERN,
} from '../videos.constants';

export class CreateUploadDto {
  /** Video title shown on the video page. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  /** Original file name, used as the download file name. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  /** File size in bytes (up to 10GB). */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  size: number;

  /** MIME type of the file, e.g. video/mp4. */
  @IsString()
  @Matches(VIDEO_CONTENT_TYPE_PATTERN)
  contentType: string;
}
