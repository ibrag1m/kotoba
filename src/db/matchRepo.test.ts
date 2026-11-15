import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KotobaDB } from './db';
import { recordMatchTime } from './matchRepo';
import { addCards, createDeck, getDeck, listCards, readChangeCounters } from './repo';

const T0 = new Date(2026, 5, 10, 9, 0, 0).getTime();

let n = 0;
let db: KotobaDB;

beforeEach(() => {
  db = new KotobaDB(`kotoba-match-test-${++n}`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await KotobaDB.delete(db.name);
});

async function makeDeck(name = 'N5'): Promise<string> {
  const deck = await createDeck(db, { name }, T0);
  await addCards(db, deck.id, [{ term: '水', reading: 'みず', definition: 'вода' }, { term: '犬', reading: 'いぬ', definition: 'собака' }], T0);
  return deck.id;
}

const seq = async () => (await readChangeCounters(db)).seq;
const best = async (id: string) => (await getDeck(db, id))?.bestMatchMs;

describe('recordMatchTime: рекорд колоды', () => {
  it('первое время записывается как рекорд, счётчик изменений растёт на 1', async () => {
    const id = await makeDeck();
    const before = await seq();
    const res = await recordMatchTime(db, id, 42_300);
    expect(res).toEqual({ isRecord: true, best: 42_300, previous: undefined });
    expect(await best(id)).toBe(42_300);
    expect(await seq()).toBe(before + 1);
  });

  it('лучшее время заменяет прежнее и тоже считается изменением', async () => {
    const id = await makeDeck();
    await recordMatchTime(db, id, 42_300);
    const before = await seq();
    const res = await recordMatchTime(db, id, 30_500);
    expect(res).toEqual({ isRecord: true, best: 30_500, previous: 42_300 });
    expect(await best(id)).toBe(30_500);
    expect(await seq()).toBe(before + 1);
  });

  it('худшее и равное время не пишется: ни рекорда, ни счётчика', async () => {
    const id = await makeDeck();
    await recordMatchTime(db, id, 30_000);
    const before = await seq();
    const worse = await recordMatchTime(db, id, 45_000);
    expect(worse).toEqual({ isRecord: false, best: 30_000, previous: 30_000 });
    const equal = await recordMatchTime(db, id, 30_000);
    expect(equal).toEqual({ isRecord: false, best: 30_000, previous: 30_000 });
    expect(await best(id)).toBe(30_000);
    expect(await seq()).toBe(before);
  });

  it('рекорд колоды не зависит от других колод', async () => {
    const a = await makeDeck('A');
    const b = await makeDeck('B');
    await recordMatchTime(db, a, 20_000);
    expect(await best(b)).toBeUndefined();
    expect((await recordMatchTime(db, b, 50_000)).isRecord).toBe(true);
    expect(await best(a)).toBe(20_000);
  });

  it('время округляется до целых миллисекунд', async () => {
    const id = await makeDeck();
    const res = await recordMatchTime(db, id, 12_345.6);
    expect(res.best).toBe(12_346);
    expect(await best(id)).toBe(12_346);
  });

  it('свободная тренировка: карточки, журнал и updatedAt колоды не меняются', async () => {
    const id = await makeDeck();
    const cardsBefore = await listCards(db, id);
    const deckBefore = await getDeck(db, id);
    const reviewsBefore = await db.reviews.count();
    await recordMatchTime(db, id, 33_000);
    expect(await listCards(db, id)).toEqual(cardsBefore);
    expect(await db.reviews.count()).toBe(reviewsBefore);
    const deckAfter = await getDeck(db, id);
    expect(deckAfter?.updatedAt).toBe(deckBefore?.updatedAt);
    expect({ ...deckAfter, bestMatchMs: undefined }).toEqual({ ...deckBefore, bestMatchMs: undefined });
  });
});

describe('recordMatchTime: одна транзакция с bumpChanges и отказы', () => {
  it('сбой счётчика откатывает и рекорд: колода не меняется', async () => {
    const id = await makeDeck();
    await recordMatchTime(db, id, 40_000);
    const before = await seq();
    vi.spyOn(db.meta, 'put').mockRejectedValueOnce(new Error('сбой счётчика'));
    await expect(recordMatchTime(db, id, 10_000)).rejects.toThrow('сбой счётчика');
    expect(await best(id)).toBe(40_000);
    expect(await seq()).toBe(before);
    // после сбоя повторная попытка проходит
    expect((await recordMatchTime(db, id, 10_000)).isRecord).toBe(true);
    expect(await best(id)).toBe(10_000);
  });

  it('сбой записи колоды не двигает счётчик', async () => {
    const id = await makeDeck();
    const before = await seq();
    vi.spyOn(db.decks, 'update').mockRejectedValueOnce(new Error('сбой колоды'));
    await expect(recordMatchTime(db, id, 10_000)).rejects.toThrow('сбой колоды');
    expect(await best(id)).toBeUndefined();
    expect(await seq()).toBe(before);
  });

  it('несуществующая колода: ошибка, ничего не создаётся и счётчик не растёт', async () => {
    const before = await seq();
    await expect(recordMatchTime(db, 'нет-такой', 10_000)).rejects.toThrow('Колода не найдена');
    expect(await db.decks.count()).toBe(0);
    expect(await seq()).toBe(before);
  });

  it('некорректное время отвергается до записи', async () => {
    const id = await makeDeck();
    const before = await seq();
    for (const bad of [Number.NaN, -1, 0, 0.4, -0, Number.POSITIVE_INFINITY]) {
      await expect(recordMatchTime(db, id, bad)).rejects.toThrow('Недопустимое время');
    }
    expect(await best(id)).toBeUndefined();
    expect(await seq()).toBe(before);
  });

  it('повреждённое прежнее значение (не число) не мешает записать рекорд', async () => {
    const id = await makeDeck();
    await db.decks.update(id, { bestMatchMs: 'плохо' as unknown as number });
    const res = await recordMatchTime(db, id, 20_000);
    expect(res).toEqual({ isRecord: true, best: 20_000, previous: undefined });
    expect(await best(id)).toBe(20_000);
  });
});
