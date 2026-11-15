// Сессия режима «Карточки»: порядок, отметки «знаю / ещё учу», шаг назад, повтор неусвоенных.
// Свободная тренировка: расписание повторений (FSRS) не затрагивается, ничего не пишется в базу.
import { shuffle } from './shuffle';
import type { Rng } from './shuffle';

/** known: знаю; again: ещё учу; skip: перешёл дальше без отметки. */
export type Mark = 'known' | 'again' | 'skip';

export interface FlashSession {
  /** Порядок показа (идентификаторы карточек). */
  readonly order: readonly string[];
  /** Сколько карточек уже отмечено; текущая карточка — order[pos]. */
  readonly pos: number;
  /** Отметки по порядку: marks[i] относится к order[i]. */
  readonly marks: readonly Mark[];
}

export function createSession(ids: readonly string[], opts: { shuffle?: boolean; rng?: Rng } = {}): FlashSession {
  const order = opts.shuffle ? shuffle(ids, opts.rng) : ids.slice();
  return { order, pos: 0, marks: [] };
}

export function currentId(s: FlashSession): string | null {
  return s.order[s.pos] ?? null;
}

export function isFinished(s: FlashSession): boolean {
  return s.pos >= s.order.length;
}

export function mark(s: FlashSession, m: Mark): FlashSession {
  if (isFinished(s)) return s;
  return { order: s.order, pos: s.pos + 1, marks: [...s.marks, m] };
}

/** Шаг назад: возвращает предыдущую карточку и снимает с неё отметку. */
export function undo(s: FlashSession): FlashSession {
  if (s.pos === 0) return s;
  return { order: s.order, pos: s.pos - 1, marks: s.marks.slice(0, -1) };
}

export function counts(s: FlashSession): { known: number; again: number; left: number; total: number } {
  const known = s.marks.filter((m) => m === 'known').length;
  const again = s.marks.filter((m) => m === 'again').length;
  return { known, again, left: s.order.length - s.pos, total: s.order.length };
}

/** Сколько карточек пройдено кнопкой «Дальше» без отметки. */
export function skippedCount(s: FlashSession): number {
  return s.marks.filter((m) => m === 'skip').length;
}

/** Идентификаторы карточек, отмеченных «ещё учу». */
export function againIds(s: FlashSession): string[] {
  return s.order.filter((_, i) => s.marks[i] === 'again');
}

/** Новый круг только по карточкам «ещё учу». */
export function retryAgain(s: FlashSession, opts: { shuffle?: boolean; rng?: Rng } = {}): FlashSession {
  return createSession(againIds(s), opts);
}

/** Перемешать оставшиеся (ещё не отмеченные) карточки; пройденные остаются на месте. */
export function shuffleRemaining(s: FlashSession, rng?: Rng): FlashSession {
  const done = s.order.slice(0, s.pos);
  const rest = shuffle(s.order.slice(s.pos), rng);
  return { order: [...done, ...rest], pos: s.pos, marks: s.marks };
}
