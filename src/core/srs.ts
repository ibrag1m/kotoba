// Адаптер интервальных повторений. ЕДИНСТВЕННЫЙ файл, который импортирует ts-fsrs.
// Остальной код работает только с типами и функциями отсюда; замена библиотеки
// (например, на ts-fsrs 5.x) затрагивает только этот файл.
//
// Особенности ts-fsrs v6, учтённые здесь:
//  - DefaultScheduler() асинхронный: модель FSRS подгружается динамическим import(),
//    поэтому планировщик создаётся один раз при запуске (loadSrs), а preview/review
//    после этого синхронные;
//  - модель по умолчанию в v6 — FSRS-7, мы закрепляем FSRS-6 явно (SRS_MODEL);
//  - карточка библиотеки: dueAt/lastReviewAt (Date), learningStep, scheduleStatus, cardId;
//    у нас своя плоская запись (раздел 3 архитектуры), преобразование — ниже.
import { DefaultScheduler, State } from 'ts-fsrs';
import type { DefaultSchedulerCardInput } from 'ts-fsrs';

/** Модель FSRS, закреплённая явно (по умолчанию в ts-fsrs v6 была бы FSRS-7). */
export const SRS_MODEL = 'FSRS-6' as const;

/** Оценка: 1 снова, 2 трудно, 3 хорошо, 4 легко. */
export type Rating = 1 | 2 | 3 | 4;
export const RATINGS: readonly Rating[] = [1, 2, 3, 4];

export type CardPhase = 'new' | 'learning' | 'review' | 'relearning';

/** Состояние повторений карточки в нашем формате (хранится в IndexedDB). Время: мс UTC. */
export interface SrsState {
  due: number;
  stability: number;
  difficulty: number;
  state: CardPhase;
  reps: number;
  lapses: number;
  lastReview?: number;
  scheduledDays: number;
  /** Номер текущего шага (пере)изучения (learning_steps в терминах FSRS). */
  learningSteps: number;
}

export interface SrsPreviewItem {
  rating: Rating;
  state: SrsState;
  /** Через сколько мс карточка снова станет к повторению (due - now). */
  intervalMs: number;
}

export interface SrsReviewResult {
  /** Состояние после ответа. */
  state: SrsState;
  /** Снимок состояния до ответа (для журнала: отмена ответа и пересчёт). */
  prev: SrsState;
  rating: Rating;
  ts: number;
}

export interface SrsInfo {
  model: typeof SRS_MODEL;
  ready: boolean;
  error: string | null;
}

const SCHEDULER_OPTIONS = {
  version: SRS_MODEL,
  desiredRetention: 0.9,
  enableShortTerm: true,
  learningSteps: ['1m', '10m'],
  relearningSteps: ['10m'],
  enableFuzz: false,
  maximumInterval: 36500,
} as const;

type Scheduler = Awaited<ReturnType<typeof DefaultScheduler<typeof SRS_MODEL>>>;
type LibCardInput = DefaultSchedulerCardInput<typeof SRS_MODEL>;

let scheduler: Scheduler | null = null;
let loading: Promise<void> | null = null;
let loadError: string | null = null;

/**
 * Создаёт планировщик (один раз). Вызывать при запуске приложения.
 * Повторные вызовы возвращают тот же промис; после ошибки можно вызвать снова.
 */
export function loadSrs(): Promise<void> {
  if (scheduler) return Promise.resolve();
  if (!loading) {
    loading = DefaultScheduler(SCHEDULER_OPTIONS)
      .then((s) => {
        scheduler = s;
        loadError = null;
      })
      .catch((e: unknown) => {
        loading = null;
        loadError = e instanceof Error ? e.message : String(e);
        throw e;
      });
  }
  return loading;
}

export function isSrsReady(): boolean {
  return scheduler !== null;
}

export function srsInfo(): SrsInfo {
  return { model: SRS_MODEL, ready: scheduler !== null, error: loadError };
}

/**
 * Только для тестов. В продакшн-сборке никем не импортируется (убирается tree-shaking),
 * а если её всё же вызвать, она откажется работать.
 */
export function resetSrsForTests(): void {
  if (import.meta.env.PROD) throw new Error('resetSrsForTests вызвана в продакшн-сборке');
  scheduler = null;
  loading = null;
  loadError = null;
}

function need(): Scheduler {
  if (!scheduler) throw new Error('Планировщик не загружен: сначала await loadSrs()');
  return scheduler;
}

/** Новая карточка. Не требует загруженного планировщика: это чистые данные. */
export function newState(now: number = Date.now()): SrsState {
  return {
    due: now,
    stability: 0,
    difficulty: 0,
    state: 'new',
    reps: 0,
    lapses: 0,
    scheduledDays: 0,
    learningSteps: 0,
  };
}

const PHASE_TO_LIB: Record<CardPhase, number> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};
const LIB_TO_PHASE: Record<number, CardPhase> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

// Библиотека требует cardId, но он влияет только на «случайность» при включённом fuzz
// (у нас выключен), поэтому адаптер подставляет константу и не тащит id наружу.
const LIB_CARD_ID = 'kotoba';

function toLib(s: SrsState): LibCardInput {
  return {
    cardId: LIB_CARD_ID,
    stability: s.stability,
    difficulty: s.difficulty,
    state: PHASE_TO_LIB[s.state] as LibCardInput['state'],
    // В v6 scheduleStatus знает только new / learning / review; переобучение = learning.
    scheduleStatus: s.state === 'new' ? 'new' : s.state === 'review' ? 'review' : 'learning',
    dueAt: new Date(s.due),
    lastReviewAt: s.lastReview === undefined ? null : new Date(s.lastReview),
    reps: s.reps,
    lapses: s.lapses,
    scheduledDays: s.scheduledDays,
    learningStep: s.learningSteps,
  };
}

interface LibCardOutput {
  stability: number;
  difficulty: number;
  state: number;
  dueAt: Date;
  lastReviewAt: Date | null;
  reps: number;
  lapses: number;
  scheduledDays: number;
  learningStep: number;
}

function fromLib(c: LibCardOutput): SrsState {
  const phase = LIB_TO_PHASE[c.state];
  if (!phase) throw new Error(`Неизвестное состояние карточки FSRS: ${c.state}`);
  const out: SrsState = {
    due: c.dueAt.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    state: phase,
    reps: c.reps,
    lapses: c.lapses,
    scheduledDays: c.scheduledDays,
    learningSteps: c.learningStep,
  };
  if (c.lastReviewAt) out.lastReview = c.lastReviewAt.getTime();
  return out;
}

/** Что будет с карточкой при каждой из четырёх оценок. Не меняет состояние. */
export function preview(state: SrsState, now: number): Record<Rating, SrsPreviewItem> {
  const result = {} as Record<Rating, SrsPreviewItem>;
  for (const item of need().preview({ card: toLib(state), now: new Date(now) })) {
    const rating = item.grade as Rating;
    const next = fromLib(item.card);
    result[rating] = { rating, state: next, intervalMs: next.due - now };
  }
  for (const r of RATINGS) {
    if (!result[r]) throw new Error(`preview не вернул оценку ${r}`);
  }
  return result;
}

/**
 * Снимок состояния FSRS явным перечислением полей. На вход review() могут передать целую
 * карточку (Card extends SrsState) с term, definition, id и т.д.: в журнал они попасть не должны.
 */
export function snapshotState(s: SrsState): SrsState {
  const out: SrsState = {
    due: s.due,
    stability: s.stability,
    difficulty: s.difficulty,
    state: s.state,
    reps: s.reps,
    lapses: s.lapses,
    scheduledDays: s.scheduledDays,
    learningSteps: s.learningSteps,
  };
  if (s.lastReview !== undefined) out.lastReview = s.lastReview;
  return out;
}

/** Применяет оценку. Возвращает новое состояние и снимок прежнего; вход не меняется. */
export function review(state: SrsState, rating: Rating, now: number): SrsReviewResult {
  const res = need().review({ card: toLib(state), grade: rating, now: new Date(now) });
  return { state: fromLib(res.card), prev: snapshotState(state), rating, ts: now };
}
