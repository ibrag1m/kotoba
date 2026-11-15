// Резервная копия поверх базы: снимок для экспорта, учёт «копия сохранена», восстановление, постоянное хранилище.
// Любая запись в базу здесь выполняется ОДНОЙ транзакцией: при ошибке всё откатывается, данные остаются как были.
import {
  backupFileName,
  buildBackup,
  orphanReviewsExportWarning,
  parseBackup,
  planMerge,
  reviewsForInsert,
  sanitizeSettings,
  serializeBackup,
  splitOrphanReviews,
} from '../core/backup';
import type { BackupFile } from '../core/backup';
import { BACKUP_SNOOZE_MS } from '../core/backupReminder';
import { makeBackupFile, shareBackup } from '../core/backupShare';
import type { ShareNavigatorLike, ShareOutcome } from '../core/backupShare';
import { errorMessage } from '../core/errors';
import { requestPersist } from '../core/storageInfo';
import type { PersistResult, StorageManagerLike } from '../core/storageInfo';
import { DB_SCHEMA_VERSION } from './db';
import type { KotobaDB } from './db';
import { BACKED_UP_META_KEYS, META_BACKUP_SNOOZE_UNTIL, META_LAST_BACKUP_AT, META_PERSIST_RESULT } from './metaKeys';
import { bumpChanges, readChangeCounters, unsavedChanges, writeChangeCounters } from './repo';

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// ---------------------------------------------------------------------------------------------
// Состояние копий

export interface BackupState {
  /** Есть ли хотя бы одна колода. */
  hasData: boolean;
  lastBackupAt?: number;
  /** Сколько изменений ещё не вошло в сохранённую копию (changeSeq − backedUpSeq). */
  changesSinceBackup: number;
  snoozeUntil?: number;
  /** Самая ранняя дата создания колоды (точка отсчёта напоминания, пока копий не было). */
  oldestDataAt?: number;
}

/** Состояние для баннера и экрана настроек, одним согласованным чтением. */
export async function readBackupState(db: KotobaDB): Promise<BackupState> {
  return db.transaction('r', db.decks, db.meta, async () => {
    const decks = await db.decks.toArray();
    const [last, snooze] = await Promise.all([db.meta.get(META_LAST_BACKUP_AT), db.meta.get(META_BACKUP_SNOOZE_UNTIL)]);
    const counters = await readChangeCounters(db);
    const state: BackupState = {
      hasData: decks.length > 0,
      changesSinceBackup: unsavedChanges(counters),
    };
    const lastBackupAt = num(last?.value);
    if (lastBackupAt !== undefined) state.lastBackupAt = lastBackupAt;
    const snoozeUntil = num(snooze?.value);
    if (snoozeUntil !== undefined) state.snoozeUntil = snoozeUntil;
    if (decks.length > 0) state.oldestDataAt = Math.min(...decks.map((d) => d.createdAt));
    return state;
  });
}

/**
 * Номер изменения данных (монотонный). Экран «Сохранить копию» следит за ним: изменился номер, значит заранее
 * подготовленный снимок устарел.
 */
export async function readChangeSeq(db: KotobaDB): Promise<number> {
  return (await readChangeCounters(db)).seq;
}

/** Откладывает баннер напоминания на сутки. Служебная запись: номер изменения не растёт. */
export async function snoozeBackupReminder(db: KotobaDB, now = Date.now()): Promise<void> {
  await db.meta.put({ key: META_BACKUP_SNOOZE_UNTIL, value: now + BACKUP_SNOOZE_MS });
}

/** Есть ли что терять при замене данных. */
export async function hasUserData(db: KotobaDB): Promise<boolean> {
  return (await db.decks.count()) > 0 || (await db.cards.count()) > 0;
}

// ---------------------------------------------------------------------------------------------
// Экспорт

export interface BackupSnapshot {
  file: BackupFile;
  /** Готовый текст файла. */
  text: string;
  filename: string;
  exportedAt: number;
  /** Номер изменения В МОМЕНТ снимка (данные и номер читаются одной транзакцией). */
  seq: number;
  /** Предупреждения пользователю (например, сколько записей журнала не вошло в копию). */
  warnings: string[];
}

/** Самопроверка копии не прошла: понятная причина и первые подробности (что именно не прошло). */
export class BackupSnapshotError extends Error {
  readonly details: string[];
  constructor(message: string, details: string[]) {
    super(message);
    this.name = 'BackupSnapshotError';
    this.details = details;
  }
}

/** Сколько подробностей о провале самопроверки показываем. */
const SELF_CHECK_DETAILS = 3;

/**
 * Делает снимок базы для файла копии. Данные и номер изменения читаются одной транзакцией.
 *
 * «Сиротские» записи журнала (карточка или колода удалены) в файл НЕ попадают, об этом возвращается предупреждение:
 * одна неидеальная запись не должна лишать пользователя возможности сделать копию. Затем готовый текст проверяется
 * тем же разбором, которым потом читается импорт: если файл всё же нельзя будет восстановить (другая причина),
 * копия НЕ выдаётся, а ошибка называет причину и первые три подробности. Выдавать непроверенную копию «как есть» нельзя.
 */
export async function createBackupSnapshot(
  db: KotobaDB,
  appVersion: string,
  now = Date.now(),
): Promise<BackupSnapshot> {
  const { decks, cards, reviews, meta, counters } = await db.transaction(
    'r',
    db.decks,
    db.cards,
    db.reviews,
    db.meta,
    async () => ({
      decks: await db.decks.toArray(),
      cards: await db.cards.toArray(),
      reviews: await db.reviews.toArray(),
      meta: await db.meta.toArray(),
      counters: await readChangeCounters(db),
    }),
  );
  const warnings: string[] = [];
  const { kept, orphans } = splitOrphanReviews(decks, cards, reviews);
  if (orphans > 0) warnings.push(orphanReviewsExportWarning(orphans));

  const built = buildBackup({ decks, cards, reviews: kept, meta, now, appVersion, dbSchemaVersion: DB_SCHEMA_VERSION });

  const check = parseBackup(serializeBackup(built));
  if (!check.ok) {
    const reason = check.message.replace(/\.$/, '');
    throw new BackupSnapshotError(
      `Не удалось собрать надёжную копию: ${reason}. Данные не изменены.`,
      check.details.slice(0, SELF_CHECK_DETAILS),
    );
  }
  const lost: string[] = [];
  if (check.backup.decks.length !== built.decks.length) lost.push(`колод: в базе ${built.decks.length}, в файле ${check.backup.decks.length}`);
  if (check.backup.cards.length !== built.cards.length) lost.push(`карточек: в базе ${built.cards.length}, в файле ${check.backup.cards.length}`);
  if (check.backup.reviews.length !== built.reviews.length) {
    lost.push(`записей журнала: в базе ${built.reviews.length}, в файле ${check.backup.reviews.length}`);
  }
  if (lost.length > 0) {
    throw new BackupSnapshotError('Не удалось собрать надёжную копию: после записи в файл часть данных теряется. Данные не изменены.', lost.slice(0, SELF_CHECK_DETAILS));
  }
  warnings.push(...check.warnings);

  // В файл идёт уже проверенная нормализованная копия: порядок полей и состав одинаковы при каждом экспорте.
  const file = check.backup;
  return {
    file,
    text: serializeBackup(file),
    filename: backupFileName(now),
    exportedAt: now,
    seq: counters.seq,
    warnings,
  };
}

/**
 * Фиксирует, что копия реально сохранена: дата копии = момент снимка (но не позже «сейчас»), а номер сохранённого
 * изменения = max(прежний, номер снимка). Пересекающиеся снимки безопасны: подтверждение более раннего снимка
 * ничего не «возвращает». Изменения после снимка остаются несохранёнными. Отложенное напоминание снимается.
 * Всё в одной транзакции вместе с миграцией старого счётчика.
 */
export async function markBackupSaved(
  db: KotobaDB,
  snap: Pick<BackupSnapshot, 'exportedAt' | 'seq'>,
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', db.meta, async () => {
    const [last, counters] = await Promise.all([db.meta.get(META_LAST_BACKUP_AT), readChangeCounters(db)]);
    const prevLast = num(last?.value);
    const savedAt = Math.min(prevLast === undefined ? snap.exportedAt : Math.max(prevLast, snap.exportedAt), now);
    await db.meta.put({ key: META_LAST_BACKUP_AT, value: savedAt });
    // Снимок «из будущего» относительно текущего номера (база была очищена после снимка) ничего не отмечает.
    const backedUpSeq = snap.seq <= counters.seq ? Math.max(counters.backedUpSeq, snap.seq) : counters.backedUpSeq;
    await writeChangeCounters(db, { seq: counters.seq, backedUpSeq });
    await db.meta.delete(META_BACKUP_SNOOZE_UNTIL);
  });
}

/**
 * Отправляет снимок через меню «Поделиться» и записывает «копия сохранена» ТОЛЬКО если пользователь довёл
 * действие до конца. Отмена меню, ошибка и «нужно нажать ещё раз» дату копии и счётчик не трогают.
 *
 * ВАЖНО для iPhone: navigator.share вызывается СИНХРОННО в начале (до первого await), чтобы жест пользователя не
 * успел «протухнуть». Поэтому файл должен быть подготовлен заранее (`file`).
 */
export async function shareSnapshot(
  db: KotobaDB,
  nav: ShareNavigatorLike | undefined,
  snap: BackupSnapshot,
  file: File = makeBackupFile(snap.filename, snap.text),
  now?: number,
): Promise<ShareOutcome> {
  const outcome = await shareBackup(nav, file);
  if (outcome.kind === 'shared') await markBackupSaved(db, snap, now);
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Восстановление

export interface RestoreReport {
  mode: 'replace' | 'merge';
  decks: number;
  cards: number;
  reviews: number;
  /** Только для «добавить»: сколько колод и карточек получили новые идентификаторы из-за конфликта. */
  reidDecks: number;
  reidCards: number;
}

/**
 * «Заменить всё»: ВСЁ или ничего, одной транзакцией. Очищает колоды, карточки и журнал, записывает данные
 * из копии, заменяет настройки. Любой сбой откатывает транзакцию, текущие данные остаются нетронутыми.
 *
 * Номера записей журнала из файла НЕ переносятся: на них никто не ссылается, порядок задаёт ts, а огромный номер
 * навсегда сломал бы автоинкремент таблицы (clear() его не лечит). База назначает свои номера.
 * Настройки записываются только проверенные (sanitizeSettings), даже если BackupFile собран не разбором файла.
 *
 * После замены база совпадает с файлом: номер изменения растёт на 1 (замена сама есть изменение, снимки, сделанные
 * до неё, больше не годятся) и сразу объявляется сохранённым; дата последней копии = дата создания файла
 * (но не позже «сейчас», на случай неверных часов в файле).
 */
export async function restoreReplace(db: KotobaDB, backup: BackupFile, now = Date.now()): Promise<RestoreReport> {
  const reviews = reviewsForInsert(backup.reviews);
  const clean = sanitizeSettings(backup.meta).meta;
  const settings = BACKED_UP_META_KEYS.flatMap((key) => (clean[key] === undefined ? [] : [{ key, value: clean[key] }]));

  await db.transaction('rw', db.decks, db.cards, db.reviews, db.meta, async () => {
    const counters = await readChangeCounters(db);
    await db.reviews.clear();
    await db.cards.clear();
    await db.decks.clear();
    await db.decks.bulkAdd(backup.decks);
    await db.cards.bulkAdd(backup.cards);
    await db.reviews.bulkAdd(reviews);
    await db.meta.bulkDelete([...BACKED_UP_META_KEYS, META_BACKUP_SNOOZE_UNTIL]);
    await db.meta.bulkPut(settings);
    await db.meta.put({ key: META_LAST_BACKUP_AT, value: Math.min(backup.exportedAt, now) });
    await writeChangeCounters(db, { seq: counters.seq + 1, backedUpSeq: counters.seq + 1 });
  });
  return {
    mode: 'replace',
    decks: backup.decks.length,
    cards: backup.cards.length,
    reviews: reviews.length,
    reidDecks: 0,
    reidCards: 0,
  };
}

export interface MergePreview {
  /** Колод из файла, чей идентификатор уже занят в базе (они добавятся как копии). */
  conflictDecks: number;
  conflictCards: number;
  /**
   * Все колоды и карточки из файла уже есть в базе: файл, скорее всего, уже загружали, и «добавить» даст дубликаты.
   * (В файле без колод признак не ставится.)
   */
  alreadyLoaded: boolean;
}

/** Сколько записей из файла конфликтует по идентификаторам с текущей базой (для предпросмотра режима «добавить»). */
export async function describeMerge(db: KotobaDB, backup: BackupFile): Promise<MergePreview> {
  const [deckKeys, cardKeys] = await Promise.all([
    db.decks.toCollection().primaryKeys(),
    db.cards.toCollection().primaryKeys(),
  ]);
  const decks = new Set(deckKeys);
  const cards = new Set(cardKeys);
  const conflictDecks = backup.decks.filter((d) => decks.has(d.id)).length;
  const conflictCards = backup.cards.filter((c) => cards.has(c.id)).length;
  return {
    conflictDecks,
    conflictCards,
    alreadyLoaded: backup.decks.length > 0 && conflictDecks === backup.decks.length && conflictCards === backup.cards.length,
  };
}

/**
 * «Добавить к существующим»: чужие записи не перезаписываются; при конфликте идентификаторов запись из файла
 * получает новый id (см. planMerge). Настройки не меняются. Одна транзакция; номер изменения растёт на
 * число добавленных колод и карточек в ней же.
 */
export async function restoreMerge(
  db: KotobaDB,
  backup: BackupFile,
  newId?: () => string,
): Promise<RestoreReport> {
  return db.transaction('rw', db.decks, db.cards, db.reviews, db.meta, async () => {
    const [deckKeys, cardKeys] = await Promise.all([
      db.decks.toCollection().primaryKeys(),
      db.cards.toCollection().primaryKeys(),
    ]);
    const plan = planMerge(backup, { deckIds: new Set(deckKeys), cardIds: new Set(cardKeys) }, newId);
    await db.decks.bulkAdd(plan.decks);
    await db.cards.bulkAdd(plan.cards);
    await db.reviews.bulkAdd(plan.reviews);
    await bumpChanges(db, plan.decks.length + plan.cards.length);
    return {
      mode: 'merge' as const,
      decks: plan.decks.length,
      cards: plan.cards.length,
      reviews: plan.reviews.length,
      reidDecks: plan.reidDecks,
      reidCards: plan.reidCards,
    };
  });
}

/** Что делать с кнопкой «Заменить всё» в момент нажатия. */
export type ReplaceGate =
  /** Данных нет: заменять можно без вопросов. */
  | { kind: 'go'; hasData: false }
  /** Данные есть, копия текущих данных сохранена или пользователь явно отказался: можно, после подтверждения. */
  | { kind: 'confirm'; hasData: true }
  /** Данные есть, а копии нет и отказа нет (данные появились после предпросмотра): заменять нельзя. */
  | { kind: 'need-safety'; hasData: true };

/**
 * Решение перед заменой. hasUserData перечитывается из базы ПРЯМО СЕЙЧАС, а не берётся из предпросмотра: пока
 * пользователь читал сводку, данные могли появиться (другая вкладка, импорт), и тогда замена без копии недопустима.
 */
export async function checkReplaceGate(db: KotobaDB, opts: { safetyDone: boolean; skipSafety: boolean }): Promise<ReplaceGate> {
  const hasData = await hasUserData(db);
  if (!hasData) return { kind: 'go', hasData: false };
  if (opts.safetyDone || opts.skipSafety) return { kind: 'confirm', hasData: true };
  return { kind: 'need-safety', hasData: true };
}

// ---------------------------------------------------------------------------------------------
// Постоянное хранилище

export interface StoredPersist {
  result: PersistResult;
  at: number;
}

export async function readStoredPersist(db: KotobaDB): Promise<StoredPersist | undefined> {
  const v = (await db.meta.get(META_PERSIST_RESULT))?.value as Partial<StoredPersist> | undefined;
  if (v && (v.result === 'granted' || v.result === 'denied' || v.result === 'unavailable') && typeof v.at === 'number') {
    return { result: v.result, at: v.at };
  }
  return undefined;
}

/**
 * Просит постоянное хранилище и запоминает результат (служебная запись, номер изменения не трогает).
 * `onlyOnce`: не спрашивать, если ответ уже записан (для «первого сохранения данных»).
 * Не бросает: сбой не должен мешать работе приложения. Возвращает то, что браузер РЕАЛЬНО ответил: если запись ответа
 * в базу не удалась, ответ всё равно возвращается (он известен), а не подменяется «нет». «unknown»: запрос упал,
 * ответа нет (в базу не записывается, чтобы потом спросить снова).
 */
export async function ensurePersist(
  db: KotobaDB,
  storage: StorageManagerLike | undefined,
  opts: { onlyOnce?: boolean; now?: number } = {},
): Promise<PersistResult | undefined> {
  try {
    if (opts.onlyOnce && (await readStoredPersist(db)) !== undefined) return undefined;
  } catch (e) {
    console.error('Не удалось прочитать результат запроса постоянного хранилища', errorMessage(e));
  }
  const result = await requestPersist(storage);
  if (result === 'unknown') return result;
  try {
    await db.meta.put({ key: META_PERSIST_RESULT, value: { result, at: opts.now ?? Date.now() } satisfies StoredPersist });
  } catch (e) {
    console.error('Не удалось запомнить результат запроса постоянного хранилища', errorMessage(e));
  }
  return result;
}
