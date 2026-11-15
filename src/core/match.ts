// Режим «Подбор пар»: свободная тренировка на время (расписание FSRS и журнал не трогает). Чистые функции, без React
// и без базы; случайность подменяется (rng), время передаётся параметром.
//
// Как это устроено:
//  - pickMatchCards: до 6 карточек колоды, у которых слова и переводы РАЗНЫЕ (иначе пара неоднозначна: два перевода
//    «красивый» подошли бы к одному слову). Если различных меньше шести, пар меньше; меньше двух — игры нет;
//  - createMatchRound: плитки (слово и перевод на каждую пару), перемешанные;
//  - selectTile: нажатие на плитку. Таймер стартует с первого нажатия. Верная пара помечается найденной, неверная
//    даёт штраф 1 с и коротко подсвечивается (в это время нажатия игнорируются); вторая плитка ТОГО ЖЕ вида, что
//    выбранная, просто переносит выбор (без штрафа); повторное нажатие на выбранную плитку и нажатие на найденную
//    игнорируются;
//  - итог: время игры плюс штраф; рекорд определяет isNewRecord и только в раунде из полных 6 пар
//    (isRecordEligible; запись в базу: src/db/matchRepo.ts).
import { definitionVariants, japaneseForms, normalizeDefinition } from './answerCheck';
import type { LearnCard } from './learn';
import { shuffle } from './shuffle';
import type { Rng } from './shuffle';

/** Сколько пар в раунде. */
export const MATCH_PAIRS = 6;
/** Меньше стольких пар играть нельзя. */
export const MIN_MATCH_PAIRS = 2;
/** Штраф за неверную пару, мс. */
export const MATCH_PENALTY_MS = 1000;
/** Сколько мс подсвечивается неверная пара (нажатия в это время игнорируются). */
export const MATCH_WRONG_FLASH_MS = 300;

export interface MatchTile {
  /** Уникальный номер плитки: `${cardId}:term` или `${cardId}:def`. */
  id: string;
  cardId: string;
  side: 'term' | 'def';
  text: string;
  /** Чтение: только у плиток-слов. */
  reading?: string;
}

/**
 * Ключи слова для сравнения: допустимые формы записи слова и его чтения (карточки «はし» и «橋, はし» не должны
 * оказаться в одном раунде), а для записи из одних знаков сама запись без пробелов.
 */
function termKeys(c: LearnCard): Set<string> {
  const forms = japaneseForms(c.term);
  if (forms.length === 0) {
    const raw = c.term.normalize('NFKC').replace(/\s+/g, '');
    return new Set(raw === '' ? [] : [`#${raw}`]);
  }
  const keys = new Set(forms);
  if (c.reading) for (const f of japaneseForms(c.reading)) keys.add(f);
  return keys;
}

/** Ключи перевода: все варианты через «,» «;» «/» (с пояснениями в скобках и без). */
function definitionKeys(c: LearnCard): Set<string> {
  const variants = definitionVariants(c.definition);
  if (variants.length > 0) return new Set(variants);
  const raw = normalizeDefinition(c.definition);
  return new Set(raw === '' ? [] : [`#${raw}`]);
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * До `max` карточек в случайном порядке, у которых слова и переводы не пересекаются (ни одним допустимым вариантом).
 * Карточки с пустым словом или переводом пропускаются.
 */
export function pickMatchCards(deck: readonly LearnCard[], rng: Rng = Math.random, max: number = MATCH_PAIRS): LearnCard[] {
  const chosen: { card: LearnCard; terms: Set<string>; defs: Set<string> }[] = [];
  for (const card of shuffle(deck, rng)) {
    if (chosen.length >= max) break;
    const terms = termKeys(card);
    const defs = definitionKeys(card);
    if (terms.size === 0 || defs.size === 0) continue;
    if (chosen.some((c) => intersects(c.terms, terms) || intersects(c.defs, defs))) continue;
    chosen.push({ card, terms, defs });
  }
  return chosen.map((c) => c.card);
}

export interface MatchState {
  tiles: readonly MatchTile[];
  /** Найденные пары (id карточек). */
  matched: readonly string[];
  /** Выбранная плитка (первая из двух) или null. */
  selected: string | null;
  /** Неверная пара, подсвеченная сейчас (id двух плиток), или null. */
  wrong: readonly [string, string] | null;
  /** До какого момента (мс) идёт подсветка неверной пары. */
  wrongUntil: number;
  mistakes: number;
  /** Время первого нажатия (старт таймера) или null, пока игра не началась. */
  startedAt: number | null;
  /** Время, когда найдена последняя пара, или null. */
  finishedAt: number | null;
}

/** Число пар в раунде. */
export function pairCount(s: MatchState): number {
  return s.tiles.length / 2;
}

/** Новый раунд из карточек колоды; null, если различных пар меньше двух. */
export function createMatchRound(deck: readonly LearnCard[], rng: Rng = Math.random): MatchState | null {
  const cards = pickMatchCards(deck, rng);
  if (cards.length < MIN_MATCH_PAIRS) return null;
  const tiles: MatchTile[] = cards.flatMap((c) => {
    const term: MatchTile = { id: `${c.id}:term`, cardId: c.id, side: 'term', text: c.term };
    if (c.reading) term.reading = c.reading;
    return [term, { id: `${c.id}:def`, cardId: c.id, side: 'def', text: c.definition } satisfies MatchTile];
  });
  return {
    tiles: shuffle(tiles, rng),
    matched: [],
    selected: null,
    wrong: null,
    wrongUntil: 0,
    mistakes: 0,
    startedAt: null,
    finishedAt: null,
  };
}

export function isMatched(s: MatchState, tile: MatchTile): boolean {
  return s.matched.includes(tile.cardId);
}

/**
 * Нажатие на плитку в момент now. Не меняет состояние, если: игра окончена, плитки нет, её пара уже найдена,
 * это та же плитка, что уже выбрана, или ещё идёт подсветка неверной пары. Плитка того же вида, что выбранная
 * (слово после слова), переносит выбор без штрафа.
 */
export function selectTile(s: MatchState, tileId: string, now: number): MatchState {
  if (s.finishedAt !== null) return s;
  const tile = s.tiles.find((t) => t.id === tileId);
  if (!tile || isMatched(s, tile)) return s;
  if (s.wrong !== null && now < s.wrongUntil) return s;
  const base: MatchState = s.wrong === null ? s : { ...s, wrong: null };
  if (base.selected === tileId) return base;
  const startedAt = base.startedAt ?? now;
  if (base.selected === null) return { ...base, selected: tileId, startedAt };
  const first = base.tiles.find((t) => t.id === base.selected);
  if (first && first.side === tile.side) return { ...base, selected: tileId, startedAt };
  if (first && first.cardId === tile.cardId && first.side !== tile.side) {
    const matched = [...base.matched, tile.cardId];
    const done = matched.length === pairCount(base);
    return { ...base, matched, selected: null, startedAt, finishedAt: done ? now : null };
  }
  return {
    ...base,
    selected: null,
    wrong: [base.selected, tileId],
    wrongUntil: now + MATCH_WRONG_FLASH_MS,
    mistakes: base.mistakes + 1,
    startedAt,
  };
}

/** Снимает подсветку неверной пары (вызывается по таймеру экрана). */
export function clearWrong(s: MatchState): MatchState {
  return s.wrong === null ? s : { ...s, wrong: null };
}

/** Штраф за ошибки, мс. */
export function penaltyMs(s: MatchState): number {
  return s.mistakes * MATCH_PENALTY_MS;
}

/** Время игры плюс штраф за ошибки на момент now (одна формула для таймера и итога). */
export function elapsedMs(startedAt: number | null, finishedAt: number | null, mistakes: number, now: number): number {
  if (startedAt === null) return 0;
  return Math.max(0, (finishedAt ?? now) - startedAt) + mistakes * MATCH_PENALTY_MS;
}

/** Время игры с учётом штрафа на момент now (после окончания фиксируется на моменте последней пары). */
export function totalMs(s: MatchState, now: number): number {
  return elapsedMs(s.startedAt, s.finishedAt, s.mistakes, now);
}

/** Рекорд колоды считается только в раунде из полных MATCH_PAIRS пар: на коротком раунде время несравнимо. */
export function isRecordEligible(s: MatchState): boolean {
  return pairCount(s) === MATCH_PAIRS;
}

/** Итоговое время (со штрафом); null, пока игра не окончена. */
export function finalMs(s: MatchState): number | null {
  return s.finishedAt === null ? null : totalMs(s, s.finishedAt);
}

/** Новый ли это рекорд: рекорда ещё не было или время строго лучше (меньше). */
export function isNewRecord(ms: number, best: number | undefined): boolean {
  return best === undefined || ms < best;
}

/** «12,3 с» (десятые секунды, по-русски). */
export function formatMatchTime(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  return `${Math.floor(tenths / 10)},${tenths % 10} с`;
}
