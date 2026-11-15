// Движок порции (core/learn) вместе с записью в базу (db/learnRepo): так же, как их соединяет экран.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KotobaDB } from './db';
import { loadLearnInfo, recordCardRating, undoCardRating } from './learnRepo';
import { addCards, createDeck, readChangeCounters } from './repo';
import type { Card } from './types';
import {
  currentCard,
  dontKnow,
  isDone,
  markTooEasy,
  next,
  startPortion,
  submitChoice,
  submitTyped,
  summarize,
  undo,
} from '../core/learn';
import type { Completion, LearnSession } from '../core/learn';
import { loadSrs } from '../core/srs';
import { seededRng } from '../core/shuffle';

const MIN = 60_000;
const T0 = new Date(2026, 5, 10, 9, 0, 0).getTime();

let n = 0;
let db: KotobaDB;
let deckId: string;

beforeAll(async () => {
  await loadSrs();
});

beforeEach(async () => {
  db = new KotobaDB(`kotoba-flow-test-${++n}`);
  const deck = await createDeck(db, { name: 'N5' }, T0);
  deckId = deck.id;
  await addCards(
    db,
    deckId,
    Array.from({ length: 10 }, (_, i) => ({ term: `語${i}`, reading: `ご${i}`, definition: `слово ${i}` })),
    T0,
  );
});

afterEach(async () => {
  db.close();
  await KotobaDB.delete(db.name);
});

/** Шаг экрана «Дальше»: сначала запись завершений в базу, потом новое состояние сессии. */
async function step(s: LearnSession, now: number, written: Map<string, number>): Promise<{ s: LearnSession; done: Completion[] }> {
  const r = next(s, { now });
  for (const c of r.completions) {
    const res = await recordCardRating(db, { cardId: c.cardId, rating: c.rating, direction: c.direction, durationMs: c.durationMs }, now);
    written.set(c.cardId, res.reviewId);
  }
  return { s: r.session, done: r.completions };
}

function right(s: LearnSession, now: number): LearnSession {
  const q = s.state.question;
  const card = currentCard(s);
  if (!q || !card) throw new Error('нет вопроса');
  if (q.stage === 'choice') return submitChoice(s, q.options.findIndex((o) => o.cardId === q.cardId), { now });
  return submitTyped(s, q.direction === 'def-to-term' ? card.term : card.definition, { now });
}

describe('порция целиком с записью в расписание', () => {
  it('7 карточек с разными исходами: оценки в базе совпадают с итогом движка, счётчики дня и очередь согласованы', async () => {
    const info = await loadLearnInfo(db, deckId, T0);
    expect(info.queue.list).toHaveLength(10);
    let s = startPortion(info.queue.list, info.cards, { now: T0, rng: seededRng(3) });
    const portionIds = s.state.cards.map((c) => c.id);
    expect(portionIds).toHaveLength(7);

    const written = new Map<string, number>();
    let t = T0;
    const doneAll: Completion[] = [];
    let first = true;
    let easyId: string | undefined;
    let stumbledId: string | undefined;
    let unknownId: string | undefined;
    let guard = 0;
    while (!isDone(s)) {
      if (++guard > 200) throw new Error('не завершается');
      t += 2000;
      const id = s.state.question?.cardId as string;
      if (first) {
        // самая первая карточка: «Не знаю» на выборе
        first = false;
        unknownId = id;
        s = dontKnow(s, { now: t });
      } else if (!stumbledId && id !== unknownId && s.state.question?.stage === 'choice') {
        // вторая: ошибка выбора
        stumbledId = id;
        const q = s.state.question;
        s = submitChoice(s, q.options.findIndex((o) => o.cardId !== q.cardId), { now: t });
      } else if (!easyId && id !== unknownId && id !== stumbledId && s.state.question?.stage === 'typing') {
        // первая подходящая на этапе ввода: верно и «слишком легко» (у новой карточки кнопка есть только после ввода)
        easyId = id;
        s = markTooEasy(right(s, t));
      } else {
        s = right(s, t);
      }
      const r = await step(s, t, written);
      s = r.s;
      doneAll.push(...r.done);
    }

    expect(doneAll).toHaveLength(7);
    const byId = new Map(doneAll.map((c) => [c.cardId, c]));
    expect(byId.get(unknownId as string)?.rating).toBe(1);
    expect(byId.get(stumbledId as string)?.rating).toBe(2);
    expect(byId.get(easyId as string)?.rating).toBe(4);
    const others = doneAll.filter((c) => ![unknownId, stumbledId, easyId].includes(c.cardId));
    expect(others).toHaveLength(4);
    expect(others.every((c) => c.rating === 3)).toBe(true);

    // база: по строке журнала на каждую карточку, оценка и режим совпадают
    const rows = await db.reviews.toArray();
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.mode).toBe('learn');
      expect(row.rating).toBe(byId.get(row.cardId)?.rating);
      expect(row.prev.state).toBe('new');
      expect(row.direction).toBeDefined();
    }
    expect(summarize(s)).toMatchObject({ total: 7, firstTry: 5, ratings: { 1: 1, 2: 1, 3: 4, 4: 1 } });

    // дневной счёт: введено 7 новых, осталось 20 - 7, но в колоде остаётся 3 новых
    const after = await loadLearnInfo(db, deckId, t + MIN);
    expect(after.newIntroducedToday).toBe(7);
    expect(after.queue.fresh).toHaveLength(3);
    // «снова» (1 минута) уже к повторению, остальные позже
    expect(after.queue.due.map((c) => c.id)).toEqual([unknownId]);
    // через 10 минут к повторению и «хорошо»/«трудно» (трудно: 5,5 минут, хорошо: 10 минут)
    const later = await loadLearnInfo(db, deckId, t + 11 * MIN);
    expect(later.queue.due.length).toBe(6);
    expect(later.queue.due.map((c) => c.id)).not.toContain(easyId);
  });

  it('отмена: ответ, завершивший карточку, откатывается и в сессии, и в базе (карточка и журнал)', async () => {
    const info = await loadLearnInfo(db, deckId, T0);
    // колода из 3 карточек: сразу ввод, первый верный ответ завершает карточку
    const small = info.cards.slice(0, 3);
    let s = startPortion(small, small, { now: T0 }, { directions: 'term-to-def' });
    const written = new Map<string, number>();
    const id = s.state.question?.cardId as string;
    const before = (await db.cards.get(id)) as Card;

    s = right(s, T0 + 1000);
    const r = await step(s, T0 + 2000, written);
    expect(r.done).toHaveLength(1);
    expect(await db.reviews.count()).toBe(1);
    expect(((await db.cards.get(id)) as Card).state).toBe('learning');
    const seqBefore = (await readChangeCounters(db)).seq;

    const u = undo(r.s, { now: T0 + 3000 });
    expect(u.rolledBack).toHaveLength(1);
    for (const c of u.rolledBack) {
      await undoCardRating(db, written.get(c.cardId) as number);
      written.delete(c.cardId);
    }
    expect(await db.cards.get(id)).toEqual(before);
    expect(await db.reviews.count()).toBe(0);
    expect((await readChangeCounters(db)).seq).toBe(seqBefore + 1);
    expect((await loadLearnInfo(db, deckId, T0 + 4000)).newIntroducedToday).toBe(0);

    // можно ответить заново, теперь с «не знаю»: у этой карточки оценка 1, на каждую карточку одна строка журнала
    s = dontKnow(u.session, { now: T0 + 5000 });
    const out: Completion[] = [];
    let t = T0 + 6000;
    let cur = await step(s, t, written);
    out.push(...cur.done);
    while (!isDone(cur.s)) {
      t += 2000;
      cur = await step(right(cur.s, t), t + 1000, written);
      out.push(...cur.done);
    }
    expect(out).toHaveLength(3);
    expect(out.find((c) => c.cardId === id)?.rating).toBe(1);
    expect(await db.reviews.count()).toBe(3);
    expect((await db.reviews.where('cardId').equals(id).toArray()).map((r) => r.rating)).toEqual([1]);
  });
});
