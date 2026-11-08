import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import {
  StorageUnavailableException,
  VideoUploadIncompleteException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_SIGNING_CLIENT } from './storage.constants';
import type {
  ByteRange,
  ObjectHead,
  ObjectRangeResult,
  PresignGetOptions,
  UploadedPart,
} from './storage.types';

// S3 errors meaning the client-provided parts do not assemble a valid object
const INVALID_PARTS_ERRORS = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
]);

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucket: string;

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(S3_SIGNING_CLIENT) private readonly signer: S3Client,
    @Inject(storageConfig.KEY) cfg: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = cfg.bucket;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const out = await this.call(() =>
      this.s3.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: contentType,
        }),
      ),
    );
    if (!out.UploadId) {
      throw new StorageUnavailableException();
    }
    return out.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<string> {
    return this.call(() =>
      getSignedUrl(
        this.signer,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: ttlSeconds },
      ),
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sorted.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.etag,
            })),
          },
        }),
      );
    } catch (err) {
      if (
        err instanceof S3ServiceException &&
        INVALID_PARTS_ERRORS.has(err.name)
      ) {
        throw new VideoUploadIncompleteException();
      }
      throw this.unavailable(err);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.call(() =>
      this.s3.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      ),
    );
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: Number(out.ContentLength ?? 0),
        contentType: out.ContentType,
      };
    } catch (err) {
      // A missing object is a valid domain result, not a storage failure
      if (err instanceof S3ServiceException && err.name === 'NotFound') {
        return null;
      }
      throw this.unavailable(err);
    }
  }

  async getObjectRange(
    key: string,
    range?: ByteRange,
  ): Promise<ObjectRangeResult> {
    const out = await this.call(() =>
      this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      ),
    );
    const contentLength = Number(out.ContentLength ?? 0);
    const totalSize = out.ContentRange
      ? Number(out.ContentRange.split('/')[1])
      : contentLength;
    return {
      stream: out.Body as Readable,
      contentLength,
      contentRange: out.ContentRange,
      totalSize,
    };
  }

  async presignGetObject(
    key: string,
    ttlSeconds: number,
    options: PresignGetOptions = {},
  ): Promise<string> {
    const client = options.internal ? this.s3 : this.signer;
    return this.call(() =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ResponseContentDisposition: options.downloadFilename
            ? `attachment; filename="${options.downloadFilename}"`
            : undefined,
        }),
        { expiresIn: ttlSeconds },
      ),
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.call(() =>
      this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      ),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.call(() =>
      this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })),
    );
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      throw this.unavailable(err);
    }
  }

  private unavailable(err: unknown): StorageUnavailableException {
    this.logger.error(`Storage operation failed: ${String(err)}`);
    return new StorageUnavailableException();
  }
}
