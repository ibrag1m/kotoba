// Формат файла резервной копии: сборка, полная проверка и план слияния.
// Чистые функции без React и без IndexedDB (раздел 1 архитектуры): тестируются отдельно.
//
// Формат (formatVersion 1), один JSON-файл:
//   {
//     "app": "kotoba",
//     "formatVersion": 1,          // версия ФОРМАТА ФАЙЛА (не путать с версией схемы базы)
//     "exportedAt": 1763150000000, // когда создана копия, мс UTC
//     "appVersion": "0.1.0",       // какая версия приложения создала файл (для справки)
//     "dbSchemaVersion": 1,        // версия схемы базы на момент создания
//     "meta": { "dailyNewLimit": 20, ... },   // только настройки пользователя (BACKED_UP_META_KEYS)
//     "decks": [...], "cards": [...],         // карточки вместе с состоянием FSRS
//     "reviews": [...]                        // журнал повторений
//   }
//
// Допустимые числа (проверка при импорте; неверное значение отклоняет файл с указанием поля):
//  - времена (createdAt, updatedAt, lastReview, ts, exportedAt): целые 0…4102444800000 (1 января 2100);
//    due: то же, плюс 36500 суток (максимальный интервал FSRS: карточка, повторённая в 2099 году, может
//    законно получить срок до 2199 года);
//  - счётчики (reps, lapses, learningSteps, scheduledDays, position): безопасные целые >= 0;
//  - difficulty 0…10, stability 0…36500 (границы FSRS-6 из ts-fsrs: D 1…10, S 0,001…36500; 0 у новой карточки);
//  - номер записи журнала (id): целое 1…4294967295 (при восстановлении НЕ переносится, номера назначает база);
//  - настройки: неверное значение настройки отбрасывается с предупреждением, остальной файл читается.
//
// Расширение формата:
//  - ЛИШНИЕ поля, о которых эта версия не знает (в корне, в колодах, карточках, журнале, meta),
//    молча игнорируются и не ломают импорт: читается только известное;
//  - если меняется состав или смысл данных, поднимается BACKUP_FORMAT_VERSION и в MIGRATIONS
//    добавляется шаг «версия n -> n+1»: старый файл проходит цепочку преобразований;
//  - файл с formatVersion новее поддерживаемого или с более новой схемой базы отклоняется
//    с просьбой обновить приложение (иначе неизвестные данные были бы тихо потеряны).
import type { Card, Deck, MetaRecord, Review } from '../db/types';
import {
  ANSWER_DIRECTIONS,
  BACKED_UP_META_KEYS,
  DAILY_NEW_LIMIT_MAX,
  VOICE_KEY_MAX_LENGTH,
  VOICE_MAX_ENTRIES,
  VOICE_VALUE_MAX_LENGTH,
} from '../db/metaKeys';
import { plural } from './format';
import type { CardPhase, SrsState } from './srs';

export const BACKUP_APP = 'kotoba';
export const BACKUP_FORMAT_VERSION = 1;
/** Предел размера текста копии (символов), чтобы случайный огромный файл не повесил телефон. */
export const BACKUP_MAX_TEXT_LENGTH = 100_000_000;
/** Сколько подробностей о проблемах показывать пользователю. */
const MAX_DETAILS = 5;

export interface BackupFile {
  app: typeof BACKUP_APP;
  formatVersion: number;
  exportedAt: number;
  appVersion: string;
  dbSchemaVersion: number;
  meta: Record<string, unknown>;
  decks: Deck[];
  cards: Card[];
  reviews: Review[];
}

export type BackupErrorCode =
  | 'empty'
  | 'too-large'
  | 'not-json'
  | 'not-object'
  | 'wrong-app'
  | 'format-invalid'
  | 'format-newer'
  | 'schema-newer'
  | 'structure'
  | 'duplicate-id'
  | 'broken-link';

export type BackupParseResult =
  | { ok: true; backup: BackupFile; sourceFormatVersion: number; warnings: string[] }
  | { ok: false; code: BackupErrorCode; message: string; details: string[] };

export interface BackupSummary {
  decks: number;
  cards: number;
  reviews: number;
  exportedAt: number;
  appVersion: string;
  formatVersion: number;
  dbSchemaVersion: number;
}

export function summarizeBackup(b: BackupFile): BackupSummary {
  return {
    decks: b.decks.length,
    cards: b.cards.length,
    reviews: b.reviews.length,
    exportedAt: b.exportedAt,
    appVersion: b.appVersion,
    formatVersion: b.formatVersion,
    dbSchemaVersion: b.dbSchemaVersion,
  };
}

// ---------------------------------------------------------------------------------------------
// Сборка

export interface BuildBackupInput {
  decks: readonly Deck[];
  cards: readonly Card[];
  reviews: readonly Review[];
  meta: readonly MetaRecord[];
  now: number;
  appVersion: string;
  dbSchemaVersion: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Собирает объект копии из содержимого базы. Порядок записей детерминированный. */
export function buildBackup(input: BuildBackupInput): BackupFile {
  const decks = [...input.decks].sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id));
  const deckOrder = new Map(decks.map((d, i) => [d.id, i] as const));
  const cards = [...input.cards].sort(
    (a, b) =>
      (deckOrder.get(a.deckId) ?? Infinity) - (deckOrder.get(b.deckId) ?? Infinity) ||
      a.position - b.position ||
      cmp(a.id, b.id),
  );
  const reviews = [...input.reviews].sort((a, b) => a.ts - b.ts || (a.id ?? 0) - (b.id ?? 0));
  const meta: Record<string, unknown> = {};
  for (const key of BACKED_UP_META_KEYS) {
    const rec = input.meta.find((m) => m.key === key);
    if (rec !== undefined && rec.value !== undefined) meta[key] = rec.value;
  }
  return {
    app: BACKUP_APP,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: input.now,
    appVersion: input.appVersion,
    dbSchemaVersion: input.dbSchemaVersion,
    meta,
    decks,
    cards,
    reviews,
  };
}

/** Читаемый текст файла (отступ 2 пробела). */
export function serializeBackup(file: BackupFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Имя файла с датой и временем по местному времени: kotoba-backup-2026-11-14-2015.json (ГГГГ-ММ-ДД-ЧЧММ). */
export function backupFileName(now: number): string {
  const d = new Date(now);
  return `kotoba-backup-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.json`;
}

// ---------------------------------------------------------------------------------------------
// Миграции формата файла

export type FormatMigration = (raw: Record<string, unknown>) => Record<string, unknown>;

/** MIGRATIONS[n] переводит файл формата n в формат n+1. Сейчас формат один, шагов нет. */
export const MIGRATIONS: Readonly<Record<number, FormatMigration>> = {};

/** Прогоняет файл по цепочке шагов от версии `from` до `to`. */
export function migrateBackup(
  raw: Record<string, unknown>,
  from: number,
  to: number = BACKUP_FORMAT_VERSION,
  steps: Readonly<Record<number, FormatMigration>> = MIGRATIONS,
): Record<string, unknown> {
  let cur = raw;
  for (let v = from; v < to; v++) {
    const step = steps[v];
    if (!step) throw new Error(`нет шага преобразования формата ${v} -> ${v + 1}`);
    cur = { ...step(cur), formatVersion: v + 1 };
  }
  return cur;
}

// ---------------------------------------------------------------------------------------------
// Проверка

type Rec = Record<string, unknown>;
type R<T> = { ok: true; value: T } | { ok: false; error: string };

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Безопасное целое >= 0 (счётчики, позиции): без дробей, без 1e300 и без чисел, теряющих точность. */
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string';

const DAY_MS = 86_400_000;
/** Верхняя граница времени: 1 января 2100 (мс UTC). */
export const MAX_TIME_MS = 4_102_444_800_000;
/** Срок повторения может уходить дальше на максимальный интервал FSRS (36500 суток). */
export const MAX_DUE_MS = MAX_TIME_MS + 36_500 * DAY_MS;
/** Границы состояния FSRS-6 (ts-fsrs v6: difficulty 1…10, stability 0,001…36500; у новой карточки обе величины 0). */
export const MAX_DIFFICULTY = 10;
export const MAX_STABILITY = 36_500;
/** Предел номера записи журнала (при восстановлении номер всё равно не переносится). */
export const MAX_REVIEW_ID = 4_294_967_295;

/** Время: целое число миллисекунд от 0 до `max`. */
const isTime = (v: unknown, max: number = MAX_TIME_MS): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const inRange = (v: unknown, max: number): v is number => isNum(v) && v >= 0 && v <= max;
const absent = (v: unknown) => v === undefined || v === null;

const PHASES: readonly string[] = ['new', 'learning', 'review', 'relearning'] satisfies CardPhase[];
const MODES: readonly string[] = ['learn', 'review'];
const DIRECTIONS: readonly string[] = ['term-to-def', 'def-to-term'];

const fail = <T>(error: string): R<T> => ({ ok: false, error });
const TIME_FIELD = (name: string) => `поле «${name}» должно быть временем: целым числом миллисекунд от 0 до 2100 года`;

/** Состояние FSRS: лежит либо прямо в карточке, либо во вложенном prev записи журнала. */
function readSrs(o: Rec): R<SrsState> {
  if (!isTime(o.due, MAX_DUE_MS)) return fail('поле «due» должно быть временем: целым числом миллисекунд от 0 до 2199 года');
  if (!inRange(o.stability, MAX_STABILITY)) return fail(`поле «stability» должно быть числом от 0 до ${MAX_STABILITY}`);
  if (!inRange(o.difficulty, MAX_DIFFICULTY)) return fail(`поле «difficulty» должно быть числом от 0 до ${MAX_DIFFICULTY}`);
  if (!isStr(o.state) || !PHASES.includes(o.state)) return fail('неизвестное значение «state»');
  if (!isCount(o.reps)) return fail('поле «reps» должно быть целым числом не меньше 0');
  if (!isCount(o.lapses)) return fail('поле «lapses» должно быть целым числом не меньше 0');
  if (!isCount(o.scheduledDays)) return fail('поле «scheduledDays» должно быть целым числом не меньше 0');
  if (!isCount(o.learningSteps)) return fail('поле «learningSteps» должно быть целым числом не меньше 0');
  const s: SrsState = {
    due: o.due,
    stability: o.stability,
    difficulty: o.difficulty,
    state: o.state as CardPhase,
    reps: o.reps,
    lapses: o.lapses,
    scheduledDays: o.scheduledDays,
    learningSteps: o.learningSteps,
  };
  if (!absent(o.lastReview)) {
    if (!isTime(o.lastReview)) return fail(TIME_FIELD('lastReview'));
    s.lastReview = o.lastReview;
  }
  return { ok: true, value: s };
}

function readDeck(o: unknown): R<Deck> {
  if (!isRec(o)) return fail('запись не является объектом');
  if (!isStr(o.id) || o.id === '') return fail('нет идентификатора «id»');
  if (!isStr(o.name) || o.name.trim() === '') return fail('нет названия «name»');
  if (!isStr(o.termLang) || o.termLang === '') return fail('нет языка «termLang»');
  if (!isStr(o.defLang) || o.defLang === '') return fail('нет языка «defLang»');
  if (!isTime(o.createdAt)) return fail(TIME_FIELD('createdAt'));
  if (!isTime(o.updatedAt)) return fail(TIME_FIELD('updatedAt'));
  if (!absent(o.description) && !isStr(o.description)) return fail('поле «description» должно быть текстом');
  if (!absent(o.bestMatchMs) && !(isNum(o.bestMatchMs) && o.bestMatchMs >= 0)) return fail('поле «bestMatchMs» должно быть числом не меньше 0');
  const deck: Deck = {
    id: o.id,
    name: o.name,
    termLang: o.termLang,
    defLang: o.defLang,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
  if (isStr(o.description)) deck.description = o.description;
  if (isNum(o.bestMatchMs)) deck.bestMatchMs = o.bestMatchMs;
  return { ok: true, value: deck };
}

function readCard(o: unknown): R<Card> {
  if (!isRec(o)) return fail('запись не является объектом');
  if (!isStr(o.id) || o.id === '') return fail('нет идентификатора «id»');
  if (!isStr(o.deckId) || o.deckId === '') return fail('нет ссылки на колоду «deckId»');
  if (!isStr(o.term) || o.term.trim() === '') return fail('нет слова «term»');
  if (!isStr(o.definition) || o.definition.trim() === '') return fail('нет перевода «definition»');
  if (!isCount(o.position)) return fail('поле «position» должно быть целым числом не меньше 0');
  if (!isTime(o.createdAt)) return fail(TIME_FIELD('createdAt'));
  if (!isTime(o.updatedAt)) return fail(TIME_FIELD('updatedAt'));
  if (!absent(o.reading) && !isStr(o.reading)) return fail('поле «reading» должно быть текстом');
  if (!absent(o.example) && !isStr(o.example)) return fail('поле «example» должно быть текстом');
  const srs = readSrs(o);
  if (!srs.ok) return srs;
  const card: Card = {
    id: o.id,
    deckId: o.deckId,
    term: o.term,
    definition: o.definition,
    position: o.position,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    ...srs.value,
  };
  if (isStr(o.reading)) card.reading = o.reading;
  if (isStr(o.example)) card.example = o.example;
  return { ok: true, value: card };
}

function readReview(o: unknown): R<Review> {
  if (!isRec(o)) return fail('запись не является объектом');
  if (!absent(o.id) && !(isCount(o.id) && o.id >= 1 && o.id <= MAX_REVIEW_ID)) {
    return fail(`поле «id» должно быть целым числом от 1 до ${MAX_REVIEW_ID}`);
  }
  if (!isStr(o.cardId) || o.cardId === '') return fail('нет ссылки на карточку «cardId»');
  if (!isStr(o.deckId) || o.deckId === '') return fail('нет ссылки на колоду «deckId»');
  if (!isTime(o.ts)) return fail(TIME_FIELD('ts'));
  if (o.rating !== 1 && o.rating !== 2 && o.rating !== 3 && o.rating !== 4) return fail('оценка «rating» должна быть от 1 до 4');
  if (!isStr(o.mode) || !MODES.includes(o.mode)) return fail('неизвестное значение «mode»');
  if (!isNum(o.durationMs) || o.durationMs < 0) return fail('поле «durationMs» должно быть числом не меньше 0');
  if (!isRec(o.prev)) return fail('нет снимка состояния «prev»');
  const prev = readSrs(o.prev);
  if (!prev.ok) return fail(`в «prev»: ${prev.error}`);
  const review: Review = {
    cardId: o.cardId,
    deckId: o.deckId,
    ts: o.ts,
    rating: o.rating,
    mode: o.mode as Review['mode'],
    durationMs: o.durationMs,
    prev: prev.value,
  };
  if (isCount(o.id)) review.id = o.id;
  if (!absent(o.direction)) {
    if (!isStr(o.direction) || !DIRECTIONS.includes(o.direction)) return fail('неизвестное значение «direction»');
    review.direction = o.direction as NonNullable<Review['direction']>;
  }
  return { ok: true, value: review };
}

type ListResult<T> = { ok: true; items: T[] } | { ok: false; message: string; details: string[] };

function readList<T>(raw: unknown, label: string, read: (o: unknown) => R<T>): ListResult<T> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: `В файле нет списка «${label}» или это не список.`, details: [] };
  }
  const items: T[] = [];
  const details: string[] = [];
  let bad = 0;
  raw.forEach((o, i) => {
    const r = read(o);
    if (r.ok) {
      items.push(r.value);
    } else {
      bad++;
      if (details.length < MAX_DETAILS) details.push(`${label}, запись ${i + 1}: ${r.error}`);
    }
  });
  if (bad > 0) {
    if (bad > details.length) details.push(`…и ещё ${bad - details.length}`);
    return { ok: false, message: `В файле повреждены записи (${label}): ${bad}.`, details };
  }
  return { ok: true, items };
}

function err(code: BackupErrorCode, message: string, details: string[] = []): BackupParseResult {
  return { ok: false, code, message, details };
}

function findDuplicates(ids: readonly (string | number | undefined)[]): string[] {
  const seen = new Set<string | number>();
  const dups = new Set<string>();
  for (const id of ids) {
    if (id === undefined) continue;
    if (seen.has(id)) dups.add(String(id));
    seen.add(id);
  }
  return [...dups];
}

// ---------------------------------------------------------------------------------------------
// Настройки и «сиротские» записи журнала

export interface SettingsResult {
  meta: Record<string, unknown>;
  warnings: string[];
}

const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
const SETTING_LABEL: Record<(typeof BACKED_UP_META_KEYS)[number], string> = {
  dailyNewLimit: 'dailyNewLimit (новых слов в день)',
  answerDirection: 'answerDirection (направление ответа)',
  voiceByLang: 'voiceByLang (голоса озвучки)',
};

/**
 * Проверка настроек из файла или из базы. Возвращает ТОЛЬКО проверенное: неверное значение настройки отбрасывается
 * с предупреждением (остальной файл при этом читается). Неизвестные ключи игнорируются.
 *  - dailyNewLimit: целое 0…1000;
 *  - answerDirection: одно из ANSWER_DIRECTIONS;
 *  - voiceByLang: объект «строка -> строка», ключи и значения 1…64 символа, не больше 200 записей,
 *    ключи __proto__, constructor, prototype запрещены (такие записи отбрасываются).
 */
export function sanitizeSettings(meta: unknown): SettingsResult {
  const out: Record<string, unknown> = {};
  const warnings: string[] = [];
  if (!isRec(meta)) return { meta: out, warnings };
  for (const key of BACKED_UP_META_KEYS) {
    const v = Object.prototype.hasOwnProperty.call(meta, key) ? meta[key] : undefined;
    if (v === undefined || v === null) continue;
    const bad = () => warnings.push(`Настройка «${SETTING_LABEL[key]}» имеет недопустимое значение и пропущена.`);
    if (key === 'dailyNewLimit') {
      if (isCount(v) && v <= DAILY_NEW_LIMIT_MAX) out[key] = v;
      else bad();
    } else if (key === 'answerDirection') {
      if (isStr(v) && (ANSWER_DIRECTIONS as readonly string[]).includes(v)) out[key] = v;
      else bad();
    } else {
      const voices = sanitizeVoices(v);
      if (voices === null) {
        bad();
      } else {
        out[key] = voices.value;
        if (voices.skipped > 0) {
          warnings.push(`В настройке «${SETTING_LABEL[key]}» пропущено записей с недопустимым ключом или значением: ${voices.skipped}.`);
        }
      }
    }
  }
  return { meta: out, warnings };
}

function sanitizeVoices(v: unknown): { value: Record<string, string>; skipped: number } | null {
  if (!isRec(v)) return null;
  const keys = Object.keys(v);
  if (keys.length > VOICE_MAX_ENTRIES) return null;
  const value: Record<string, string> = {};
  let skipped = 0;
  for (const k of keys) {
    const val = v[k];
    if (
      FORBIDDEN_KEYS.includes(k) ||
      k.length < 1 ||
      k.length > VOICE_KEY_MAX_LENGTH ||
      !isStr(val) ||
      val.length < 1 ||
      val.length > VOICE_VALUE_MAX_LENGTH
    ) {
      skipped++;
      continue;
    }
    value[k] = val;
  }
  return { value, skipped };
}

/**
 * Делит журнал на записи с живой карточкой и колодой и «сиротские» (карточка или колода удалены).
 * Запись, чья карточка есть, но в другой колоде, сиротской не считается: это повреждение, его ловит проверка.
 */
export function splitOrphanReviews<T extends Pick<Review, 'cardId' | 'deckId'>>(
  decks: readonly Pick<Deck, 'id'>[],
  cards: readonly Pick<Card, 'id'>[],
  reviews: readonly T[],
): { kept: T[]; orphans: number } {
  const deckIds = new Set(decks.map((d) => d.id));
  const cardIds = new Set(cards.map((c) => c.id));
  const kept = reviews.filter((r) => deckIds.has(r.deckId) && cardIds.has(r.cardId));
  return { kept, orphans: reviews.length - kept.length };
}

const orphanNoun = (n: number) => plural(n, 'запись журнала', 'записи журнала', 'записей журнала');

/** Предупреждение при экспорте: «3 записи журнала без карточки не вошли в копию». */
export function orphanReviewsExportWarning(n: number): string {
  return `${n} ${orphanNoun(n)} без карточки ${plural(n, 'не вошла', 'не вошли', 'не вошли')} в копию.`;
}

/** Предупреждение при импорте: такие записи пропущены, остальное загружается. */
export function orphanReviewsImportWarning(n: number): string {
  return `${n} ${orphanNoun(n)} без карточки или колоды ${plural(n, 'пропущена', 'пропущены', 'пропущены')} (остальные данные загружаются).`;
}

/**
 * Записи журнала для вставки в базу: номер (id) НЕ переносится вовсе (на него никто не ссылается; порядок задаёт ts,
 * номера назначает база), записи идут в порядке времени (при равном времени сохраняется порядок файла).
 */
export function reviewsForInsert(reviews: readonly Review[]): Review[] {
  return reviews
    .map((r) => {
      const copy: Review = { ...r };
      delete copy.id;
      return copy;
    })
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Полная проверка текста копии. Ничего не пишет в базу. При любой проблеме возвращает ошибку
 * с понятным русским текстом; при успехе возвращает нормализованную копию (только известные поля).
 */
export function parseBackup(input: string): BackupParseResult {
  if (typeof input !== 'string') return err('empty', 'Нет данных для проверки.');
  if (input.length > BACKUP_MAX_TEXT_LENGTH) {
    return err('too-large', 'Файл слишком большой для резервной копии Kotoba. Возможно, выбран не тот файл.');
  }
  // BOM в начале (его добавляют некоторые редакторы) не должен ломать разбор.
  const text = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).trim();
  if (text === '') return err('empty', 'Файл пустой: в нём нет ни одного символа.');

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err(
      'not-json',
      'Это не файл копии Kotoba: текст не читается как JSON. Если вы вставляли текст, проверьте, что он скопирован целиком, с первой до последней фигурной скобки.',
    );
  }
  if (!isRec(raw)) return err('not-object', 'Это не файл копии Kotoba: внутри не объект с данными.');
  if (raw.app !== BACKUP_APP) {
    return err('wrong-app', 'Это файл не из Kotoba (в нём нет пометки приложения). Он не будет загружен.');
  }

  const fv = raw.formatVersion;
  if (!isCount(fv) || fv < 1) {
    return err('format-invalid', 'В файле не указана версия формата, или она записана неверно.');
  }
  if (fv > BACKUP_FORMAT_VERSION) {
    return err(
      'format-newer',
      `Файл создан более новой версией Kotoba (формат ${fv}, эта версия понимает формат ${BACKUP_FORMAT_VERSION}). Обновите приложение и повторите.`,
    );
  }

  let data: Rec;
  try {
    data = migrateBackup(raw, fv);
  } catch (e) {
    return err('structure', `Не удалось преобразовать файл старого формата: ${e instanceof Error ? e.message : String(e)}.`);
  }

  if (!isTime(data.exportedAt)) {
    return err('structure', 'В файле не указано время создания копии, или оно записано неверно.');
  }
  if (!isCount(data.dbSchemaVersion) || data.dbSchemaVersion < 1) {
    return err('structure', 'В файле не указана версия схемы базы, или она записана неверно.');
  }

  const decks = readList(data.decks, 'колоды', readDeck);
  if (!decks.ok) return err('structure', decks.message, decks.details);
  const cards = readList(data.cards, 'карточки', readCard);
  if (!cards.ok) return err('structure', cards.message, cards.details);
  const reviews = readList(data.reviews, 'журнал', readReview);
  if (!reviews.ok) return err('structure', reviews.message, reviews.details);

  let settings: SettingsResult = { meta: {}, warnings: [] };
  if (!absent(data.meta)) {
    if (!isRec(data.meta)) return err('structure', 'Раздел «meta» в файле должен быть объектом.');
    settings = sanitizeSettings(data.meta);
  }
  const warnings = [...settings.warnings];

  // Уникальность идентификаторов.
  const dupDecks = findDuplicates(decks.items.map((d) => d.id));
  const dupCards = findDuplicates(cards.items.map((c) => c.id));
  const dupReviews = findDuplicates(reviews.items.map((r) => r.id));
  if (dupDecks.length + dupCards.length + dupReviews.length > 0) {
    const details = [
      ...dupDecks.slice(0, MAX_DETAILS).map((id) => `Повторяется идентификатор колоды: ${id}`),
      ...dupCards.slice(0, MAX_DETAILS).map((id) => `Повторяется идентификатор карточки: ${id}`),
      ...dupReviews.slice(0, MAX_DETAILS).map((id) => `Повторяется номер записи журнала: ${id}`),
    ].slice(0, MAX_DETAILS);
    return err('duplicate-id', 'В файле есть повторяющиеся идентификаторы. Такой файл повреждён и не будет загружен.', details);
  }

  // Целостность связей.
  const deckIds = new Set(decks.items.map((d) => d.id));
  const cardDeck = new Map(cards.items.map((c) => [c.id, c.deckId] as const));
  const broken: string[] = [];
  let brokenCount = 0;
  const note = (msg: string) => {
    brokenCount++;
    if (broken.length < MAX_DETAILS) broken.push(msg);
  };
  cards.items.forEach((c, i) => {
    if (!deckIds.has(c.deckId)) note(`Карточка ${i + 1} («${c.term}») ссылается на несуществующую колоду`);
  });
  // «Сиротские» записи журнала (колода или карточка удалены) не отклоняют файл: они пропускаются с предупреждением.
  // Запись, чья карточка есть, но лежит в другой колоде, остаётся повреждением.
  const keptReviews: Review[] = [];
  let orphanReviews = 0;
  reviews.items.forEach((r, i) => {
    if (!deckIds.has(r.deckId) || !cardDeck.has(r.cardId)) {
      orphanReviews++;
    } else {
      if (cardDeck.get(r.cardId) !== r.deckId) note(`Запись журнала ${i + 1} относится к другой колоде, чем её карточка`);
      keptReviews.push(r);
    }
  });
  if (brokenCount > 0) {
    if (brokenCount > broken.length) broken.push(`…и ещё ${brokenCount - broken.length}`);
    return err('broken-link', `В файле нарушены связи между данными (проблем: ${brokenCount}). Файл не будет загружен.`, broken);
  }

  if (orphanReviews > 0) warnings.unshift(orphanReviewsImportWarning(orphanReviews));

  return {
    ok: true,
    sourceFormatVersion: fv,
    warnings,
    backup: {
      app: BACKUP_APP,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: data.exportedAt,
      appVersion: isStr(data.appVersion) ? data.appVersion : 'неизвестна',
      dbSchemaVersion: data.dbSchemaVersion,
      meta: settings.meta,
      decks: decks.items,
      cards: cards.items,
      reviews: keptReviews,
    },
  };
}

/**
 * Проверка текста копии для приложения со схемой базы `supportedSchemaVersion`:
 * parseBackup плюс отказ для файла с более новой схемой базы.
 */
export function parseBackupFor(input: string, supportedSchemaVersion: number): BackupParseResult {
  const r = parseBackup(input);
  if (r.ok && r.backup.dbSchemaVersion > supportedSchemaVersion) {
    return err(
      'schema-newer',
      `Файл создан более новой версией базы Kotoba (схема ${r.backup.dbSchemaVersion}, эта версия понимает схему ${supportedSchemaVersion}). Обновите приложение и повторите.`,
    );
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Слияние («добавить к существующим»)

export interface MergePlan {
  decks: Deck[];
  cards: Card[];
  /** Записи журнала без id: база назначит новые номера. */
  reviews: Review[];
  /** У скольких колод пришлось создать новый идентификатор. */
  reidDecks: number;
  /** У скольких карточек пришлось создать новый идентификатор. */
  reidCards: number;
}

export const COPY_SUFFIX = ' (копия)';

/**
 * План добавления копии к существующим данным БЕЗ перезаписи чужих записей: если id колоды или
 * карточки уже занят, запись получает новый идентификатор, а все ссылки на неё в файле
 * (карточки, журнал) переписываются. Колоды с новым id получают пометку «(копия)» в названии.
 * Записи журнала получают новые номера (id убирается). Настройки (meta) при добавлении не трогаются.
 */
export function planMerge(
  backup: BackupFile,
  existing: { deckIds: ReadonlySet<string>; cardIds: ReadonlySet<string> },
  newId: () => string = () => crypto.randomUUID(),
): MergePlan {
  const usedDecks = new Set<string>(existing.deckIds);
  const usedCards = new Set<string>(existing.cardIds);
  const fileDeckIds = new Set(backup.decks.map((d) => d.id));
  const fileCardIds = new Set(backup.cards.map((c) => c.id));

  const fresh = (used: Set<string>, reserved: ReadonlySet<string>): string => {
    let id = newId();
    while (used.has(id) || reserved.has(id)) id = newId();
    used.add(id);
    return id;
  };

  const deckMap = new Map<string, string>();
  let reidDecks = 0;
  const decks = backup.decks.map((d) => {
    if (existing.deckIds.has(d.id)) {
      reidDecks++;
      const id = fresh(usedDecks, fileDeckIds);
      deckMap.set(d.id, id);
      return { ...d, id, name: `${d.name}${COPY_SUFFIX}` };
    }
    deckMap.set(d.id, d.id);
    return { ...d };
  });

  const cardMap = new Map<string, string>();
  let reidCards = 0;
  const cards = backup.cards.map((c) => {
    const deckId = deckMap.get(c.deckId) ?? c.deckId;
    if (existing.cardIds.has(c.id)) {
      reidCards++;
      const id = fresh(usedCards, fileCardIds);
      cardMap.set(c.id, id);
      return { ...c, id, deckId };
    }
    cardMap.set(c.id, c.id);
    return { ...c, deckId };
  });

  const reviews = reviewsForInsert(
    backup.reviews.map((r) => ({ ...r, cardId: cardMap.get(r.cardId) ?? r.cardId, deckId: deckMap.get(r.deckId) ?? r.deckId })),
  );

  return { decks, cards, reviews, reidDecks, reidCards };
}
