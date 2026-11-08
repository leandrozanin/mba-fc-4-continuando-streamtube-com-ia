import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_SIGNING_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

function buildClient(
  cfg: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client {
  return new S3Client({
    endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  });
}

@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        buildClient(cfg, cfg.endpoint),
    },
    {
      // Presigned URLs embed the host in the signature, so they are signed
      // against the endpoint the caller will reach (phase-03-videos/TD-08)
      provide: S3_SIGNING_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        buildClient(cfg, cfg.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
