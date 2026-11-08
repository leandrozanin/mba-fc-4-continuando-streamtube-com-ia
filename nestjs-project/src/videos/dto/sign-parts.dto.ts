import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { MAX_UPLOAD_PARTS } from '../videos.constants';

export class SignPartsDto {
  /** Part numbers that need a fresh presigned URL (resume). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_UPLOAD_PARTS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
