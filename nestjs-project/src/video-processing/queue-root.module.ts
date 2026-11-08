import { BullModule } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

// Root BullMQ connection, shared by the API and the worker entrypoints
export const QueueRootModule = BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.redisHost, port: cfg.redisPort },
  }),
});
