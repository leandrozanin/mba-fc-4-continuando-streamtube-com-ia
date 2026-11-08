import type { Readable } from 'node:stream';

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface ByteRange {
  start: number;
  end: number;
}

export interface ObjectHead {
  size: number;
  contentType?: string;
}

export interface ObjectRangeResult {
  stream: Readable;
  contentLength: number;
  contentRange?: string;
  totalSize: number;
}

export interface PresignGetOptions {
  downloadFilename?: string;
  internal?: boolean;
}
