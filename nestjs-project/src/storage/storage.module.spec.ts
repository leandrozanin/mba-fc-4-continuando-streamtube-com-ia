import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_SIGNING_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  const original = {
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('should build the internal and signing clients from storage config', async () => {
    process.env.S3_ENDPOINT = 'http://internal:9000';
    process.env.S3_PUBLIC_ENDPOINT = 'http://public:9000';

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    const internal = module.get<S3Client>(S3_CLIENT);
    const signing = module.get<S3Client>(S3_SIGNING_CLIENT);
    const internalEndpoint = await internal.config.endpoint!();
    const signingEndpoint = await signing.config.endpoint!();

    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(internalEndpoint.hostname).toBe('internal');
    expect(signingEndpoint.hostname).toBe('public');
    expect(internal.config.forcePathStyle).toBe(true);
    await module.close();
  });
});
