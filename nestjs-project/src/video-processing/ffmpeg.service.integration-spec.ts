import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../config/video.config';
import { generateTestClip } from '../test/video-fixture';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingError } from './video-processing.errors';

type VideoConfig = ConfigType<typeof videoConfig>;

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('FfmpegService (integration)', () => {
  let service: FfmpegService;
  let dir: string;
  let clipPath: string;

  beforeAll(() => {
    service = new FfmpegService({ ffmpegTimeoutMs: 30000 } as VideoConfig);
    dir = mkdtempSync(join(tmpdir(), 'ffmpeg-spec-'));
    clipPath = join(dir, 'clip.mp4');
    writeFileSync(clipPath, generateTestClip(3));
  }, 30000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('probes duration, resolution and codec of a real clip', async () => {
    const probe = await service.probe(clipPath);

    const video = probe.streams!.find((s) => s.codec_type === 'video')!;
    expect(Number(probe.format!.duration)).toBeCloseTo(3, 0);
    expect(video.codec_name).toBe('h264');
    expect(video.width).toBe(320);
    expect(video.height).toBe(240);
  });

  it('extracts a JPEG frame', async () => {
    const jpeg = await service.extractFrame(clipPath, 1);

    expect(jpeg.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
  });

  it('raises VideoProcessingError for an invalid input', async () => {
    const corrupt = join(dir, 'corrupt.mp4');
    writeFileSync(corrupt, Buffer.from('this is not a video'));

    await expect(service.probe(corrupt)).rejects.toThrow(VideoProcessingError);
  });

  it('kills the process when it exceeds the timeout', async () => {
    const slow = new FfmpegService({ ffmpegTimeoutMs: 1 } as VideoConfig);

    await expect(slow.probe(clipPath)).rejects.toThrow(/timed out/);
  });
});
