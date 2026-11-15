// Постоянное хранилище и занятое место: обёртки над navigator.storage с понятным результатом.
// Менеджер хранилища передаётся параметром (в тестах подставляется подделка).

export interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

/**
 * granted: браузер обещает не стирать данные без вашего решения; denied: браузер РЕАЛЬНО ответил «нет»;
 * unavailable: API нет; unknown: запрос завершился ошибкой, ответа нет (не выдаём это за «нет»).
 */
export type PersistResult = 'granted' | 'denied' | 'unavailable' | 'unknown';

export const PERSIST_TEXT: Record<PersistResult, string> = {
  granted: 'Да: браузер отметил хранилище как постоянное',
  denied: 'Нет: браузер не дал гарантии (это обычное дело на iPhone)',
  unavailable: 'Недоступно в этом браузере',
  unknown: 'Не удалось узнать: браузер не ответил на запрос',
};

/** Уже ли хранилище постоянное, без запроса. null: узнать нельзя. */
export async function readPersisted(storage: StorageManagerLike | undefined): Promise<boolean | null> {
  if (!storage || typeof storage.persisted !== 'function') return null;
  try {
    return await storage.persisted();
  } catch {
    return null;
  }
}

/** Просит постоянное хранилище. Если оно уже постоянное, повторный запрос не нужен. */
export async function requestPersist(storage: StorageManagerLike | undefined): Promise<PersistResult> {
  if (!storage || typeof storage.persist !== 'function') return 'unavailable';
  try {
    if ((await readPersisted(storage)) === true) return 'granted';
    const answer: unknown = await storage.persist();
    // «denied» только при реальном ответе false; любой другой ответ не выдаём за отказ.
    return answer === true ? 'granted' : answer === false ? 'denied' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface StorageEstimate {
  usage: number | null;
  quota: number | null;
}

/** Занятое место и квота; null, если оценка недоступна. */
export async function readEstimate(storage: StorageManagerLike | undefined): Promise<StorageEstimate | null> {
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const e = await storage.estimate();
    const ok = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
    return { usage: ok(e.usage), quota: ok(e.quota) };
  } catch {
    return null;
  }
}

/** 1536 -> «1,5 КБ». */
export function formatBytes(n: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i === 0 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString().replace('.', ',');
  return `${text} ${units[i]}`;
}
