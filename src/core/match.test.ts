import { describe, expect, it } from 'vitest';
import { normalizeDefinition, normalizeJapanese } from './answerCheck';
import type { LearnCard } from './learn';
import {
  MATCH_PAIRS,
  MATCH_PENALTY_MS,
  MATCH_WRONG_FLASH_MS,
  clearWrong,
  createMatchRound,
  elapsedMs,
  finalMs,
  formatMatchTime,
  isMatched,
  isNewRecord,
  isRecordEligible,
  penaltyMs,
  pickMatchCards,
  selectTile,
  totalMs,
} from './match';
import type { MatchState } from './match';
import { seededRng } from './shuffle';

const card = (id: string, term: string, definition: string, reading?: string): LearnCard => ({
  id,
  term,
  definition,
  ...(reading === undefined ? {} : { reading }),
});
const plain = (n: number): LearnCard[] => Array.from({ length: n }, (_, i) => card(`c${i}`, `語${i}`, `слово ${i}`, `ご${i}`));

const T0 = 1_000_000;
const isFinished = (s: MatchState): boolean => s.finishedAt !== null;

function round(deck: LearnCard[], seed = 1): MatchState {
  const r = createMatchRound(deck, seededRng(seed));
  if (!r) throw new Error('раунд не создан');
  return r;
}

const tile = (s: MatchState, cardId: string, side: 'term' | 'def') => {
  const t = s.tiles.find((x) => x.cardId === cardId && x.side === side);
  if (!t) throw new Error(`нет плитки ${cardId}:${side}`);
  return t.id;
};

/** Верная пара за два нажатия; возвращает состояние и время после нажатий. */
function matchPair(s: MatchState, cardId: string, at: number): { state: MatchState; at: number } {
  const a = selectTile(s, tile(s, cardId, 'term'), at);
  return { state: selectTile(a, tile(a, cardId, 'def'), at + 100), at: at + 100 };
}

describe('pickMatchCards', () => {
  it('до 6 карточек, без повторов', () => {
    const deck = plain(30);
    for (let seed = 1; seed <= 30; seed++) {
      const picked = pickMatchCards(deck, seededRng(seed));
      expect(picked).toHaveLength(MATCH_PAIRS);
      expect(new Set(picked.map((c) => c.id)).size).toBe(MATCH_PAIRS);
    }
  });

  it('если карточек меньше шести, берутся все', () => {
    expect(pickMatchCards(plain(4), seededRng(1))).toHaveLength(4);
    expect(pickMatchCards(plain(1), seededRng(1))).toHaveLength(1);
    expect(pickMatchCards([], seededRng(1))).toEqual([]);
  });

  it('выбор случайный: разные rng дают разные наборы', () => {
    const deck = plain(30);
    const sets = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      sets.add(
        pickMatchCards(deck, seededRng(seed))
          .map((c) => c.id)
          .sort()
          .join(),
      );
    }
    expect(sets.size).toBeGreaterThan(10);
  });

  it('одинаковые слова (в том числе хирагана и катакана) не попадают вместе', () => {
    const deck = [card('a', 'ねこ', 'кошка'), card('b', 'ネコ', 'кот'), card('c', 'はし', 'мост'), card('d', 'はし', 'палочки'), card('e', '犬', 'собака')];
    for (let seed = 1; seed <= 40; seed++) {
      const picked = pickMatchCards(deck, seededRng(seed));
      const terms = picked.map((c) => normalizeJapanese(c.term));
      expect(new Set(terms).size).toBe(terms.length);
      expect(picked).toHaveLength(3); // ねこ/ネコ, はし/はし, 犬: по одному из каждой группы
    }
  });

  it('слово совпало с чтением другой карточки («はし» и «橋, はし») — в один раунд не попадают', () => {
    const deck = [card('a', 'はし', 'палочки'), card('b', '橋', 'мост', 'はし'), card('c', '犬', 'собака'), card('d', '猫', 'кошка')];
    for (let seed = 1; seed <= 40; seed++) {
      const ids = pickMatchCards(deck, seededRng(seed)).map((c) => c.id);
      expect(['a', 'b'].filter((x) => ids.includes(x))).toHaveLength(1);
      expect(ids).toHaveLength(3);
    }
  });

  it('одинаковые и пересекающиеся переводы не попадают вместе', () => {
    const deck = [
      card('a', '美しい', 'красивый'),
      card('b', 'きれい', 'Красивый'),
      card('c', '山', 'гора; холм'),
      card('d', '丘', 'холм'),
      card('e', 'いる', 'быть; находиться (о живом)'),
      card('f', 'ある', 'находиться'),
      card('g', '犬', 'собака'),
    ];
    for (let seed = 1; seed <= 60; seed++) {
      const picked = pickMatchCards(deck, seededRng(seed));
      const defs = picked.map((c) => normalizeDefinition(c.definition));
      expect(new Set(defs).size).toBe(defs.length);
      const ids = picked.map((c) => c.id);
      expect(['a', 'b'].filter((x) => ids.includes(x))).toHaveLength(1);
      expect(['c', 'd'].filter((x) => ids.includes(x))).toHaveLength(1);
      expect(['e', 'f'].filter((x) => ids.includes(x))).toHaveLength(1);
      expect(ids).toContain('g');
    }
  });

  it('карточки с пустым словом или переводом пропускаются', () => {
    const deck = [card('a', '  ', 'пусто'), card('b', '犬', ' '), card('c', '猫', 'кошка')];
    expect(pickMatchCards(deck, seededRng(1)).map((c) => c.id)).toEqual(['c']);
  });

  it('вход не меняется', () => {
    const deck = Object.freeze(plain(10).map((c) => Object.freeze(c)));
    expect(() => pickMatchCards(deck, seededRng(1))).not.toThrow();
  });
});

describe('createMatchRound', () => {
  it('12 плиток: по слову и переводу на каждую из 6 пар, id уникальны', () => {
    const r = round(plain(20));
    expect(r.tiles).toHaveLength(12);
    expect(new Set(r.tiles.map((t) => t.id)).size).toBe(12);
    const cardIds = new Set(r.tiles.map((t) => t.cardId));
    expect(cardIds.size).toBe(6);
    for (const id of cardIds) {
      expect(r.tiles.filter((t) => t.cardId === id).map((t) => t.side).sort()).toEqual(['def', 'term']);
    }
  });

  it('плитка-слово хранит term и reading, плитка-перевод хранит перевод и без чтения', () => {
    const r = round([card('a', '水', 'вода', 'みず'), card('b', 'ねこ', 'кошка')]);
    const a = r.tiles.find((t) => t.id === 'a:term');
    expect(a).toMatchObject({ text: '水', reading: 'みず', side: 'term' });
    expect(r.tiles.find((t) => t.id === 'a:def')).toMatchObject({ text: 'вода', side: 'def' });
    expect(r.tiles.find((t) => t.id === 'a:def')?.reading).toBeUndefined();
    expect(r.tiles.find((t) => t.id === 'b:term')?.reading).toBeUndefined();
  });

  it('меньше пар, если различных мало; две — минимум; меньше двух — null', () => {
    expect(round(plain(3)).tiles).toHaveLength(6);
    expect(round(plain(2)).tiles).toHaveLength(4);
    expect(createMatchRound(plain(1), seededRng(1))).toBeNull();
    expect(createMatchRound([], seededRng(1))).toBeNull();
    // много карточек, но все с одним переводом: различных нет
    const same = Array.from({ length: 8 }, (_, i) => card(`s${i}`, `語${i}`, 'один'));
    expect(createMatchRound(same, seededRng(1))).toBeNull();
    // три различных из восьми
    const mixed = [...same, card('x', '犬', 'собака'), card('y', '猫', 'кошка')];
    expect(round(mixed).tiles).toHaveLength(6);
  });

  it('плитки перемешаны', () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) orders.add(round(plain(6), seed).tiles.map((t) => t.id).join());
    expect(orders.size).toBeGreaterThan(5);
  });

  it('начальное состояние: ничего не выбрано, таймер не идёт', () => {
    const r = round(plain(6));
    expect(r).toMatchObject({ matched: [], selected: null, wrong: null, mistakes: 0, startedAt: null, finishedAt: null });
    expect(totalMs(r, T0)).toBe(0);
    expect(finalMs(r)).toBeNull();
  });
});

describe('selectTile', () => {
  it('таймер стартует с первого нажатия', () => {
    const r = round(plain(6));
    const a = selectTile(r, tile(r, 'c0', 'term'), T0);
    expect(a.startedAt).toBe(T0);
    expect(a.selected).toBe(tile(r, 'c0', 'term'));
    expect(totalMs(a, T0 + 2500)).toBe(2500);
  });

  it('верная пара найдена, выбор снят, штрафа нет', () => {
    const r = round(plain(6));
    const { state } = matchPair(r, 'c0', T0);
    expect(state.matched).toEqual(['c0']);
    expect(state.selected).toBeNull();
    expect(state.mistakes).toBe(0);
    expect(state.wrong).toBeNull();
    expect(isMatched(state, r.tiles.find((t) => t.cardId === 'c0')!)).toBe(true);
  });

  it('порядок нажатий не важен: сначала перевод, потом слово', () => {
    const r = round(plain(6));
    const a = selectTile(r, tile(r, 'c1', 'def'), T0);
    const b = selectTile(a, tile(a, 'c1', 'term'), T0 + 10);
    expect(b.matched).toEqual(['c1']);
  });

  it('неверная пара: штраф +1, подсветка двух плиток, выбор снят', () => {
    const r = round(plain(6));
    const a = selectTile(r, tile(r, 'c0', 'term'), T0);
    const b = selectTile(a, tile(a, 'c1', 'def'), T0 + 500);
    expect(b.mistakes).toBe(1);
    expect(b.matched).toEqual([]);
    expect(b.selected).toBeNull();
    expect(b.wrong).toEqual([tile(r, 'c0', 'term'), tile(r, 'c1', 'def')]);
    expect(b.wrongUntil).toBe(T0 + 500 + MATCH_WRONG_FLASH_MS);
    expect(penaltyMs(b)).toBe(MATCH_PENALTY_MS);
  });

  it('плитка того же вида (слово после слова) переносит выбор: без штрафа, без подсветки и без блокировки', () => {
    const r = round(plain(6));
    const a = selectTile(r, tile(r, 'c0', 'term'), T0);
    const b = selectTile(a, tile(a, 'c1', 'term'), T0 + 10);
    expect(b.mistakes).toBe(0);
    expect(b.wrong).toBeNull();
    expect(b.matched).toEqual([]);
    expect(b.selected).toBe(tile(r, 'c1', 'term'));
    // нажатие сразу после переноса работает, верная пара для нового выбора находится
    const c = selectTile(b, tile(b, 'c1', 'def'), T0 + 20);
    expect(c.matched).toEqual(['c1']);
    expect(c.mistakes).toBe(0);
    // то же для переводов
    const d = selectTile(round(plain(6)), tile(r, 'c2', 'def'), T0);
    const e = selectTile(d, tile(d, 'c3', 'def'), T0 + 5);
    expect(e.selected).toBe(tile(d, 'c3', 'def'));
    expect(e.mistakes).toBe(0);
  });

  it('перенос выбора не мешает таймеру и защите: первое нажатие стартует таймер', () => {
    const r = round(plain(6));
    const a = selectTile(r, tile(r, 'c0', 'term'), T0);
    const b = selectTile(a, tile(a, 'c1', 'term'), T0 + 400);
    expect(b.startedAt).toBe(T0);
  });

  it('повторное нажатие на уже выбранную плитку игнорируется: ни штрафа, ни снятия выбора', () => {
    const r = round(plain(6));
    const id = tile(r, 'c0', 'term');
    const a = selectTile(r, id, T0);
    const b = selectTile(a, id, T0 + 50);
    expect(b).toEqual(a);
    expect(b.mistakes).toBe(0);
    expect(b.selected).toBe(id);
    // и после этого верная пара по-прежнему находится
    expect(selectTile(b, tile(b, 'c0', 'def'), T0 + 200).matched).toEqual(['c0']);
  });

  it('нажатие на найденную плитку игнорируется', () => {
    const r = round(plain(6));
    const { state, at } = matchPair(r, 'c0', T0);
    const tapped = selectTile(state, tile(state, 'c0', 'term'), at + 50);
    expect(tapped).toEqual(state);
  });

  it('двойное нажатие на вторую плитку верной пары не ломает ничего', () => {
    const r = round(plain(6));
    const a = selectTile(r, tile(r, 'c0', 'term'), T0);
    const second = tile(a, 'c0', 'def');
    const b = selectTile(a, second, T0 + 100);
    const c = selectTile(b, second, T0 + 120);
    expect(c).toEqual(b);
    expect(c.matched).toEqual(['c0']);
    expect(c.mistakes).toBe(0);
  });

  it('пока подсвечена неверная пара, нажатия игнорируются; после подсветки работают', () => {
    const r = round(plain(6));
    const a = selectTile(r, tile(r, 'c0', 'term'), T0);
    const wrong = selectTile(a, tile(a, 'c1', 'def'), T0 + 100);
    const during = selectTile(wrong, tile(wrong, 'c2', 'term'), T0 + 100 + MATCH_WRONG_FLASH_MS - 1);
    expect(during).toBe(wrong);
    // двойное нажатие на вторую плитку неверной пары не открывает новую пару
    expect(selectTile(wrong, tile(wrong, 'c1', 'def'), T0 + 150)).toBe(wrong);
    const after = selectTile(wrong, tile(wrong, 'c2', 'term'), T0 + 100 + MATCH_WRONG_FLASH_MS);
    expect(after.wrong).toBeNull();
    expect(after.selected).toBe(tile(wrong, 'c2', 'term'));
    expect(after.mistakes).toBe(1);
  });

  it('clearWrong снимает подсветку и больше ничего не меняет', () => {
    const r = round(plain(6));
    const a = selectTile(r, tile(r, 'c0', 'term'), T0);
    const wrong = selectTile(a, tile(a, 'c1', 'def'), T0 + 100);
    const cleared = clearWrong(wrong);
    expect(cleared.wrong).toBeNull();
    expect(cleared).toEqual({ ...wrong, wrong: null });
    expect(clearWrong(cleared)).toBe(cleared);
    // после снятия нажатия принимаются сразу
    expect(selectTile(cleared, tile(cleared, 'c2', 'term'), T0 + 101).selected).toBe(tile(cleared, 'c2', 'term'));
  });

  it('неизвестная плитка игнорируется', () => {
    const r = round(plain(6));
    expect(selectTile(r, 'нет-такой', T0)).toBe(r);
  });

  it('вход не меняется (состояние неизменяемое)', () => {
    const r = round(plain(6));
    const snapshot = JSON.stringify(r);
    selectTile(r, tile(r, 'c0', 'term'), T0);
    expect(JSON.stringify(r)).toBe(snapshot);
  });
});

describe('окончание игры и результат', () => {
  function play(deck: LearnCard[], mistakesBefore: number): MatchState {
    let s = round(deck);
    let at = T0;
    // ошибки: плитка слова и чужой перевод
    const ids = [...new Set(s.tiles.map((t) => t.cardId))];
    for (let i = 0; i < mistakesBefore; i++) {
      s = selectTile(s, tile(s, ids[0] as string, 'term'), (at += 1000));
      s = selectTile(s, tile(s, ids[1] as string, 'def'), (at += 100));
      s = clearWrong(s);
    }
    for (const id of ids) {
      const r = matchPair(s, id, at + 1000);
      s = r.state;
      at = r.at;
    }
    return s;
  }

  it('игра окончена, когда найдены все пары; итог — время игры плюс штраф', () => {
    const s = play(plain(6), 0);
    expect(isFinished(s)).toBe(true);
    expect(s.matched).toHaveLength(6);
    expect(finalMs(s)).toBe((s.finishedAt as number) - (s.startedAt as number));
    expect(penaltyMs(s)).toBe(0);
  });

  it('каждая ошибка добавляет ровно 1 секунду к итогу', () => {
    const clean = play(plain(6), 0);
    const bad = play(plain(6), 3);
    expect(bad.mistakes).toBe(3);
    expect(penaltyMs(bad)).toBe(3000);
    // итог = (время игры) + 3 с; время игры считаем независимо от самих функций итога
    const raw = (bad.finishedAt as number) - (bad.startedAt as number);
    expect(finalMs(bad)).toBe(raw + 3000);
    expect(finalMs(clean)).toBe((clean.finishedAt as number) - (clean.startedAt as number));
  });

  it('после окончания нажатия игнорируются, а время не растёт', () => {
    const s = play(plain(2), 0);
    expect(selectTile(s, s.tiles[0]!.id, (s.finishedAt as number) + 5000)).toBe(s);
    expect(totalMs(s, (s.finishedAt as number) + 60_000)).toBe(finalMs(s));
  });

  it('игра из двух пар заканчивается после второй пары', () => {
    const r = round(plain(2));
    const first = matchPair(r, 'c0', T0);
    expect(isFinished(first.state)).toBe(false);
    const second = matchPair(first.state, 'c1', first.at + 1000);
    expect(isFinished(second.state)).toBe(true);
  });

  it('итоговое время в ходе игры включает уже набранный штраф', () => {
    let s = round(plain(6));
    s = selectTile(s, tile(s, 'c0', 'term'), T0);
    s = selectTile(s, tile(s, 'c1', 'def'), T0 + 1000);
    expect(totalMs(s, T0 + 2000)).toBe(2000 + MATCH_PENALTY_MS);
  });
});

describe('рекорд и формат времени', () => {
  it('рекорд: первый результат, строго лучшее время; равное и худшее не рекорд', () => {
    expect(isNewRecord(30_000, undefined)).toBe(true);
    expect(isNewRecord(29_999, 30_000)).toBe(true);
    expect(isNewRecord(30_000, 30_000)).toBe(false);
    expect(isNewRecord(30_001, 30_000)).toBe(false);
  });

  it('рекорд считается только при полных 6 парах: на коротком раунде (2–5 пар) нет', () => {
    for (const pairs of [2, 3, 4, 5]) expect(isRecordEligible(round(plain(pairs)))).toBe(false);
    expect(isRecordEligible(round(plain(6)))).toBe(true);
    expect(isRecordEligible(round(plain(30)))).toBe(true);
    // раунд короткий и тогда, когда карточек много, но различных слов мало
    const mixed = [...Array.from({ length: 8 }, (_, i) => card(`s${i}`, `語${i}`, 'один')), card('x', '犬', 'собака'), card('y', '猫', 'кошка')];
    expect(isRecordEligible(round(mixed))).toBe(false);
  });

  it('elapsedMs: одна формула для таймера и итога', () => {
    expect(elapsedMs(null, null, 3, T0)).toBe(0);
    expect(elapsedMs(T0, null, 0, T0 + 2500)).toBe(2500);
    expect(elapsedMs(T0, null, 2, T0 + 2500)).toBe(2500 + 2 * MATCH_PENALTY_MS);
    expect(elapsedMs(T0, T0 + 4000, 1, T0 + 99_000)).toBe(4000 + MATCH_PENALTY_MS);
    expect(elapsedMs(T0, null, 0, T0 - 500)).toBe(0); // часы пошли назад
  });

  it('время по-русски с десятыми', () => {
    expect(formatMatchTime(0)).toBe('0,0 с');
    expect(formatMatchTime(12_340)).toBe('12,3 с');
    expect(formatMatchTime(12_350)).toBe('12,4 с');
    expect(formatMatchTime(75_000)).toBe('75,0 с');
    expect(formatMatchTime(-5)).toBe('0,0 с');
  });
});
