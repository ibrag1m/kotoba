import type { SrsState } from '../core/srs';

/** Колода. Время: мс UTC. */
export interface Deck {
  id: string;
  name: string;
  description?: string;
  /** BCP-47, язык слова (для озвучки). Для японского: ja-JP. */
  termLang: string;
  /** BCP-47, язык определения. По умолчанию ru-RU. */
  defLang: string;
  /** Лучшее время «Подбора пар», мс. */
  bestMatchMs?: number;
  createdAt: number;
  updatedAt: number;
}

/** Содержимое карточки (то, что вводит пользователь). */
export interface CardContent {
  /** Слово: кандзи или кана. */
  term: string;
  /** Чтение каной; нужно, когда в term есть кандзи. */
  reading?: string;
  /** Перевод на русский. */
  definition: string;
  example?: string;
}

export interface Card extends CardContent, SrsState {
  id: string;
  deckId: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

/** Журнал повторений, только добавление. */
export interface Review {
  id?: number;
  cardId: string;
  deckId: string;
  ts: number;
  /** 1 снова, 2 трудно, 3 хорошо, 4 легко. */
  rating: 1 | 2 | 3 | 4;
  mode: 'learn' | 'review';
  /** В какую сторону спрашивали: слово по переводу или перевод по слову. Необязательно (старые записи без него). */
  direction?: 'term-to-def' | 'def-to-term';
  durationMs: number;
  /** Снимок состояния карточки до ответа (для отмены и пересчёта). */
  prev: SrsState;
}

/** Ключ-значение: lastBackupAt, dailyNewLimit и т.п. */
export interface MetaRecord {
  key: string;
  value: unknown;
}
