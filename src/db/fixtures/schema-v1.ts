// Образец базы схемы версии 1 для будущих тестов миграций.
//
// Правило: этот файл не меняется никогда. Когда появится схема версии 2, тест миграции делает так:
//   1. createV1Database(name) создаёт базу РОВНО в формате версии 1 (схема записана здесь буквально,
//      а не берётся из KotobaDB, который со временем изменится) и заполняет её V1_FIXTURE;
//   2. база закрывается и открывается текущим KotobaDB(name): запускается upgrade;
//   3. тест проверяет, что все данные фикстуры на месте и приведены к новой схеме.
import Dexie from 'dexie';
import type { Card, Deck, MetaRecord, Review } from '../types';

/** Схема версии 1 буквально (копия this.version(1).stores(...) из db.ts на момент версии 1). */
export const V1_STORES = {
  decks: 'id, updatedAt',
  cards: 'id, deckId, [deckId+position], due, [deckId+due]',
  reviews: '++id, cardId, deckId, ts',
  meta: 'key',
} as const;

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const DAY = 86_400_000;

const deck: Deck = {
  id: 'deck-v1-1',
  name: 'N5, глаголы',
  description: 'Образец для миграций',
  termLang: 'ja-JP',
  defLang: 'ru-RU',
  bestMatchMs: 42_000,
  createdAt: T0,
  updatedAt: T0 + DAY,
};

const newCard: Card = {
  id: 'card-v1-new',
  deckId: deck.id,
  position: 0,
  term: '水',
  reading: 'みず',
  definition: 'вода',
  due: T0,
  stability: 0,
  difficulty: 0,
  state: 'new',
  reps: 0,
  lapses: 0,
  scheduledDays: 0,
  learningSteps: 0,
  createdAt: T0,
  updatedAt: T0,
};

const reviewedCard: Card = {
  id: 'card-v1-reviewed',
  deckId: deck.id,
  position: 1,
  term: '食べる',
  reading: 'たべる',
  definition: 'есть, кушать',
  example: '寿司を食べる。',
  due: T0 + 2 * DAY,
  stability: 2.3065,
  difficulty: 4.2,
  state: 'review',
  reps: 2,
  lapses: 0,
  lastReview: T0,
  scheduledDays: 2,
  learningSteps: 0,
  createdAt: T0,
  updatedAt: T0 + DAY,
};

const review: Review = {
  id: 1,
  cardId: reviewedCard.id,
  deckId: deck.id,
  ts: T0,
  rating: 3,
  mode: 'learn',
  durationMs: 4_500,
  // Запись версии 1: поля direction ещё нет.
  prev: {
    due: T0,
    stability: 0,
    difficulty: 0,
    state: 'new',
    reps: 0,
    lapses: 0,
    scheduledDays: 0,
    learningSteps: 0,
  },
};

const meta: MetaRecord[] = [
  { key: 'dailyNewLimit', value: 20 },
  { key: 'lastBackupAt', value: T0 },
];

export interface V1Fixture {
  decks: Deck[];
  cards: Card[];
  reviews: Review[];
  meta: MetaRecord[];
}

/** Содержимое образца. Это данные: тесты копируют их через structuredClone, не меняя оригинал. */
export const V1_FIXTURE: Readonly<V1Fixture> = {
  decks: [deck],
  cards: [newCard, reviewedCard],
  reviews: [review],
  meta,
};

/** Создаёт и заполняет базу строго в формате версии 1 (отдельным экземпляром Dexie), затем закрывает её. */
export async function createV1Database(name: string): Promise<void> {
  const raw = new Dexie(name);
  raw.version(1).stores(V1_STORES);
  await raw.open();
  const data = structuredClone(V1_FIXTURE) as V1Fixture;
  await raw.table('decks').bulkAdd(data.decks);
  await raw.table('cards').bulkAdd(data.cards);
  await raw.table('reviews').bulkAdd(data.reviews);
  await raw.table('meta').bulkAdd(data.meta);
  raw.close();
}
