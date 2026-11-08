import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configNamespaces } from './config/config-load';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import { buildTypeOrmOptions } from './database/typeorm-options';
import { UsersModule } from './users/users.module';
import { QueueRootModule } from './video-processing/queue-root.module';
import { VideoProcessingModule } from './video-processing/video-processing.module';

// Root module of the video worker process (src/worker.ts): no HTTP layer
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: configNamespaces,
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) =>
        buildTypeOrmOptions(dbConfig),
    }),
    QueueRootModule,
    // autoLoadEntities only sees entities registered by imported modules; Video
    // relates to Channel, which relates to User, so their modules come along
    UsersModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
