import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Card, Deck, MetaRecord, Review } from './types';

/**
 * Версия схемы базы (Dexie version). Правила:
 *  - новая версия добавляет новый шаг `this.version(n)` (с upgrade при необходимости);
 *  - старые шаги не редактируются никогда;
 *  - число здесь равно последней версии.
 */
export const DB_SCHEMA_VERSION = 1;

export const DB_NAME = 'kotoba';

export class KotobaDB extends Dexie {
  decks!: Table<Deck, string>;
  cards!: Table<Card, string>;
  reviews!: Table<Review, number>;
  meta!: Table<MetaRecord, string>;

  constructor(name: string = DB_NAME) {
    super(name);
    // Версия 1 (раздел 3 архитектуры). В ключи индексов попадают только поля, по которым ищем.
    this.version(1).stores({
      decks: 'id, updatedAt',
      cards: 'id, deckId, [deckId+position], due, [deckId+due]',
      reviews: '++id, cardId, deckId, ts',
      meta: 'key',
    });
  }
}

/** Единственная база приложения. Тесты создают свои экземпляры с уникальными именами. */
export const db = new KotobaDB();
