// Движок режима «Заучивание»: очередь колоды и порция по 7 карточек. Чистые функции, без React и без базы.
//
// Как это устроено:
//  - buildQueue: что показывать сегодня (карточки с due <= сейчас, затем новые в пределах остатка дневного лимита);
//  - startPortion: первые 7 карточек очереди образуют порцию. Этап 1: выбор из 4 вариантов (только если в колоде не
//    меньше 4 карточек), этап 2: ввод с клавиатуры. Направление каждого вопроса случайное (rng подменяется в тестах);
//  - ошибка («не знаю», неверный выбор или ввод) возвращает карточку в конец очереди текущего этапа;
//  - оценка карточки определяется ОДИН раз, когда карточка завершена (верно введена или отмечена «слишком легко»),
//    по худшему исходу: «не знаю» = 1 (снова), любая ошибка = 2 (трудно), всё верно с первого раза = 3 (хорошо),
//    «слишком легко» = 4 (легко). Движок сам ничего не пишет: next() и undo() возвращают завершения и откаты,
//    а запись в базу делает вызывающий код (src/db/learnRepo.ts);
//  - состояние неизменяемое; каждый ответ запоминает состояние «до», поэтому undo() откатывает шаг целиком.
import { checkDefinitionAnswer, checkTermAnswer, japaneseForms, normalizeDefinition, normalizeJapanese } from './answerCheck';
import { shuffle } from './shuffle';
import type { Rng } from './shuffle';
import type { CardPhase, Rating } from './srs';

export const PORTION_SIZE = 7;
/** Сколько вариантов в вопросе с выбором (один верный и три обманки). */
export const CHOICE_OPTIONS = 4;
/** Выбор из вариантов включается, только если в колоде не меньше стольких карточек. */
export const MIN_DECK_FOR_CHOICE = 4;
/** Не больше стольких мс на один вопрос идёт в длительность ответа (забытый на столе телефон не портит данные). */
export const MAX_QUESTION_MS = 120_000;

/** Слово → перевод, или перевод → слово. */
export type Direction = 'term-to-def' | 'def-to-term';
/** Настройка направления: оба вперемешку или одно. */
export type DirectionMode = 'both' | Direction;
export type Stage = 'choice' | 'typing';

/** Минимум полей карточки, которые нужны движку. */
export interface LearnCard {
  id: string;
  term: string;
  reading?: string;
  definition: string;
  example?: string;
  /** Фаза карточки в расписании на момент загрузки очереди (нужна, чтобы отличать новые карточки). */
  state?: CardPhase;
}

// ---------- граница дня и очередь ----------

/** Начало местных суток (по часовому поясу устройства), мс UTC. */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Начало следующих местных суток, мс UTC. */
export function startOfNextLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export interface QueueCard extends LearnCard {
  state: CardPhase;
  due: number;
  position: number;
}

export interface LearnQueue {
  /** Карточки, которым пора повторяться (не новые, due <= сейчас), самые просроченные первыми. */
  due: QueueCard[];
  /** Новые карточки в пределах остатка дневного лимита, в порядке добавления. */
  fresh: QueueCard[];
  /** due, затем fresh: из этого списка берутся порции. */
  list: QueueCard[];
  /** Сколько новых карточек всего в колоде (без учёта лимита). */
  newTotal: number;
  /** Когда ближайшая не новая карточка станет к повторению (due > сейчас); null, если таких нет. */
  nextDueAt: number | null;
}

/**
 * Очередь колоды. `newRemaining` — сколько новых карточек ещё можно ввести сегодня (дневной лимит минус уже
 * введённые); отрицательное и дробное значения приводятся к целому не меньше нуля.
 */
export function buildQueue(cards: readonly QueueCard[], now: number, newRemaining: number): LearnQueue {
  const room = Number.isFinite(newRemaining) ? Math.max(0, Math.floor(newRemaining)) : 0;
  const due = cards.filter((c) => c.state !== 'new' && c.due <= now).sort((a, b) => a.due - b.due || a.position - b.position);
  const allNew = cards.filter((c) => c.state === 'new').sort((a, b) => a.position - b.position);
  const fresh = allNew.slice(0, room);
  let nextDueAt: number | null = null;
  for (const c of cards) {
    if (c.state !== 'new' && c.due > now && (nextDueAt === null || c.due < nextDueAt)) nextDueAt = c.due;
  }
  return { due, fresh, list: [...due, ...fresh], newTotal: allNew.length, nextDueAt };
}

// ---------- состояние порции ----------

export interface ChoiceOption {
  cardId: string;
  /** Перевод (для направления слово → перевод) или слово (для перевод → слово). */
  text: string;
  /** Чтение: только у вариантов-слов. */
  reading?: string;
}

export interface Question {
  cardId: string;
  stage: Stage;
  direction: Direction;
  /** Варианты для этапа выбора; для ввода пусто. */
  options: readonly ChoiceOption[];
  /** Когда вопрос показан (мс): от него считается длительность ответа. */
  askedAt: number;
}

export interface Feedback {
  /** correct: верно; wrong: неверно; dontknow: нажато «Не знаю» (ответ показан, считается ошибкой). */
  kind: 'correct' | 'wrong' | 'dontknow';
  /** Что ввёл или выбрал пользователь. */
  given: string;
  /** Номер выбранного варианта (этап выбора). */
  chosenIndex?: number;
  answeredAt: number;
  /** Доступна кнопка «Я был прав»: только после неверного ввода с клавиатуры. */
  canOverride: boolean;
  /** Доступна кнопка «Слишком легко»: только если верно с первого раза. */
  canTooEasy: boolean;
  /** Нажато «Слишком легко»: при переходе дальше карточка завершится с оценкой 4. */
  tooEasy: boolean;
}

export interface Progress {
  mistakes: number;
  dontKnow: boolean;
  /** Накопленное время ответов на вопросы по этой карточке, мс. */
  ms: number;
}

/** Завершённая карточка: именно её оценку нужно записать в расписание. */
export interface Completion {
  cardId: string;
  rating: Rating;
  /** Направление вопроса, на котором карточка завершилась. */
  direction: Direction;
  durationMs: number;
  mistakes: number;
  dontKnow: boolean;
  easy: boolean;
}

export interface PortionState {
  readonly cards: readonly LearnCard[];
  /** Вся колода: из неё берутся варианты-обманки. */
  readonly deck: readonly LearnCard[];
  readonly directions: DirectionMode;
  readonly stage: Stage | 'done';
  /** Очередь текущего этапа; голова — текущая карточка. */
  readonly queue: readonly string[];
  readonly progress: Readonly<Record<string, Progress>>;
  readonly question: Question | null;
  readonly feedback: Feedback | null;
  /** Введена латиница или кириллица вместо японского: ответ не принят, показать подсказку. */
  readonly hint: 'romaji' | null;
  /** В этой порции уже был хотя бы один вопрос с выбором (нужно, чтобы подписывать этап ввода). */
  readonly choiceAsked: boolean;
  readonly completed: readonly Completion[];
}

export interface LearnSession {
  readonly state: PortionState;
  /** Состояния «до ответа», по одному на каждый данный ответ (для undo). */
  readonly history: readonly PortionState[];
}

export interface Ctx {
  /** Текущее время, мс. */
  now: number;
  /** Генератор случайных чисел; по умолчанию Math.random. */
  rng?: Rng;
}

const NO_PROGRESS: Progress = { mistakes: 0, dontKnow: false, ms: 0 };

const progressOf = (s: PortionState, id: string): Progress => s.progress[id] ?? NO_PROGRESS;

function cardOf(s: PortionState, id: string): LearnCard {
  const c = s.cards.find((x) => x.id === id);
  if (!c) throw new Error(`Карточка ${id} не входит в порцию`);
  return c;
}

/** Оценка карточки по худшему исходу. */
export function ratingFor(p: { mistakes: number; dontKnow: boolean }, easy: boolean): Rating {
  if (easy) return 4;
  if (p.dontKnow) return 1;
  if (p.mistakes > 0) return 2;
  return 3;
}

// ---------- вопросы ----------

function pickDirection(mode: DirectionMode, rng: Rng | undefined): Direction {
  if (mode !== 'both') return mode;
  return (rng ?? Math.random)() < 0.5 ? 'term-to-def' : 'def-to-term';
}

function optionKey(c: LearnCard, direction: Direction): string {
  return direction === 'term-to-def' ? normalizeDefinition(c.definition) : normalizeJapanese(c.term);
}

function toOption(c: LearnCard, direction: Direction): ChoiceOption {
  if (direction === 'term-to-def') return { cardId: c.id, text: c.definition };
  const o: ChoiceOption = { cardId: c.id, text: c.term };
  if (c.reading) o.reading = c.reading;
  return o;
}

/** Все допустимые формы term и reading карточки (нормализованные). */
function japaneseKeys(c: LearnCard): Set<string> {
  const keys = new Set(japaneseForms(c.term));
  if (c.reading) for (const f of japaneseForms(c.reading)) keys.add(f);
  return keys;
}

/**
 * Совпадает ли с верной карточкой СТОРОНА ВОПРОСА: тогда другая карточка тоже была бы верным ответом.
 * Перевод → слово: совпал нормализованный перевод. Слово → перевод: совпали term или reading (きれい и 美しい
 * с одним переводом отличаются по вопросу; а два слова «はし» с разными переводами неразличимы по вопросу).
 */
function sameQuestion(card: LearnCard, other: LearnCard, direction: Direction): boolean {
  if (direction === 'def-to-term') {
    const mine = normalizeDefinition(card.definition);
    return mine !== '' && normalizeDefinition(other.definition) === mine;
  }
  const mine = japaneseKeys(card);
  for (const k of japaneseKeys(other)) if (mine.has(k)) return true;
  return false;
}

/**
 * Верный вариант и три обманки из той же колоды: без повторов и без совпадения с верным; карточки, у которых
 * сторона вопроса совпадает с верной (см. sameQuestion), в обманки не берутся. null: обманок не хватило.
 */
function buildOptions(card: LearnCard, direction: Direction, deck: readonly LearnCard[], rng: Rng | undefined): ChoiceOption[] | null {
  const seen = new Set<string>([optionKey(card, direction)]);
  // Слово, совпадающее с чтением верной карточки (みず для 水), тоже было бы верным ответом: в обманки не берём.
  if (direction === 'def-to-term' && card.reading) seen.add(normalizeJapanese(card.reading));
  const distractors: ChoiceOption[] = [];
  for (const c of shuffle(
    deck.filter((x) => x.id !== card.id && !sameQuestion(card, x, direction)),
    rng,
  )) {
    const key = optionKey(c, direction);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    distractors.push(toOption(c, direction));
    if (distractors.length === CHOICE_OPTIONS - 1) break;
  }
  if (distractors.length < CHOICE_OPTIONS - 1) return null;
  return shuffle([toOption(card, direction), ...distractors], rng);
}

function choiceQuestion(card: LearnCard, s: PortionState, ctx: Ctx): Question | null {
  const first = pickDirection(s.directions, ctx.rng);
  const order: Direction[] = s.directions === 'both' ? [first, first === 'term-to-def' ? 'def-to-term' : 'term-to-def'] : [first];
  for (const direction of order) {
    const options = buildOptions(card, direction, s.deck, ctx.rng);
    if (options) return { cardId: card.id, stage: 'choice', direction, options, askedAt: ctx.now };
  }
  return null;
}

function advanceStage(s: PortionState, ctx: Ctx): PortionState {
  if (s.stage === 'choice') {
    const finished = new Set(s.completed.map((c) => c.cardId));
    const queue = shuffle(
      s.cards.filter((c) => !finished.has(c.id)).map((c) => c.id),
      ctx.rng,
    );
    return { ...s, stage: queue.length > 0 ? 'typing' : 'done', queue };
  }
  return { ...s, stage: 'done', queue: [] };
}

/** Готовит вопрос по голове очереди; при пустой очереди переходит к следующему этапу или завершает порцию. */
function ask(start: PortionState, ctx: Ctx): PortionState {
  let s: PortionState = { ...start, question: null, feedback: null, hint: null };
  for (;;) {
    if (s.stage === 'done') return s;
    const id = s.queue[0];
    if (id === undefined) {
      s = advanceStage(s, ctx);
      continue;
    }
    if (s.stage === 'typing') {
      const question: Question = {
        cardId: id,
        stage: 'typing',
        direction: pickDirection(s.directions, ctx.rng),
        options: [],
        askedAt: ctx.now,
      };
      return { ...s, question };
    }
    const question = choiceQuestion(cardOf(s, id), s, ctx);
    if (question) return { ...s, question, choiceAsked: true };
    // Четыре разных варианта собрать не из чего (например, у всех карточек один перевод): выбор пропускается.
    s = { ...s, queue: s.queue.slice(1) };
  }
}

// ---------- запуск ----------

/** Начинает порцию: берёт первые PORTION_SIZE карточек очереди, перемешивает их и задаёт первый вопрос. */
export function startPortion(
  queue: readonly LearnCard[],
  deck: readonly LearnCard[],
  ctx: Ctx,
  opts: { directions?: DirectionMode } = {},
): LearnSession {
  const cards = queue.slice(0, PORTION_SIZE);
  const ids = shuffle(
    cards.map((c) => c.id),
    ctx.rng,
  );
  const base: PortionState = {
    cards,
    deck,
    directions: opts.directions ?? 'both',
    stage: deck.length >= MIN_DECK_FOR_CHOICE ? 'choice' : 'typing',
    queue: ids,
    progress: {},
    question: null,
    feedback: null,
    hint: null,
    choiceAsked: false,
    completed: [],
  };
  return { state: ask(base, ctx), history: [] };
}

// ---------- ответы ----------

type Outcome =
  | { kind: 'correct'; given: string; chosenIndex?: number }
  | { kind: 'wrong'; given: string; chosenIndex?: number }
  | { kind: 'dontknow' };

/** Применяет исход к состоянию «до ответа» и переводит его в режим показа результата. */
function applyOutcome(pre: PortionState, outcome: Outcome, answeredAt: number): PortionState {
  const q = pre.question;
  if (!q) return pre;
  const old = progressOf(pre, q.cardId);
  const spent = Math.min(Math.max(0, answeredAt - q.askedAt), MAX_QUESTION_MS);
  const progress: Progress = {
    ms: old.ms + spent,
    mistakes: old.mistakes + (outcome.kind === 'correct' ? 0 : 1),
    dontKnow: old.dontKnow || outcome.kind === 'dontknow',
  };
  const feedback: Feedback = {
    kind: outcome.kind,
    given: outcome.kind === 'dontknow' ? '' : outcome.given,
    answeredAt,
    canOverride: outcome.kind === 'wrong' && q.stage === 'typing',
    // Новую карточку можно назвать «слишком лёгкой» только после верного ввода: выбор из вариантов угадывается.
    canTooEasy:
      outcome.kind === 'correct' &&
      progress.mistakes === 0 &&
      !progress.dontKnow &&
      (q.stage === 'typing' || cardOf(pre, q.cardId).state !== 'new'),
    tooEasy: false,
  };
  if (outcome.kind !== 'dontknow' && outcome.chosenIndex !== undefined) feedback.chosenIndex = outcome.chosenIndex;
  return { ...pre, progress: { ...pre.progress, [q.cardId]: progress }, feedback, hint: null };
}

/** Можно ли сейчас отвечать (вопрос задан, результат ещё не показан). */
export function canAnswer(s: LearnSession): boolean {
  return s.state.question !== null && s.state.feedback === null;
}

function answered(s: LearnSession, state: PortionState): LearnSession {
  return { state, history: [...s.history, s.state] };
}

/** Выбор варианта на этапе 1. */
export function submitChoice(s: LearnSession, index: number, ctx: Ctx): LearnSession {
  const q = s.state.question;
  if (!canAnswer(s) || !q || q.stage !== 'choice') return s;
  const opt = q.options[index];
  if (!opt) return s;
  const kind = opt.cardId === q.cardId ? 'correct' : 'wrong';
  return answered(s, applyOutcome(s.state, { kind, given: opt.text, chosenIndex: index }, ctx.now));
}

/**
 * Ответ с клавиатуры на этапе 2. Пустой ответ игнорируется. Латиница или кириллица вместо японского
 * (направление «слово по переводу») НЕ принимается и НЕ считается ошибкой: показывается подсказка, можно ввести заново.
 */
export function submitTyped(s: LearnSession, text: string, ctx: Ctx): LearnSession {
  const q = s.state.question;
  if (!canAnswer(s) || !q || q.stage !== 'typing') return s;
  if (text.trim() === '') return s;
  const card = cardOf(s.state, q.cardId);
  if (q.direction === 'def-to-term') {
    // Верны также слова других карточек колоды с тем же переводом (きれい и 美しい: «красивый»).
    const key = normalizeDefinition(card.definition);
    const same = key === '' ? [] : s.state.deck.filter((c) => c.id !== card.id && normalizeDefinition(c.definition) === key);
    const res = checkTermAnswer(text, card, same);
    if (res.romajiHint) return { state: { ...s.state, hint: 'romaji' }, history: s.history };
    return answered(s, applyOutcome(s.state, { kind: res.correct ? 'correct' : 'wrong', given: text }, ctx.now));
  }
  // Два одинаково записанных слова («はし» и «はし») с разными переводами: верен перевод любого из них.
  const term = normalizeJapanese(card.term);
  const same = term === '' ? [] : s.state.deck.filter((c) => c.id !== card.id && normalizeJapanese(c.term) === term);
  const ok = checkDefinitionAnswer(
    text,
    card.definition,
    same.map((c) => c.definition),
  );
  return answered(s, applyOutcome(s.state, { kind: ok ? 'correct' : 'wrong', given: text }, ctx.now));
}

/** «Не знаю»: показывается ответ, считается ошибкой («снова»). Доступно на обоих этапах. */
export function dontKnow(s: LearnSession, ctx: Ctx): LearnSession {
  if (!canAnswer(s)) return s;
  return answered(s, applyOutcome(s.state, { kind: 'dontknow' }, ctx.now));
}

/** «Я был прав»: превращает неверный ввод с клавиатуры в верный (исправляет ложную ошибку). */
export function iWasRight(s: LearnSession): LearnSession {
  const fb = s.state.feedback;
  const pre = s.history[s.history.length - 1];
  if (!fb || !fb.canOverride || !pre) return s;
  return { state: applyOutcome(pre, { kind: 'correct', given: fb.given }, fb.answeredAt), history: s.history };
}

/** «Слишком легко»: только после верного ответа с первого раза; при переходе дальше карточка завершится с оценкой 4. */
export function markTooEasy(s: LearnSession): LearnSession {
  const fb = s.state.feedback;
  if (!fb || !fb.canTooEasy || fb.tooEasy) return s;
  return { state: { ...s.state, feedback: { ...fb, tooEasy: true } }, history: s.history };
}

export interface NextResult {
  session: LearnSession;
  /** Карточки, завершённые этим шагом (их оценку нужно записать). */
  completions: Completion[];
}

/** Переход к следующему вопросу после показа результата. Здесь карточка и завершается. */
export function next(s: LearnSession, ctx: Ctx): NextResult {
  const st = s.state;
  const q = st.question;
  const fb = st.feedback;
  if (!q || !fb) return { session: s, completions: [] };
  const correct = fb.kind === 'correct';
  let queue: readonly string[] = st.queue.slice(1);
  let completed = st.completed;
  const completions: Completion[] = [];
  if (correct && (fb.tooEasy || q.stage === 'typing')) {
    const p = progressOf(st, q.cardId);
    const done: Completion = {
      cardId: q.cardId,
      rating: ratingFor(p, fb.tooEasy),
      direction: q.direction,
      durationMs: p.ms,
      mistakes: p.mistakes,
      dontKnow: p.dontKnow,
      easy: fb.tooEasy,
    };
    completions.push(done);
    completed = [...completed, done];
  } else if (!correct) {
    // Ошибка: карточка возвращается в конец очереди этапа.
    queue = [...queue, q.cardId];
  }
  // Верно на этапе выбора без «слишком легко»: карточка просто уходит на этап ввода.
  const state = ask({ ...st, queue, completed }, ctx);
  return { session: { state, history: s.history }, completions };
}

export interface UndoResult {
  session: LearnSession;
  /** Завершения, отменённые этим откатом: их запись в базе нужно откатить. */
  rolledBack: Completion[];
}

/**
 * Отмена последнего ответа: возвращает вопрос, на который он был дан (без результата). Если ответ уже завершил
 * карточку (после «Дальше»), она возвращается в rolledBack, и вызывающий код откатывает запись в базе.
 */
export function undo(s: LearnSession, ctx: Ctx): UndoResult {
  const prev = s.history[s.history.length - 1];
  if (!prev) return { session: s, rolledBack: [] };
  const rolledBack = s.state.completed.slice(prev.completed.length);
  const state: PortionState = prev.question ? { ...prev, question: { ...prev.question, askedAt: ctx.now } } : prev;
  return { session: { state, history: s.history.slice(0, -1) }, rolledBack };
}

// ---------- сведения для экрана ----------

export function isDone(s: LearnSession): boolean {
  return s.state.stage === 'done';
}

export function currentCard(s: LearnSession): LearnCard | null {
  const q = s.state.question;
  return q ? cardOf(s.state, q.cardId) : null;
}

export function canUndo(s: LearnSession): boolean {
  return s.history.length > 0;
}

export interface PortionSummary {
  total: number;
  /** Сколько карточек верно с первого раза (без ошибок и «не знаю»). */
  firstTry: number;
  /** Карточки, в которых были ошибки или «не знаю» (в порядке порции). */
  missed: LearnCard[];
  /** Сколько карточек получило каждую оценку. */
  ratings: Record<Rating, number>;
}

export function summarize(s: LearnSession): PortionSummary {
  const done = s.state.completed;
  const clean = (c: Completion) => c.mistakes === 0 && !c.dontKnow;
  const missedIds = new Set(done.filter((c) => !clean(c)).map((c) => c.cardId));
  const ratings: Record<Rating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const c of done) ratings[c.rating]++;
  return {
    total: s.state.cards.length,
    firstTry: done.filter(clean).length,
    missed: s.state.cards.filter((c) => missedIds.has(c.id)),
    ratings,
  };
}
