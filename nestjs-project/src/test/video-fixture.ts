import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface TestClipOptions {
  size?: string;
  /** Adds per-frame noise so the clip does not compress (bigger file). */
  noise?: boolean;
}

/**
 * Generates a real H.264 MP4 with ffmpeg's synthetic test source, so the
 * processing tests run against an actual video without committing binaries.
 */
export function generateTestClip(
  durationSeconds = 3,
  { size = '320x240', noise = false }: TestClipOptions = {},
): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'streamtube-clip-'));
  const output = join(dir, 'clip.mp4');
  try {
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${durationSeconds}:size=${size}:rate=25`,
      ...(noise ? ['-vf', 'noise=alls=100:allf=t'] : []),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      output,
    ]);
    return readFileSync(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
