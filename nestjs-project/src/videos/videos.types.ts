import type { Readable } from 'node:stream';

export interface VideoMetadata {
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  fps: number | null;
}

export interface VideoStream {
  stream: Readable;
  /** True when a Range was requested (206), false for the full body (200). */
  partial: boolean;
  start: number;
  end: number;
  totalSize: number;
  contentLength: number;
  contentType: string;
}
