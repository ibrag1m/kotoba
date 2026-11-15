// Запись «Заучивания» в базу: очередь колоды, дневной лимит новых карточек, оценка карточки и её отмена.
//
// ПРАВИЛО проекта: любая запись данных вызывает bumpChanges в той же транзакции. Здесь так и сделано: и запись оценки,
// и отмена пишут карточку, журнал и счётчик изменений одной транзакцией (либо всё, либо ничего).
//
// «Была ли карточка новой» определяется по журналу без поля-метки и без новой версии схемы: в каждой записи reviews
// лежит снимок prev (состояние до ответа), и prev.state === 'new' отличает первый ответ по новой карточке. У каждой
// карточки такая запись может быть только одна (после первого ответа карточка уже не «new»), отмена удаляет строку
// журнала, поэтому счёт новых за день восстанавливается сам.
import { buildQueue, startOfLocalDay, startOfNextLocalDay } from '../core/learn';
import type { Direction, DirectionMode, LearnQueue } from '../core/learn';
import { RATINGS, review } from '../core/srs';
import type { Rating, SrsState } from '../core/srs';
import type { KotobaDB } from './db';
import { ANSWER_DIRECTIONS, DAILY_NEW_LIMIT_MAX, DEFAULT_DAILY_NEW_LIMIT } from './metaKeys';
import { bumpChanges, getMeta, listCards } from './repo';
import type { Card } from './types';

/** Дневной лимит новых карточек из настроек; пустое или повреждённое значение даёт значение по умолчанию. */
export async function getDailyNewLimit(db: KotobaDB): Promise<number> {
  const v = await getMeta(db, 'dailyNewLimit');
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= DAILY_NEW_LIMIT_MAX ? v : DEFAULT_DAILY_NEW_LIMIT;
}

/** Направление вопросов из настроек; по умолчанию оба вперемешку. */
export async function getAnswerDirection(db: KotobaDB): Promise<DirectionMode> {
  const v = await getMeta(db, 'answerDirection');
  return typeof v === 'string' && (ANSWER_DIRECTIONS as readonly string[]).includes(v) ? (v as DirectionMode) : 'both';
}

/**
 * Сколько новых карточек введено сегодня (по местному времени устройства) по ВСЕМ колодам: лимит «новых слов в
 * день» один на пользователя. Считаются записи журнала с prev.state === 'new'.
 */
export function countNewIntroducedToday(db: KotobaDB, now: number): Promise<number> {
  return db.reviews
    .where('ts')
    .between(startOfLocalDay(now), startOfNextLocalDay(now), true, false)
    .filter((r) => r.prev.state === 'new')
    .count();
}

export interface LearnInfo {
  /** Все карточки колоды (из них берутся варианты-обманки). */
  cards: Card[];
  queue: LearnQueue;
  newLimit: number;
  newIntroducedToday: number;
  /** Сколько новых карточек ещё можно ввести сегодня. */
  newRemaining: number;
}

/** Читает очередь колоды на момент now одним согласованным снимком. */
export function loadLearnInfo(db: KotobaDB, deckId: string, now: number): Promise<LearnInfo> {
  return db.transaction('r', db.cards, db.reviews, db.meta, async () => {
    const [cards, newLimit, newIntroducedToday] = await Promise.all([
      listCards(db, deckId),
      getDailyNewLimit(db),
      countNewIntroducedToday(db, now),
    ]);
    const newRemaining = Math.max(0, newLimit - newIntroducedToday);
    return { cards, queue: buildQueue(cards, now, newRemaining), newLimit, newIntroducedToday, newRemaining };
  });
}

export interface RatingInput {
  cardId: string;
  rating: Rating;
  direction: Direction;
  durationMs: number;
}

export interface RatingResult {
  /** Ключ добавленной строки журнала: по нему оценку можно отменить. */
  reviewId: number;
  /** Состояние карточки после оценки. */
  state: SrsState;
}

/** Карточка с новым состоянием повторений; необязательное lastReview убирается, если в состоянии его нет. */
function withSrs(card: Card, s: SrsState): Card {
  const next: Card = { ...card, ...s };
  if (s.lastReview === undefined) delete next.lastReview;
  return next;
}

/**
 * Записывает оценку карточки в расписание ОДНОЙ транзакцией: состояние карточки (через srs.ts), строка журнала
 * (mode «learn», направление, длительность, снимок prev) и счётчик изменений. Планировщик должен быть загружен
 * (loadSrs): иначе бросает ошибку и ничего не меняется.
 */
export async function recordCardRating(db: KotobaDB, input: RatingInput, now: number = Date.now()): Promise<RatingResult> {
  if (!RATINGS.includes(input.rating)) throw new Error(`Недопустимая оценка: ${String(input.rating)}`);
  const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : 0;
  return db.transaction('rw', db.cards, db.reviews, db.meta, async () => {
    const card = await db.cards.get(input.cardId);
    if (!card) throw new Error('Карточка не найдена');
    const res = review(card, input.rating, now);
    await db.cards.put(withSrs(card, res.state));
    const reviewId = await db.reviews.add({
      cardId: card.id,
      deckId: card.deckId,
      ts: now,
      rating: input.rating,
      mode: 'learn',
      direction: input.direction,
      durationMs,
      prev: res.prev,
    });
    await bumpChanges(db);
    return { reviewId, state: res.state };
  });
}

/**
 * Отменяет оценку: возвращает карточку к снимку prev и удаляет строку журнала, одной транзакцией вместе со счётчиком
 * изменений. Если после этого ответа карточка уже оценивалась ещё раз, отмена отказывает (откат был бы неверным).
 */
export function undoCardRating(db: KotobaDB, reviewId: number): Promise<void> {
  return db.transaction('rw', db.cards, db.reviews, db.meta, async () => {
    const rev = await db.reviews.get(reviewId);
    if (!rev) throw new Error('Запись об ответе не найдена');
    const card = await db.cards.get(rev.cardId);
    if (!card) throw new Error('Карточка не найдена');
    const later = await db.reviews
      .where('cardId')
      .equals(rev.cardId)
      .filter((r) => (r.id ?? 0) > reviewId)
      .count();
    if (later > 0) throw new Error('Отменить нельзя: после этого ответа карточка уже оценивалась ещё раз');
    await db.cards.put(withSrs(card, rev.prev));
    await db.reviews.delete(reviewId);
    await bumpChanges(db);
  });
}
