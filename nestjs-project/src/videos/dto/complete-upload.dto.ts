import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_UPLOAD_PARTS } from '../videos.constants';

export class UploadedPartDto {
  /** Part number, starting at 1. */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** ETag returned by the storage for the uploaded part. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Every uploaded part with its ETag. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_UPLOAD_PARTS)
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
