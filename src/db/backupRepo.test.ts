// Резервная копия на базе (fake-indexeddb): круговой тест, откат, режим «добавить», счётчик изменений.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KotobaDB } from './db';
import {
  BackupSnapshotError,
  checkReplaceGate,
  createBackupSnapshot,
  describeMerge,
  ensurePersist,
  hasUserData,
  markBackupSaved,
  readBackupState,
  readChangeSeq,
  readStoredPersist,
  restoreMerge,
  restoreReplace,
  shareSnapshot,
  snoozeBackupReminder,
} from './backupRepo';
import { addCards, bumpChanges, createDeck, deleteDeck, getMeta, readChangeCounters, setMeta } from './repo';
import {
  META_BACKED_UP_SEQ,
  META_BACKUP_SNOOZE_UNTIL,
  META_CHANGES_SINCE_BACKUP,
  META_CHANGE_SEQ,
  META_LAST_BACKUP_AT,
  META_PERSIST_RESULT,
} from './metaKeys';
import { parseBackup } from '../core/backup';
import type { BackupFile } from '../core/backup';
import { BACKUP_SNOOZE_MS } from '../core/backupReminder';
import type { ShareNavigatorLike } from '../core/backupShare';
import { loadSrs, review } from '../core/srs';
import { V1_FIXTURE, createV1Database } from './fixtures/schema-v1';
import type { Card, MetaRecord, Review } from './types';

let n = 0;
let db: KotobaDB;
const dbs: KotobaDB[] = [];

function fresh(): KotobaDB {
  const d = new KotobaDB(`kotoba-backup-test-${++n}`);
  dbs.push(d);
  return d;
}

beforeAll(async () => {
  await loadSrs();
});

beforeEach(() => {
  db = fresh();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dbs.splice(0)) {
    d.close();
    await KotobaDB.delete(d.name);
  }
});

const T = Date.UTC(2026, 10, 1, 9, 0, 0);
const DAY = 86_400_000;

/** Наполняет базу: две колоды, карточки с реальным состоянием FSRS, журнал, настройки. Возвращает всё прочитанное из базы. */
async function populate(target: KotobaDB) {
  const a = await createDeck(target, { name: 'N5, глаголы', description: 'Первая' }, T);
  const b = await createDeck(target, { name: 'N5, числа' }, T + 1000);
  await target.decks.update(b.id, { bestMatchMs: 31_500 });
  const ca = await addCards(
    target,
    a.id,
    [
      { term: '食べる', reading: 'たべる', definition: 'есть', example: '寿司を食べる。' },
      { term: '飲む', reading: 'のむ', definition: 'пить' },
      { term: '水', definition: 'вода' },
    ],
    T,
  );
  await addCards(target, b.id, [{ term: '一', reading: 'いち', definition: 'один' }], T + 2000);

  // Реальные ответы: состояние карточек и журнал.
  const reviews: Review[] = [];
  let t = T + DAY;
  const answers: Array<[number, 1 | 2 | 3 | 4]> = [[0, 3], [0, 3], [1, 1], [1, 3], [2, 4]];
  for (const [idx, rating] of answers) {
    const card = (await target.cards.get(ca[idx]!.id))!;
    const res = review(card, rating, t);
    await target.cards.update(card.id, { ...res.state, updatedAt: t });
    reviews.push({
      cardId: card.id,
      deckId: card.deckId,
      ts: t,
      rating,
      mode: idx === 2 ? 'review' : 'learn',
      direction: idx % 2 === 0 ? 'term-to-def' : 'def-to-term',
      durationMs: 2500 + idx,
      prev: res.prev,
    });
    t += 600_000;
  }
  await target.reviews.bulkAdd(reviews);
  await setMeta(target, 'dailyNewLimit', 15);
  await setMeta(target, 'voiceByLang', { 'ja-JP': 'Kyoko' });
  return snapshotRows(target);
}

async function snapshotRows(target: KotobaDB) {
  const byId = <T extends { id?: string | number }>(a: T, b: T) => String(a.id).localeCompare(String(b.id));
  return {
    decks: (await target.decks.toArray()).sort(byId),
    cards: (await target.cards.toArray()).sort(byId),
    reviews: (await target.reviews.toArray()).sort((a, b) => a.id! - b.id!),
    settings: {
      dailyNewLimit: await getMeta(target, 'dailyNewLimit'),
      voiceByLang: await getMeta(target, 'voiceByLang'),
      answerDirection: await getMeta(target, 'answerDirection'),
    },
  };
}

/** Номера журнала при восстановлении не переносятся: сравниваем содержимое без них. */
function stripIds<T extends { reviews: Review[] }>(snap: T) {
  return { ...snap, reviews: snap.reviews.map((r) => ({ ...r, id: undefined })) };
}

async function clearAll(target: KotobaDB) {
  await target.transaction('rw', target.decks, target.cards, target.reviews, target.meta, async () => {
    await target.decks.clear();
    await target.cards.clear();
    await target.reviews.clear();
    await target.meta.clear();
  });
}

function parsed(text: string): BackupFile {
  const r = parseBackup(text);
  if (!r.ok) throw new Error(r.message);
  return r.backup;
}

describe('круговой тест: экспорт, очистка, импорт', () => {
  it('данные идентичны, включая состояние FSRS и журнал', async () => {
    const before = await populate(db);
    expect(before.cards.some((c) => c.state !== 'new' && c.stability > 0)).toBe(true);
    expect(before.reviews).toHaveLength(5);

    const snap = await createBackupSnapshot(db, '0.1.0', T + 10 * DAY);
    expect(snap.filename).toMatch(/^kotoba-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(snap.file.meta).toEqual({ dailyNewLimit: 15, voiceByLang: { 'ja-JP': 'Kyoko' } });

    await clearAll(db);
    expect(await hasUserData(db)).toBe(false);

    const rep = await restoreReplace(db, parsed(snap.text), T + 11 * DAY);
    expect(rep).toMatchObject({ mode: 'replace', decks: 2, cards: 4, reviews: 5 });

    const after = await snapshotRows(db);
    expect(stripIds(after)).toStrictEqual(stripIds(before));
  });

  it('копия в ДРУГУЮ пустую базу (перенос на новый телефон) тоже идентична', async () => {
    const before = await populate(db);
    const snap = await createBackupSnapshot(db, '0.1.0', T + DAY);
    const other = fresh();
    await restoreReplace(other, parsed(snap.text), T + 2 * DAY);
    expect(stripIds(await snapshotRows(other))).toStrictEqual(stripIds(before));
  });

  it('копия от копии: второй экспорт после восстановления даёт тот же файл (кроме времени)', async () => {
    await populate(db);
    const s1 = await createBackupSnapshot(db, '0.1.0', T + DAY);
    const other = fresh();
    await restoreReplace(other, parsed(s1.text), T + 2 * DAY);
    const s2 = await createBackupSnapshot(other, '0.1.0', T + DAY);
    expect(s2.text).toBe(s1.text);
  });

  it('после замены: дата копии = дата файла, счётчик 0, служебные ключи устройства не затронуты', async () => {
    await populate(db);
    await db.meta.put({ key: META_PERSIST_RESULT, value: { result: 'denied', at: 5 } });
    const snap = await createBackupSnapshot(db, '0.1.0', T + 3 * DAY);
    await snoozeBackupReminder(db, T);
    await restoreReplace(db, parsed(snap.text), T + 4 * DAY);
    const st = await readBackupState(db);
    expect(st.lastBackupAt).toBe(T + 3 * DAY);
    expect(st.changesSinceBackup).toBe(0);
    expect(st.snoozeUntil).toBeUndefined();
    expect((await readStoredPersist(db))?.result).toBe('denied');
  });

  it('дата копии из будущего (неверные часы в файле) ограничивается «сейчас»', async () => {
    await populate(db);
    const snap = await createBackupSnapshot(db, '0.1.0', T + 400 * DAY);
    const other = fresh();
    await restoreReplace(other, parsed(snap.text), T + DAY);
    expect((await readBackupState(other)).lastBackupAt).toBe(T + DAY);
  });

  it('замена убирает настройки, которых нет в файле', async () => {
    await setMeta(db, 'answerDirection', 'both');
    await createDeck(db, { name: 'X' });
    const src = fresh();
    await createDeck(src, { name: 'Y' });
    const snap = await createBackupSnapshot(src, '0.1.0');
    await restoreReplace(db, parsed(snap.text));
    expect(await getMeta(db, 'answerDirection')).toBeUndefined();
  });

  it('образец базы версии 1 из src/db/fixtures экспортируется и восстанавливается без потерь', async () => {
    const name = `kotoba-backup-v1-${++n}`;
    await createV1Database(name);
    const old = new KotobaDB(name);
    dbs.push(old);
    const snap = await createBackupSnapshot(old, '0.1.0', T);
    // Из meta образца в файл идёт только dailyNewLimit; lastBackupAt устройства не попадает.
    expect(snap.file.meta).toEqual({ dailyNewLimit: 20 });
    const target = fresh();
    await restoreReplace(target, parsed(snap.text), T + DAY);
    expect(await target.decks.toArray()).toStrictEqual(V1_FIXTURE.decks);
    expect((await target.cards.toArray()).sort((a, b) => a.id.localeCompare(b.id))).toStrictEqual(
      [...V1_FIXTURE.cards].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await target.reviews.toArray()).toStrictEqual(V1_FIXTURE.reviews);
  });

  it('снимок падает, если файл нельзя будет прочитать обратно (нечисловое состояние)', async () => {
    const d = await createDeck(db, { name: 'X' });
    await addCards(db, d.id, [{ term: '水', definition: 'вода' }]);
    const [card] = await db.cards.toArray();
    await db.cards.update(card!.id, { stability: Number.NaN });
    const err = await createBackupSnapshot(db, '0.1.0').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupSnapshotError);
    expect((err as BackupSnapshotError).message).toContain('Не удалось собрать надёжную копию');
    // Причина понятна, подробности называют поле.
    expect((err as BackupSnapshotError).details.join(' ')).toContain('stability');
  });

  it('снимок читает данные и счётчик согласованно', async () => {
    await populate(db);
    const state = await readBackupState(db);
    const snap = await createBackupSnapshot(db, '0.1.0');
    expect(snap.seq).toBe(state.changesSinceBackup);
    expect(snap.seq).toBe(await readChangeSeq(db));
    expect(snap.seq).toBeGreaterThan(0);
  });
});

describe('откат при сбое посреди восстановления', () => {
  async function existing() {
    const before = await populate(db);
    await db.meta.put({ key: META_LAST_BACKUP_AT, value: T });
    const meta = await db.meta.toArray();
    return { before, meta: meta.sort((a, b) => a.key.localeCompare(b.key)) };
  }
  async function metaNow() {
    return (await db.meta.toArray()).sort((a, b) => a.key.localeCompare(b.key));
  }

  function incoming(): BackupFile {
    return {
      app: 'kotoba',
      formatVersion: 1,
      exportedAt: T + 5 * DAY,
      appVersion: 'x',
      dbSchemaVersion: 1,
      meta: { dailyNewLimit: 7 },
      decks: [{ id: 'in-deck', name: 'Чужая', termLang: 'ja-JP', defLang: 'ru-RU', createdAt: T, updatedAt: T }],
      cards: [
        { ...V1_FIXTURE.cards[0]!, id: 'in-1', deckId: 'in-deck' },
        { ...V1_FIXTURE.cards[1]!, id: 'in-2', deckId: 'in-deck' },
      ],
      reviews: [{ ...V1_FIXTURE.reviews[0]!, id: 1, cardId: 'in-2', deckId: 'in-deck' }],
    };
  }

  it('сбой при записи карточек (после очистки и записи колод): всё как было', async () => {
    const { before, meta } = await existing();
    vi.spyOn(db.cards, 'bulkAdd').mockRejectedValue(new Error('сбой записи карточек'));
    await expect(restoreReplace(db, incoming())).rejects.toThrow('сбой записи карточек');
    expect(await snapshotRows(db)).toStrictEqual(before);
    expect(await metaNow()).toStrictEqual(meta);
  });

  it('сбой при записи журнала (колоды и карточки уже записаны): всё как было', async () => {
    const { before, meta } = await existing();
    vi.spyOn(db.reviews, 'bulkAdd').mockRejectedValue(new Error('сбой журнала'));
    await expect(restoreReplace(db, incoming())).rejects.toThrow('сбой журнала');
    expect(await snapshotRows(db)).toStrictEqual(before);
    expect(await metaNow()).toStrictEqual(meta);
  });

  it('сбой на последнем шаге (запись счётчика): откатывается и всё остальное', async () => {
    const { before, meta } = await existing();
    const realPut = db.meta.put.bind(db.meta);
    vi.spyOn(db.meta, 'put').mockImplementation(((item: MetaRecord, key?: string) => {
      if (item.key === META_CHANGE_SEQ) return Promise.reject(new Error('сбой счётчика'));
      return realPut(item, key);
    }) as never);
    await expect(restoreReplace(db, incoming())).rejects.toThrow('сбой счётчика');
    expect(await snapshotRows(db)).toStrictEqual(before);
    expect(await metaNow()).toStrictEqual(meta);
  });

  it('настоящий сбой базы: повторяющиеся id в карточках (мимо проверки) откатывают замену', async () => {
    const { before, meta } = await existing();
    const bad = incoming();
    bad.cards = [bad.cards[0]!, { ...bad.cards[0]! }];
    bad.reviews = [];
    await expect(restoreReplace(db, bad)).rejects.toThrow();
    expect(await snapshotRows(db)).toStrictEqual(before);
    expect(await metaNow()).toStrictEqual(meta);
  });

  it('успешная замена после неудачной работает (база не «сломана» откатом)', async () => {
    const { before } = await existing();
    vi.spyOn(db.reviews, 'bulkAdd').mockRejectedValueOnce(new Error('сбой'));
    await expect(restoreReplace(db, incoming())).rejects.toThrow();
    expect(await snapshotRows(db)).toStrictEqual(before);
    const rep = await restoreReplace(db, incoming());
    expect(rep).toMatchObject({ decks: 1, cards: 2, reviews: 1 });
    expect((await db.decks.toArray()).map((d) => d.id)).toEqual(['in-deck']);
    expect(await getMeta(db, 'dailyNewLimit')).toBe(7);
  });

  it('номера записей журнала из файла не переносятся: база назначает свои, порядок по времени', async () => {
    const b = incoming();
    const r1 = { ...b.reviews[0]!, ts: T + 30 };
    delete r1.id;
    b.reviews = [r1, { ...b.reviews[0]!, id: 5, ts: T + 20 }, { ...r1, ts: T + 10 }];
    await restoreReplace(db, b);
    const rows = (await db.reviews.toArray()).sort((a, c) => a.id! - c.id!);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(rows.map((r) => r.id)).not.toContain(5);
    expect(rows.map((r) => r.ts)).toEqual([T + 10, T + 20, T + 30]);
  });
});

describe('режим «добавить к существующим»', () => {
  it('конфликт id: чужие данные нетронуты, копии получают новые id, ссылки целы', async () => {
    const before = await populate(db);
    const snap = await createBackupSnapshot(db, '0.1.0', T + DAY);

    const rep = await restoreMerge(db, parsed(snap.text));
    expect(rep).toMatchObject({ mode: 'merge', decks: 2, cards: 4, reviews: 5, reidDecks: 2, reidCards: 4 });

    // Всё старое на месте и не изменено.
    for (const d of before.decks) expect(await db.decks.get(d.id)).toStrictEqual(d);
    for (const c of before.cards) expect(await db.cards.get(c.id)).toStrictEqual(c);
    for (const r of before.reviews) expect(await db.reviews.get(r.id!)).toStrictEqual(r);

    expect(await db.decks.count()).toBe(4);
    expect(await db.cards.count()).toBe(8);
    expect(await db.reviews.count()).toBe(10);

    // Новые колоды: пометка, карточки привязаны к новым колодам, журнал к новым карточкам.
    const oldDeckIds = new Set(before.decks.map((d) => d.id));
    const newDecks = (await db.decks.toArray()).filter((d) => !oldDeckIds.has(d.id));
    expect(newDecks.map((d) => d.name).sort()).toEqual(['N5, глаголы (копия)', 'N5, числа (копия)']);
    const newDeckIds = new Set(newDecks.map((d) => d.id));
    const oldCardIds = new Set(before.cards.map((c) => c.id));
    const newCards = (await db.cards.toArray()).filter((c) => !oldCardIds.has(c.id));
    expect(newCards.every((c) => newDeckIds.has(c.deckId))).toBe(true);
    const newCardIds = new Set(newCards.map((c) => c.id));
    const oldReviewIds = new Set(before.reviews.map((r) => r.id));
    const newReviews = (await db.reviews.toArray()).filter((r) => !oldReviewIds.has(r.id));
    expect(newReviews).toHaveLength(5);
    expect(newReviews.every((r) => newCardIds.has(r.cardId) && newDeckIds.has(r.deckId))).toBe(true);
    // Состояние FSRS перенесено.
    const orig = before.cards.find((c) => c.term === '食べる')!;
    const copy = newCards.find((c) => c.term === '食べる')!;
    expect({ ...copy, id: orig.id, deckId: orig.deckId }).toStrictEqual(orig);
  });

  it('без конфликтов: id сохраняются; настройки не меняются; дата копии не меняется', async () => {
    const src = fresh();
    await populate(src);
    const snap = await createBackupSnapshot(src, '0.1.0', T + DAY);
    await createDeck(db, { name: 'Своя' }, T);
    await setMeta(db, 'dailyNewLimit', 99);
    await db.meta.put({ key: META_LAST_BACKUP_AT, value: T });
    await restoreMerge(db, parsed(snap.text));
    expect(await db.decks.count()).toBe(3);
    expect((await db.decks.toArray()).map((d) => d.id)).toContain(snap.file.decks[0]!.id);
    expect(await getMeta(db, 'dailyNewLimit')).toBe(99);
    expect((await readBackupState(db)).lastBackupAt).toBe(T);
  });

  it('счётчик изменений растёт на число добавленных колод и карточек', async () => {
    const src = fresh();
    await populate(src);
    const snap = await createBackupSnapshot(src, '0.1.0');
    await db.meta.bulkPut([
      { key: META_CHANGE_SEQ, value: 10 },
      { key: META_BACKED_UP_SEQ, value: 7 },
    ]);
    await restoreMerge(db, parsed(snap.text));
    expect((await readBackupState(db)).changesSinceBackup).toBe(3 + 2 + 4);
    expect(await readChangeSeq(db)).toBe(10 + 2 + 4);
  });

  it('сбой посреди добавления откатывает всё, включая счётчик', async () => {
    const src = fresh();
    await populate(src);
    const snap = await createBackupSnapshot(src, '0.1.0');
    await createDeck(db, { name: 'Своя' });
    const before = await snapshotRows(db);
    const counter = (await readBackupState(db)).changesSinceBackup;
    vi.spyOn(db.reviews, 'bulkAdd').mockRejectedValue(new Error('сбой'));
    await expect(restoreMerge(db, parsed(snap.text))).rejects.toThrow('сбой');
    expect(await snapshotRows(db)).toStrictEqual(before);
    expect((await readBackupState(db)).changesSinceBackup).toBe(counter);
  });

  it('describeMerge считает конфликты для предпросмотра', async () => {
    await populate(db);
    const snap = await createBackupSnapshot(db, '0.1.0');
    expect(await describeMerge(db, snap.file)).toEqual({ conflictDecks: 2, conflictCards: 4, alreadyLoaded: true });
    expect(await describeMerge(fresh(), snap.file)).toEqual({ conflictDecks: 0, conflictCards: 0, alreadyLoaded: false });
  });
});

describe('счётчик изменений внутри транзакций', () => {
  const counter = async () => (await readBackupState(db)).changesSinceBackup;

  it('создание колоды +1, добавление карточек +N, пустой набор ничего не добавляет', async () => {
    const d = await createDeck(db, { name: 'A' });
    expect(await counter()).toBe(1);
    await addCards(db, d.id, [{ term: '一', definition: 'один' }, { term: '二', definition: 'два' }, { term: '', definition: 'пусто' }]);
    expect(await counter()).toBe(3);
    await addCards(db, d.id, [{ term: '', definition: 'x' }]);
    expect(await counter()).toBe(3);
  });

  it('удаление колоды +1; удаление несуществующей не меняет счёт', async () => {
    const d = await createDeck(db, { name: 'A' });
    await addCards(db, d.id, [{ term: '一', definition: 'один' }]);
    expect(await counter()).toBe(2);
    await deleteDeck(db, d.id);
    expect(await counter()).toBe(3);
    await deleteDeck(db, 'нет-такой');
    expect(await counter()).toBe(3);
  });

  it('настройки из копии (dailyNewLimit) считаются; то же значение и служебные ключи нет', async () => {
    await setMeta(db, 'dailyNewLimit', 20);
    expect(await counter()).toBe(1);
    await setMeta(db, 'dailyNewLimit', 20);
    expect(await counter()).toBe(1);
    await setMeta(db, 'dailyNewLimit', 25);
    expect(await counter()).toBe(2);
    await setMeta(db, 'persistResult', { result: 'granted', at: 1 });
    await setMeta(db, 'installHintDismissed', true);
    await setMeta(db, 'lastBackupAt', 5);
    expect(await counter()).toBe(2);
  });

  it('счётчик меняется ВНУТРИ той же транзакции: при откате внешней транзакции откатывается и он', async () => {
    const d = await createDeck(db, { name: 'A' });
    const base = await counter();
    await expect(
      db.transaction('rw', db.decks, db.cards, db.meta, async () => {
        await addCards(db, d.id, [{ term: '一', definition: 'один' }, { term: '二', definition: 'два' }]);
        expect(toNumber(await db.meta.get(META_CHANGE_SEQ))).toBe(base + 2); // виден внутри
        throw new Error('отмена');
      }),
    ).rejects.toThrow('отмена');
    expect(await counter()).toBe(base);
    expect(await db.cards.count()).toBe(0);
  });

  it('сбой на середине addCards откатывает и карточки, и счётчик', async () => {
    const d = await createDeck(db, { name: 'A' });
    const base = await counter();
    vi.spyOn(db.decks, 'update').mockRejectedValue(new Error('сбой'));
    await expect(addCards(db, d.id, [{ term: '一', definition: 'один' }])).rejects.toThrow('сбой');
    expect(await db.cards.count()).toBe(0);
    expect(await counter()).toBe(base);
  });

  it('сбой записи счётчика откатывает создание колоды', async () => {
    vi.spyOn(db.meta, 'put').mockRejectedValue(new Error('сбой счётчика'));
    await expect(createDeck(db, { name: 'A' })).rejects.toThrow('сбой счётчика');
    expect(await db.decks.count()).toBe(0);
  });

  it('удаление несуществующей колоды после сбоя: удаление откатывается вместе со счётчиком', async () => {
    const d = await createDeck(db, { name: 'A' });
    await addCards(db, d.id, [{ term: '一', definition: 'один' }]);
    const base = await counter();
    vi.spyOn(db.decks, 'delete').mockRejectedValue(new Error('сбой удаления'));
    await expect(deleteDeck(db, d.id)).rejects.toThrow('сбой удаления');
    expect(await db.cards.count()).toBe(1);
    expect(await counter()).toBe(base);
  });

  it('bumpChanges вне подходящей транзакции бросает ошибку и ничего не пишет', async () => {
    await expect(bumpChanges(db)).rejects.toThrow('внутри транзакции');
    await expect(db.transaction('r', db.meta, () => bumpChanges(db))).rejects.toThrow();
    await expect(db.transaction('rw', db.decks, () => bumpChanges(db))).rejects.toThrow();
    expect(await counter()).toBe(0);
  });

  it('повреждённое значение счётчика трактуется как 0', async () => {
    await db.meta.put({ key: META_CHANGES_SINCE_BACKUP, value: 'мусор' });
    await createDeck(db, { name: 'A' });
    expect(await counter()).toBe(1);
  });
});

function toNumber(rec: { value: unknown } | undefined): number | undefined {
  return typeof rec?.value === 'number' ? rec.value : undefined;
}

describe('«копия сохранена»: счётчик сбрасывается только после реального успеха', () => {
  function nav(share: () => Promise<void>, canShare = true): ShareNavigatorLike {
    return { share, canShare: () => canShare };
  }
  const abort = () => Object.assign(new Error('отмена'), { name: 'AbortError' });

  async function withChanges() {
    await populate(db);
    const state = await readBackupState(db);
    expect(state.changesSinceBackup).toBeGreaterThan(0);
    return state;
  }

  it('отмена меню «Поделиться»: дата и счётчик не меняются', async () => {
    const before = await withChanges();
    const snap = await createBackupSnapshot(db, '0.1.0');
    const outcome = await shareSnapshot(db, nav(() => Promise.reject(abort())), snap, undefined, T + 10 * DAY);
    expect(outcome.kind).toBe('cancelled');
    expect(await readBackupState(db)).toStrictEqual(before);
  });

  it('блокировка («нажмите ещё раз», NotAllowedError), неподдержка и ошибка тоже ничего не сбрасывают', async () => {
    const before = await withChanges();
    const snap = await createBackupSnapshot(db, '0.1.0');
    const blocked = await shareSnapshot(db, nav(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))), snap);
    expect(blocked.kind).toBe('blocked');
    const unsupported = await shareSnapshot(db, nav(async () => {}, false), snap);
    expect(unsupported.kind).toBe('unsupported');
    const failed = await shareSnapshot(db, nav(() => Promise.reject(new Error('сбой'))), snap);
    expect(failed.kind).toBe('error');
    expect(await readBackupState(db)).toStrictEqual(before);
  });

  it('успешное «Поделиться»: дата = момент снимка, счётчик 0, отсрочка снята', async () => {
    await withChanges();
    await snoozeBackupReminder(db, T);
    const snap = await createBackupSnapshot(db, '0.1.0', T + 5 * DAY);
    const outcome = await shareSnapshot(db, nav(async () => {}), snap, undefined, T + 6 * DAY);
    expect(outcome.kind).toBe('shared');
    expect(await readBackupState(db)).toMatchObject({ lastBackupAt: T + 5 * DAY, changesSinceBackup: 0 });
    expect((await readBackupState(db)).snoozeUntil).toBeUndefined();
  });

  it('изменения, сделанные пока меню было открыто, остаются несохранёнными', async () => {
    await withChanges();
    const snap = await createBackupSnapshot(db, '0.1.0');
    const outcome = await shareSnapshot(
      db,
      nav(async () => {
        // Пока меню открыто, в базе появилась новая колода (+1 изменение).
        await createDeck(db, { name: 'Новая' });
      }),
      snap,
      undefined,
      T + 10 * DAY,
    );
    expect(outcome.kind).toBe('shared');
    expect((await readBackupState(db)).changesSinceBackup).toBe(1);
  });

  it('ручное подтверждение (скачивание, буфер) тоже использует снимок и не уходит в минус', async () => {
    await withChanges();
    const snap = await createBackupSnapshot(db, '0.1.0', T + DAY);
    await markBackupSaved(db, snap, T + 10 * DAY);
    await markBackupSaved(db, snap, T + 10 * DAY); // повторное подтверждение безвредно
    expect(await readBackupState(db)).toMatchObject({ lastBackupAt: T + DAY, changesSinceBackup: 0 });
  });

  it('дата копии не откатывается назад, если подтвердили более старый снимок', async () => {
    await withChanges();
    const old = await createBackupSnapshot(db, '0.1.0', T + DAY);
    const newer = await createBackupSnapshot(db, '0.1.0', T + 2 * DAY);
    await markBackupSaved(db, newer, T + 10 * DAY);
    await markBackupSaved(db, old, T + 10 * DAY);
    expect((await readBackupState(db)).lastBackupAt).toBe(T + 2 * DAY);
  });
});

describe('состояние для баннера и настроек', () => {
  it('пустая база: данных нет', async () => {
    expect(await readBackupState(db)).toEqual({ hasData: false, changesSinceBackup: 0 });
  });

  it('с данными: самая ранняя колода, отсрочка на сутки', async () => {
    await createDeck(db, { name: 'B' }, T + 5);
    await createDeck(db, { name: 'A' }, T);
    await snoozeBackupReminder(db, T + 100);
    const s = await readBackupState(db);
    expect(s).toMatchObject({ hasData: true, oldestDataAt: T, snoozeUntil: T + 100 + BACKUP_SNOOZE_MS });
    expect(s.lastBackupAt).toBeUndefined();
    expect(await getMeta(db, META_BACKUP_SNOOZE_UNTIL)).toBe(T + 100 + BACKUP_SNOOZE_MS);
  });

  it('отсрочка и служебные записи не увеличивают счётчик изменений', async () => {
    await snoozeBackupReminder(db, T);
    await db.meta.put({ key: META_LAST_BACKUP_AT, value: T });
    expect((await readBackupState(db)).changesSinceBackup).toBe(0);
  });
});

describe('постоянное хранилище', () => {
  it('результат запоминается; onlyOnce не спрашивает повторно', async () => {
    const persist = vi.fn().mockResolvedValue(false);
    const storage = { persist, persisted: async () => false };
    expect(await ensurePersist(db, storage, { onlyOnce: true, now: 7 })).toBe('denied');
    expect(await readStoredPersist(db)).toEqual({ result: 'denied', at: 7 });
    expect(await ensurePersist(db, storage, { onlyOnce: true })).toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
    // Без onlyOnce (экран настроек) спрашивает заново и обновляет запись.
    expect(await ensurePersist(db, { persist: async () => true, persisted: async () => false }, { now: 9 })).toBe('granted');
    expect(await readStoredPersist(db)).toEqual({ result: 'granted', at: 9 });
  });

  it('API нет: unavailable, счётчик изменений не растёт', async () => {
    expect(await ensurePersist(db, undefined)).toBe('unavailable');
    expect((await readBackupState(db)).changesSinceBackup).toBe(0);
  });

  it('сбой записи в базу не бросается наружу и не подменяет настоящий ответ браузера (М7)', async () => {
    vi.spyOn(db.meta, 'put').mockRejectedValue(new Error('сбой'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(ensurePersist(db, { persist: async () => true })).resolves.toBe('granted');
    // Реальный отказ при сбое записи остаётся отказом, «Нет» не выдумывается и не теряется.
    await expect(ensurePersist(db, { persist: async () => false })).resolves.toBe('denied');
  });

  it('запрос упал (ответа нет): «unknown», а не «denied»; в базу не пишется, чтобы спросить снова (М7)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = { persist: () => Promise.reject(new Error('сбой запроса')) };
    expect(await ensurePersist(db, storage, { onlyOnce: true })).toBe('unknown');
    expect(await readStoredPersist(db)).toBeUndefined();
    // Следующая попытка снова спрашивает (onlyOnce не считает «unknown» ответом).
    expect(await ensurePersist(db, { persist: async () => false }, { onlyOnce: true, now: 3 })).toBe('denied');
    expect(await readStoredPersist(db)).toEqual({ result: 'denied', at: 3 });
  });
});

describe('типы карточек в тестах', () => {
  it('Card из базы имеет состояние FSRS (защита от случайной правки populate)', async () => {
    await populate(db);
    const cards: Card[] = await db.cards.toArray();
    expect(cards.filter((c) => c.reps > 0).length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Исправления по замечаниям ревью (шаг 2)

/** Копия «вручную» (мимо разбора файла): так проверяется, что восстановление само не доверяет номерам и настройкам. */
function handmade(over: Partial<BackupFile> = {}): BackupFile {
  const f = structuredClone(V1_FIXTURE);
  return {
    app: 'kotoba',
    formatVersion: 1,
    exportedAt: T,
    appVersion: 'x',
    dbSchemaVersion: 1,
    meta: {},
    decks: f.decks,
    cards: f.cards,
    reviews: f.reviews,
    ...over,
  };
}

const newReview = (cardId: string, deckId: string): Review => ({
  cardId,
  deckId,
  ts: T,
  rating: 3,
  mode: 'learn',
  durationMs: 1,
  prev: V1_FIXTURE.cards[0]!,
});

describe('В1: огромный номер записи журнала не ломает автоинкремент', () => {
  const card = V1_FIXTURE.cards[0]!;

  it.each([2 ** 53, 1e300, 4_294_967_295])('замена: номер %s не переносится, db.reviews.add() работает', async (hugeId) => {
    const base = V1_FIXTURE.reviews[0]!;
    await restoreReplace(db, handmade({ reviews: [{ ...base, id: hugeId }] }));
    const [restored] = await db.reviews.toArray();
    expect(restored!.id).toBeLessThan(1000);
    // Самое важное: новое повторение (ответ в «Заучивании») по-прежнему записывается.
    await expect(db.reviews.add(newReview(card.id, card.deckId))).resolves.toBeGreaterThan(restored!.id!);
    // Повторная чистая замена тоже не ломается.
    await restoreReplace(db, handmade({ reviews: [] }));
    await expect(db.reviews.add(newReview(card.id, card.deckId))).resolves.toBeTypeOf('number');
  });

  it('добавление: огромный номер не переносится, db.reviews.add() работает', async () => {
    const base = V1_FIXTURE.reviews[0]!;
    await restoreMerge(db, handmade({ reviews: [{ ...base, id: 2 ** 53 }] }));
    expect((await db.reviews.toArray()).map((r) => r.id!).every((id) => id < 1000)).toBe(true);
    await expect(db.reviews.add(newReview(card.id, card.deckId))).resolves.toBeTypeOf('number');
  });

  it('файл с огромным номером журнала отклоняется разбором; допустимо большой номер разбор принимает, но он не переносится', async () => {
    const f = handmade();
    f.reviews = [{ ...f.reviews[0]!, id: 2 ** 53 }];
    expect(parseBackup(JSON.stringify(f)).ok).toBe(false);
    f.reviews = [{ ...f.reviews[0]!, id: 4_000_000_000 }];
    const r = parseBackup(JSON.stringify(f));
    expect(r.ok).toBe(true);
    if (r.ok) {
      await restoreReplace(db, r.backup);
      expect((await db.reviews.toArray())[0]!.id).toBe(1);
    }
  });
});

describe('В2: одна неидеальная запись не лишает возможности сделать копию', () => {
  async function withOrphans() {
    await populate(db);
    const cards = await db.cards.toArray();
    // Карточку удалили, а журнал остался (так бывает при сбое или будущем коде удаления карточек).
    const victim = cards.find((c) => c.term === '食べる')!;
    const orphanCount = await db.reviews.where('cardId').equals(victim.id).count();
    expect(orphanCount).toBeGreaterThan(0);
    await db.cards.delete(victim.id);
    return orphanCount;
  }

  it('сиротские записи не входят в файл, пользователь получает предупреждение, остальное цело', async () => {
    const orphanCount = await withOrphans();
    const total = await db.reviews.count();
    const snap = await createBackupSnapshot(db, '0.1.0', T + DAY);
    expect(snap.warnings.join(' ')).toContain(`${orphanCount} `);
    expect(snap.warnings[0]).toMatch(/без карточки не вош(ла|ли) в копию/);
    expect(snap.file.reviews).toHaveLength(total - orphanCount);
    expect(snap.file.cards).toHaveLength(3);
    // Такой файл читается обратно без предупреждений.
    const back = parseBackup(snap.text);
    expect(back.ok && back.warnings).toEqual([]);
    const other = fresh();
    await restoreReplace(other, parsed(snap.text), T + 2 * DAY);
    expect(await other.reviews.count()).toBe(total - orphanCount);
  });

  it('сиротская запись из удалённой колоды (строка колоды стёрта) тоже исключается', async () => {
    await populate(db);
    const deck = (await db.decks.toArray()).find((d) => d.name === 'N5, глаголы')!;
    // Колоду стёрли вместе с карточками, а журнал остался.
    await db.decks.delete(deck.id);
    await db.cards.where('deckId').equals(deck.id).delete();
    const snap = await createBackupSnapshot(db, '0.1.0', T + DAY);
    expect(snap.warnings[0]).toMatch(/без карточки/);
    expect(snap.file.reviews.every((r) => r.deckId !== deck.id)).toBe(true);
    expect(snap.file.reviews).toHaveLength(0);
  });

  it('другая причина самопроверки (запись журнала в чужой колоде): отказ с причиной и первыми тремя подробностями', async () => {
    const a = await createDeck(db, { name: 'A' });
    const b = await createDeck(db, { name: 'B' });
    const [card] = await addCards(db, a.id, [{ term: '水', definition: 'вода' }]);
    // Шесть записей: карточка из колоды A, но запись приписана колоде B.
    await db.reviews.bulkAdd(Array.from({ length: 6 }, (_, i) => ({ ...newReview(card!.id, b.id), ts: T + i })));
    const err = await createBackupSnapshot(db, '0.1.0').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupSnapshotError);
    const e = err as BackupSnapshotError;
    expect(e.message).toContain('Не удалось собрать надёжную копию');
    expect(e.message).toContain('связи между данными');
    expect(e.message).toContain('Данные не изменены');
    expect(e.details).toHaveLength(3);
    expect(e.details[0]).toContain('другой колоде');
    // Данные не тронуты.
    expect(await db.reviews.count()).toBe(6);
  });

  it('файл с сиротской записью журнала восстанавливается с предупреждением (замена и добавление)', async () => {
    const f = handmade();
    const text = JSON.stringify({ ...f, reviews: [...f.reviews, { ...f.reviews[0]!, id: 77, cardId: 'призрак' }] });
    const r = parseBackup(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings[0]).toContain('1 запись журнала без карточки или колоды пропущена');
    const rep = await restoreReplace(db, r.backup, T + DAY);
    expect(rep.reviews).toBe(1);
    expect(await db.reviews.count()).toBe(1);
    const merged = fresh();
    expect((await restoreMerge(merged, r.backup)).reviews).toBe(1);
  });

  it('createDeck: пустой или пробельный язык заменяется языком по умолчанию, копия делается', async () => {
    const d = await createDeck(db, { name: 'A', termLang: '', defLang: '   ' });
    expect(d.termLang).toBe('ja-JP');
    expect(d.defLang).toBe('ru-RU');
    const e = await createDeck(db, { name: 'B', termLang: ' en-US ' });
    expect(e.termLang).toBe('en-US');
    expect(e.defLang).toBe('ru-RU');
    expect((await db.decks.get(d.id))!.termLang).toBe('ja-JP');
    await expect(createBackupSnapshot(db, '0.1.0')).resolves.toMatchObject({ warnings: [] });
  });
});

describe('В4: настройки при восстановлении записываются только проверенные', () => {
  it('мусор в настройках файла: замена его не записывает, прежние настройки удаляются', async () => {
    await setMeta(db, 'dailyNewLimit', 15);
    await setMeta(db, 'answerDirection', 'both');
    const f = handmade();
    const text = JSON.stringify({ ...f, meta: { dailyNewLimit: 'много', answerDirection: { x: 1 }, voiceByLang: 5, other: 1 } });
    const r = parseBackup(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toHaveLength(3);
    await restoreReplace(db, r.backup, T + DAY);
    expect(await getMeta(db, 'dailyNewLimit')).toBeUndefined();
    expect(await getMeta(db, 'answerDirection')).toBeUndefined();
    expect(await getMeta(db, 'voiceByLang')).toBeUndefined();
    expect(await getMeta(db, 'other')).toBeUndefined();
  });

  it('даже если BackupFile собран мимо разбора, в meta попадает только проверенное', async () => {
    const poisoned = JSON.parse('{"ja-JP":"Kyoko","__proto__":{"polluted":true},"constructor":"x"}') as Record<string, string>;
    await restoreReplace(
      db,
      handmade({ meta: { dailyNewLimit: 5000, answerDirection: 'sideways', voiceByLang: poisoned } }),
      T + DAY,
    );
    expect(await getMeta(db, 'dailyNewLimit')).toBeUndefined();
    expect(await getMeta(db, 'answerDirection')).toBeUndefined();
    const voices = (await getMeta(db, 'voiceByLang')) as Record<string, string>;
    expect(voices).toEqual({ 'ja-JP': 'Kyoko' });
    expect(Object.prototype.hasOwnProperty.call(voices, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('допустимые настройки переносятся целиком', async () => {
    await restoreReplace(
      db,
      handmade({ meta: { dailyNewLimit: 12, answerDirection: 'def-to-term', voiceByLang: { 'ja-JP': 'Kyoko' } } }),
      T + DAY,
    );
    expect(await getMeta(db, 'dailyNewLimit')).toBe(12);
    expect(await getMeta(db, 'answerDirection')).toBe('def-to-term');
    expect(await getMeta(db, 'voiceByLang')).toEqual({ 'ja-JP': 'Kyoko' });
  });
});

describe('М1: монотонные changeSeq и backedUpSeq', () => {
  const unsaved = async () => (await readBackupState(db)).changesSinceBackup;

  it('два пересекающихся снимка: подтверждение более раннего не «возвращает» сохранённое', async () => {
    const d = await createDeck(db, { name: 'A' });
    await addCards(db, d.id, [{ term: '水', definition: 'в' }, { term: '火', definition: 'о' }]);
    const s1 = await createBackupSnapshot(db, '0.1.0', T);
    const s2 = await createBackupSnapshot(db, '0.1.0', T + 1);
    expect(s1.seq).toBe(s2.seq);
    await markBackupSaved(db, s2, T + DAY);
    expect(await unsaved()).toBe(0);
    await addCards(db, d.id, [{ term: '木', definition: 'д' }, { term: '金', definition: 'з' }]);
    expect(await unsaved()).toBe(2);
    await markBackupSaved(db, s1, T + DAY); // раннее подтверждение приходит позже
    expect(await unsaved()).toBe(2); // при вычитании здесь получилось бы 0
  });

  it('снимки с разными номерами: сохранённым считается наибольший, порядок подтверждений не важен', async () => {
    const d = await createDeck(db, { name: 'A' });
    const early = await createBackupSnapshot(db, '0.1.0', T);
    await addCards(db, d.id, [{ term: '水', definition: 'в' }]);
    const late = await createBackupSnapshot(db, '0.1.0', T + 1);
    await addCards(db, d.id, [{ term: '火', definition: 'о' }]);
    await markBackupSaved(db, late, T + DAY);
    await markBackupSaved(db, early, T + DAY);
    expect(await unsaved()).toBe(1);
    expect((await readChangeCounters(db)).backedUpSeq).toBe(late.seq);
  });

  it('номер изменения только растёт: подтверждение копии его не меняет', async () => {
    await createDeck(db, { name: 'A' });
    const before = await readChangeSeq(db);
    const snap = await createBackupSnapshot(db, '0.1.0', T);
    await markBackupSaved(db, snap, T + DAY);
    expect(await readChangeSeq(db)).toBe(before);
    await createDeck(db, { name: 'B' });
    expect(await readChangeSeq(db)).toBe(before + 1);
  });

  it('миграция: старый счётчик changesSinceBackup = n превращается в seq = n, backedUpSeq = 0 (без поднятия схемы Dexie)', async () => {
    await db.meta.put({ key: META_CHANGES_SINCE_BACKUP, value: 7 });
    expect(await unsaved()).toBe(7);
    expect(await readChangeSeq(db)).toBe(7);
    // Чтение само ничего не пишет.
    expect(await db.meta.get(META_CHANGE_SEQ)).toBeUndefined();
    // Первое же изменение переносит значения в новые ключи и убирает старый.
    await createDeck(db, { name: 'A' });
    expect(await unsaved()).toBe(8);
    expect(await db.meta.get(META_CHANGE_SEQ)).toEqual({ key: META_CHANGE_SEQ, value: 8 });
    expect(await db.meta.get(META_BACKED_UP_SEQ)).toEqual({ key: META_BACKED_UP_SEQ, value: 0 });
    expect(await db.meta.get(META_CHANGES_SINCE_BACKUP)).toBeUndefined();
  });

  it('миграция: подтверждение копии у старого устройства даёт 0 и тоже убирает старый ключ', async () => {
    await db.meta.put({ key: META_CHANGES_SINCE_BACKUP, value: 12 });
    const snap = await createBackupSnapshot(db, '0.1.0', T);
    expect(snap.seq).toBe(12);
    await markBackupSaved(db, snap, T + DAY);
    expect(await unsaved()).toBe(0);
    expect(await db.meta.get(META_CHANGES_SINCE_BACKUP)).toBeUndefined();
  });

  it('повреждённые значения: мусор трактуется как 0, backedUpSeq больше seq приводится к seq', async () => {
    await db.meta.bulkPut([
      { key: META_CHANGE_SEQ, value: 5 },
      { key: META_BACKED_UP_SEQ, value: 99 },
    ]);
    expect(await unsaved()).toBe(0);
    await createDeck(db, { name: 'A' }); // изменение не прячется за испорченным значением
    expect(await unsaved()).toBe(1);
    await db.meta.bulkPut([
      { key: META_CHANGE_SEQ, value: 'мусор' },
      { key: META_BACKED_UP_SEQ, value: -3 },
    ]);
    expect(await unsaved()).toBe(0);
  });

  it('снимок «из будущего» (база очищена после снимка) ничего не отмечает сохранённым, но дата копии ставится', async () => {
    await createDeck(db, { name: 'A' });
    await markBackupSaved(db, { exportedAt: T, seq: 500 }, T + DAY);
    expect(await unsaved()).toBe(1);
    expect((await readBackupState(db)).lastBackupAt).toBe(T);
  });

  it('замена данных: номер растёт, база объявляется сохранённой; снимок, сделанный до замены, не годится', async () => {
    await populate(db);
    const stale = await createBackupSnapshot(db, '0.1.0', T + DAY);
    const seqBefore = await readChangeSeq(db);
    await restoreReplace(db, handmade(), T + 2 * DAY);
    expect(await readChangeSeq(db)).toBe(seqBefore + 1);
    expect(await unsaved()).toBe(0);
    await createDeck(db, { name: 'После замены' });
    await markBackupSaved(db, stale, T + 3 * DAY); // старый снимок другого содержимого
    expect(await unsaved()).toBe(1);
  });
});

describe('М3: дата копии не бывает «из будущего»', () => {
  it('lastBackupAt ограничивается «сейчас»: и снимок, и прежнее значение из будущего', async () => {
    await createDeck(db, { name: 'A' });
    await markBackupSaved(db, { exportedAt: T + 400 * DAY, seq: 0 }, T + DAY);
    expect((await readBackupState(db)).lastBackupAt).toBe(T + DAY);
    await db.meta.put({ key: META_LAST_BACKUP_AT, value: T + 500 * DAY });
    await markBackupSaved(db, { exportedAt: T + 2 * DAY, seq: 0 }, T + 3 * DAY);
    expect((await readBackupState(db)).lastBackupAt).toBe(T + 3 * DAY);
  });
});

describe('М4: предпросмотр «добавить» узнаёт уже загруженную копию', () => {
  it('все колоды и карточки файла уже есть: alreadyLoaded', async () => {
    await populate(db);
    const snap = await createBackupSnapshot(db, '0.1.0');
    expect(await describeMerge(db, snap.file)).toMatchObject({ conflictDecks: 2, conflictCards: 4, alreadyLoaded: true });
  });

  it('частичное совпадение, новая база и пустой файл: не alreadyLoaded', async () => {
    await populate(db);
    const snap = await createBackupSnapshot(db, '0.1.0');
    await db.cards.delete(snap.file.cards[0]!.id);
    expect((await describeMerge(db, snap.file)).alreadyLoaded).toBe(false); // одной карточки в базе нет
    expect((await describeMerge(fresh(), snap.file)).alreadyLoaded).toBe(false);
    expect((await describeMerge(db, { ...snap.file, decks: [], cards: [], reviews: [] })).alreadyLoaded).toBe(false);
  });
});

describe('М10: перед заменой наличие данных перечитывается из базы', () => {
  it('данных нет: можно; данные есть без копии: нельзя; с копией или явным отказом: после подтверждения', async () => {
    expect(await checkReplaceGate(db, { safetyDone: false, skipSafety: false })).toEqual({ kind: 'go', hasData: false });
    await createDeck(db, { name: 'A' });
    expect(await checkReplaceGate(db, { safetyDone: false, skipSafety: false })).toEqual({ kind: 'need-safety', hasData: true });
    expect(await checkReplaceGate(db, { safetyDone: true, skipSafety: false })).toEqual({ kind: 'confirm', hasData: true });
    expect(await checkReplaceGate(db, { safetyDone: false, skipSafety: true })).toEqual({ kind: 'confirm', hasData: true });
  });

  it('данные появились ПОСЛЕ предпросмотра (в предпросмотре было «пусто»): замена без копии останавливается', async () => {
    const preview = { hasExisting: await hasUserData(db) };
    expect(preview.hasExisting).toBe(false);
    await createDeck(db, { name: 'Появилась позже' });
    const gate = await checkReplaceGate(db, { safetyDone: false, skipSafety: false });
    expect(gate.kind).toBe('need-safety');
    // Данные на месте: ничего не заменялось.
    expect(await db.decks.count()).toBe(1);
  });
});
