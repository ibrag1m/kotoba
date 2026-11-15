import { db } from './db/db';
import { ensurePersist } from './db/backupRepo';

/**
 * Запрашивает постоянное хранилище при первом сохранении данных (один раз: ответ запоминается).
 * Вызывается после успешного создания колоды или добавления карточек. Ничего не бросает.
 */
export function persistOnFirstSave(): void {
  void ensurePersist(db, typeof navigator === 'undefined' ? undefined : navigator.storage, { onlyOnce: true });
}
