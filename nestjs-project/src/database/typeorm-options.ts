import type { ConfigType } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';

// Shared by the API (AppModule) and the video worker (WorkerModule)
export function buildTypeOrmOptions(
  dbConfig: ConfigType<typeof databaseConfig>,
): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  };
}
