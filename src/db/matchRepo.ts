// Запись «Подбора пар» в базу. Тест и Подбор пар — свободная тренировка: расписание карточек (cards) и журнал (reviews)
// они не трогают. Единственная запись — лучшее время колоды decks.bestMatchMs, и только если новое время лучше.
//
// ПРАВИЛО проекта: любая запись данных вызывает bumpChanges в той же транзакции. Здесь так и сделано: рекорд и счётчик
// изменений пишутся одной транзакцией (либо оба, либо ничего). Если рекорда нет, не пишется ничего, счётчик не растёт.
// Время обновления колоды (updatedAt) не меняется: игра не должна двигать колоду вверх списка на главной.
import { isNewRecord } from '../core/match';
import type { KotobaDB } from './db';
import { bumpChanges } from './repo';

export interface MatchRecordResult {
  /** Время улучшило рекорд (или рекорда ещё не было) и записано в колоду. */
  isRecord: boolean;
  /** Рекорд колоды после этой игры, мс. */
  best: number;
  /** Рекорд до этой игры; undefined, если играли впервые. */
  previous: number | undefined;
}

/**
 * Корректное время для записи: конечное положительное число, округлённое до целых мс. Нулевое и отрицательное время
 * (например, при переводе часов во время игры) отвергается: такой «рекорд» нельзя было бы побить.
 */
function toMs(ms: number): number {
  const rounded = Math.round(ms);
  if (!Number.isFinite(ms) || rounded <= 0) throw new Error(`Недопустимое время: ${String(ms)}`);
  return rounded;
}

/** Записывает время игры как рекорд колоды, если оно лучше прежнего. Колода не найдена: ошибка, ничего не меняется. */
export async function recordMatchTime(db: KotobaDB, deckId: string, ms: number): Promise<MatchRecordResult> {
  const time = toMs(ms);
  return db.transaction('rw', db.decks, db.meta, async () => {
    const deck = await db.decks.get(deckId);
    if (!deck) throw new Error('Колода не найдена');
    const previous = typeof deck.bestMatchMs === 'number' && Number.isFinite(deck.bestMatchMs) ? deck.bestMatchMs : undefined;
    if (!isNewRecord(time, previous)) return { isRecord: false, best: previous as number, previous };
    await db.decks.update(deckId, { bestMatchMs: time });
    await bumpChanges(db);
    return { isRecord: true, best: time, previous };
  });
}
