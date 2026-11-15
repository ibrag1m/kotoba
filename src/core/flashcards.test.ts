import { describe, expect, it } from 'vitest';
import {
  againIds,
  counts,
  createSession,
  currentId,
  isFinished,
  mark,
  retryAgain,
  shuffleRemaining,
  undo,
} from './flashcards';
import { seededRng, shuffle } from './shuffle';
import { formatInterval, plural } from './format';

const ids = ['a', 'b', 'c', 'd'];

describe('shuffle', () => {
  it('сохраняет набор элементов, не меняет вход, детерминирован при одинаковом seed', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const copy = input.slice();
    const a = shuffle(input, seededRng(42));
    const b = shuffle(input, seededRng(42));
    expect(input).toEqual(copy);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(copy);
    expect(a).not.toEqual(copy);
  });
  it('пустой и одноэлементный массивы', () => {
    expect(shuffle([])).toEqual([]);
    expect(shuffle([1])).toEqual([1]);
  });
});

describe('сессия карточек', () => {
  it('идёт по порядку, считает «знаю / ещё учу»', () => {
    let s = createSession(ids);
    expect(currentId(s)).toBe('a');
    s = mark(s, 'known');
    s = mark(s, 'again');
    expect(currentId(s)).toBe('c');
    expect(counts(s)).toEqual({ known: 1, again: 1, left: 2, total: 4 });
    s = mark(mark(s, 'known'), 'again');
    expect(isFinished(s)).toBe(true);
    expect(currentId(s)).toBeNull();
    expect(againIds(s)).toEqual(['b', 'd']);
  });

  it('mark после конца ничего не меняет', () => {
    let s = createSession(['a']);
    s = mark(s, 'known');
    expect(mark(s, 'again')).toBe(s);
  });

  it('шаг назад снимает отметку; на первой карточке ничего не делает', () => {
    let s = createSession(ids);
    expect(undo(s)).toBe(s);
    s = mark(mark(s, 'known'), 'again');
    s = undo(s);
    expect(currentId(s)).toBe('b');
    expect(counts(s)).toEqual({ known: 1, again: 0, left: 3, total: 4 });
    s = mark(s, 'known');
    expect(counts(s).known).toBe(2);
  });

  it('повтор только «ещё учу»', () => {
    let s = createSession(ids);
    for (const m of ['again', 'known', 'again', 'known'] as const) s = mark(s, m);
    const r = retryAgain(s);
    expect(r.order).toEqual(['a', 'c']);
    expect(r.pos).toBe(0);
    expect(counts(r).total).toBe(2);
  });

  it('перемешивание оставшихся не трогает уже пройденные', () => {
    let s = createSession(['a', 'b', 'c', 'd', 'e', 'f']);
    s = mark(mark(s, 'known'), 'again');
    const sh = shuffleRemaining(s, seededRng(7));
    expect(sh.order.slice(0, 2)).toEqual(['a', 'b']);
    expect([...sh.order].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(sh.pos).toBe(2);
    expect(sh.marks).toEqual(s.marks);
  });

  it('создание с перемешиванием не теряет карточки', () => {
    const s = createSession(ids, { shuffle: true, rng: seededRng(1) });
    expect([...s.order].sort()).toEqual(ids);
  });
});

describe('format', () => {
  it('plural', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25, 101, 111].map((n) => plural(n, 'карточка', 'карточки', 'карточек'))).toEqual([
      'карточка',
      'карточки',
      'карточек',
      'карточек',
      'карточек',
      'карточка',
      'карточки',
      'карточек',
      'карточка',
      'карточек',
    ]);
  });
  it('formatInterval', () => {
    expect(formatInterval(30_000)).toBe('меньше минуты');
    expect(formatInterval(10 * 60_000)).toBe('10 мин');
    expect(formatInterval(5 * 3_600_000)).toBe('5 ч');
    expect(formatInterval(8 * 86_400_000)).toBe('8 дн.');
    expect(formatInterval(45 * 86_400_000)).toBe('1,5 мес.');
  });
});
