import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Video } from './videos/entities/video.entity';
import { WorkerModule } from './worker.module';

// Runs in its own Jest module registry, without AppModule: proves the worker
// process alone registers every entity reachable from Video
describe('WorkerModule (integration)', () => {
  it('should boot with the Video relations resolved', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await module.init();

    const dataSource = module.get(DataSource);
    const relations = dataSource
      .getMetadata(Video)
      .relations.map((r) => r.propertyName);

    expect(dataSource.isInitialized).toBe(true);
    expect(relations).toContain('channel');
    await module.close();
  }, 30000);
});
