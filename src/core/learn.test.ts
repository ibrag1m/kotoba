import { describe, expect, it } from 'vitest';
import {
  CHOICE_OPTIONS,
  PORTION_SIZE,
  buildQueue,
  canAnswer,
  canUndo,
  currentCard,
  dontKnow,
  isDone,
  iWasRight,
  markTooEasy,
  next,
  ratingFor,
  startOfLocalDay,
  startOfNextLocalDay,
  startPortion,
  submitChoice,
  submitTyped,
  summarize,
  undo,
} from './learn';
import type { Completion, Ctx, LearnCard, LearnSession, QueueCard } from './learn';
import { seededRng } from './shuffle';

const T0 = new Date(2026, 5, 10, 12, 0, 0).getTime();
const MIN = 60_000;
const DAY = 86_400_000;

function card(i: number, extra: Partial<LearnCard> = {}): LearnCard {
  return { id: `c${i}`, term: `語${i}`, reading: `ご${i}`, definition: `слово ${i}`, ...extra };
}
const cards = (n: number): LearnCard[] => Array.from({ length: n }, (_, i) => card(i));

function qc(i: number, over: Partial<QueueCard> = {}): QueueCard {
  return { ...card(i), state: 'new', due: T0, position: i, ...over };
}

let clock = T0;
const ctx = (extra: Partial<Ctx> = {}): Ctx => ({ now: (clock += 1000), ...extra });

/** Верный ответ на текущий вопрос (выбор или ввод) и переход дальше; возвращает сессию и завершения. */
function answerRight(s: LearnSession, c: Ctx = ctx()): { session: LearnSession; done: Completion[] } {
  const q = s.state.question;
  if (!q) throw new Error('нет вопроса');
  const card = currentCard(s);
  if (!card) throw new Error('нет карточки');
  let after: LearnSession;
  if (q.stage === 'choice') {
    after = submitChoice(s, q.options.findIndex((o) => o.cardId === q.cardId), c);
  } else {
    after = submitTyped(s, q.direction === 'def-to-term' ? card.term : card.definition, c);
  }
  expect(after.state.feedback?.kind).toBe('correct');
  const r = next(after, c);
  return { session: r.session, done: r.completions };
}

/** Заведомо неверный ответ на текущий вопрос. */
function answerWrong(s: LearnSession, c: Ctx = ctx()): LearnSession {
  const q = s.state.question;
  if (!q) throw new Error('нет вопроса');
  if (q.stage === 'choice') {
    return submitChoice(s, q.options.findIndex((o) => o.cardId !== q.cardId), c);
  }
  return submitTyped(s, q.direction === 'def-to-term' ? 'ぜんぜんちがう' : 'совсем не то', c);
}

/** Проходит порцию до конца без ошибок. */
function runPerfect(s0: LearnSession): { session: LearnSession; done: Completion[]; steps: number } {
  let s = s0;
  const done: Completion[] = [];
  let steps = 0;
  while (!isDone(s)) {
    const r = answerRight(s);
    s = r.session;
    done.push(...r.done);
    if (++steps > 200) throw new Error('порция не завершается');
  }
  return { session: s, done, steps };
}

describe('startOfLocalDay', () => {
  it('начало суток по местному времени', () => {
    const noon = new Date(2026, 5, 10, 12, 30).getTime();
    expect(startOfLocalDay(noon)).toBe(new Date(2026, 5, 10, 0, 0, 0, 0).getTime());
    expect(startOfLocalDay(new Date(2026, 5, 10, 23, 59, 59, 999).getTime())).toBe(new Date(2026, 5, 10).getTime());
    expect(startOfLocalDay(new Date(2026, 5, 10).getTime())).toBe(new Date(2026, 5, 10).getTime());
    expect(startOfNextLocalDay(noon)).toBe(new Date(2026, 5, 11).getTime());
  });
});

describe('buildQueue', () => {
  const mixed: QueueCard[] = [
    qc(0, { state: 'review', due: T0 - 2 * DAY, position: 0 }),
    qc(1, { state: 'learning', due: T0 - 5 * MIN, position: 1 }),
    qc(2, { state: 'review', due: T0 + 3 * DAY, position: 2 }),
    qc(3, { state: 'new', position: 3 }),
    qc(4, { state: 'new', position: 4 }),
    qc(5, { state: 'new', position: 5 }),
    qc(6, { state: 'relearning', due: T0 + 10 * MIN, position: 6 }),
  ];

  it('сначала карточки к повторению (самые просроченные первыми), затем новые по порядку', () => {
    const q = buildQueue(mixed, T0, 2);
    expect(q.due.map((c) => c.id)).toEqual(['c0', 'c1']);
    expect(q.fresh.map((c) => c.id)).toEqual(['c3', 'c4']);
    expect(q.list.map((c) => c.id)).toEqual(['c0', 'c1', 'c3', 'c4']);
    expect(q.newTotal).toBe(3);
  });

  it('новые карточки со сроком due <= сейчас не считаются карточками к повторению', () => {
    const q = buildQueue([qc(0, { state: 'new', due: T0 - DAY })], T0, 0);
    expect(q.due).toEqual([]);
    expect(q.fresh).toEqual([]);
    expect(q.newTotal).toBe(1);
  });

  it('остаток лимита: ноль, отрицательный и дробный', () => {
    expect(buildQueue(mixed, T0, 0).fresh).toEqual([]);
    expect(buildQueue(mixed, T0, -5).fresh).toEqual([]);
    expect(buildQueue(mixed, T0, Number.NaN).fresh).toEqual([]);
    expect(buildQueue(mixed, T0, 1.9).fresh.map((c) => c.id)).toEqual(['c3']);
    expect(buildQueue(mixed, T0, 100).fresh.map((c) => c.id)).toEqual(['c3', 'c4', 'c5']);
  });

  it('ближайшее будущее повторение', () => {
    expect(buildQueue(mixed, T0, 0).nextDueAt).toBe(T0 + 10 * MIN);
    expect(buildQueue([qc(0)], T0, 5).nextDueAt).toBeNull();
  });

  it('граница due: ровно в срок карточка уже в очереди', () => {
    const c = qc(0, { state: 'learning', due: T0 + 10 * MIN });
    expect(buildQueue([c], T0 + 10 * MIN - 1, 0).due).toEqual([]);
    expect(buildQueue([c], T0 + 10 * MIN, 0).due).toHaveLength(1);
  });
});

describe('порция: состав и этапы', () => {
  it('в порцию входят не больше 7 карточек', () => {
    const s = startPortion(cards(12), cards(12), ctx());
    expect(s.state.cards).toHaveLength(PORTION_SIZE);
    expect(s.state.queue).toHaveLength(PORTION_SIZE);
    expect(startPortion(cards(3), cards(3), ctx()).state.cards).toHaveLength(3);
  });

  it('пустая очередь: порция сразу завершена', () => {
    const s = startPortion([], cards(10), ctx());
    expect(isDone(s)).toBe(true);
    expect(s.state.question).toBeNull();
  });

  it('в колоде 4 и более карточек: сначала выбор, потом ввод', () => {
    const s = startPortion(cards(4), cards(4), ctx());
    expect(s.state.stage).toBe('choice');
    expect(s.state.question?.stage).toBe('choice');
  });

  it('в колоде меньше 4 карточек: сразу ввод, выбора нет', () => {
    const s = startPortion(cards(3), cards(3), ctx());
    expect(s.state.stage).toBe('typing');
    expect(s.state.question?.stage).toBe('typing');
    expect(s.state.question?.options).toEqual([]);
  });

  it('колода больше порции: выбор включён, даже если в порции всего 2 карточки', () => {
    const s = startPortion(cards(2), cards(30), ctx());
    expect(s.state.stage).toBe('choice');
  });

  it('безошибочное прохождение: каждая карточка завершается один раз с оценкой 3', () => {
    const { session, done } = runPerfect(startPortion(cards(7), cards(7), ctx()));
    expect(done).toHaveLength(7);
    expect(new Set(done.map((d) => d.cardId)).size).toBe(7);
    expect(done.every((d) => d.rating === 3 && d.mistakes === 0 && !d.dontKnow && !d.easy)).toBe(true);
    expect(isDone(session)).toBe(true);
    expect(summarize(session)).toMatchObject({ total: 7, firstTry: 7, missed: [], ratings: { 1: 0, 2: 0, 3: 7, 4: 0 } });
  });

  it('оба этапа проходит каждая карточка: 7 вопросов выбора, затем 7 вопросов ввода', () => {
    let s = startPortion(cards(7), cards(7), ctx());
    const stages: string[] = [];
    while (!isDone(s)) {
      stages.push(s.state.question?.stage ?? '?');
      s = answerRight(s).session;
    }
    expect(stages).toEqual([...Array(7).fill('choice'), ...Array(7).fill('typing')]);
  });
});

describe('варианты выбора', () => {
  it('ровно 4 варианта, верный среди них, без повторов', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = startPortion(cards(10), cards(10), ctx({ rng: seededRng(seed) }));
      const q = s.state.question;
      expect(q?.options).toHaveLength(CHOICE_OPTIONS);
      expect(q?.options.filter((o) => o.cardId === q.cardId)).toHaveLength(1);
      expect(new Set(q?.options.map((o) => o.text)).size).toBe(CHOICE_OPTIONS);
      expect(new Set(q?.options.map((o) => o.cardId)).size).toBe(CHOICE_OPTIONS);
    }
  });

  it('обманки берутся только из этой колоды', () => {
    const deck = cards(8);
    const ids = new Set(deck.map((c) => c.id));
    const s = startPortion(deck.slice(0, 2), deck, ctx());
    expect(s.state.question?.options.every((o) => ids.has(o.cardId))).toBe(true);
  });

  it('обманка с таким же переводом, как у верной карточки, не попадает в варианты', () => {
    const deck = [
      card(0, { definition: 'вода' }),
      card(1, { definition: 'Вода ' }),
      card(2, { definition: 'ВОДА' }),
      card(3, { definition: 'огонь' }),
      card(4, { definition: 'земля' }),
      card(5, { definition: 'воздух' }),
    ];
    for (let seed = 1; seed <= 40; seed++) {
      const s = startPortion([deck[0] as LearnCard], deck, ctx({ rng: seededRng(seed) }), { directions: 'term-to-def' });
      const texts = s.state.question?.options.map((o) => o.text.trim().toLowerCase());
      expect(texts?.filter((t) => t === 'вода')).toHaveLength(1);
      expect(new Set(texts).size).toBe(4);
    }
  });

  it('направление перевод → слово: варианты это слова, верное слово среди них один раз (чтение или катакана не дублирует)', () => {
    const deck = [
      card(0, { term: '水', reading: 'みず' }),
      card(1, { term: 'ミズ', reading: 'みず' }),
      card(2, { term: 'みず' }),
      card(3, { term: '火', reading: 'ひ' }),
      card(4, { term: '木', reading: 'き' }),
      card(5, { term: '土', reading: 'つち' }),
    ];
    for (let seed = 1; seed <= 40; seed++) {
      const s = startPortion([deck[0] as LearnCard], deck, ctx({ rng: seededRng(seed) }), { directions: 'def-to-term' });
      const q = s.state.question;
      expect(q?.direction).toBe('def-to-term');
      expect(q?.options).toHaveLength(4);
      const keys = q?.options.map((o) => o.text);
      // 'みず' совпадает с чтением верной карточки (тоже верный ответ), 'ミズ' с ним равнозначно
      expect(keys).not.toContain('ミズ');
      expect(keys).not.toContain('みず');
      expect(keys?.filter((t) => t === '水')).toHaveLength(1);
      expect(q?.options.find((o) => o.cardId === 'c0')?.reading).toBe('みず');
    }
  });

  it('не из чего собрать 4 разных варианта: этап выбора пропускается, сразу ввод', () => {
    const same = Array.from({ length: 5 }, (_, i) => card(i, { definition: 'одно и то же' }));
    const s = startPortion(same.slice(0, 2), same, ctx(), { directions: 'term-to-def' });
    expect(s.state.question?.stage).toBe('typing');
  });

  it('если в одном направлении вариантов не хватает, берётся другое', () => {
    // У верной карточки есть омоним по чтению (橋 и 箸 «はし»): «слово → перевод» не собрать (омоним исключён),
    // а «перевод → слово» собирается.
    const deck = [
      card(0, { term: '橋', reading: 'はし', definition: 'мост' }),
      card(1, { term: '箸', reading: 'はし', definition: 'палочки' }),
      card(2, { term: '火', reading: 'ひ', definition: 'огонь' }),
      card(3, { term: '木', reading: 'き', definition: 'дерево' }),
    ];
    for (let seed = 1; seed <= 20; seed++) {
      const s = startPortion([deck[0] as LearnCard], deck, ctx({ rng: seededRng(seed) }));
      expect(s.state.question?.stage).toBe('choice');
      expect(s.state.question?.direction).toBe('def-to-term');
    }
  });

  it('карточки с тем же переводом (きれい и 美しい: «красивый») не попадают в обманки перевода → слова', () => {
    const deck = [
      card(0, { term: 'きれい', reading: 'きれい', definition: 'красивый' }),
      card(1, { term: '美しい', reading: 'うつくしい', definition: 'Красивый' }),
      card(2, { term: '火', reading: 'ひ', definition: 'огонь' }),
      card(3, { term: '木', reading: 'き', definition: 'дерево' }),
      card(4, { term: '土', reading: 'つち', definition: 'земля' }),
      card(5, { term: '水', reading: 'みず', definition: 'вода' }),
    ];
    for (let seed = 1; seed <= 40; seed++) {
      const s = startPortion([deck[0] as LearnCard], deck, ctx({ rng: seededRng(seed) }), { directions: 'def-to-term' });
      const q = s.state.question;
      expect(q?.stage).toBe('choice');
      expect(q?.options.map((o) => o.cardId)).not.toContain('c1');
      expect(q?.options).toHaveLength(4);
    }
    // в обратную сторону (слово → перевод) одинаковые переводы и так не повторяются
    for (let seed = 1; seed <= 40; seed++) {
      const s = startPortion([deck[0] as LearnCard], deck, ctx({ rng: seededRng(seed) }), { directions: 'term-to-def' });
      const defs = s.state.question?.options.map((o) => o.text.toLowerCase());
      expect(defs?.filter((d) => d === 'красивый')).toHaveLength(1);
    }
  });

  it('два одинаковых слова «はし» с разными переводами: в вопросе «слово → перевод» двойник не обманка', () => {
    const deck = [
      card(0, { term: 'はし', reading: 'はし', definition: 'мост' }),
      card(1, { term: 'はし', reading: 'はし', definition: 'палочки' }),
      card(2, { term: '火', reading: 'ひ', definition: 'огонь' }),
      card(3, { term: '木', reading: 'き', definition: 'дерево' }),
      card(4, { term: '土', reading: 'つち', definition: 'земля' }),
    ];
    for (let seed = 1; seed <= 40; seed++) {
      const s = startPortion([deck[0] as LearnCard], deck, ctx({ rng: seededRng(seed) }), { directions: 'term-to-def' });
      expect(s.state.question?.stage).toBe('choice');
      expect(s.state.question?.options.map((o) => o.cardId).sort()).toEqual(['c0', 'c2', 'c3', 'c4']);
    }
  });

  it('совпадение по чтению (橋 и 箸 «はし»): если обманок не хватает, этап выбора пропускается', () => {
    const deck = [
      card(0, { term: '橋', reading: 'はし', definition: 'мост' }),
      card(1, { term: '箸', reading: 'はし', definition: 'палочки' }),
      card(2, { term: '火', reading: 'ひ', definition: 'огонь' }),
      card(3, { term: '木', reading: 'き', definition: 'дерево' }),
    ];
    const s = startPortion([deck[0] as LearnCard], deck, ctx(), { directions: 'term-to-def' });
    expect(s.state.question?.stage).toBe('typing');
    expect(s.state.choiceAsked).toBe(false);
  });
});

describe('направление вопроса', () => {
  it('выбирается случайно: подменяемый генератор управляет направлением', () => {
    const low = startPortion(cards(2), cards(2), { now: T0, rng: () => 0.1 });
    expect(low.state.question?.direction).toBe('term-to-def');
    const high = startPortion(cards(2), cards(2), { now: T0, rng: () => 0.9 });
    expect(high.state.question?.direction).toBe('def-to-term');
  });

  it('при настройке «одно направление» оно и используется', () => {
    for (const rng of [() => 0.1, () => 0.9]) {
      const a = startPortion(cards(2), cards(2), { now: T0, rng }, { directions: 'def-to-term' });
      expect(a.state.question?.direction).toBe('def-to-term');
      const b = startPortion(cards(2), cards(2), { now: T0, rng }, { directions: 'term-to-def' });
      expect(b.state.question?.direction).toBe('term-to-def');
    }
  });

  it('в обоих направлениях встречаются оба при обычном генераторе', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const s = startPortion(cards(3), cards(3), { now: T0, rng: seededRng(seed) });
      if (s.state.question) seen.add(s.state.question.direction);
    }
    expect(seen).toEqual(new Set(['term-to-def', 'def-to-term']));
  });

  it('один и тот же генератор даёт один и тот же ход порции', () => {
    const trace = (seed: number) => {
      let s = startPortion(cards(9), cards(9), { now: T0, rng: seededRng(seed) });
      const out: string[] = [];
      while (!isDone(s)) {
        const q = s.state.question;
        out.push(`${q?.cardId}:${q?.stage}:${q?.direction}:${q?.options.map((o) => o.cardId).join('+')}`);
        s = answerRight(s, { now: T0, rng: seededRng(seed + 1000) }).session;
      }
      return out;
    };
    expect(trace(7)).toEqual(trace(7));
    expect(trace(7)).not.toEqual(trace(8));
  });
});

describe('ввод с клавиатуры', () => {
  it('японский по переводу: засчитывается term и reading, катакана', () => {
    const base = startPortion([card(0, { term: '水', reading: 'みず', definition: 'вода' })], cards(1), ctx(), {
      directions: 'def-to-term',
    });
    for (const ok of ['水', 'みず', 'ミズ', ' み ず ']) {
      expect(submitTyped(base, ok, ctx()).state.feedback?.kind).toBe('correct');
    }
    expect(submitTyped(base, 'ひ', ctx()).state.feedback?.kind).toBe('wrong');
  });

  it('перевод по японскому: регистр, ё/е, варианты', () => {
    const base = startPortion([card(0, { term: '蛇', definition: 'Ёж, ежик' })], cards(1), ctx(), { directions: 'term-to-def' });
    for (const ok of ['еж', 'ЁЖ', 'ежик', ' ёжик. ']) {
      expect(submitTyped(base, ok, ctx()).state.feedback?.kind).toBe('correct');
    }
    expect(submitTyped(base, 'змея', ctx()).state.feedback?.kind).toBe('wrong');
  });

  it('романдзи не принимается и не считается ошибкой: подсказка, состояние и история прежние', () => {
    const base = startPortion([card(0, { term: '水', reading: 'みず' })], cards(1), ctx(), { directions: 'def-to-term' });
    const hinted = submitTyped(base, 'mizu', ctx());
    expect(hinted.state.hint).toBe('romaji');
    expect(hinted.state.feedback).toBeNull();
    expect(hinted.state.progress).toEqual(base.state.progress);
    expect(hinted.history).toHaveLength(0);
    expect(canAnswer(hinted)).toBe(true);
    // после переключения клавиатуры ответ принимается как верный с первого раза
    const ok = submitTyped(hinted, 'みず', ctx());
    expect(ok.state.hint).toBeNull();
    expect(ok.state.feedback).toMatchObject({ kind: 'correct', canTooEasy: true });
  });

  it('латиница в направлении «перевод по японскому» не даёт подсказку про клавиатуру', () => {
    const base = startPortion([card(0)], cards(1), ctx(), { directions: 'term-to-def' });
    const r = submitTyped(base, 'mizu', ctx());
    expect(r.state.hint).toBeNull();
    expect(r.state.feedback?.kind).toBe('wrong');
  });

  it('пустой ввод игнорируется', () => {
    const base = startPortion(cards(2), cards(2), ctx());
    expect(submitTyped(base, '   ', ctx())).toBe(base);
  });

  it('повторный ответ на тот же вопрос игнорируется (двойное нажатие)', () => {
    const base = startPortion(cards(2), cards(2), ctx(), { directions: 'term-to-def' });
    const q = base.state.question;
    const first = submitTyped(base, 'совсем не то', ctx());
    expect(submitTyped(first, 'совсем не то', ctx())).toBe(first);
    expect(dontKnow(first, ctx())).toBe(first);
    expect(first.history).toHaveLength(1);
    expect(q).not.toBeNull();
  });

  it('ввод не принимается на этапе выбора, выбор на этапе ввода', () => {
    const choice = startPortion(cards(5), cards(5), ctx());
    expect(submitTyped(choice, 'что-то', ctx())).toBe(choice);
    const typing = startPortion(cards(2), cards(2), ctx());
    expect(submitChoice(typing, 0, ctx())).toBe(typing);
    expect(submitChoice(choice, 99, ctx())).toBe(choice);
  });
});

describe('ошибки и оценки', () => {
  it('ошибка возвращает карточку в очередь порции (в конец), порция не кончается, пока она не усвоена', () => {
    const start = startPortion(cards(5), cards(5), ctx());
    const firstId = start.state.question?.cardId as string;
    const wrong = answerWrong(start);
    expect(wrong.state.feedback?.kind).toBe('wrong');
    const r = next(wrong, ctx());
    expect(r.completions).toEqual([]);
    expect(r.session.state.queue).toHaveLength(5);
    expect(r.session.state.queue[r.session.state.queue.length - 1]).toBe(firstId);
    expect(r.session.state.question?.cardId).not.toBe(firstId);
  });

  it('«Не знаю»: ошибка, карточка возвращается, итоговая оценка 1 даже после верных ответов', () => {
    let s = startPortion(cards(1), cards(1), ctx(), { directions: 'term-to-def' });
    s = dontKnow(s, ctx());
    expect(s.state.feedback).toMatchObject({ kind: 'dontknow', canOverride: false, canTooEasy: false });
    let r = next(s, ctx());
    expect(r.completions).toEqual([]);
    expect(isDone(r.session)).toBe(false);
    r = answerRight(r.session) && next(submitTyped(r.session, 'слово 0', ctx()), ctx());
    expect(r.completions).toHaveLength(1);
    expect(r.completions[0]).toMatchObject({ cardId: 'c0', rating: 1, dontKnow: true, easy: false });
    expect(isDone(r.session)).toBe(true);
  });

  it('ошибка выбора, потом всё верно: оценка 2 (трудно)', () => {
    let s = startPortion(cards(4), cards(4), ctx());
    const id = s.state.question?.cardId as string;
    s = next(answerWrong(s), ctx()).session;
    const out: Completion[] = [];
    while (!isDone(s)) {
      const r = answerRight(s);
      s = r.session;
      out.push(...r.done);
    }
    expect(out.find((c) => c.cardId === id)).toMatchObject({ rating: 2, mistakes: 1, dontKnow: false });
    expect(out.filter((c) => c.cardId !== id).every((c) => c.rating === 3)).toBe(true);
    expect(summarize(s).missed.map((c) => c.id)).toEqual([id]);
    expect(summarize(s).firstTry).toBe(3);
  });

  it('ошибка ввода, потом верно: оценка 2', () => {
    let s = startPortion(cards(2), cards(2), ctx());
    const id = s.state.question?.cardId as string;
    s = next(answerWrong(s), ctx()).session;
    const out: Completion[] = [];
    while (!isDone(s)) {
      const r = answerRight(s);
      s = r.session;
      out.push(...r.done);
    }
    expect(out.find((c) => c.cardId === id)?.rating).toBe(2);
  });

  it('несколько ошибок подряд всё равно «трудно», а «не знаю» среди них даёт «снова»', () => {
    let s = startPortion(cards(1), cards(1), ctx(), { directions: 'term-to-def' });
    s = next(answerWrong(s), ctx()).session;
    s = next(answerWrong(s), ctx()).session;
    let r = next(submitTyped(s, 'слово 0', ctx()), ctx());
    expect(r.completions[0]).toMatchObject({ rating: 2, mistakes: 2 });

    s = startPortion(cards(1), cards(1), ctx(), { directions: 'term-to-def' });
    s = next(answerWrong(s), ctx()).session;
    s = next(dontKnow(s, ctx()), ctx()).session;
    r = next(submitTyped(s, 'слово 0', ctx()), ctx());
    expect(r.completions[0]).toMatchObject({ rating: 1, mistakes: 2, dontKnow: true });
  });

  it('ratingFor: приоритет «слишком легко» > «не знаю» > ошибка > чисто', () => {
    expect(ratingFor({ mistakes: 0, dontKnow: false }, false)).toBe(3);
    expect(ratingFor({ mistakes: 2, dontKnow: false }, false)).toBe(2);
    expect(ratingFor({ mistakes: 1, dontKnow: true }, false)).toBe(1);
    expect(ratingFor({ mistakes: 0, dontKnow: false }, true)).toBe(4);
  });

  it('длительность: сумма времени ответов, один вопрос не больше двух минут', () => {
    let s = startPortion(cards(1), cards(1), { now: 0 }, { directions: 'term-to-def' });
    s = submitTyped(s, 'слово 0', { now: 5000 });
    let r = next(s, { now: 6000 });
    expect(r.completions[0]?.durationMs).toBe(5000);

    s = startPortion(cards(1), cards(1), { now: 0 }, { directions: 'term-to-def' });
    s = next(submitTyped(s, 'нет', { now: 3000 }), { now: 10_000 }).session;
    s = submitTyped(s, 'слово 0', { now: 10_000 + 4000 });
    r = next(s, { now: 20_000 });
    expect(r.completions[0]?.durationMs).toBe(7000);

    s = startPortion(cards(1), cards(1), { now: 0 }, { directions: 'term-to-def' });
    r = next(submitTyped(s, 'слово 0', { now: 3_600_000 }), { now: 3_600_001 });
    expect(r.completions[0]?.durationMs).toBe(120_000);
  });

  it('направление в завершении: то, на котором карточка завершилась', () => {
    const s = startPortion(cards(1), cards(1), { now: T0 }, { directions: 'def-to-term' });
    const r = next(submitTyped(s, '語0', { now: T0 + 1 }), { now: T0 + 2 });
    expect(r.completions[0]?.direction).toBe('def-to-term');
  });
});

describe('«Я был прав»', () => {
  const base = () => startPortion([card(0, { term: '水', reading: 'みず', definition: 'вода' })], cards(1), ctx(), { directions: 'def-to-term' });

  it('исправляет ложную ошибку: ответ становится верным с первого раза, карточка завершается с оценкой 3', () => {
    const wrong = submitTyped(base(), 'ふつう', ctx());
    expect(wrong.state.feedback).toMatchObject({ kind: 'wrong', canOverride: true });
    const fixed = iWasRight(wrong);
    expect(fixed.state.feedback).toMatchObject({ kind: 'correct', canOverride: false, canTooEasy: true });
    expect(fixed.state.progress.c0).toMatchObject({ mistakes: 0, dontKnow: false });
    expect(fixed.history).toHaveLength(1);
    const r = next(fixed, ctx());
    expect(r.completions[0]).toMatchObject({ rating: 3, mistakes: 0 });
    expect(isDone(r.session)).toBe(true);
  });

  it('недоступно после «не знаю», после верного ответа и на этапе выбора', () => {
    const dk = dontKnow(base(), ctx());
    expect(iWasRight(dk)).toBe(dk);
    const ok = submitTyped(base(), 'みず', ctx());
    expect(iWasRight(ok)).toBe(ok);
    const choice = startPortion(cards(5), cards(5), ctx());
    const wrong = answerWrong(choice);
    expect(wrong.state.feedback?.canOverride).toBe(false);
    expect(iWasRight(wrong)).toBe(wrong);
  });

  it('если до этого были ошибки, исправленный ответ остаётся «трудно»', () => {
    let s = startPortion(cards(1), cards(1), ctx(), { directions: 'term-to-def' });
    s = next(answerWrong(s), ctx()).session;
    s = iWasRight(submitTyped(s, 'не то', ctx()));
    expect(s.state.feedback?.canTooEasy).toBe(false);
    const r = next(s, ctx());
    expect(r.completions[0]).toMatchObject({ rating: 2, mistakes: 1 });
  });

  it('повторное нажатие ничего не меняет', () => {
    const fixed = iWasRight(submitTyped(base(), 'ふつう', ctx()));
    expect(iWasRight(fixed)).toBe(fixed);
  });
});

describe('«Слишком легко»', () => {
  it('после верного ответа с первого раза на этапе выбора: карточка завершается с оценкой 4 и пропускает ввод', () => {
    const start = startPortion(cards(5), cards(5), ctx());
    const id = start.state.question?.cardId as string;
    const q = start.state.question;
    const picked = submitChoice(start, q?.options.findIndex((o) => o.cardId === id) ?? 0, ctx());
    expect(picked.state.feedback?.canTooEasy).toBe(true);
    const easy = markTooEasy(picked);
    expect(easy.state.feedback?.tooEasy).toBe(true);
    const r = next(easy, ctx());
    expect(r.completions).toHaveLength(1);
    expect(r.completions[0]).toMatchObject({ cardId: id, rating: 4, easy: true, direction: q?.direction });
    // на этапе ввода эта карточка больше не спрашивается
    let s = r.session;
    const typedIds: string[] = [];
    while (!isDone(s)) {
      if (s.state.question?.stage === 'typing') typedIds.push(s.state.question.cardId);
      s = answerRight(s).session;
    }
    expect(typedIds).not.toContain(id);
    expect(typedIds).toHaveLength(4);
  });

  it('после верного ввода с первого раза: оценка 4', () => {
    const s = startPortion(cards(1), cards(1), ctx(), { directions: 'term-to-def' });
    const r = next(markTooEasy(submitTyped(s, 'слово 0', ctx())), ctx());
    expect(r.completions[0]).toMatchObject({ rating: 4, easy: true });
  });

  it('недоступно после ошибки: ни в этом ответе, ни в следующих верных', () => {
    let s = startPortion(cards(1), cards(1), ctx(), { directions: 'term-to-def' });
    const wrong = submitTyped(s, 'нет', ctx());
    expect(wrong.state.feedback?.canTooEasy).toBe(false);
    expect(markTooEasy(wrong)).toBe(wrong);
    s = next(wrong, ctx()).session;
    const right = submitTyped(s, 'слово 0', ctx());
    expect(right.state.feedback).toMatchObject({ kind: 'correct', canTooEasy: false });
    expect(markTooEasy(right)).toBe(right);
  });

  it('недоступно после «не знаю» и до ответа', () => {
    const s = startPortion(cards(2), cards(2), ctx());
    expect(markTooEasy(s)).toBe(s);
    const dk = dontKnow(s, ctx());
    expect(markTooEasy(dk)).toBe(dk);
  });
});

describe('ввод: эквивалентные карточки колоды', () => {
  const deck = [
    card(0, { term: 'きれい', reading: 'きれい', definition: 'красивый' }),
    card(1, { term: '美しい', reading: 'うつくしい', definition: 'красивый' }),
    card(2, { term: 'はし', reading: 'はし', definition: 'мост' }),
    card(3, { term: 'はし', reading: 'はし', definition: 'палочки' }),
  ];

  it('перевод → слово: слово или чтение другой карточки с тем же переводом тоже верно', () => {
    const base = startPortion([deck[0] as LearnCard], deck, ctx(), { directions: 'def-to-term' });
    // выбор пропущен (в колоде 4 карточки, но одинаковые слова мешают): проверяем именно ввод
    const typing = base.state.question?.stage === 'typing' ? base : null;
    const s = typing ?? { ...base, state: { ...base.state, stage: 'typing' as const, question: { ...(base.state.question as NonNullable<typeof base.state.question>), stage: 'typing' as const, options: [] } } };
    for (const ok of ['きれい', 'うつくしい', '美しい', 'ウツクシイ']) {
      expect(submitTyped(s, ok, ctx()).state.feedback?.kind).toBe('correct');
    }
    expect(submitTyped(s, 'はし', ctx()).state.feedback?.kind).toBe('wrong');
  });

  it('слово → перевод: два одинаковых слова «はし»: верен перевод любого из них', () => {
    const base = startPortion([deck[2] as LearnCard], deck, ctx(), { directions: 'term-to-def' });
    const s = { ...base, state: { ...base.state, stage: 'typing' as const, question: { ...(base.state.question as NonNullable<typeof base.state.question>), stage: 'typing' as const, options: [] } } };
    for (const ok of ['мост', 'палочки']) {
      expect(submitTyped(s, ok, ctx()).state.feedback?.kind).toBe('correct');
    }
    expect(submitTyped(s, 'красивый', ctx()).state.feedback?.kind).toBe('wrong');
  });

  it('кириллица в японском поле: подсказка про клавиатуру, не ошибка', () => {
    const base = startPortion([card(0)], cards(1), ctx(), { directions: 'def-to-term' });
    const r = submitTyped(base, 'слово', ctx());
    expect(r.state.hint).toBe('romaji');
    expect(r.state.feedback).toBeNull();
    expect(r.history).toHaveLength(0);
  });
});

describe('«Слишком легко» для новых карточек', () => {
  const fresh = (i: number): LearnCard => ({ ...card(i), state: 'new' });
  const seen = (i: number): LearnCard => ({ ...card(i), state: 'review' });

  it('новая карточка: на этапе выбора кнопки нет, после верного ввода есть', () => {
    const deck = [0, 1, 2, 3, 4].map(fresh);
    let s = startPortion([deck[0] as LearnCard], deck, ctx());
    const id = s.state.question?.cardId as string;
    const q = s.state.question;
    const picked = submitChoice(s, q?.options.findIndex((o) => o.cardId === id) ?? 0, ctx());
    expect(picked.state.feedback).toMatchObject({ kind: 'correct', canTooEasy: false });
    expect(markTooEasy(picked)).toBe(picked);
    s = next(picked, ctx()).session;
    expect(s.state.question?.stage).toBe('typing');
    const typed = answerRightTyped(s);
    expect(typed.state.feedback).toMatchObject({ kind: 'correct', canTooEasy: true });
    const r = next(markTooEasy(typed), ctx());
    expect(r.completions[0]).toMatchObject({ rating: 4, easy: true });
  });

  it('карточка, уже видевшая расписание: кнопка есть и на этапе выбора', () => {
    const deck = [0, 1, 2, 3, 4].map(seen);
    const s = startPortion([deck[0] as LearnCard], deck, ctx());
    const q = s.state.question;
    const picked = submitChoice(s, q?.options.findIndex((o) => o.cardId === q.cardId) ?? 0, ctx());
    expect(picked.state.feedback?.canTooEasy).toBe(true);
    const r = next(markTooEasy(picked), ctx());
    expect(r.completions[0]).toMatchObject({ rating: 4, easy: true });
  });

  it('новая карточка в колоде меньше 4 карточек (сразу ввод): кнопка после верного ввода', () => {
    const deck = [0, 1].map(fresh);
    const s = startPortion([deck[0] as LearnCard], deck, ctx(), { directions: 'term-to-def' });
    expect(submitTyped(s, 'слово 0', ctx()).state.feedback?.canTooEasy).toBe(true);
  });
});

function answerRightTyped(s: LearnSession): LearnSession {
  const q = s.state.question;
  const c = currentCard(s);
  if (!q || !c || q.stage !== 'typing') throw new Error('нужен вопрос с вводом');
  return submitTyped(s, q.direction === 'def-to-term' ? c.term : c.definition, ctx());
}

describe('итог порции', () => {
  it('сколько верно с первого раза и какие карточки ошибались', () => {
    let s = startPortion(cards(4), cards(4), ctx());
    const missedId = s.state.question?.cardId as string;
    s = next(dontKnow(s, ctx()), ctx()).session;
    while (!isDone(s)) s = answerRight(s).session;
    const sum = summarize(s);
    expect(sum.total).toBe(4);
    expect(sum.firstTry).toBe(3);
    expect(sum.missed.map((c) => c.id)).toEqual([missedId]);
    expect(sum.ratings).toEqual({ 1: 1, 2: 0, 3: 3, 4: 0 });
  });

  it('слишком легко считается «с первого раза»', () => {
    const s = startPortion(cards(1), cards(1), ctx(), { directions: 'term-to-def' });
    const r = next(markTooEasy(submitTyped(s, 'слово 0', ctx())), ctx());
    expect(summarize(r.session)).toMatchObject({ total: 1, firstTry: 1, missed: [], ratings: { 1: 0, 2: 0, 3: 0, 4: 1 } });
  });
});

describe('отмена последнего ответа', () => {
  it('до «Дальше»: возвращает вопрос без результата, ничего не завершено', () => {
    const start = startPortion(cards(3), cards(3), ctx());
    const wrong = answerWrong(start);
    expect(canUndo(wrong)).toBe(true);
    const r = undo(wrong, ctx());
    expect(r.rolledBack).toEqual([]);
    expect(r.session.state.feedback).toBeNull();
    expect(r.session.state.question?.cardId).toBe(start.state.question?.cardId);
    expect(r.session.state.progress).toEqual({});
    expect(canUndo(r.session)).toBe(false);
  });

  it('после «Дальше» на ошибке: возвращается предыдущий вопрос, очередь и счётчики как были', () => {
    const start = startPortion(cards(3), cards(3), ctx());
    const moved = next(answerWrong(start), ctx()).session;
    expect(moved.state.queue).not.toEqual(start.state.queue);
    const r = undo(moved, ctx());
    expect(r.rolledBack).toEqual([]);
    expect(r.session.state.queue).toEqual(start.state.queue);
    expect(r.session.state.question?.cardId).toBe(start.state.question?.cardId);
    expect(r.session.state.progress).toEqual({});
  });

  it('если ответ завершил карточку: она возвращается в rolledBack, а в сессии снова не завершена', () => {
    // у колоды из 2 карточек сразу ввод: первый верный ответ завершает карточку
    const fresh = startPortion(cards(2), cards(2), ctx());
    const step = answerRight(fresh);
    expect(step.done).toHaveLength(1);
    const r = undo(step.session, ctx());
    expect(r.rolledBack).toEqual(step.done);
    expect(r.session.state.completed).toEqual([]);
    expect(r.session.state.question?.cardId).toBe(step.done[0]?.cardId);
    expect(r.session.state.feedback).toBeNull();
    expect(r.session.state.queue).toEqual(fresh.state.queue);
  });

  it('отменить можно несколько ответов подряд, до начала порции', () => {
    let s = startPortion(cards(5), cards(5), ctx());
    const q0 = s.state.question?.cardId;
    for (let i = 0; i < 3; i++) s = answerRight(s).session;
    let rolled = 0;
    while (canUndo(s)) {
      const r = undo(s, ctx());
      rolled += r.rolledBack.length;
      s = r.session;
    }
    expect(rolled).toBe(0);
    expect(s.state.question?.cardId).toBe(q0);
    expect(undo(s, ctx())).toEqual({ session: s, rolledBack: [] });
  });

  it('после завершения порции отмена возвращает последний вопрос', () => {
    const { session } = runPerfect(startPortion(cards(2), cards(2), ctx()));
    expect(isDone(session)).toBe(true);
    const r = undo(session, ctx());
    expect(isDone(r.session)).toBe(false);
    expect(r.rolledBack).toHaveLength(1);
    expect(r.session.state.question).not.toBeNull();
  });

  it('«Слишком легко» тоже откатывается вместе с завершением', () => {
    const s = startPortion(cards(1), cards(1), ctx(), { directions: 'term-to-def' });
    const r = next(markTooEasy(submitTyped(s, 'слово 0', ctx())), ctx());
    const u = undo(r.session, ctx());
    expect(u.rolledBack).toEqual(r.completions);
    expect(u.session.state.feedback).toBeNull();
    // и можно ответить заново, теперь без «слишком легко»
    const again = next(submitTyped(u.session, 'слово 0', ctx()), ctx());
    expect(again.completions[0]).toMatchObject({ rating: 3, easy: false });
  });

  it('отмена и повторный ответ: время вопроса отсчитывается заново', () => {
    const s = startPortion(cards(1), cards(1), { now: 0 }, { directions: 'term-to-def' });
    const wrong = submitTyped(s, 'нет', { now: 90_000 });
    const u = undo(wrong, { now: 100_000 });
    expect(u.session.state.question?.askedAt).toBe(100_000);
    const r = next(submitTyped(u.session, 'слово 0', { now: 102_000 }), { now: 103_000 });
    expect(r.completions[0]?.durationMs).toBe(2000);
  });
});

describe('случайные прогоны', () => {
  it('при любых ошибках порция завершается, каждая карточка завершается ровно один раз, оценки согласованы', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const rng = seededRng(seed);
      const size = 1 + Math.floor(rng() * 12);
      const deckSize = 1 + Math.floor(rng() * 12);
      const deck = cards(Math.max(size, deckSize));
      let s = startPortion(deck.slice(0, size), deck, { now: T0, rng });
      const done: Completion[] = [];
      const mistakes = new Map<string, number>();
      let steps = 0;
      while (!isDone(s)) {
        if (++steps > 600) throw new Error(`seed ${seed}: порция не завершилась`);
        const q = s.state.question;
        if (!q) throw new Error('нет вопроса');
        const roll = rng();
        const c = { now: T0 + steps * 1000, rng };
        let after: LearnSession;
        if (roll < 0.25) {
          after = answerWrong(s, c);
          mistakes.set(q.cardId, (mistakes.get(q.cardId) ?? 0) + 1);
        } else if (roll < 0.3) {
          after = dontKnow(s, c);
          mistakes.set(q.cardId, (mistakes.get(q.cardId) ?? 0) + 1);
        } else {
          const card = currentCard(s) as LearnCard;
          after =
            q.stage === 'choice'
              ? submitChoice(s, q.options.findIndex((o) => o.cardId === q.cardId), c)
              : submitTyped(s, q.direction === 'def-to-term' ? card.term : card.definition, c);
        }
        const r = next(after, c);
        done.push(...r.completions);
        s = r.session;
      }
      const expected = Math.min(size, PORTION_SIZE);
      expect(done).toHaveLength(expected);
      expect(new Set(done.map((d) => d.cardId)).size).toBe(expected);
      for (const d of done) {
        expect(d.mistakes).toBe(mistakes.get(d.cardId) ?? 0);
        expect([1, 2, 3]).toContain(d.rating);
        expect(d.rating).toBe(d.dontKnow ? 1 : d.mistakes > 0 ? 2 : 3);
      }
    }
  });
});

describe('обманки: частичное совпадение переводов и записей', () => {
  const filler = [1, 2, 3, 4].map((i) => card(100 + i));

  /** Варианты первого вопроса по карточке target; null, если выбор собрать не из чего (этап выбора пропущен). */
  function optionsFor(target: LearnCard, deck: LearnCard[], direction: 'term-to-def' | 'def-to-term', seed: number) {
    const s = startPortion([target], deck, ctx({ rng: seededRng(seed) }), { directions: direction });
    const q = s.state.question;
    return q && q.stage === 'choice' ? q.options : null;
  }

  it('вопрос ある (слово → перевод): среди вариантов нет «быть; находиться (о живом)»', () => {
    const iru = card(50, { term: 'いる', reading: undefined, definition: 'быть; находиться (о живом)' });
    const aru = card(51, { term: 'ある', reading: undefined, definition: 'находиться' });
    const deck = [iru, aru, ...filler];
    let asked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const forAru = optionsFor(aru, deck, 'term-to-def', seed);
      const forIru = optionsFor(iru, deck, 'term-to-def', seed);
      for (const [options, other] of [[forAru, iru], [forIru, aru]] as const) {
        if (!options) continue;
        asked++;
        expect(options.map((o) => o.cardId)).not.toContain(other.id);
      }
    }
    expect(asked).toBeGreaterThan(100);
  });

  it('вопрос «четыре» (перевод → слово, слово «よん/し»): среди вариантов нет «し», и наоборот', () => {
    const yon = card(60, { term: 'よん/し', reading: undefined, definition: 'четыре' });
    const shi = card(61, { term: 'し', reading: undefined, definition: 'смерть' });
    const deck = [yon, shi, ...filler];
    let asked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (const [target, other] of [[yon, shi], [shi, yon]] as const) {
        const options = optionsFor(target, deck, 'def-to-term', seed);
        if (!options) continue;
        asked++;
        expect(options.map((o) => o.cardId)).not.toContain(other.id);
      }
    }
    expect(asked).toBeGreaterThan(100);
  });

  it('вопрос «красивый» (перевод → слово): не бывает двух верных слов', () => {
    const utsukushii = card(70, { term: '美しい', reading: 'うつくしい', definition: 'красивый' });
    const kirei = card(71, { term: 'きれい', reading: undefined, definition: 'красивый; чистый' });
    const deck = [utsukushii, kirei, ...filler];
    let asked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (const [target, other] of [[utsukushii, kirei], [kirei, utsukushii]] as const) {
        const options = optionsFor(target, deck, 'def-to-term', seed);
        if (!options) continue;
        asked++;
        expect(options.map((o) => o.cardId)).not.toContain(other.id);
      }
    }
    expect(asked).toBeGreaterThan(100);
  });

  it('вырожденная колода: вариантов не набрать, этап выбора пропускается и вопрос идёт на ввод', () => {
    // все четыре карточки отвечают на один вопрос по переводу
    const deck = [0, 1, 2, 3].map((i) => card(80 + i, { definition: i === 0 ? 'один' : `один; вариант ${i}` }));
    expect(optionsFor(deck[0] as LearnCard, deck, 'def-to-term', 1)).toBeNull();
    const s = startPortion([deck[0] as LearnCard], deck, ctx({ rng: seededRng(1) }), { directions: 'def-to-term' });
    expect(s.state.question?.stage).toBe('typing');
  });

  it('ввод: слово карточки с перекрывающимся переводом засчитывается («красивый» → きれい)', () => {
    const utsukushii = card(90, { term: '美しい', reading: 'うつくしい', definition: 'красивый' });
    const kirei = card(91, { term: 'きれい', reading: undefined, definition: 'красивый; чистый' });
    const deck = [utsukushii, kirei];
    const s = startPortion([utsukushii], deck, ctx({ rng: seededRng(1) }), { directions: 'def-to-term' });
    expect(s.state.question?.stage).toBe('typing');
    expect(submitTyped(s, 'きれい', ctx()).state.feedback?.kind).toBe('correct');
  });
});
