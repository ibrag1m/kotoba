import { BACKUP_FORMAT_VERSION } from './core/backup';
import { DB_SCHEMA_VERSION } from './db/db';

/** Версия приложения; вне сборки Vite (например, в особых окружениях) честно «неизвестна». */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'неизвестна';
export { DB_SCHEMA_VERSION, BACKUP_FORMAT_VERSION };
