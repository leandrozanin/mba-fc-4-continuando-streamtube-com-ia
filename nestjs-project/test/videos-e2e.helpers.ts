import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';

export const MiB = 1024 * 1024;
// Smallest part size S3 accepts; keeps e2e uploads small
export const E2E_PART_SIZE = 5 * MiB;

export async function createVideosApp(
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<INestApplication<App>> {
  process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = String(E2E_PART_SIZE);
  const moduleFixture = await configure(
    Test.createTestingModule({ imports: [AppModule] }),
  ).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return app;
}

export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  // mailService is private to AuthService; bracket access keeps the type
  const mailService = app.get(AuthService)['mailService'];
  let token = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_e: string, _n: string, t: string) => {
      token = t;
      return Promise.resolve();
    });
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token })
    .expect(204);
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  return bodyOf<{ access_token: string }>(res).access_token;
}

export async function putPart(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  if (res.status !== 200) {
    throw new Error(`Part upload failed with ${res.status}`);
  }
  return res.headers.get('etag')!;
}

export async function uploadParts(
  file: Buffer,
  parts: { partNumber: number; url: string }[],
): Promise<{ partNumber: number; etag: string }[]> {
  return Promise.all(
    parts.map(async ({ partNumber, url }) => ({
      partNumber,
      etag: await putPart(
        url,
        file.subarray(
          (partNumber - 1) * E2E_PART_SIZE,
          partNumber * E2E_PART_SIZE,
        ),
      ),
    })),
  );
}

export function bodyOf<T>(res: request.Response): T {
  return res.body as T;
}

// supertest buffers unknown content types as text; keep the raw bytes
export function binaryParser(
  res: request.Response,
  callback: (err: Error | null, body: Buffer) => void,
): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}
