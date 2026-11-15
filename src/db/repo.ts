// Операции над данными. Все функции принимают базу первым параметром (в тестах — fake-indexeddb).
import Dexie from 'dexie';
import { newState } from '../core/srs';
import type { KotobaDB } from './db';
import {
  META_BACKED_UP_SEQ,
  META_CHANGES_SINCE_BACKUP,
  META_CHANGE_SEQ,
  isBackedUpMetaKey,
} from './metaKeys';
import type { Card, CardContent, Deck } from './types';

export interface NewDeckInput {
  name: string;
  description?: string;
  termLang?: string;
  defLang?: string;
}

export interface DeckSummary extends Deck {
  cardCount: number;
}

export const DEFAULT_TERM_LANG = 'ja-JP';
export const DEFAULT_DEF_LANG = 'ru-RU';

const newId = () => crypto.randomUUID();

/** Пустая строка (или одни пробелы) вместо языка означает «по умолчанию»: пустой язык не прошёл бы проверку копии. */
export function langOrDefault(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return v ? v : fallback;
}

/** Число из meta: только безопасное неотрицательное целое, иначе 0 (повреждённое значение не ломает счёт). */
export function toChangeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Счётчики изменений. `seq` растёт на каждое изменение и никогда не уменьшается; `backedUpSeq` — наибольший
 * номер, вошедший в подтверждённую копию. Несохранённых изменений: seq − backedUpSeq. Это устойчиво к
 * пересекающимся снимкам: подтверждение более раннего снимка не может «вернуть» уже сохранённое.
 */
export interface ChangeCounters {
  seq: number;
  backedUpSeq: number;
}

/** Несохранённых изменений (никогда не меньше нуля). */
export function unsavedChanges(c: ChangeCounters): number {
  return Math.max(0, c.seq - c.backedUpSeq);
}

/**
 * Читает счётчики (в любой транзакции или без неё). Миграция без поднятия версии схемы Dexie: если новых ключей
 * ещё нет, а есть старый «changesSinceBackup» = n, то n изменений не сохранено: seq = n, backedUpSeq = 0.
 * Значение backedUpSeq не может быть больше seq (повреждение): оно приводится к seq.
 */
export async function readChangeCounters(db: KotobaDB): Promise<ChangeCounters> {
  const [seqRec, backedRec, legacyRec] = await db.meta.bulkGet([META_CHANGE_SEQ, META_BACKED_UP_SEQ, META_CHANGES_SINCE_BACKUP]);
  const seq = seqRec !== undefined ? toChangeCount(seqRec.value) : toChangeCount(legacyRec?.value);
  const backedUpSeq = seqRec !== undefined ? toChangeCount(backedRec?.value) : 0;
  return { seq, backedUpSeq: Math.min(backedUpSeq, seq) };
}

/** Записывает счётчики и убирает старый ключ (только внутри транзакции rw с таблицей meta). */
export async function writeChangeCounters(db: KotobaDB, c: ChangeCounters): Promise<void> {
  await db.meta.put({ key: META_CHANGE_SEQ, value: c.seq });
  await db.meta.put({ key: META_BACKED_UP_SEQ, value: Math.min(c.backedUpSeq, c.seq) });
  await db.meta.delete(META_CHANGES_SINCE_BACKUP);
}

/**
 * Увеличивает номер изменения на n (n изменений: счётчик растёт на n, так что «число несохранённых» остаётся
 * понятным человеку).
 *
 * ОБЯЗАТЕЛЬНО вызывается ВНУТРИ той же транзакции (rw, с таблицей meta), что и сама правка данных:
 * тогда счётчик и данные меняются вместе или откатываются вместе. Любая новая функция записи
 * (в том числе ответы в «Заучивании»: запись в reviews и обновление карточки) обязана вызывать её
 * в своей транзакции. Вне подходящей транзакции функция бросает ошибку, чтобы забытое место
 * находилось сразу, а не превращалось в тихо неверный счётчик.
 */
export async function bumpChanges(db: KotobaDB, n = 1): Promise<void> {
  if (!Number.isFinite(n) || n <= 0) return;
  const tx = Dexie.currentTransaction as { db?: unknown; mode?: string; storeNames?: string[] } | null;
  if (!tx || tx.db !== db || tx.mode !== 'readwrite' || !tx.storeNames?.includes(db.meta.name)) {
    throw new Error('bumpChanges нужно вызывать внутри транзакции rw, в которую входит таблица meta');
  }
  const c = await readChangeCounters(db);
  await writeChangeCounters(db, { seq: c.seq + Math.floor(n), backedUpSeq: c.backedUpSeq });
}

export async function createDeck(db: KotobaDB, input: NewDeckInput, now = Date.now()): Promise<Deck> {
  const name = input.name.trim();
  if (name === '') throw new Error('Название колоды не может быть пустым');
  const deck: Deck = {
    id: newId(),
    name,
    termLang: langOrDefault(input.termLang, DEFAULT_TERM_LANG),
    defLang: langOrDefault(input.defLang, DEFAULT_DEF_LANG),
    createdAt: now,
    updatedAt: now,
  };
  const description = input.description?.trim();
  if (description) deck.description = description;
  await db.transaction('rw', db.decks, db.meta, async () => {
    await db.decks.add(deck);
    await bumpChanges(db);
  });
  return deck;
}

export function getDeck(db: KotobaDB, id: string): Promise<Deck | undefined> {
  return db.decks.get(id);
}

/** Колоды, недавно изменённые — первыми, с числом карточек. */
export async function listDeckSummaries(db: KotobaDB): Promise<DeckSummary[]> {
  const decks = await db.decks.orderBy('updatedAt').reverse().toArray();
  return Promise.all(
    decks.map(async (d) => ({ ...d, cardCount: await db.cards.where('deckId').equals(d.id).count() })),
  );
}

/**
 * Добавляет карточки в конец колоды одной транзакцией.
 * Пустые term/definition отбрасываются. Возвращает созданные карточки.
 */
export async function addCards(
  db: KotobaDB,
  deckId: string,
  items: readonly CardContent[],
  now = Date.now(),
): Promise<Card[]> {
  return db.transaction('rw', db.decks, db.cards, db.meta, async () => {
    const deck = await db.decks.get(deckId);
    if (!deck) throw new Error('Колода не найдена');
    const last = await db.cards.where('[deckId+position]').between([deckId, -Infinity], [deckId, Infinity]).last();
    let position = last ? last.position + 1 : 0;
    const created: Card[] = [];
    for (const item of items) {
      const term = item.term.trim();
      const definition = item.definition.trim();
      if (term === '' || definition === '') continue;
      const card: Card = {
        id: newId(),
        deckId,
        term,
        definition,
        position: position++,
        createdAt: now,
        updatedAt: now,
        ...newState(now),
      };
      const reading = item.reading?.trim();
      if (reading) card.reading = reading;
      const example = item.example?.trim();
      if (example) card.example = example;
      created.push(card);
    }
    if (created.length > 0) {
      await db.cards.bulkAdd(created);
      await db.decks.update(deckId, { updatedAt: now });
      await bumpChanges(db, created.length);
    }
    return created;
  });
}

/** Карточки колоды в порядке добавления. */
export function listCards(db: KotobaDB, deckId: string): Promise<Card[]> {
  return db.cards.where('[deckId+position]').between([deckId, -Infinity], [deckId, Infinity]).toArray();
}

export function countCards(db: KotobaDB, deckId: string): Promise<number> {
  return db.cards.where('deckId').equals(deckId).count();
}

/**
 * Удаляет колоду вместе с карточками и журналом в одной транзакции (вместе со счётчиком изменений:
 * удаление считается одним изменением, а удаление несуществующей колоды ничего не меняет).
 *
 * Важно для резервной копии: журнал удаляется вместе с карточками. При проверке файла копии запись
 * журнала со ссылкой на несуществующую карточку считается повреждением. Если появится удаление
 * отдельных карточек, оно тоже обязано удалять их журнал (или проверку нужно смягчить).
 */
export async function deleteDeck(db: KotobaDB, deckId: string): Promise<void> {
  await db.transaction('rw', db.decks, db.cards, db.reviews, db.meta, async () => {
    const existed = (await db.decks.get(deckId)) !== undefined;
    await db.reviews.where('deckId').equals(deckId).delete();
    await db.cards.where('deckId').equals(deckId).delete();
    await db.decks.delete(deckId);
    if (existed) await bumpChanges(db);
  });
}

export async function getMeta<T = unknown>(db: KotobaDB, key: string): Promise<T | undefined> {
  const rec = await db.meta.get(key);
  return rec?.value as T | undefined;
}

/**
 * Записывает значение meta. Для настроек, входящих в резервную копию (BACKED_UP_META_KEYS),
 * изменение значения считается изменением данных: счётчик увеличивается в той же транзакции.
 * Служебные ключи устройства (lastBackupAt, persistResult и т.п.) счётчик не трогают.
 */
export async function setMeta(db: KotobaDB, key: string, value: unknown): Promise<void> {
  if (!isBackedUpMetaKey(key)) {
    await db.meta.put({ key, value });
    return;
  }
  await db.transaction('rw', db.meta, async () => {
    const old = await db.meta.get(key);
    await db.meta.put({ key, value });
    if (JSON.stringify(old?.value) !== JSON.stringify(value)) await bumpChanges(db);
  });
}
