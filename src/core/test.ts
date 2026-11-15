// Режим «Тест»: свободная тренировка (НЕ пишет в расписание FSRS и в журнал). Чистые функции, без React и без базы.
//
// Как это устроено:
//  - generateTest: из карточек колоды выбирает без повторов нужное число и для каждой собирает вопрос одного из трёх
//    типов: ввод, выбор из 4 вариантов, верно/неверно. Типы раздаются поровну, порядок перемешан (rng подменяется в
//    тестах). Если вопрос выбранного типа собрать нельзя (не из чего взять обманки), он переходит на другое направление
//    или на ввод, а «неверное» утверждение, у которого нет безопасной подмены, становится верным;
//  - выбор из вариантов собирается тем же buildOptions, что и в «Заучивании»: две карточки с одинаковым переводом или
//    словом не дают двух верных вариантов;
//  - «верно/неверно»: показывается слово и перевод; в неверных утверждениях подставлен перевод (или слово) ДРУГОЙ
//    карточки, которая не равна верному ответу и не эквивалентна ему (тот же перевод, то же слово или чтение);
//  - answerQuestion проверяет ответ и возвращает запись для итога; summarizeTest считает результат;
//    «Я был прав» (markRight) исправляет только ложную ошибку ввода; mistakeCardIds даёт карточки для повтора ошибок.
import {
  checkDefinitionAnswer,
  checkTermAnswer,
  normalizeDefinition,
  normalizeJapanese,
} from './answerCheck';
import { MIN_DECK_FOR_CHOICE, acceptedKeys, buildOptions, sameQuestion, showsAcceptedAnswer } from './learn';
import type { ChoiceOption, Direction, DirectionMode, LearnCard } from './learn';
import { shuffle } from './shuffle';
import type { Rng } from './shuffle';

/** Сколько вопросов в тесте по умолчанию (не больше числа карточек). */
export const TEST_DEFAULT_COUNT = 20;
/** Верно/неверно возможно, только если в колоде не меньше стольких карточек (нужна другая карточка для подмены). */
export const MIN_DECK_FOR_TRUEFALSE = 2;

export type TestQuestionType = 'typing' | 'choice' | 'truefalse';
export const TEST_QUESTION_TYPES: readonly TestQuestionType[] = ['typing', 'choice', 'truefalse'];

export const TYPE_LABELS: Readonly<Record<TestQuestionType, string>> = {
  typing: 'Ввод',
  choice: 'Выбор из вариантов',
  truefalse: 'Верно/неверно',
};

/** Подписи ответов «верно/неверно» (они же попадают в запись об ответе). */
export const TRUE_TEXT = 'Верно';
export const FALSE_TEXT = 'Неверно';

/** Можно ли использовать тип при данном числе карточек в колоде. */
export function isTypeAvailable(type: TestQuestionType, deckSize: number): boolean {
  if (type === 'choice') return deckSize >= MIN_DECK_FOR_CHOICE;
  if (type === 'truefalse') return deckSize >= MIN_DECK_FOR_TRUEFALSE;
  return deckSize >= 1;
}

/** Почему тип недоступен (текст для экрана); null, если доступен. */
export function typeUnavailableReason(type: TestQuestionType, deckSize: number): string | null {
  if (isTypeAvailable(type, deckSize)) return null;
  if (type === 'choice') return `Нужно не меньше ${MIN_DECK_FOR_CHOICE} карточек в колоде`;
  if (type === 'truefalse') return `Нужно не меньше ${MIN_DECK_FOR_TRUEFALSE} карточек в колоде`;
  return 'В колоде нет карточек';
}

export interface TestSettings {
  /** Сколько вопросов. */
  count: number;
  types: readonly TestQuestionType[];
  directions: DirectionMode;
}

/** Настройки по умолчанию: min(20, карточек) вопросов, все доступные типы, направление из настроек приложения. */
export function defaultTestSettings(deckSize: number, directions: DirectionMode = 'both'): TestSettings {
  return {
    count: Math.min(TEST_DEFAULT_COUNT, Math.max(0, deckSize)),
    types: TEST_QUESTION_TYPES.filter((t) => isTypeAvailable(t, deckSize)),
    directions,
  };
}

/**
 * Приводит настройки к допустимым: число вопросов целое от 1 до числа карточек (при пустой колоде 0), недоступные
 * типы убираются, повторы убираются, а если не осталось ни одного типа, остаётся «Ввод».
 */
export function normalizeTestSettings(s: TestSettings, deckSize: number): TestSettings {
  const size = Math.max(0, Math.floor(deckSize));
  const raw = Number.isFinite(s.count) ? Math.floor(s.count) : 1;
  const count = size === 0 ? 0 : Math.min(size, Math.max(1, raw));
  const types = TEST_QUESTION_TYPES.filter((t) => s.types.includes(t) && isTypeAvailable(t, size));
  return { count, types: types.length > 0 ? types : ['typing'], directions: s.directions };
}

// ---------- вопросы ----------

export interface TypingQuestion {
  type: 'typing';
  cardId: string;
  direction: Direction;
}

export interface ChoiceQuestion {
  type: 'choice';
  cardId: string;
  direction: Direction;
  /** Ровно CHOICE_OPTIONS вариантов, верный один (с cardId вопроса). */
  options: readonly ChoiceOption[];
}

export interface TrueFalseQuestion {
  type: 'truefalse';
  cardId: string;
  direction: Direction;
  /**
   * Карточка, чей перевод (term-to-def) или чьё слово (def-to-term) показано в утверждении. Равна cardId, если
   * утверждение верное, иначе это другая карточка.
   */
  claimCardId: string;
  isTrue: boolean;
}

export type TestQuestion = TypingQuestion | ChoiceQuestion | TrueFalseQuestion;

function pickDirection(mode: DirectionMode, rng: Rng): Direction {
  if (mode !== 'both') return mode;
  return rng() < 0.5 ? 'term-to-def' : 'def-to-term';
}

function directionOrder(mode: DirectionMode, rng: Rng): Direction[] {
  const first = pickDirection(mode, rng);
  if (mode !== 'both') return [first];
  return [first, first === 'term-to-def' ? 'def-to-term' : 'term-to-def'];
}

function choiceOrTyping(card: LearnCard, mode: DirectionMode, deck: readonly LearnCard[], rng: Rng): TestQuestion {
  const order = directionOrder(mode, rng);
  for (const direction of order) {
    const options = buildOptions(card, direction, deck, rng);
    if (options) return { type: 'choice', cardId: card.id, direction, options };
  }
  // Четыре разных варианта собрать не из чего: вопрос переходит на ввод (направление то же, что было первым).
  return { type: 'typing', cardId: card.id, direction: order[0] as Direction };
}

/**
 * Можно ли показать claim как «неверное» утверждение про card. Нельзя, если claim по сути тот же ответ:
 *  - слово → перевод: другая карточка с тем же словом или чтением, либо хотя бы один вариант её перевода допустим
 *    для карточки (или карточек с тем же словом);
 *  - перевод → слово: другая карточка с тем же переводом, либо её слово или чтение (в любой допустимой записи)
 *    принимается как ответ на вопрос.
 */
function isSafeFalseClaim(card: LearnCard, claim: LearnCard, direction: Direction, accepted: ReadonlySet<string>): boolean {
  if (claim.id === card.id) return false;
  if (sameQuestion(card, claim, direction)) return false;
  if (showsAcceptedAnswer(accepted, claim, direction, true)) return false;
  // Пустое после нормализации слово (одни знаки) в утверждении бессмысленно.
  return direction === 'term-to-def' ? normalizeDefinition(claim.definition) !== '' : normalizeJapanese(claim.term) !== '';
}

function trueFalse(card: LearnCard, wantTrue: boolean, mode: DirectionMode, deck: readonly LearnCard[], rng: Rng): TrueFalseQuestion {
  const order = directionOrder(mode, rng);
  if (!wantTrue) {
    const others = shuffle(
      deck.filter((c) => c.id !== card.id),
      rng,
    );
    for (const direction of order) {
      const accepted = acceptedKeys(card, direction, deck);
      const claim = others.find((c) => isSafeFalseClaim(card, c, direction, accepted));
      if (claim) return { type: 'truefalse', cardId: card.id, direction, claimCardId: claim.id, isTrue: false };
    }
  }
  // Безопасной подмены нет: утверждение остаётся верным (ложное «неверно» хуже, чем лишнее «верно»).
  return { type: 'truefalse', cardId: card.id, direction: order[0] as Direction, claimCardId: card.id, isTrue: true };
}

/**
 * Собирает тест. `deck` — вся колода (из неё берутся обманки и подмены), `poolIds` — какие карточки спрашивать
 * (по умолчанию все; нужен для повтора ошибок). Карточки в тесте не повторяются; вопросов не больше settings.count и
 * не больше числа карточек пула.
 */
export function generateTest(
  deck: readonly LearnCard[],
  settings: TestSettings,
  rng: Rng = Math.random,
  poolIds?: readonly string[],
): TestQuestion[] {
  const s = normalizeTestSettings(settings, deck.length);
  const allowed = poolIds ? new Set(poolIds) : null;
  const seen = new Set<string>();
  const pool = deck.filter((c) => {
    if (seen.has(c.id) || (allowed && !allowed.has(c.id))) return false;
    seen.add(c.id);
    return true;
  });
  const picked = shuffle(pool, rng).slice(0, Math.min(s.count, pool.length));
  // Типы раздаются по кругу в случайном порядке, затем перемешиваются: поровну, но без закономерности.
  const order = shuffle(s.types, rng);
  const types = shuffle(
    picked.map((_, i) => order[i % order.length] as TestQuestionType),
    rng,
  );
  // Верных утверждений ровно половина (при нечётном числе лишнее случайно верное или неверное).
  const tfCount = types.filter((t) => t === 'truefalse').length;
  const trueCount = Math.floor(tfCount / 2) + (tfCount % 2 === 1 && rng() < 0.5 ? 1 : 0);
  const truths = shuffle(
    Array.from({ length: tfCount }, (_, i) => i < trueCount),
    rng,
  );
  let tfIndex = 0;
  return picked.map((card, i) => {
    const type = types[i] as TestQuestionType;
    if (type === 'truefalse') return trueFalse(card, truths[tfIndex++] === true, s.directions, deck, rng);
    if (type === 'choice') return choiceOrTyping(card, s.directions, deck, rng);
    return { type: 'typing', cardId: card.id, direction: pickDirection(s.directions, rng) };
  });
}

// ---------- ответы ----------

export type TestAnswer =
  | { kind: 'typed'; text: string }
  | { kind: 'choice'; index: number }
  | { kind: 'truefalse'; saidTrue: boolean }
  | { kind: 'skip' };

/** Запись об одном данном ответе (из неё строится итог). */
export interface TestRecord {
  question: TestQuestion;
  /** Что ответил пользователь (текст для показа); пустая строка при пропуске. */
  given: string;
  /** Для выбора из вариантов: карточка выбранного варианта (чтобы показать его целиком). */
  givenCardId?: string;
  correct: boolean;
  skipped: boolean;
  /** Ошибка ввода исправлена кнопкой «Я был прав». */
  overridden: boolean;
}

export type AnswerOutcome =
  | { kind: 'recorded'; record: TestRecord }
  /** Введена латиница или кириллица вместо японского: ответ не принят и не считается ошибкой. */
  | { kind: 'hint' }
  /** Ответ не относится к вопросу или пуст: игнорируется. */
  | { kind: 'ignored' };

/** Проверка ввода: те же правила и эквиваленты, что в «Заучивании». */
function checkTyped(q: TypingQuestion, text: string, deck: readonly LearnCard[]): { correct: boolean; romajiHint: boolean } {
  const card = deck.find((c) => c.id === q.cardId);
  if (!card) return { correct: false, romajiHint: false };
  if (q.direction === 'def-to-term') {
    // Верны и слова карточек, отвечающих на тот же вопрос (как в «Заучивании»).
    const same = deck.filter((c) => c.id !== card.id && sameQuestion(card, c, 'def-to-term'));
    return checkTermAnswer(text, card, same);
  }
  const term = normalizeJapanese(card.term);
  const same = term === '' ? [] : deck.filter((c) => c.id !== card.id && normalizeJapanese(c.term) === term);
  return {
    correct: checkDefinitionAnswer(
      text,
      card.definition,
      same.map((c) => c.definition),
    ),
    romajiHint: false,
  };
}

/** Проверяет ответ на вопрос. Ответ другого вида, пустой ввод и неверный номер варианта игнорируются. */
export function answerQuestion(question: TestQuestion, answer: TestAnswer, deck: readonly LearnCard[]): AnswerOutcome {
  if (answer.kind === 'skip') {
    return { kind: 'recorded', record: { question, given: '', correct: false, skipped: true, overridden: false } };
  }
  if (question.type === 'typing' && answer.kind === 'typed') {
    if (answer.text.trim() === '') return { kind: 'ignored' };
    const res = checkTyped(question, answer.text, deck);
    if (res.romajiHint) return { kind: 'hint' };
    const record: TestRecord = { question, given: answer.text.trim(), correct: res.correct, skipped: false, overridden: false };
    return { kind: 'recorded', record };
  }
  if (question.type === 'choice' && answer.kind === 'choice') {
    const option = question.options[answer.index];
    if (!option) return { kind: 'ignored' };
    const record: TestRecord = {
      question,
      given: option.text,
      givenCardId: option.cardId,
      correct: option.cardId === question.cardId,
      skipped: false,
      overridden: false,
    };
    return { kind: 'recorded', record };
  }
  if (question.type === 'truefalse' && answer.kind === 'truefalse') {
    const record: TestRecord = {
      question,
      given: answer.saidTrue ? TRUE_TEXT : FALSE_TEXT,
      correct: answer.saidTrue === question.isTrue,
      skipped: false,
      overridden: false,
    };
    return { kind: 'recorded', record };
  }
  return { kind: 'ignored' };
}

/** Можно ли исправить запись кнопкой «Я был прав»: только неверный ввод с клавиатуры, не пропуск. */
export function canOverride(r: TestRecord): boolean {
  return r.question.type === 'typing' && !r.correct && !r.skipped;
}

/** «Я был прав»: запись с номером index становится верной. Остальные записи и вход не меняются. */
export function markRight(records: readonly TestRecord[], index: number): TestRecord[] {
  return records.map((r, i) => (i === index && canOverride(r) ? { ...r, correct: true, overridden: true } : r));
}

// ---------- итог ----------

export interface TestSummary {
  total: number;
  correct: number;
  /** Целые проценты верных ответов, округлены вниз: 100 только если верны все (0 при пустом тесте). */
  percent: number;
  /** Ошибки с номером записи (он нужен для markRight). */
  mistakes: { index: number; record: TestRecord }[];
}

export function summarizeTest(records: readonly TestRecord[]): TestSummary {
  const mistakes: TestSummary['mistakes'] = [];
  records.forEach((record, index) => {
    if (!record.correct) mistakes.push({ index, record });
  });
  const total = records.length;
  const correct = total - mistakes.length;
  return { total, correct, percent: total === 0 ? 0 : Math.floor((correct * 100) / total), mistakes };
}

/** Карточки с ошибками без повторов, в порядке прохождения: из них собирается тест «Повторить ошибки». */
export function mistakeCardIds(records: readonly TestRecord[]): string[] {
  const ids: string[] = [];
  for (const r of records) if (!r.correct && !ids.includes(r.question.cardId)) ids.push(r.question.cardId);
  return ids;
}

/** Настройки теста по ошибкам: те же типы и направление, вопросов столько, сколько карточек с ошибками. */
export function retrySettings(settings: TestSettings, mistakeCount: number): TestSettings {
  return { ...settings, count: Math.max(1, mistakeCount) };
}
