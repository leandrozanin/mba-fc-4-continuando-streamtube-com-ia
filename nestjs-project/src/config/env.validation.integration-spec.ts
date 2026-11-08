import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and video', () => {
  it.each(['S3_ACCESS_KEY', 'S3_SECRET_KEY'])(
    'should reject a missing %s',
    (key) => {
      const env: Record<string, string> = { ...requiredEnv };
      delete env[key];
      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply defaults for storage, queue and video settings', () => {
    const { value, error } = validate({}) as {
      value: Record<string, unknown>;
      error?: Error;
    };
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'streamtube-media',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      VIDEO_MAX_UPLOAD_BYTES: 10737418240,
      VIDEO_UPLOAD_PART_SIZE_BYTES: 104857600,
      VIDEO_UPLOAD_URL_TTL_SECONDS: 3600,
      VIDEO_DOWNLOAD_URL_TTL_SECONDS: 300,
      VIDEO_PROCESSING_ATTEMPTS: 3,
      FFMPEG_TIMEOUT_MS: 120000,
    });
  });

  it('should reject a part size below the S3 minimum of 5 MiB', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '1024' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });
});
