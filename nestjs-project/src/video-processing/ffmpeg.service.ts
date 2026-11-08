import { spawn } from 'node:child_process';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../config/video.config';
import { VideoProcessingError } from './video-processing.errors';
import type { ProbeResult } from './video-processing.types';

const STDERR_TAIL_LENGTH = 500;

@Injectable()
export class FfmpegService {
  constructor(
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async probe(input: string): Promise<ProbeResult> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      input,
    ]);
    try {
      return JSON.parse(stdout.toString('utf-8')) as ProbeResult;
    } catch {
      throw new VideoProcessingError('ffprobe returned invalid JSON');
    }
  }

  async extractFrame(input: string, atSeconds: number): Promise<Buffer> {
    const jpeg = await this.run('ffmpeg', [
      '-v',
      'error',
      // -ss before -i seeks on the input: only the bytes around the frame are read
      '-ss',
      atSeconds.toFixed(3),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    if (jpeg.length === 0) {
      throw new VideoProcessingError('ffmpeg produced no frame');
    }
    return jpeg;
  }

  private run(command: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.config.ffmpegTimeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf-8')).slice(-STDERR_TAIL_LENGTH);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new VideoProcessingError(`${command} failed: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new VideoProcessingError(
              `${command} timed out after ${this.config.ffmpegTimeoutMs}ms`,
            ),
          );
        } else if (code !== 0) {
          reject(
            new VideoProcessingError(
              `${command} exited with code ${code}: ${stderr.trim()}`,
            ),
          );
        } else {
          resolve(Buffer.concat(stdout));
        }
      });
    });
  }
}
