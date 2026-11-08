import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MiB = 1024 * 1024;

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

async function putPart(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  expect(res.status).toBe(200);
  return res.headers.get('etag')!;
}

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  function testKey(): string {
    const key = `videos/test-${randomUUID()}/original`;
    createdKeys.push(key);
    return key;
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
  });

  afterEach(async () => {
    await Promise.all(createdKeys.map((key) => storage.deleteObject(key)));
    createdKeys.length = 0;
  });

  afterAll(async () => {
    await module.close();
  });

  it('assembles an object uploaded in two presigned parts', async () => {
    const key = testKey();
    const part1 = randomBytes(5 * MiB);
    const part2 = randomBytes(1024);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const etag1 = await putPart(
      await storage.presignUploadPart(key, uploadId, 1, 60),
      part1,
    );
    const etag2 = await putPart(
      await storage.presignUploadPart(key, uploadId, 2, 60),
      part2,
    );
    // Parts given out of order: the service sorts them before completing
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: etag2 },
      { partNumber: 1, etag: etag1 },
    ]);

    const head = await storage.headObject(key);
    expect(head).toEqual({
      size: part1.length + part2.length,
      contentType: 'video/mp4',
    });
  }, 30000);

  it('rejects completion with an unknown ETag as an incomplete upload', async () => {
    const key = testKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await putPart(
      await storage.presignUploadPart(key, uploadId, 1, 60),
      randomBytes(1024),
    );

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toMatchObject({ errorCode: 'VIDEO_UPLOAD_INCOMPLETE' });

    await storage.abortMultipartUpload(key, uploadId);
  });

  it('abort discards the multipart upload', async () => {
    const key = testKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    await storage.abortMultipartUpload(key, uploadId);

    // The aborted upload id can no longer be completed into an object
    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"x"' },
      ]),
    ).rejects.toThrow();
    expect(await storage.headObject(key)).toBeNull();
  });

  it('returns null from headObject for a missing key', async () => {
    expect(
      await storage.headObject(`videos/missing-${randomUUID()}`),
    ).toBeNull();
  });

  it('reads an exact byte range with Content-Range', async () => {
    const key = testKey();
    const body = randomBytes(4096);
    await storage.putObject(key, body, 'video/mp4');

    const result = await storage.getObjectRange(key, { start: 0, end: 9 });
    const bytes = await streamToBuffer(result.stream);

    expect(bytes.equals(body.subarray(0, 10))).toBe(true);
    expect(result.contentLength).toBe(10);
    expect(result.contentRange).toBe(`bytes 0-9/${body.length}`);
    expect(result.totalSize).toBe(body.length);
  });

  it('reads the whole object when no range is given', async () => {
    const key = testKey();
    const body = randomBytes(2048);
    await storage.putObject(key, body, 'video/mp4');

    const result = await storage.getObjectRange(key);

    expect((await streamToBuffer(result.stream)).equals(body)).toBe(true);
    expect(result.totalSize).toBe(body.length);
  });

  it('presigns a GET that downloads the object as an attachment', async () => {
    const key = testKey();
    const body = randomBytes(1024);
    await storage.putObject(key, body, 'video/mp4');

    const url = await storage.presignGetObject(key, 60, {
      downloadFilename: 'clip.mp4',
    });
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="clip.mp4"',
    );
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
  });

  it('round-trips putObject and deleteObject', async () => {
    const key = testKey();
    await storage.putObject(key, Buffer.from('jpeg'), 'image/jpeg');
    expect(await storage.headObject(key)).toEqual({
      size: 4,
      contentType: 'image/jpeg',
    });

    await storage.deleteObject(key);

    expect(await storage.headObject(key)).toBeNull();
  });
});
