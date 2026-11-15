import { beforeAll, describe, expect, it } from 'vitest';
import {
  RATINGS,
  isSrsReady,
  loadSrs,
  newState,
  preview,
  resetSrsForTests,
  review,
  snapshotState,
  srsInfo,
} from './srs';
import type { Rating, SrsState } from './srs';

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;

describe('srs: до загрузки планировщика', () => {
  it('preview и review бросают понятную ошибку, newState работает', () => {
    resetSrsForTests();
    expect(isSrsReady()).toBe(false);
    expect(() => preview(newState(T0), T0)).toThrow(/loadSrs/);
    expect(() => review(newState(T0), 3, T0)).toThrow(/loadSrs/);
    expect(newState(T0).state).toBe('new');
  });
});

describe('srs: адаптер ts-fsrs v6 (модель FSRS-6)', () => {
  beforeAll(async () => {
    await loadSrs();
  });

  it('loadSrs идемпотентен, srsInfo сообщает модель', async () => {
    await loadSrs();
    expect(isSrsReady()).toBe(true);
    expect(srsInfo()).toEqual({ model: 'FSRS-6', ready: true, error: null });
  });

  it('newState: новая карточка к показу сейчас, без истории', () => {
    expect(newState(T0)).toEqual({
      due: T0,
      stability: 0,
      difficulty: 0,
      state: 'new',
      reps: 0,
      lapses: 0,
      scheduledDays: 0,
      learningSteps: 0,
    });
  });

  it('preview новой карточки: интервалы четырёх оценок (эталон)', () => {
    const p = preview(newState(T0), T0);
    expect(RATINGS.map((r) => p[r].intervalMs)).toEqual([
      1 * MIN, // снова
      5.5 * MIN, // трудно
      10 * MIN, // хорошо
      8 * DAY, // легко
    ]);
    expect(p[1].state.state).toBe('learning');
    expect(p[3].state.state).toBe('learning');
    expect(p[4].state.state).toBe('review');
    expect(p[4].state.stability).toBeCloseTo(8.2956, 4);
  });

  it('preview не меняет исходное состояние', () => {
    const s = newState(T0);
    const copy = structuredClone(s);
    preview(s, T0);
    expect(s).toEqual(copy);
  });

  it('review не меняет вход и возвращает снимок прежнего состояния', () => {
    const s = newState(T0);
    const res = review(s, 3, T0);
    expect(s).toEqual(newState(T0));
    expect(res.prev).toEqual(s);
    expect(res.rating).toBe(3);
    expect(res.ts).toBe(T0);
    expect(res.state.reps).toBe(1);
    expect(res.state.lastReview).toBe(T0);
  });

  it('эталонная последовательность оценок: хорошо, хорошо, хорошо, снова, хорошо', () => {
    // Любое обновление библиотеки, меняющее эти числа, должно ронять тест.
    const ratings: Rating[] = [3, 3, 3, 1, 3];
    const expected = [
      { state: 'learning', due: '2026-01-01T00:10:00.000Z', stability: 2.3065, reps: 1, lapses: 0 },
      { state: 'review', due: '2026-01-03T00:10:00.000Z', stability: 2.3065, reps: 2, lapses: 0 },
      { state: 'review', due: '2026-01-14T00:10:00.000Z', stability: 10.97104786, reps: 3, lapses: 0 },
      { state: 'relearning', due: '2026-01-14T00:20:00.000Z', stability: 1.5390125, reps: 4, lapses: 1 },
      { state: 'review', due: '2026-01-16T00:20:00.000Z', stability: 1.57184156, reps: 5, lapses: 1 },
    ];
    let state: SrsState = newState(T0);
    let now = T0;
    ratings.forEach((rating, i) => {
      state = review(state, rating, now).state;
      const e = expected[i]!;
      expect(state.state).toBe(e.state);
      expect(new Date(state.due).toISOString()).toBe(e.due);
      expect(state.stability).toBeCloseTo(e.stability, 6);
      expect(state.reps).toBe(e.reps);
      expect(state.lapses).toBe(e.lapses);
      now = state.due;
    });
  });

  it('состояние переживает сериализацию (как после записи в IndexedDB) и даёт тот же результат', () => {
    let state = newState(T0);
    let now = T0;
    for (const r of [3, 3, 1] as Rating[]) {
      state = review(state, r, now).state;
      now = state.due;
    }
    expect(state.state).toBe('relearning');
    const restored = JSON.parse(JSON.stringify(state)) as SrsState;
    const a = review(state, 3, now);
    const b = review(restored, 3, now);
    expect(b.state).toEqual(a.state);
  });

  it('ранний повтор даёт строго меньший интервал, поздний строго больший (эталон)', () => {
    let s = newState(T0);
    s = review(s, 3, T0).state;
    s = review(s, 3, s.due).state; // review, интервал 2 дня
    const early = review(s, 3, s.due - DAY).state; // на день раньше срока
    const onTime = review(s, 3, s.due).state;
    const late = review(s, 3, s.due + 10 * DAY).state; // на 10 дней позже
    expect(early.scheduledDays).toBeLessThan(onTime.scheduledDays);
    expect(late.scheduledDays).toBeGreaterThan(onTime.scheduledDays);
    expect(early.stability).toBeLessThan(onTime.stability);
    expect(late.stability).toBeGreaterThan(onTime.stability);
    // Конкретные числа закреплены: любое изменение библиотеки обязано ронять тест.
    expect([early.scheduledDays, onTime.scheduledDays, late.scheduledDays]).toEqual([7, 11, 27]);
  });

  it('prev в журнале содержит ровно поля состояния FSRS, даже если передали целую карточку', () => {
    const card = {
      ...newState(T0),
      id: 'card-1',
      deckId: 'deck-1',
      term: '水',
      reading: 'みず',
      definition: 'вода',
      position: 0,
      createdAt: T0,
      updatedAt: T0,
    };
    const res = review(card, 3, T0);
    expect(Object.keys(res.prev).sort()).toEqual(
      ['difficulty', 'due', 'lapses', 'learningSteps', 'reps', 'scheduledDays', 'stability', 'state'].sort(),
    );
    expect(res.prev).toEqual(newState(T0));
    // после первого ответа появляется lastReview, и он тоже попадает в снимок следующего ответа
    const withExtra = { ...res.state, term: 'лишнее' };
    const second = review(withExtra, 3, res.state.due);
    expect(Object.keys(second.prev)).toContain('lastReview');
    expect(second.prev).not.toHaveProperty('term');
    expect(second.prev.lastReview).toBe(T0);
  });

  it('snapshotState не оставляет lastReview, если его не было, и не делится объектом с входом', () => {
    const s = newState(T0);
    const snap = snapshotState(s);
    expect(snap).toEqual(s);
    expect(snap).not.toBe(s);
    expect('lastReview' in snap).toBe(false);
  });

  it('«снова» на карточке в повторении увеличивает число провалов', () => {
    let s = newState(T0);
    s = review(s, 4, T0).state; // сразу в review
    expect(s.state).toBe('review');
    const lapsed = review(s, 1, s.due).state;
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.state).toBe('relearning');
  });

  it('значения preview совпадают с результатом review для той же оценки', () => {
    const s = newState(T0);
    const p = preview(s, T0);
    for (const r of RATINGS) expect(review(s, r, T0).state).toEqual(p[r].state);
  });
});
