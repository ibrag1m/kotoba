// Тесты по замечаниям ревью: откат транзакций при сбое, образец базы версии 1, поле direction в журнале.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_SCHEMA_VERSION, KotobaDB } from './db';
import { addCards, countCards, createDeck, deleteDeck, getDeck, getMeta, listCards } from './repo';
import { V1_FIXTURE, createV1Database } from './fixtures/schema-v1';
import { newState } from '../core/srs';

let n = 0;
let db: KotobaDB;

beforeEach(() => {
  db = new KotobaDB(`kotoba-review-test-${++n}`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await KotobaDB.delete(db.name);
});

const rev = (cardId: string, deckId: string) => ({
  cardId,
  deckId,
  ts: 1,
  rating: 3 as const,
  mode: 'learn' as const,
  durationMs: 1000,
  prev: newState(0),
});

describe('откат транзакций при сбое', () => {
  it('addCards: сбой на обновлении колоды откатывает уже добавленные карточки', async () => {
    const deck = await createDeck(db, { name: 'N5' }, 1);
    await addCards(db, deck.id, [{ term: '一', definition: 'один' }], 2);
    vi.spyOn(db.decks, 'update').mockRejectedValue(new Error('сбой записи колоды'));

    await expect(
      addCards(
        db,
        deck.id,
        [
          { term: '水', definition: 'вода' },
          { term: '火', definition: 'огонь' },
        ],
        10,
      ),
    ).rejects.toThrow('сбой записи колоды');

    vi.restoreAllMocks();
    expect((await listCards(db, deck.id)).map((c) => c.term)).toEqual(['一']);
    expect((await getDeck(db, deck.id))?.updatedAt).toBe(2);
  });

  it('addCards: сбой посреди массовой вставки (повтор id) не оставляет ни одной новой карточки', async () => {
    const deck = await createDeck(db, { name: 'N5' }, 1);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');

    await expect(
      addCards(db, deck.id, [
        { term: '水', definition: 'вода' },
        { term: '火', definition: 'огонь' },
        { term: '木', definition: 'дерево' },
      ]),
    ).rejects.toThrow();

    vi.restoreAllMocks();
    expect(await countCards(db, deck.id)).toBe(0);
    expect(await db.cards.count()).toBe(0);
  });

  it('deleteDeck: сбой на последнем шаге возвращает назад карточки, журнал и колоду', async () => {
    const a = await createDeck(db, { name: 'A' });
    const [card] = await addCards(db, a.id, [
      { term: '水', definition: 'вода' },
      { term: '火', definition: 'огонь' },
    ]);
    await db.reviews.add(rev(card!.id, a.id));
    vi.spyOn(db.decks, 'delete').mockRejectedValue(new Error('сбой удаления колоды'));

    await expect(deleteDeck(db, a.id)).rejects.toThrow('сбой удаления колоды');

    vi.restoreAllMocks();
    expect(await getDeck(db, a.id)).toBeDefined();
    expect(await countCards(db, a.id)).toBe(2);
    expect(await db.reviews.where('deckId').equals(a.id).count()).toBe(1);
  });

  it('deleteDeck: сбой посреди удаления карточек тоже откатывает удаление журнала', async () => {
    const a = await createDeck(db, { name: 'A' });
    const [card] = await addCards(db, a.id, [{ term: '水', definition: 'вода' }]);
    await db.reviews.add(rev(card!.id, a.id));
    vi.spyOn(db.cards, 'where').mockImplementation(() => {
      throw new Error('сбой чтения карточек');
    });

    await expect(deleteDeck(db, a.id)).rejects.toThrow('сбой чтения карточек');

    vi.restoreAllMocks();
    expect(await db.reviews.where('deckId').equals(a.id).count()).toBe(1);
    expect(await countCards(db, a.id)).toBe(1);
    expect(await getDeck(db, a.id)).toBeDefined();
  });
});

describe('образец базы схемы версии 1 (для будущих тестов миграций)', () => {
  it('база версии 1 открывается текущим KotobaDB, все данные на месте', async () => {
    await createV1Database(db.name);
    db.close();
    db = new KotobaDB(db.name);
    await db.open();

    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    expect(await db.decks.toArray()).toEqual(V1_FIXTURE.decks);
    expect(await db.cards.orderBy('id').toArray()).toEqual([...V1_FIXTURE.cards].sort((x, y) => (x.id < y.id ? -1 : 1)));
    expect(await db.reviews.toArray()).toEqual(V1_FIXTURE.reviews);
    expect(await getMeta<number>(db, 'dailyNewLimit')).toBe(20);
    expect((await listCards(db, 'deck-v1-1')).map((c) => c.term)).toEqual(['水', '食べる']);
  });

  it('индексы версии 1 работают на образце', async () => {
    await createV1Database(db.name);
    db.close();
    db = new KotobaDB(db.name);
    const dueSoon = await db.cards.where('[deckId+due]').between(['deck-v1-1', 0], ['deck-v1-1', Date.UTC(2026, 0, 1, 12)], true, true).toArray();
    expect(dueSoon.map((c) => c.id)).toEqual(['card-v1-new']);
    expect(await db.reviews.where('deckId').equals('deck-v1-1').count()).toBe(1);
  });

  it('фикстура самодостаточна: её схема совпадает с текущей версией 1, а старые записи без direction читаются', async () => {
    expect(DB_SCHEMA_VERSION).toBe(1); // при появлении версии 2 здесь добавляется тест миграции с этой фикстурой
    await createV1Database(db.name);
    db.close();
    db = new KotobaDB(db.name);
    const [first] = await db.reviews.toArray();
    expect(first).toBeDefined();
    expect(first?.direction).toBeUndefined();
  });
});

describe('журнал: поле direction', () => {
  it('сохраняется и читается без изменения версии схемы; без него запись тоже валидна', async () => {
    await db.open();
    expect(db.verno).toBe(1);
    const deck = await createDeck(db, { name: 'N5' });
    const [card] = await addCards(db, deck.id, [{ term: '水', definition: 'вода' }]);
    const a = await db.reviews.add({ ...rev(card!.id, deck.id), direction: 'term-to-def' });
    const b = await db.reviews.add({ ...rev(card!.id, deck.id), direction: 'def-to-term' });
    const c = await db.reviews.add(rev(card!.id, deck.id));
    expect((await db.reviews.get(a))?.direction).toBe('term-to-def');
    expect((await db.reviews.get(b))?.direction).toBe('def-to-term');
    expect((await db.reviews.get(c))?.direction).toBeUndefined();
  });
});
