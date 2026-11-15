import { describe, expect, it } from 'vitest';
import { againIds, counts, createSession, currentId, isFinished, mark, skippedCount, undo } from './flashcards';

const ids = ['a', 'b', 'c', 'd'];

describe('кнопка «Дальше» (переход без отметки)', () => {
  it('двигает дальше, но не считается ни «знаю», ни «ещё учу»', () => {
    let s = createSession(ids);
    s = mark(s, 'skip');
    expect(currentId(s)).toBe('b');
    expect(counts(s)).toEqual({ known: 0, again: 0, left: 3, total: 4 });
    expect(skippedCount(s)).toBe(1);
  });

  it('карточка без отметки не попадает в «ещё учу»', () => {
    let s = createSession(ids);
    for (const m of ['skip', 'again', 'known', 'skip'] as const) s = mark(s, m);
    expect(isFinished(s)).toBe(true);
    expect(againIds(s)).toEqual(['b']);
    expect(counts(s)).toEqual({ known: 1, again: 1, left: 0, total: 4 });
    expect(skippedCount(s)).toBe(2);
  });

  it('шаг назад возвращает пропущенную карточку и снимает «без отметки»', () => {
    let s = createSession(ids);
    s = mark(mark(s, 'known'), 'skip');
    s = undo(s);
    expect(currentId(s)).toBe('b');
    expect(skippedCount(s)).toBe(0);
    expect(counts(s).known).toBe(1);
  });
});
