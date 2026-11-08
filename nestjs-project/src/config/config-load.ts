import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import mailConfig from './mail.config';
import queueConfig from './queue.config';
import storageConfig from './storage.config';
import swaggerConfig from './swagger.config';
import videoConfig from './video.config';

// Namespaces loaded by both entrypoints (API and video worker)
export const configNamespaces = [
  appConfig,
  authConfig,
  databaseConfig,
  mailConfig,
  swaggerConfig,
  storageConfig,
  queueConfig,
  videoConfig,
];
