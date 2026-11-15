import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_SCHEMA_VERSION, KotobaDB } from './db';
import {
  addCards,
  countCards,
  createDeck,
  deleteDeck,
  getDeck,
  getMeta,
  listCards,
  listDeckSummaries,
  setMeta,
} from './repo';
import { newState } from '../core/srs';

let n = 0;
let db: KotobaDB;

beforeEach(() => {
  db = new KotobaDB(`kotoba-test-${++n}`);
});

afterEach(async () => {
  db.close();
  await KotobaDB.delete(db.name);
});

describe('схема', () => {
  it('версия 1 и все таблицы на месте', async () => {
    await db.open();
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    expect(DB_SCHEMA_VERSION).toBe(1);
    expect(db.tables.map((t) => t.name).sort()).toEqual(['cards', 'decks', 'meta', 'reviews']);
    expect(db.table('cards').schema.indexes.map((i) => i.name).sort()).toEqual([
      '[deckId+due]',
      '[deckId+position]',
      'deckId',
      'due',
    ]);
  });
});

describe('колоды', () => {
  it('создание: значения по умолчанию для японского', async () => {
    const deck = await createDeck(db, { name: '  N5  ' }, 1000);
    expect(deck).toMatchObject({ name: 'N5', termLang: 'ja-JP', defLang: 'ru-RU', createdAt: 1000, updatedAt: 1000 });
    expect(deck.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getDeck(db, deck.id)).toEqual(deck);
  });

  it('пустое название отклоняется', async () => {
    await expect(createDeck(db, { name: '   ' })).rejects.toThrow();
    expect(await db.decks.count()).toBe(0);
  });

  it('список: свежие сверху, с числом карточек', async () => {
    const a = await createDeck(db, { name: 'A' }, 1);
    const b = await createDeck(db, { name: 'B' }, 2);
    await addCards(db, a.id, [{ term: '水', definition: 'вода' }], 3);
    const list = await listDeckSummaries(db);
    expect(list.map((d) => [d.name, d.cardCount])).toEqual([
      ['A', 1],
      ['B', 0],
    ]);
    expect(list[0]?.id).toBe(a.id);
    expect(list[1]?.id).toBe(b.id);
  });
});

describe('карточки', () => {
  it('добавление: порядок, позиции, начальное состояние повторений', async () => {
    const deck = await createDeck(db, { name: 'N5' }, 1);
    const created = await addCards(
      db,
      deck.id,
      [
        { term: ' 食べる ', reading: 'たべる', definition: 'есть' },
        { term: '水', definition: 'вода', example: '水を飲む。' },
        { term: '', definition: 'пустое слово' },
        { term: 'пустое определение', definition: '  ' },
      ],
      500,
    );
    expect(created).toHaveLength(2);
    const cards = await listCards(db, deck.id);
    expect(cards.map((c) => [c.term, c.position])).toEqual([
      ['食べる', 0],
      ['水', 1],
    ]);
    expect(cards[0]).toMatchObject({ reading: 'たべる', definition: 'есть', deckId: deck.id });
    expect(cards[1]?.reading).toBeUndefined();
    expect(cards[1]?.example).toBe('水を飲む。');
    expect(cards[0]).toMatchObject(newState(500));
    expect(cards[0]).toMatchObject({ createdAt: 500, updatedAt: 500, state: 'new', due: 500 });
    expect((await getDeck(db, deck.id))?.updatedAt).toBe(500);
  });

  it('позиции продолжаются в следующем импорте, колоды не смешиваются', async () => {
    const a = await createDeck(db, { name: 'A' });
    const b = await createDeck(db, { name: 'B' });
    await addCards(db, a.id, [{ term: '一', definition: 'один' }, { term: '二', definition: 'два' }]);
    await addCards(db, b.id, [{ term: '犬', definition: 'собака' }]);
    await addCards(db, a.id, [{ term: '三', definition: 'три' }]);
    expect((await listCards(db, a.id)).map((c) => [c.term, c.position])).toEqual([
      ['一', 0],
      ['二', 1],
      ['三', 2],
    ]);
    expect((await listCards(db, b.id)).map((c) => c.position)).toEqual([0]);
    expect(await countCards(db, a.id)).toBe(3);
  });

  it('добавление в несуществующую колоду отклоняется и ничего не пишет', async () => {
    await expect(addCards(db, 'нет-такой', [{ term: '水', definition: 'вода' }])).rejects.toThrow();
    expect(await db.cards.count()).toBe(0);
  });

  it('данные переживают переоткрытие базы', async () => {
    const deck = await createDeck(db, { name: 'N5' });
    await addCards(db, deck.id, [{ term: '水', reading: 'みず', definition: 'вода' }]);
    const name = db.name;
    db.close();
    db = new KotobaDB(name);
    expect((await listCards(db, deck.id)).map((c) => c.term)).toEqual(['水']);
  });

  it('индекс [deckId+due] находит карточки к повторению', async () => {
    const deck = await createDeck(db, { name: 'N5' });
    await addCards(db, deck.id, [{ term: '水', definition: 'вода' }], 1000);
    const due = await db.cards.where('[deckId+due]').between([deck.id, 0], [deck.id, 1000], true, true).count();
    const notDue = await db.cards.where('[deckId+due]').between([deck.id, 0], [deck.id, 999], true, true).count();
    expect([due, notDue]).toEqual([1, 0]);
  });
});

describe('удаление колоды', () => {
  it('удаляет колоду, её карточки и журнал; чужие данные не трогает', async () => {
    const a = await createDeck(db, { name: 'A' });
    const b = await createDeck(db, { name: 'B' });
    const [ca] = await addCards(db, a.id, [{ term: '水', definition: 'вода' }]);
    const [cb] = await addCards(db, b.id, [{ term: '火', definition: 'огонь' }]);
    const rev = (cardId: string, deckId: string) => ({
      cardId,
      deckId,
      ts: 1,
      rating: 3 as const,
      mode: 'learn' as const,
      durationMs: 1000,
      prev: newState(0),
    });
    await db.reviews.bulkAdd([rev(ca!.id, a.id), rev(cb!.id, b.id)]);

    await deleteDeck(db, a.id);

    expect(await getDeck(db, a.id)).toBeUndefined();
    expect(await countCards(db, a.id)).toBe(0);
    expect(await db.reviews.where('deckId').equals(a.id).count()).toBe(0);
    expect(await getDeck(db, b.id)).toBeDefined();
    expect(await countCards(db, b.id)).toBe(1);
    expect(await db.reviews.where('deckId').equals(b.id).count()).toBe(1);
  });
});

describe('meta', () => {
  it('ключ-значение', async () => {
    expect(await getMeta(db, 'dailyNewLimit')).toBeUndefined();
    await setMeta(db, 'dailyNewLimit', 20);
    await setMeta(db, 'voiceByLang', { 'ja-JP': 'Kyoko' });
    expect(await getMeta<number>(db, 'dailyNewLimit')).toBe(20);
    expect(await getMeta(db, 'voiceByLang')).toEqual({ 'ja-JP': 'Kyoko' });
    await setMeta(db, 'dailyNewLimit', 30);
    expect(await getMeta<number>(db, 'dailyNewLimit')).toBe(30);
  });
});
