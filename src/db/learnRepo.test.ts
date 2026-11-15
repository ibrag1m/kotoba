import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KotobaDB } from './db';
import {
  countNewIntroducedToday,
  getAnswerDirection,
  getDailyNewLimit,
  loadLearnInfo,
  recordCardRating,
  undoCardRating,
} from './learnRepo';
import { addCards, createDeck, listCards, readChangeCounters, setMeta } from './repo';
import type { Card } from './types';
import { loadSrs, newState } from '../core/srs';
import type { Rating } from '../core/srs';
import { PORTION_SIZE } from '../core/learn';

const MIN = 60_000;
const DAY = 86_400_000;
// Местное время устройства: границы суток не зависят от часового пояса, на котором идут тесты.
const T0 = new Date(2026, 5, 10, 9, 0, 0).getTime();

let n = 0;
let db: KotobaDB;

beforeAll(async () => {
  await loadSrs();
});

beforeEach(() => {
  db = new KotobaDB(`kotoba-learn-test-${++n}`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await KotobaDB.delete(db.name);
});

async function makeDeck(count: number, name = 'N5', at = T0): Promise<{ deckId: string; cards: Card[] }> {
  const deck = await createDeck(db, { name }, at);
  await addCards(
    db,
    deck.id,
    Array.from({ length: count }, (_, i) => ({ term: `語${i}`, reading: `ご${i}`, definition: `слово ${i}` })),
    at,
  );
  return { deckId: deck.id, cards: await listCards(db, deck.id) };
}

const rate = (cardId: string, rating: Rating, now: number, direction: 'term-to-def' | 'def-to-term' = 'term-to-def') =>
  recordCardRating(db, { cardId, rating, direction, durationMs: 1500 }, now);

const seq = async () => (await readChangeCounters(db)).seq;

describe('recordCardRating', () => {
  it('новая карточка после «хорошо»: изучение, срок через 10 минут, строка журнала с prev', async () => {
    const { cards } = await makeDeck(1);
    const card = cards[0] as Card;
    const seqBefore = await seq();
    const res = await rate(card.id, 3, T0 + 5000, 'def-to-term');

    const after = (await db.cards.get(card.id)) as Card;
    expect(after.state).toBe('learning');
    expect(after.due).toBe(T0 + 5000 + 10 * MIN);
    expect(after.reps).toBe(1);
    expect(after.lastReview).toBe(T0 + 5000);
    expect(res.state.due).toBe(after.due);
    // содержимое карточки не тронуто
    expect(after).toMatchObject({ term: '語0', reading: 'ご0', definition: 'слово 0', position: 0, deckId: card.deckId });

    const rows = await db.reviews.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: res.reviewId,
      cardId: card.id,
      deckId: card.deckId,
      ts: T0 + 5000,
      rating: 3,
      mode: 'learn',
      direction: 'def-to-term',
      durationMs: 1500,
      prev: newState(T0),
    });
    expect(await seq()).toBe(seqBefore + 1);
  });

  it('интервалы четырёх оценок новой карточки: 1 мин, 5,5 мин, 10 мин, 8 дней', async () => {
    const { cards } = await makeDeck(4);
    const expected: Record<Rating, number> = { 1: MIN, 2: 5.5 * MIN, 3: 10 * MIN, 4: 8 * DAY };
    for (const [i, rating] of ([1, 2, 3, 4] as Rating[]).entries()) {
      const c = cards[i] as Card;
      await rate(c.id, rating, T0);
      expect(((await db.cards.get(c.id)) as Card).due - T0).toBe(expected[rating]);
    }
  });

  it('prev содержит только поля состояния FSRS, без содержимого карточки', async () => {
    const { cards } = await makeDeck(1);
    await rate((cards[0] as Card).id, 3, T0);
    const row = (await db.reviews.toArray())[0];
    expect(Object.keys(row?.prev ?? {}).sort()).toEqual(
      ['difficulty', 'due', 'learningSteps', 'lapses', 'reps', 'scheduledDays', 'stability', 'state'].sort(),
    );
  });

  it('сбой записи журнала или счётчика откатывает и карточку: ничего не меняется', async () => {
    const { cards } = await makeDeck(1);
    const card = cards[0] as Card;
    const seqBefore = await seq();

    vi.spyOn(db.reviews, 'add').mockRejectedValueOnce(new Error('сбой журнала'));
    await expect(rate(card.id, 3, T0 + 1000)).rejects.toThrow('сбой журнала');
    expect(await db.cards.get(card.id)).toEqual(card);
    expect(await db.reviews.count()).toBe(0);
    expect(await seq()).toBe(seqBefore);

    vi.restoreAllMocks();
    vi.spyOn(db.meta, 'put').mockRejectedValueOnce(new Error('сбой счётчика'));
    await expect(rate(card.id, 3, T0 + 1000)).rejects.toThrow('сбой счётчика');
    expect(await db.cards.get(card.id)).toEqual(card);
    expect(await db.reviews.count()).toBe(0);
    expect(await seq()).toBe(seqBefore);
  });

  it('несуществующая карточка и недопустимая оценка: ошибка, ничего не записано', async () => {
    await expect(rate('нет-такой', 3, T0)).rejects.toThrow('Карточка не найдена');
    const { cards } = await makeDeck(1);
    await expect(rate((cards[0] as Card).id, 7 as Rating, T0)).rejects.toThrow('Недопустимая оценка');
    expect(await db.reviews.count()).toBe(0);
  });

  it('каждая запись увеличивает счётчик изменений на 1', async () => {
    const { cards } = await makeDeck(2);
    const s0 = await seq();
    await rate((cards[0] as Card).id, 3, T0);
    await rate((cards[1] as Card).id, 1, T0);
    expect(await seq()).toBe(s0 + 2);
  });

  it('повторная оценка той же карточки: prev это состояние перед ответом', async () => {
    const { cards } = await makeDeck(1);
    const id = (cards[0] as Card).id;
    const first = await rate(id, 3, T0);
    await rate(id, 3, T0 + 10 * MIN);
    const rows = await db.reviews.orderBy('id').toArray();
    expect(rows.map((r) => r.prev.state)).toEqual(['new', 'learning']);
    expect(rows[1]?.prev).toEqual(first.state);
    expect(((await db.cards.get(id)) as Card).state).toBe('review');
  });
});

describe('сдвиг времени: когда карточка появляется в очереди', () => {
  it('после «хорошо» в очереди только когда наступил срок (10 минут)', async () => {
    const { deckId, cards } = await makeDeck(2);
    const a = cards[0] as Card;
    await rate(a.id, 3, T0);

    const justBefore = await loadLearnInfo(db, deckId, T0 + 10 * MIN - 1);
    expect(justBefore.queue.due.map((c) => c.id)).toEqual([]);
    const onTime = await loadLearnInfo(db, deckId, T0 + 10 * MIN);
    expect(onTime.queue.due.map((c) => c.id)).toEqual([a.id]);
    expect(onTime.queue.nextDueAt).toBeNull();
    expect(justBefore.queue.nextDueAt).toBe(T0 + 10 * MIN);
  });

  it('после «легко» карточка возвращается через 8 дней, а не раньше', async () => {
    const { deckId, cards } = await makeDeck(1);
    const a = cards[0] as Card;
    await rate(a.id, 4, T0);
    expect((await loadLearnInfo(db, deckId, T0 + 8 * DAY - 1)).queue.due).toHaveLength(0);
    expect((await loadLearnInfo(db, deckId, T0 + 8 * DAY)).queue.due.map((c) => c.id)).toEqual([a.id]);
  });

  it('вторая «хорошо» по сроку отодвигает карточку на дни, затем «снова» возвращает на минуты', async () => {
    const { deckId, cards } = await makeDeck(1);
    const a = cards[0] as Card;
    await rate(a.id, 3, T0);
    await rate(a.id, 3, T0 + 10 * MIN);
    const reviewed = (await db.cards.get(a.id)) as Card;
    expect(reviewed.state).toBe('review');
    expect(reviewed.due - (T0 + 10 * MIN)).toBe(2 * DAY);
    expect((await loadLearnInfo(db, deckId, T0 + DAY)).queue.due).toHaveLength(0);
    expect((await loadLearnInfo(db, deckId, reviewed.due)).queue.due).toHaveLength(1);

    await rate(a.id, 1, reviewed.due);
    const lapsed = (await db.cards.get(a.id)) as Card;
    expect(lapsed.state).toBe('relearning');
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.due - reviewed.due).toBe(10 * MIN);
  });

  it('в очереди сначала карточки к повторению, затем новые', async () => {
    const { deckId, cards } = await makeDeck(4);
    await rate((cards[2] as Card).id, 4, T0 - 20 * DAY);
    const info = await loadLearnInfo(db, deckId, T0);
    expect(info.queue.list.map((c) => c.id)).toEqual([(cards[2] as Card).id, (cards[0] as Card).id, (cards[1] as Card).id, (cards[3] as Card).id]);
    expect(info.queue.due).toHaveLength(1);
    expect(info.queue.fresh).toHaveLength(3);
  });
});

describe('дневной лимит новых карточек', () => {
  it('по умолчанию 20; из настроек; повреждённое значение даёт 20', async () => {
    expect(await getDailyNewLimit(db)).toBe(20);
    await setMeta(db, 'dailyNewLimit', 5);
    expect(await getDailyNewLimit(db)).toBe(5);
    await setMeta(db, 'dailyNewLimit', 0);
    expect(await getDailyNewLimit(db)).toBe(0);
    for (const bad of [-1, 1.5, 'много', null, 5000, Number.NaN]) {
      await db.meta.put({ key: 'dailyNewLimit', value: bad });
      expect(await getDailyNewLimit(db)).toBe(20);
    }
  });

  it('направление ответа из настроек; по умолчанию оба', async () => {
    expect(await getAnswerDirection(db)).toBe('both');
    await setMeta(db, 'answerDirection', 'def-to-term');
    expect(await getAnswerDirection(db)).toBe('def-to-term');
    await db.meta.put({ key: 'answerDirection', value: 'что-то' });
    expect(await getAnswerDirection(db)).toBe('both');
  });

  it('новые карточки ограничены остатком лимита; введённые сегодня уменьшают остаток', async () => {
    const { deckId, cards } = await makeDeck(10);
    await setMeta(db, 'dailyNewLimit', 4);
    let info = await loadLearnInfo(db, deckId, T0);
    expect([info.newLimit, info.newIntroducedToday, info.newRemaining]).toEqual([4, 0, 4]);
    expect(info.queue.fresh).toHaveLength(4);
    expect(info.queue.newTotal).toBe(10);

    await rate((cards[0] as Card).id, 3, T0);
    await rate((cards[1] as Card).id, 1, T0);
    info = await loadLearnInfo(db, deckId, T0 + MIN);
    expect([info.newIntroducedToday, info.newRemaining]).toEqual([2, 2]);
    expect(info.queue.fresh.map((c) => c.id)).toEqual([(cards[2] as Card).id, (cards[3] as Card).id]);
  });

  it('повторный ответ по уже начатой карточке не считается новой карточкой', async () => {
    const { cards } = await makeDeck(2);
    const id = (cards[0] as Card).id;
    await rate(id, 1, T0);
    await rate(id, 3, T0 + MIN);
    await rate(id, 3, T0 + 20 * MIN);
    expect(await countNewIntroducedToday(db, T0 + 30 * MIN)).toBe(1);
  });

  it('когда лимит исчерпан, новых в очереди нет, но карточки к повторению остаются', async () => {
    const { deckId, cards } = await makeDeck(5);
    await setMeta(db, 'dailyNewLimit', 2);
    await rate((cards[0] as Card).id, 3, T0);
    await rate((cards[1] as Card).id, 3, T0);
    const info = await loadLearnInfo(db, deckId, T0 + 11 * MIN);
    expect(info.newRemaining).toBe(0);
    expect(info.queue.fresh).toEqual([]);
    expect(info.queue.due.map((c) => c.id).sort()).toEqual([(cards[0] as Card).id, (cards[1] as Card).id].sort());
  });

  it('лимит ноль: новых нет совсем', async () => {
    const { deckId } = await makeDeck(3);
    await setMeta(db, 'dailyNewLimit', 0);
    const info = await loadLearnInfo(db, deckId, T0);
    expect(info.queue.fresh).toEqual([]);
    expect(info.queue.list).toEqual([]);
  });

  it('граница суток по местному времени: в 23:59 учтено, после полуночи счёт с нуля', async () => {
    const { deckId, cards } = await makeDeck(6);
    await setMeta(db, 'dailyNewLimit', 3);
    const late = new Date(2026, 5, 10, 23, 59, 30).getTime();
    await rate((cards[0] as Card).id, 3, late);
    await rate((cards[1] as Card).id, 3, late);
    expect((await loadLearnInfo(db, deckId, late + 20_000)).newRemaining).toBe(1);

    const afterMidnight = new Date(2026, 5, 11, 0, 0, 5).getTime();
    expect(await countNewIntroducedToday(db, afterMidnight)).toBe(0);
    const next = await loadLearnInfo(db, deckId, afterMidnight);
    expect(next.newRemaining).toBe(3);
    expect(next.queue.fresh).toHaveLength(3);
    // вчерашнее по-прежнему вчерашнее
    expect(await countNewIntroducedToday(db, new Date(2026, 5, 10, 8, 0).getTime())).toBe(2);
  });

  it('лимит общий для всех колод', async () => {
    const a = await makeDeck(3, 'A');
    const b = await makeDeck(3, 'B');
    await setMeta(db, 'dailyNewLimit', 3);
    await rate((a.cards[0] as Card).id, 3, T0);
    await rate((a.cards[1] as Card).id, 3, T0);
    expect(await countNewIntroducedToday(db, T0)).toBe(2);
    const info = await loadLearnInfo(db, b.deckId, T0 + MIN);
    expect(info.newRemaining).toBe(1);
    expect(info.queue.fresh).toHaveLength(1);
  });

  it('границы порции: в очереди больше 7, порция берёт первые 7', async () => {
    const { deckId } = await makeDeck(12);
    const info = await loadLearnInfo(db, deckId, T0);
    expect(info.queue.list).toHaveLength(12);
    expect(info.queue.list.slice(0, PORTION_SIZE)).toHaveLength(7);
  });
});

describe('undoCardRating', () => {
  it('возвращает карточку к состоянию до ответа и удаляет строку журнала', async () => {
    const { cards } = await makeDeck(1);
    const card = cards[0] as Card;
    const res = await rate(card.id, 3, T0 + 1000);
    expect(((await db.cards.get(card.id)) as Card).state).toBe('learning');

    const seqBefore = await seq();
    await undoCardRating(db, res.reviewId);
    expect(await db.cards.get(card.id)).toEqual(card);
    expect('lastReview' in ((await db.cards.get(card.id)) as Card)).toBe(false);
    expect(await db.reviews.count()).toBe(0);
    expect(await seq()).toBe(seqBefore + 1);
  });

  it('счёт новых за день восстанавливается, карточка снова новая и снова в очереди', async () => {
    const { deckId, cards } = await makeDeck(3);
    await setMeta(db, 'dailyNewLimit', 2);
    const res = await rate((cards[0] as Card).id, 3, T0);
    expect((await loadLearnInfo(db, deckId, T0 + MIN)).newRemaining).toBe(1);
    await undoCardRating(db, res.reviewId);
    const info = await loadLearnInfo(db, deckId, T0 + MIN);
    expect(info.newRemaining).toBe(2);
    expect(info.queue.fresh.map((c) => c.id)).toEqual([(cards[0] as Card).id, (cards[1] as Card).id]);
  });

  it('откат второго ответа возвращает состояние после первого', async () => {
    const { cards } = await makeDeck(1);
    const id = (cards[0] as Card).id;
    const first = await rate(id, 3, T0);
    const afterFirst = (await db.cards.get(id)) as Card;
    const second = await rate(id, 3, T0 + 10 * MIN);
    await undoCardRating(db, second.reviewId);
    expect(await db.cards.get(id)).toEqual(afterFirst);
    expect((await db.cards.get(id)) as Card).toMatchObject(first.state);
    expect(await db.reviews.count()).toBe(1);
  });

  it('нельзя отменить ответ, после которого уже был другой: ничего не меняется', async () => {
    const { cards } = await makeDeck(1);
    const id = (cards[0] as Card).id;
    const first = await rate(id, 3, T0);
    await rate(id, 3, T0 + 10 * MIN);
    const before = (await db.cards.get(id)) as Card;
    const seqBefore = await seq();
    await expect(undoCardRating(db, first.reviewId)).rejects.toThrow('Отменить нельзя');
    expect(await db.cards.get(id)).toEqual(before);
    expect(await db.reviews.count()).toBe(2);
    expect(await seq()).toBe(seqBefore);
  });

  it('повторная отмена и несуществующая запись: понятная ошибка', async () => {
    const { cards } = await makeDeck(1);
    const res = await rate((cards[0] as Card).id, 3, T0);
    await undoCardRating(db, res.reviewId);
    await expect(undoCardRating(db, res.reviewId)).rejects.toThrow('Запись об ответе не найдена');
    await expect(undoCardRating(db, 9999)).rejects.toThrow('Запись об ответе не найдена');
  });

  it('сбой посреди отмены откатывает всю транзакцию', async () => {
    const { cards } = await makeDeck(1);
    const id = (cards[0] as Card).id;
    const res = await rate(id, 3, T0);
    const rated = (await db.cards.get(id)) as Card;
    const seqBefore = await seq();
    vi.spyOn(db.meta, 'put').mockRejectedValueOnce(new Error('сбой счётчика'));
    await expect(undoCardRating(db, res.reviewId)).rejects.toThrow('сбой счётчика');
    expect(await db.cards.get(id)).toEqual(rated);
    expect(await db.reviews.count()).toBe(1);
    expect(await seq()).toBe(seqBefore);
  });
});
