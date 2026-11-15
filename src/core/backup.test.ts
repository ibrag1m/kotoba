// Формат резервной копии: сборка, проверка (битые, чужие, новые файлы), миграции, план слияния.
import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_MAX_TEXT_LENGTH,
  MAX_DUE_MS,
  MAX_REVIEW_ID,
  MAX_TIME_MS,
  backupFileName,
  buildBackup,
  migrateBackup,
  orphanReviewsExportWarning,
  orphanReviewsImportWarning,
  parseBackup,
  parseBackupFor,
  planMerge,
  reviewsForInsert,
  sanitizeSettings,
  serializeBackup,
  splitOrphanReviews,
  summarizeBackup,
} from './backup';
import type { BackupFile } from './backup';
import { V1_FIXTURE } from '../db/fixtures/schema-v1';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

function sample(): BackupFile {
  const f = structuredClone(V1_FIXTURE);
  return buildBackup({ ...f, now: NOW, appVersion: '0.1.0', dbSchemaVersion: 1 });
}

/** Файл как объект JSON, который можно портить по месту (в тесте нужен произвольный доступ к полям). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function raw(): Record<string, any> {
  return JSON.parse(serializeBackup(sample()));
}
const text = (o: unknown) => JSON.stringify(o);

function expectError(input: string, code: string) {
  const r = parseBackup(input);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.code).toBe(code);
    expect(r.message.length).toBeGreaterThan(10);
  }
  return r;
}

describe('сборка и круговая проверка', () => {
  it('в файле есть все обязательные разделы', () => {
    const f = sample();
    expect(f.app).toBe('kotoba');
    expect(f.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(f.exportedAt).toBe(NOW);
    expect(f.dbSchemaVersion).toBe(1);
    expect(f.appVersion).toBe('0.1.0');
    expect(f.decks).toHaveLength(1);
    expect(f.cards).toHaveLength(2);
    expect(f.reviews).toHaveLength(1);
    // Только настройки пользователя: lastBackupAt из образца в файл не попадает.
    expect(f.meta).toEqual({ dailyNewLimit: 20 });
  });

  it('текст читается обратно в то же самое (включая состояние FSRS и журнал)', () => {
    const f = sample();
    const r = parseBackup(serializeBackup(f));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backup).toStrictEqual(f);
      const reviewed = r.backup.cards.find((c) => c.id === 'card-v1-reviewed');
      expect(reviewed).toMatchObject({ stability: 2.3065, difficulty: 4.2, state: 'review', reps: 2, scheduledDays: 2 });
      expect(r.backup.reviews[0]?.prev.state).toBe('new');
      expect(summarizeBackup(r.backup)).toMatchObject({ decks: 1, cards: 2, reviews: 1, exportedAt: NOW });
    }
  });

  it('имя файла с датой и временем (часы и минуты) по местному времени', () => {
    expect(backupFileName(new Date(2026, 10, 14, 23, 59).getTime())).toBe('kotoba-backup-2026-11-14-2359.json');
    expect(backupFileName(new Date(2027, 0, 5, 0, 1).getTime())).toBe('kotoba-backup-2027-01-05-0001.json');
    expect(backupFileName(new Date(2026, 10, 14, 9, 5).getTime())).toBe('kotoba-backup-2026-11-14-0905.json');
    // Две копии в один день получают разные имена.
    expect(backupFileName(new Date(2026, 10, 14, 9, 5).getTime())).not.toBe(backupFileName(new Date(2026, 10, 14, 9, 6).getTime()));
  });

  it('порядок записей детерминированный: колоды по дате, карточки по колоде и позиции', () => {
    const f = structuredClone(V1_FIXTURE);
    const second = { ...f.decks[0]!, id: 'a-deck', createdAt: f.decks[0]!.createdAt - 1 };
    const cardsReversed = [...f.cards].reverse();
    const b = buildBackup({ ...f, decks: [f.decks[0]!, second], cards: cardsReversed, now: NOW, appVersion: 'x', dbSchemaVersion: 1 });
    expect(b.decks.map((d) => d.id)).toEqual(['a-deck', 'deck-v1-1']);
    expect(b.cards.map((c) => c.position)).toEqual([0, 1]);
  });
});

describe('отклонение плохих файлов', () => {
  it('пустой файл и одни пробелы', () => {
    expectError('', 'empty');
    expectError('   \n\t ', 'empty');
  });

  it('не JSON', () => {
    expectError('привет, это не копия', 'not-json');
    expectError('{"app": "kotoba", ', 'not-json'); // обрезанный файл
  });

  it('JSON, но не объект', () => {
    expectError('[1,2,3]', 'not-object');
    expectError('"строка"', 'not-object');
    expectError('null', 'not-object');
    expectError('42', 'not-object');
  });

  it('чужой файл (нет пометки kotoba)', () => {
    const o = raw();
    o.app = 'quizlet';
    expectError(text(o), 'wrong-app');
    delete o.app;
    expectError(text(o), 'wrong-app');
  });

  it('версия формата: нет, не число, нулевая', () => {
    for (const v of [undefined, 'один', 0, -1, 1.5, null]) {
      const o = raw();
      o.formatVersion = v;
      expectError(text(o), 'format-invalid');
    }
  });

  it('файл новее поддерживаемого формата отклоняется с просьбой обновить приложение', () => {
    const o = raw();
    o.formatVersion = BACKUP_FORMAT_VERSION + 1;
    const r = expectError(text(o), 'format-newer');
    if (!r.ok) expect(r.message).toContain('Обновите приложение');
  });

  it('файл с более новой схемой базы отклоняется (parseBackupFor)', () => {
    const o = raw();
    o.dbSchemaVersion = 7;
    expect(parseBackup(text(o)).ok).toBe(true);
    const r = parseBackupFor(text(o), 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('schema-newer');
    expect(parseBackupFor(text(raw()), 1).ok).toBe(true);
  });

  it('нет времени создания или версии схемы', () => {
    const a = raw();
    delete a.exportedAt;
    expectError(text(a), 'structure');
    const b = raw();
    b.dbSchemaVersion = 'x';
    expectError(text(b), 'structure');
  });

  it('нет списка колод, карточек или журнала', () => {
    for (const key of ['decks', 'cards', 'reviews']) {
      const o = raw();
      delete o[key];
      expectError(text(o), 'structure');
      o[key] = {};
      expectError(text(o), 'structure');
    }
  });

  it('повреждённая запись: подробности называют номер записи и поле', () => {
    const o = raw();
    o.cards[1].stability = 'много';
    const r = expectError(text(o), 'structure');
    if (!r.ok) expect(r.details.join(' ')).toContain('запись 2');
    const o2 = raw();
    o2.cards[0].state = 'unknown';
    expectError(text(o2), 'structure');
    const o3 = raw();
    o3.reviews[0].rating = 9;
    expectError(text(o3), 'structure');
    const o4 = raw();
    o4.decks[0].name = '   ';
    expectError(text(o4), 'structure');
    const o5 = raw();
    o5.cards[0] = null;
    expectError(text(o5), 'structure');
    const o6 = raw();
    o6.reviews[0].prev = null;
    expectError(text(o6), 'structure');
    const o7 = raw();
    o7.cards[0].reps = -1;
    expectError(text(o7), 'structure');
    const o8 = raw();
    o8.cards[0].due = null;
    expectError(text(o8), 'structure');
  });

  it('раздел «meta» не объект: файл отклоняется (неверное значение отдельной настройки отбрасывается, см. ниже)', () => {
    const o = raw();
    o.meta = 5;
    expectError(text(o), 'structure');
    o.meta = [];
    expectError(text(o), 'structure');
  });

  it('карточка ссылается на несуществующую колоду', () => {
    const o = raw();
    o.cards[0].deckId = 'нет-такой-колоды';
    const r = expectError(text(o), 'broken-link');
    if (!r.ok) expect(r.details.join(' ')).toContain('несуществующую колоду');
  });

  it('запись журнала, чья карточка лежит в другой колоде, остаётся повреждением (отказ)', () => {
    const c = raw();
    c.decks.push({ ...c.decks[0], id: 'other-deck' });
    c.reviews[0].deckId = 'other-deck';
    const r = expectError(text(c), 'broken-link');
    if (!r.ok) expect(r.details.join(' ')).toContain('другой колоде');
  });

  it('повторяющиеся идентификаторы колод, карточек, журнала', () => {
    const a = raw();
    a.decks.push({ ...a.decks[0] });
    expectError(text(a), 'duplicate-id');
    const b = raw();
    b.cards.push({ ...b.cards[0] });
    expectError(text(b), 'duplicate-id');
    const c = raw();
    c.reviews.push({ ...c.reviews[0] });
    expectError(text(c), 'duplicate-id');
  });

  it('слишком большой текст отклоняется до разбора', () => {
    expectError('x'.repeat(BACKUP_MAX_TEXT_LENGTH + 1), 'too-large');
  });

  it('много проблем: показывается не больше пяти, остальное счётчиком', () => {
    const o = raw();
    o.cards = Array.from({ length: 20 }, () => ({ nonsense: true }));
    const r = expectError(text(o), 'structure');
    if (!r.ok) {
      expect(r.details.length).toBeLessThanOrEqual(6);
      expect(r.details.at(-1)).toContain('ещё');
    }
  });
});

describe('мусор и расширения, которые не должны ломать импорт', () => {
  it('лишние поля везде игнорируются, известные данные читаются полностью', () => {
    const o = raw();
    o.futureRoot = { a: 1 };
    o.meta.futureSetting = 'x';
    o.decks[0].colour = 'red';
    o.cards[0].audioUrl = 'x.mp3';
    o.reviews[0].extra = [1, 2];
    o.reviews[0].prev.extraPrev = true;
    const r = parseBackup(text(o));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backup).toStrictEqual(sample());
      expect(JSON.stringify(r.backup)).not.toContain('futureRoot');
      expect(JSON.stringify(r.backup)).not.toContain('colour');
    }
  });

  it('необязательные поля могут отсутствовать или быть null', () => {
    const o = raw();
    o.cards[0].reading = null;
    o.cards[0].example = null;
    o.decks[0].description = null;
    o.decks[0].bestMatchMs = null;
    delete o.cards[1].lastReview;
    delete o.meta;
    const r = parseBackup(text(o));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('reading' in r.backup.cards[0]!).toBe(false);
      expect('description' in r.backup.decks[0]!).toBe(false);
      expect(r.backup.meta).toEqual({});
    }
  });

  it('BOM в начале файла не мешает', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(parseBackup(bom + serializeBackup(sample())).ok).toBe(true);
  });

  it('пробелы и переводы строк вокруг текста (вставка из буфера)', () => {
    expect(parseBackup(`\n\n  ${serializeBackup(sample())}  \n`).ok).toBe(true);
  });

  it('служебные ключи вроде __proto__ в идентификаторах не ломают проверку', () => {
    const o = raw();
    o.decks[0].id = '__proto__';
    o.cards[0].deckId = '__proto__';
    o.cards[1].deckId = '__proto__';
    o.reviews[0].deckId = '__proto__';
    expect(parseBackup(text(o)).ok).toBe(true);
    const evil = '{"app":"kotoba","formatVersion":1,"exportedAt":1,"dbSchemaVersion":1,"decks":[],"cards":[],"reviews":[],"meta":{"__proto__":{"polluted":true}}}';
    const r = parseBackup(evil);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('пустая, но корректная копия принимается', () => {
    const r = parseBackup(text({ app: 'kotoba', formatVersion: 1, exportedAt: NOW, dbSchemaVersion: 1, decks: [], cards: [], reviews: [] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.backup.appVersion).toBe('неизвестна');
  });
});

describe('миграции формата файла', () => {
  it('цепочка шагов применяется по порядку и обновляет formatVersion', () => {
    const steps = {
      1: (r: Record<string, unknown>) => ({ ...r, a: 1 }),
      2: (r: Record<string, unknown>) => ({ ...r, b: (r.a as number) + 1 }),
    };
    const out = migrateBackup({ formatVersion: 1 }, 1, 3, steps);
    expect(out).toMatchObject({ a: 1, b: 2, formatVersion: 3 });
  });

  it('если шага нет, бросает понятную ошибку; текущая версия проходит без шагов', () => {
    expect(() => migrateBackup({}, 1, 3, {})).toThrow('нет шага');
    const same = { formatVersion: 1, x: 1 };
    expect(migrateBackup(same, 1)).toBe(same);
  });
});

describe('план слияния («добавить к существующим»)', () => {
  const none = { deckIds: new Set<string>(), cardIds: new Set<string>() };

  it('без конфликтов идентификаторы сохраняются, журнал без номеров', () => {
    const b = sample();
    const plan = planMerge(b, none, () => 'новый');
    expect(plan.decks.map((d) => d.id)).toEqual(['deck-v1-1']);
    expect(plan.cards.map((c) => c.id).sort()).toEqual(['card-v1-new', 'card-v1-reviewed']);
    expect(plan.reidDecks + plan.reidCards).toBe(0);
    expect(plan.reviews[0]).not.toHaveProperty('id');
    expect(plan.decks[0]!.name).toBe('N5, глаголы');
  });

  it('конфликт колоды: новый id, ссылки карточек и журнала переписаны, имя с пометкой', () => {
    const b = sample();
    let n = 0;
    const plan = planMerge(b, { deckIds: new Set(['deck-v1-1']), cardIds: new Set() }, () => `gen-${++n}`);
    expect(plan.reidDecks).toBe(1);
    expect(plan.decks[0]!.id).toBe('gen-1');
    expect(plan.decks[0]!.name).toBe('N5, глаголы (копия)');
    expect(plan.cards.every((c) => c.deckId === 'gen-1')).toBe(true);
    expect(plan.reviews[0]!.deckId).toBe('gen-1');
    // Исходный файл не изменён.
    expect(b.decks[0]!.id).toBe('deck-v1-1');
  });

  it('конфликт карточки: новый id только у неё, журнал смотрит на новый id', () => {
    const b = sample();
    const plan = planMerge(b, { deckIds: new Set(), cardIds: new Set(['card-v1-reviewed']) }, () => 'card-new');
    expect(plan.reidCards).toBe(1);
    expect(plan.cards.map((c) => c.id).sort()).toEqual(['card-new', 'card-v1-new']);
    expect(plan.reviews[0]!.cardId).toBe('card-new');
  });

  it('генератор не должен выдавать занятый или файловый id: пропускает такие', () => {
    const b = sample();
    const queue = ['deck-v1-1', 'busy', 'free'];
    const plan = planMerge(b, { deckIds: new Set(['deck-v1-1', 'busy']), cardIds: new Set() }, () => queue.shift() ?? 'zzz');
    expect(plan.decks[0]!.id).toBe('free');
  });
});

// ---------------------------------------------------------------------------------------------
// В3: числа в файле

describe('числа в файле: диапазоны (В3)', () => {
  const DAY = 86_400_000;
  type Mut = (o: Record<string, any>) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

  /** Каждый случай: портим одно число, файл отклоняется, в подробностях названо поле. */
  const cases: Array<[string, Mut, string]> = [
    ['карточка: due отрицательное', (o) => (o.cards[0].due = -1), 'due'],
    ['карточка: due 1e300', (o) => (o.cards[0].due = 1e300), 'due'],
    ['карточка: due 9e15 (за пределом Date)', (o) => (o.cards[0].due = 9e15), 'due'],
    ['карточка: due дальше 2199 года', (o) => (o.cards[0].due = MAX_DUE_MS + 1), 'due'],
    ['карточка: due дробное', (o) => (o.cards[0].due = 1.5), 'due'],
    ['карточка: lastReview после 2100', (o) => (o.cards[1].lastReview = MAX_TIME_MS + 1), 'lastReview'],
    ['карточка: lastReview отрицательное', (o) => (o.cards[1].lastReview = -5), 'lastReview'],
    ['карточка: createdAt отрицательное', (o) => (o.cards[0].createdAt = -5), 'createdAt'],
    ['карточка: updatedAt 1e300', (o) => (o.cards[0].updatedAt = 1e300), 'updatedAt'],
    ['карточка: position -3.5', (o) => (o.cards[0].position = -3.5), 'position'],
    ['карточка: position -1', (o) => (o.cards[0].position = -1), 'position'],
    ['карточка: position 1e300', (o) => (o.cards[0].position = 1e300), 'position'],
    ['карточка: position 2^53', (o) => (o.cards[0].position = 2 ** 53), 'position'],
    ['карточка: reps 1e300', (o) => (o.cards[0].reps = 1e300), 'reps'],
    ['карточка: reps дробное', (o) => (o.cards[0].reps = 1.5), 'reps'],
    ['карточка: lapses 2^53', (o) => (o.cards[0].lapses = 2 ** 53), 'lapses'],
    ['карточка: learningSteps -1', (o) => (o.cards[0].learningSteps = -1), 'learningSteps'],
    ['карточка: scheduledDays дробное', (o) => (o.cards[0].scheduledDays = 0.5), 'scheduledDays'],
    ['карточка: scheduledDays 1e300', (o) => (o.cards[0].scheduledDays = 1e300), 'scheduledDays'],
    ['карточка: difficulty 999', (o) => (o.cards[0].difficulty = 999), 'difficulty'],
    ['карточка: difficulty 10.5', (o) => (o.cards[0].difficulty = 10.5), 'difficulty'],
    ['карточка: difficulty -0.1', (o) => (o.cards[0].difficulty = -0.1), 'difficulty'],
    ['карточка: stability 1e308', (o) => (o.cards[0].stability = 1e308), 'stability'],
    ['карточка: stability 36501', (o) => (o.cards[0].stability = 36_501), 'stability'],
    ['колода: createdAt после 2100', (o) => (o.decks[0].createdAt = MAX_TIME_MS + 1), 'createdAt'],
    ['колода: updatedAt отрицательное', (o) => (o.decks[0].updatedAt = -1), 'updatedAt'],
    ['колода: bestMatchMs -1', (o) => (o.decks[0].bestMatchMs = -1), 'bestMatchMs'],
    ['журнал: ts после 2100', (o) => (o.reviews[0].ts = MAX_TIME_MS + 1), 'ts'],
    ['журнал: ts отрицательное', (o) => (o.reviews[0].ts = -1), 'ts'],
    ['журнал: id 2^53 (огромный номер)', (o) => (o.reviews[0].id = 2 ** 53), 'id'],
    ['журнал: id 1e300', (o) => (o.reviews[0].id = 1e300), 'id'],
    ['журнал: id 0', (o) => (o.reviews[0].id = 0), 'id'],
    ['журнал: id дробный', (o) => (o.reviews[0].id = 1.5), 'id'],
    ['журнал: id больше предела', (o) => (o.reviews[0].id = MAX_REVIEW_ID + 1), 'id'],
    ['журнал: prev.difficulty 11', (o) => (o.reviews[0].prev.difficulty = 11), 'difficulty'],
    ['журнал: prev.reps 1e300', (o) => (o.reviews[0].prev.reps = 1e300), 'reps'],
    ['журнал: prev.due после 2199', (o) => (o.reviews[0].prev.due = MAX_DUE_MS + 1), 'due'],
  ];

  it.each(cases)('отказ: %s', (_name, mutate, field) => {
    const o = raw();
    mutate(o);
    const r = expectError(text(o), 'structure');
    if (!r.ok) expect(r.details.join(' ')).toContain(`«${field}»`);
  });

  it.each([
    ['exportedAt 1e300', 1e300],
    ['exportedAt отрицательное', -5],
    ['exportedAt после 2100', MAX_TIME_MS + 1],
    ['exportedAt дробное', 1.5],
  ])('отказ: %s', (_name, value) => {
    const o = raw();
    o.exportedAt = value;
    const r = expectError(text(o), 'structure');
    if (!r.ok) expect(r.message).toContain('время создания');
  });

  it('границы допустимого проходят: 0, ровно 2100 год, difficulty 10, stability 36500, due через 100 лет', () => {
    const o = raw();
    o.exportedAt = MAX_TIME_MS;
    o.decks[0].createdAt = 0;
    o.decks[0].updatedAt = MAX_TIME_MS;
    o.decks[0].bestMatchMs = 0;
    o.cards[0].position = 0;
    o.cards[1].difficulty = 10;
    o.cards[1].stability = 36_500;
    o.cards[1].lastReview = MAX_TIME_MS;
    // Карточка, повторённая в 2099 году, может законно получить срок до 36500 суток вперёд (максимальный интервал FSRS).
    o.cards[1].due = MAX_TIME_MS + 36_500 * DAY;
    o.cards[0].reps = 2 ** 31;
    o.reviews[0].ts = 0;
    o.reviews[0].id = MAX_REVIEW_ID;
    const r = parseBackup(text(o));
    expect(r.ok).toBe(true);
  });

  it('отказ называет поле и ничего не меняет: исходные данные остаются нетронутыми', () => {
    const o = raw();
    o.cards[0].due = 1e300;
    const snapshot = text(o);
    const r = parseBackup(snapshot);
    expect(r.ok).toBe(false);
    expect(text(o)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------------------------
// В1/В2: номера журнала и «сиротские» записи

describe('сиротские записи журнала (В2)', () => {
  it('нет карточки: файл читается, запись пропущена, есть предупреждение', () => {
    const o = raw();
    o.reviews[0].cardId = 'призрак';
    const r = parseBackup(text(o));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backup.reviews).toHaveLength(0);
      expect(r.backup.cards).toHaveLength(2);
      expect(r.warnings).toEqual([orphanReviewsImportWarning(1)]);
      expect(r.warnings[0]).toContain('1 запись журнала без карточки');
      expect(summarizeBackup(r.backup).reviews).toBe(0);
    }
  });

  it('нет колоды: тоже пропускается; несколько записей: склонение; остальные записи остаются', () => {
    const o = raw();
    const good = o.reviews[0];
    o.reviews = [
      { ...good, id: 11, deckId: 'призрак' },
      { ...good, id: 12, cardId: 'призрак-2' },
      { ...good, id: 13, cardId: 'призрак-3' },
      { ...good, id: 14, ts: good.ts + 1 },
    ];
    const r = parseBackup(text(o));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backup.reviews.map((x) => x.id)).toEqual([14]);
      expect(r.warnings[0]).toContain('3 записи журнала без карточки или колоды пропущены');
    }
  });

  it('карточка на несуществующую колоду, дубли id, чужая колода у записи остаются отказом', () => {
    const a = raw();
    a.cards[0].deckId = 'нет-такой-колоды';
    expectError(text(a), 'broken-link');
    const b = raw();
    b.reviews.push({ ...b.reviews[0] });
    expectError(text(b), 'duplicate-id');
    const c = raw();
    c.decks.push({ ...c.decks[0], id: 'other-deck' });
    c.reviews[0].deckId = 'other-deck';
    expectError(text(c), 'broken-link');
  });

  it('splitOrphanReviews и тексты предупреждений', () => {
    const decks = [{ id: 'd' }];
    const cards = [{ id: 'c' }];
    const reviews = [
      { cardId: 'c', deckId: 'd' },
      { cardId: 'x', deckId: 'd' },
      { cardId: 'c', deckId: 'y' },
    ];
    const { kept, orphans } = splitOrphanReviews(decks, cards, reviews);
    expect(kept).toEqual([{ cardId: 'c', deckId: 'd' }]);
    expect(orphans).toBe(2);
    expect(orphanReviewsExportWarning(1)).toBe('1 запись журнала без карточки не вошла в копию.');
    expect(orphanReviewsExportWarning(2)).toBe('2 записи журнала без карточки не вошли в копию.');
    expect(orphanReviewsExportWarning(5)).toBe('5 записей журнала без карточки не вошли в копию.');
  });

  it('номера журнала при вставке не переносятся, порядок задаёт время', () => {
    const b = sample();
    const base = b.reviews[0]!;
    const out = reviewsForInsert([
      { ...base, id: 9, ts: 300 },
      { ...base, id: 5, ts: 100 },
      { ...base, id: 7, ts: 100, rating: 1 },
    ]);
    expect(out.every((r) => !('id' in r))).toBe(true);
    expect(out.map((r) => r.ts)).toEqual([100, 100, 300]);
    expect(out[0]!.rating).toBe(base.rating); // при равном времени сохраняется порядок файла
    expect(out[1]!.rating).toBe(1);
    const plan = planMerge(
      { ...b, reviews: [{ ...base, id: 9, ts: 300 }, { ...base, id: 5, ts: 100 }] },
      { deckIds: new Set(), cardIds: new Set() },
    );
    expect(plan.reviews.map((r) => r.ts)).toEqual([100, 300]);
    expect(plan.reviews.every((r) => !('id' in r))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// В4: настройки

describe('настройки в файле (В4): мусор отбрасывается с предупреждением', () => {
  it('допустимые значения проходят', () => {
    for (const dir of ['both', 'term-to-def', 'def-to-term']) {
      const o = raw();
      o.meta = { answerDirection: dir, dailyNewLimit: 0, voiceByLang: { 'ja-JP': 'Kyoko' } };
      const r = parseBackup(text(o));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.backup.meta).toEqual({ answerDirection: dir, dailyNewLimit: 0, voiceByLang: { 'ja-JP': 'Kyoko' } });
        expect(r.warnings).toEqual([]);
      }
    }
    const o = raw();
    o.meta = { dailyNewLimit: 1000 };
    const r = parseBackup(text(o));
    expect(r.ok && r.backup.meta).toEqual({ dailyNewLimit: 1000 });
  });

  it.each([
    ['answerDirection: чужая строка', { answerDirection: 'sideways' }, 'answerDirection'],
    ['answerDirection: объект', { answerDirection: { a: [1, 2] } }, 'answerDirection'],
    ['answerDirection: число', { answerDirection: 5 }, 'answerDirection'],
    ['dailyNewLimit: строка', { dailyNewLimit: '20' }, 'dailyNewLimit'],
    ['dailyNewLimit: отрицательное', { dailyNewLimit: -1 }, 'dailyNewLimit'],
    ['dailyNewLimit: больше 1000', { dailyNewLimit: 1001 }, 'dailyNewLimit'],
    ['dailyNewLimit: дробное', { dailyNewLimit: 1.5 }, 'dailyNewLimit'],
    ['dailyNewLimit: 1e300', { dailyNewLimit: 1e300 }, 'dailyNewLimit'],
    ['voiceByLang: число', { voiceByLang: 5 }, 'voiceByLang'],
    ['voiceByLang: строка', { voiceByLang: 'Kyoko' }, 'voiceByLang'],
    ['voiceByLang: массив', { voiceByLang: ['a'] }, 'voiceByLang'],
  ])('%s: настройка отброшена, файл принят, остальные данные целы', (_name, meta, key) => {
    const o = raw();
    o.meta = { ...meta, futureSetting: 'x' };
    const r = parseBackup(text(o));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backup.meta).toEqual({});
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain(key);
      expect(r.backup.cards).toHaveLength(2);
      expect(r.backup.decks).toHaveLength(1);
    }
  });

  it('одна плохая настройка не мешает хорошим', () => {
    const o = raw();
    o.meta = { dailyNewLimit: 'много', answerDirection: 'both', voiceByLang: { 'ja-JP': 'Kyoko' } };
    const r = parseBackup(text(o));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backup.meta).toEqual({ answerDirection: 'both', voiceByLang: { 'ja-JP': 'Kyoko' } });
      expect(r.warnings).toHaveLength(1);
    }
  });

  it('voiceByLang: длинные ключи и значения, не строки, запрещённые ключи отбрасываются по одной', () => {
    const doc = (voices: string) =>
      `{"app":"kotoba","formatVersion":1,"exportedAt":1,"dbSchemaVersion":1,"decks":[],"cards":[],"reviews":[],"meta":{"voiceByLang":${voices}}}`;
    const good = '"ja-JP":"Kyoko"';
    const longKey = JSON.stringify('k'.repeat(65));
    const longVal = JSON.stringify('v'.repeat(65));
    const edge = 'v'.repeat(64);
    const r = parseBackup(
      doc(
        `{${good},${longKey}:"x","en-US":${longVal},"ru-RU":5,"de-DE":"","__proto__":{"polluted":true},"constructor":"x","prototype":"y","edge":"${edge}"}`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const voices = r.backup.meta.voiceByLang as Record<string, string>;
      expect(Object.keys(voices).sort()).toEqual(['edge', 'ja-JP']);
      expect(Object.getPrototypeOf(voices)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(voices, '__proto__')).toBe(false);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain('пропущено записей');
      expect(r.warnings[0]).toContain('7');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('voiceByLang: больше 200 записей отбрасывается целиком', () => {
    const voices: Record<string, string> = {};
    for (let i = 0; i < 201; i++) voices[`l${i}`] = 'v';
    const o = raw();
    o.meta = { voiceByLang: voices };
    const r = parseBackup(text(o));
    expect(r.ok && r.backup.meta).toEqual({});
    expect(r.ok && r.warnings).toHaveLength(1);
  });

  it('sanitizeSettings: только проверенное, неизвестные ключи и не-объект игнорируются', () => {
    expect(sanitizeSettings(undefined)).toEqual({ meta: {}, warnings: [] });
    expect(sanitizeSettings([1, 2])).toEqual({ meta: {}, warnings: [] });
    const r = sanitizeSettings({ dailyNewLimit: 7, answerDirection: 'nope', other: 1, voiceByLang: null });
    expect(r.meta).toEqual({ dailyNewLimit: 7 });
    expect(r.warnings).toHaveLength(1);
  });
});
