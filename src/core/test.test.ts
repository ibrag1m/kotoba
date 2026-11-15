import { describe, expect, it } from 'vitest';
import { checkDefinitionAnswer, checkTermAnswer, definitionVariants, normalizeJapanese } from './answerCheck';
import { CHOICE_OPTIONS } from './learn';
import type { LearnCard } from './learn';
import { seededRng } from './shuffle';
import {
  FALSE_TEXT,
  MIN_DECK_FOR_TRUEFALSE,
  TEST_DEFAULT_COUNT,
  TRUE_TEXT,
  answerQuestion,
  canOverride,
  defaultTestSettings,
  generateTest,
  isTypeAvailable,
  markRight,
  mistakeCardIds,
  normalizeTestSettings,
  retrySettings,
  summarizeTest,
  typeUnavailableReason,
} from './test';
import type { TestQuestion, TestQuestionType, TestRecord, TestSettings } from './test';

const card = (id: string, term: string, definition: string, reading?: string): LearnCard => ({
  id,
  term,
  definition,
  ...(reading === undefined ? {} : { reading }),
});

const plain = (n: number): LearnCard[] => Array.from({ length: n }, (_, i) => card(`c${i}`, `語${i}`, `слово ${i}`, `ご${i}`));

/** Колода с эквивалентами: одинаковые переводы, одинаковые чтения, перекрывающиеся варианты перевода. */
function tricky(): LearnCard[] {
  return [
    card('mizu', '水', 'вода', 'みず'),
    card('omizu', 'お水', 'вода', 'おみず'),
    card('utsukushii', '美しい', 'красивый', 'うつくしい'),
    card('kirei', 'きれい', 'красивый; чистый'),
    card('hashi1', '橋', 'мост', 'はし'),
    card('hashi2', '箸', 'палочки', 'はし'),
    card('hashi3', 'はし', 'край'),
    card('iru', 'いる', 'быть; находиться (о живом)'),
    card('aru', 'ある', 'находиться'),
    card('inu', '犬', 'собака', 'いぬ'),
    card('neko', '猫', 'кошка', 'ねこ'),
    card('yama', '山', 'гора', 'やま'),
  ];
}

const settings = (over: Partial<TestSettings> = {}): TestSettings => ({
  count: 10,
  types: ['typing', 'choice', 'truefalse'],
  directions: 'both',
  ...over,
});

/** Пересекаются ли варианты перевода двух карточек («красивый» и «красивый; чистый»): тот же вопрос по переводу. */
const sameMeaning = (a: LearnCard, b: LearnCard): boolean => {
  const mine = new Set(definitionVariants(a.definition));
  return definitionVariants(b.definition).some((v) => mine.has(v));
};

const byId = (deck: readonly LearnCard[], id: string): LearnCard => {
  const c = deck.find((x) => x.id === id);
  if (!c) throw new Error(`нет карточки ${id}`);
  return c;
};

describe('доступность типов и настройки', () => {
  it('выбор из вариантов нужен от 4 карточек, верно/неверно от 2, ввод от 1', () => {
    expect([3, 4].map((n) => isTypeAvailable('choice', n))).toEqual([false, true]);
    expect([1, 2].map((n) => isTypeAvailable('truefalse', n))).toEqual([false, true]);
    expect([0, 1].map((n) => isTypeAvailable('typing', n))).toEqual([false, true]);
    expect(MIN_DECK_FOR_TRUEFALSE).toBe(2);
  });

  it('у недоступного типа есть объяснение по-русски, у доступного нет', () => {
    expect(typeUnavailableReason('choice', 3)).toMatch(/не меньше 4/);
    expect(typeUnavailableReason('truefalse', 1)).toMatch(/не меньше 2/);
    expect(typeUnavailableReason('typing', 0)).toMatch(/нет карточек/);
    expect(typeUnavailableReason('choice', 4)).toBeNull();
  });

  it('по умолчанию min(20, карточек) вопросов, все доступные типы, направление из настроек', () => {
    expect(defaultTestSettings(50, 'def-to-term')).toEqual({
      count: TEST_DEFAULT_COUNT,
      types: ['typing', 'choice', 'truefalse'],
      directions: 'def-to-term',
    });
    expect(defaultTestSettings(3)).toEqual({ count: 3, types: ['typing', 'truefalse'], directions: 'both' });
    expect(defaultTestSettings(1).types).toEqual(['typing']);
    expect(defaultTestSettings(0).count).toBe(0);
  });

  it('число вопросов приводится к 1..число карточек, недоступные типы убираются', () => {
    expect(normalizeTestSettings(settings({ count: 100 }), 12).count).toBe(12);
    expect(normalizeTestSettings(settings({ count: 0 }), 12).count).toBe(1);
    expect(normalizeTestSettings(settings({ count: -5 }), 12).count).toBe(1);
    expect(normalizeTestSettings(settings({ count: Number.NaN }), 12).count).toBe(1);
    expect(normalizeTestSettings(settings({ count: 7.9 }), 12).count).toBe(7);
    expect(normalizeTestSettings(settings({ count: 5 }), 0).count).toBe(0);
    expect(normalizeTestSettings(settings(), 3).types).toEqual(['typing', 'truefalse']);
    expect(normalizeTestSettings(settings(), 1).types).toEqual(['typing']);
  });

  it('если типов не осталось, остаётся ввод', () => {
    expect(normalizeTestSettings(settings({ types: [] }), 12).types).toEqual(['typing']);
    expect(normalizeTestSettings(settings({ types: ['choice'] }), 3).types).toEqual(['typing']);
  });
});

describe('generateTest: состав теста', () => {
  it('карточки не повторяются, вопросов ровно столько, сколько просили', () => {
    const deck = plain(30);
    for (let seed = 1; seed <= 50; seed++) {
      const qs = generateTest(deck, settings({ count: 20 }), seededRng(seed));
      expect(qs).toHaveLength(20);
      expect(new Set(qs.map((q) => q.cardId)).size).toBe(20);
      for (const q of qs) expect(deck.some((c) => c.id === q.cardId)).toBe(true);
    }
  });

  it('вопросов не больше числа карточек, даже если просили больше', () => {
    const qs = generateTest(plain(5), settings({ count: 50 }), seededRng(1));
    expect(qs).toHaveLength(5);
    expect(new Set(qs.map((q) => q.cardId)).size).toBe(5);
  });

  it('пустая колода даёт пустой тест', () => {
    expect(generateTest([], settings(), seededRng(1))).toEqual([]);
  });

  it('используются только выбранные типы, и каждый из них встречается', () => {
    const deck = plain(30);
    const typesOf = (types: TestQuestionType[]) => new Set(generateTest(deck, settings({ count: 30, types }), seededRng(3)).map((q) => q.type));
    expect(typesOf(['typing'])).toEqual(new Set(['typing']));
    expect(typesOf(['choice'])).toEqual(new Set(['choice']));
    expect(typesOf(['truefalse'])).toEqual(new Set(['truefalse']));
    expect(typesOf(['typing', 'truefalse'])).toEqual(new Set(['typing', 'truefalse']));
    expect(typesOf(['typing', 'choice', 'truefalse'])).toEqual(new Set(['typing', 'choice', 'truefalse']));
  });

  it('типы раздаются поровну (разница не больше 1)', () => {
    const qs = generateTest(plain(30), settings({ count: 30 }), seededRng(9));
    const n = (t: string) => qs.filter((q) => q.type === t).length;
    expect([n('typing'), n('choice'), n('truefalse')]).toEqual([10, 10, 10]);
  });

  it('направление «слово → перевод» и «перевод → слово» соблюдается, «оба» даёт оба', () => {
    const deck = plain(30);
    const dirs = (directions: TestSettings['directions']) =>
      new Set(generateTest(deck, settings({ count: 30, directions }), seededRng(5)).map((q) => q.direction));
    expect(dirs('term-to-def')).toEqual(new Set(['term-to-def']));
    expect(dirs('def-to-term')).toEqual(new Set(['def-to-term']));
    expect(dirs('both')).toEqual(new Set(['term-to-def', 'def-to-term']));
  });

  it('тест воспроизводим при одинаковом rng и не меняет вход', () => {
    const deck = Object.freeze(plain(15).map((c) => Object.freeze(c)));
    const a = generateTest(deck, settings(), seededRng(42));
    const b = generateTest(deck, settings(), seededRng(42));
    expect(a).toEqual(b);
    expect(generateTest(deck, settings(), seededRng(43))).not.toEqual(a);
  });

  it('при пуле (повтор ошибок) спрашиваются только карточки пула, все, и по одному разу', () => {
    const deck = plain(20);
    const pool = ['c3', 'c7', 'c7', 'c11', 'нет-такой'];
    const qs = generateTest(deck, retrySettings(settings({ count: 20 }), 3), seededRng(2), pool);
    expect(qs.map((q) => q.cardId).sort()).toEqual(['c11', 'c3', 'c7']);
  });
});

describe('generateTest: выбор из вариантов', () => {
  const choiceOnly = settings({ count: 12, types: ['choice'] });

  it('четыре разных варианта, верный ровно один', () => {
    const deck = plain(12);
    for (let seed = 1; seed <= 30; seed++) {
      for (const q of generateTest(deck, choiceOnly, seededRng(seed))) {
        expect(q.type).toBe('choice');
        if (q.type !== 'choice') continue;
        expect(q.options).toHaveLength(CHOICE_OPTIONS);
        expect(q.options.filter((o) => o.cardId === q.cardId)).toHaveLength(1);
        expect(new Set(q.options.map((o) => o.cardId)).size).toBe(CHOICE_OPTIONS);
        expect(new Set(q.options.map((o) => o.text)).size).toBe(CHOICE_OPTIONS);
      }
    }
  });

  it('при эквивалентных карточках верен только один вариант (проверка независимой проверкой ответа)', () => {
    const deck = tricky();
    let asked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (const q of generateTest(deck, choiceOnly, seededRng(seed))) {
        if (q.type !== 'choice') continue;
        asked++;
        const c = byId(deck, q.cardId);
        const accepted = q.options.filter((o) => {
          if (q.direction === 'def-to-term') {
            const same = deck.filter((x) => x.id !== c.id && sameMeaning(x, c));
            return checkTermAnswer(o.text, c, same).correct || (o.cardId !== c.id && sameMeaning(byId(deck, o.cardId), c));
          }
          const same = deck.filter((x) => x.id !== c.id && normalizeJapanese(x.term) === normalizeJapanese(c.term));
          return checkDefinitionAnswer(o.text, c.definition, same.map((x) => x.definition));
        });
        expect(accepted.map((o) => o.cardId)).toEqual([q.cardId]);
      }
    }
    expect(asked).toBeGreaterThan(100);
  });

  it('слово с вариантами записи не соседствует с совпавшим вариантом: «よん/し» и «し» не бывают в одном вопросе', () => {
    const deck = [
      card('yon', 'よん/し', 'четыре'),
      card('shi', 'し', 'смерть'),
      ...[1, 2, 3, 4].map((i) => card(`o${i}`, `語${i}`, `слово ${i}`)),
    ];
    let askedAboutPair = 0;
    for (let seed = 1; seed <= 80; seed++) {
      for (const q of generateTest(deck, settings({ count: 6, types: ['choice'], directions: 'def-to-term' }), seededRng(seed))) {
        if (q.type !== 'choice') continue;
        const ids = q.options.map((o) => o.cardId);
        if (q.cardId === 'yon') {
          askedAboutPair++;
          expect(ids).not.toContain('shi');
        }
        if (q.cardId === 'shi') {
          askedAboutPair++;
          expect(ids).not.toContain('yon');
        }
      }
    }
    expect(askedAboutPair).toBeGreaterThan(100);
  });

  it('частичное совпадение переводов: «красивый» и «красивый; чистый», «находиться» и «быть; находиться» не бывают вместе', () => {
    const deck = [
      card('utsukushii', '美しい', 'красивый', 'うつくしい'),
      card('kirei', 'きれい', 'красивый; чистый'),
      card('iru', 'いる', 'быть; находиться (о живом)'),
      card('aru', 'ある', 'находиться'),
      ...[1, 2, 3, 4].map((i) => card(`o${i}`, `語${i}`, `слово ${i}`)),
    ];
    const clash: Record<string, string> = { utsukushii: 'kirei', kirei: 'utsukushii', iru: 'aru', aru: 'iru' };
    let checked = 0;
    for (const directions of ['def-to-term', 'term-to-def'] as const) {
      for (let seed = 1; seed <= 60; seed++) {
        for (const q of generateTest(deck, settings({ count: 8, types: ['choice'], directions }), seededRng(seed))) {
          if (q.type !== 'choice') continue;
          const other = clash[q.cardId];
          if (other === undefined) continue;
          checked++;
          expect(q.options.map((o) => o.cardId)).not.toContain(other);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('одинаковые переводы у всех карточек: выбор собрать нельзя, вопрос переходит на ввод', () => {
    const deck = Array.from({ length: 6 }, (_, i) => card(`s${i}`, `語${i}`, 'один'));
    const qs = generateTest(deck, choiceOnly, seededRng(1));
    expect(qs).toHaveLength(6);
    for (const q of qs) expect(q.type).toBe('typing');
  });

  it('если нужное направление не собирается, берётся другое; если задано одно, то ввод в том же направлении', () => {
    // Все чтения совпадают: слово → перевод даёт одно «тот же вопрос»; перевод → слово собирается.
    const deck = [card('a', '橋', 'мост', 'はし'), card('b', '箸', 'палочки', 'はし'), card('c', '端', 'край', 'はし'), card('d', '嘴', 'клюв', 'はし')];
    const both = generateTest(deck, settings({ count: 4, types: ['choice'], directions: 'both' }), seededRng(1));
    for (const q of both) {
      expect(q.type).toBe('choice');
      expect(q.direction).toBe('def-to-term');
    }
    const only = generateTest(deck, settings({ count: 4, types: ['choice'], directions: 'term-to-def' }), seededRng(1));
    for (const q of only) {
      expect(q.type).toBe('typing');
      expect(q.direction).toBe('term-to-def');
    }
  });
});

describe('generateTest: верно/неверно', () => {
  const tfOnly = (count: number) => settings({ count, types: ['truefalse'] });

  it('верных утверждений примерно половина: при чётном числе ровно половина', () => {
    const deck = plain(30);
    for (let seed = 1; seed <= 25; seed++) {
      const qs = generateTest(deck, tfOnly(10), seededRng(seed));
      expect(qs.filter((q) => q.type === 'truefalse' && q.isTrue)).toHaveLength(5);
    }
  });

  it('при нечётном числе верных floor(n/2) или ceil(n/2), встречаются оба случая', () => {
    const deck = plain(30);
    const counts = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const qs = generateTest(deck, tfOnly(7), seededRng(seed));
      const t = qs.filter((q) => q.type === 'truefalse' && q.isTrue).length;
      expect([3, 4]).toContain(t);
      counts.add(t);
    }
    expect(counts).toEqual(new Set([3, 4]));
  });

  it('верное утверждение про саму карточку, неверное про другую', () => {
    for (const q of generateTest(plain(20), tfOnly(20), seededRng(7))) {
      if (q.type !== 'truefalse') throw new Error('ожидался вопрос верно/неверно');
      if (q.isTrue) expect(q.claimCardId).toBe(q.cardId);
      else expect(q.claimCardId).not.toBe(q.cardId);
    }
  });

  it('неверное утверждение никогда не эквивалентно верному (проверка независимой проверкой ответа)', () => {
    const deck = tricky();
    let falseSeen = 0;
    for (let seed = 1; seed <= 120; seed++) {
      for (const q of generateTest(deck, tfOnly(12), seededRng(seed))) {
        if (q.type !== 'truefalse' || q.isTrue) continue;
        falseSeen++;
        const c = byId(deck, q.cardId);
        const claim = byId(deck, q.claimCardId);
        expect(claim.id).not.toBe(c.id);
        if (q.direction === 'term-to-def') {
          // Слово показано, перевод подменён. Перевод подменённой карточки не должен быть верным ни для самой карточки,
          // ни для карточек с тем же словом, и наоборот (пересечение вариантов).
          const sameTerm = deck.filter((x) => x.id !== c.id && normalizeJapanese(x.term) === normalizeJapanese(c.term));
          expect(checkDefinitionAnswer(claim.definition, c.definition, sameTerm.map((x) => x.definition))).toBe(false);
          expect(checkDefinitionAnswer(c.definition, claim.definition)).toBe(false);
          // Та же запись или то же чтение: слово подменённой карточки совпало бы с вопросом.
          expect(normalizeJapanese(claim.term)).not.toBe(normalizeJapanese(c.term));
          if (c.reading !== undefined) expect(normalizeJapanese(claim.term)).not.toBe(normalizeJapanese(c.reading));
        } else {
          // Перевод показан, слово подменено. Слово (и чтение) подменённой карточки не должно быть верным ответом.
          const sameDef = deck.filter((x) => x.id !== c.id && sameMeaning(x, c));
          expect(checkTermAnswer(claim.term, c, sameDef).correct).toBe(false);
          if (claim.reading !== undefined) expect(checkTermAnswer(claim.reading, c, sameDef).correct).toBe(false);
          expect(sameMeaning(claim, c)).toBe(false);
        }
      }
    }
    expect(falseSeen).toBeGreaterThan(200);
  });

  it('если безопасной подмены нет (все карточки эквивалентны), все утверждения остаются верными', () => {
    const deck = Array.from({ length: 4 }, (_, i) => card(`e${i}`, `語${i}`, 'один'));
    const qs = generateTest(deck, tfOnly(4), seededRng(3));
    expect(qs).toHaveLength(4);
    for (const q of qs) {
      if (q.type !== 'truefalse') throw new Error('ожидался вопрос верно/неверно');
      expect(q.isTrue).toBe(true);
      expect(q.claimCardId).toBe(q.cardId);
    }
  });

  it('«красивый — きれい» (перекрывающиеся переводы) не подставляется как ложное утверждение, ни в одном направлении', () => {
    const deck = [
      card('utsukushii', '美しい', 'красивый', 'うつくしい'),
      card('kirei', 'きれい', 'красивый; чистый'),
      card('iru', 'いる', 'быть; находиться (о живом)'),
      card('aru', 'ある', 'находиться'),
      ...[1, 2, 3].map((i) => card(`o${i}`, `語${i}`, `слово ${i}`)),
    ];
    const clash: Record<string, string> = { utsukushii: 'kirei', kirei: 'utsukushii', iru: 'aru', aru: 'iru' };
    let falseAboutPair = 0;
    for (let seed = 1; seed <= 200; seed++) {
      for (const q of generateTest(deck, tfOnly(7), seededRng(seed))) {
        if (q.type !== 'truefalse' || q.isTrue) continue;
        const other = clash[q.cardId];
        if (other === undefined) continue;
        falseAboutPair++;
        expect(q.claimCardId).not.toBe(other);
      }
    }
    expect(falseAboutPair).toBeGreaterThan(50);
  });

  it('работает на двух карточках', () => {
    const deck = plain(2);
    const qs = generateTest(deck, tfOnly(2), seededRng(1));
    expect(qs).toHaveLength(2);
    expect(qs.filter((q) => q.type === 'truefalse' && !q.isTrue)).toHaveLength(1);
  });
});

// ---------- ответы ----------

function only<T extends TestQuestion['type']>(qs: TestQuestion[], type: T): Extract<TestQuestion, { type: T }> {
  const q = qs.find((x) => x.type === type);
  if (!q) throw new Error(`нет вопроса ${type}`);
  return q as Extract<TestQuestion, { type: T }>;
}

function recorded(out: ReturnType<typeof answerQuestion>): TestRecord {
  if (out.kind !== 'recorded') throw new Error(`ожидалась запись, получено ${out.kind}`);
  return out.record;
}

describe('answerQuestion: ввод', () => {
  const deck = tricky();
  const typingQ = (cardId: string, direction: 'term-to-def' | 'def-to-term') => ({ type: 'typing' as const, cardId, direction });

  it('слово по переводу: засчитываются слово, чтение и запись другой каной; лишнее не засчитывается', () => {
    const q = typingQ('mizu', 'def-to-term');
    const ok = (text: string) => recorded(answerQuestion(q, { kind: 'typed', text }, deck)).correct;
    expect(ok('水')).toBe(true);
    expect(ok('みず')).toBe(true);
    expect(ok('ミズ')).toBe(true);
    expect(ok('犬')).toBe(false);
    expect(ok('いぬ')).toBe(false);
  });

  it('слово по переводу: слово другой карточки с тем же переводом тоже верно', () => {
    const q = typingQ('mizu', 'def-to-term');
    expect(recorded(answerQuestion(q, { kind: 'typed', text: 'お水' }, deck)).correct).toBe(true);
  });

  it('слово по переводу: слово карточки с перекрывающимся переводом тоже верно (美しい «красивый», きれい «красивый; чистый»)', () => {
    const q = typingQ('utsukushii', 'def-to-term');
    expect(recorded(answerQuestion(q, { kind: 'typed', text: 'きれい' }, deck)).correct).toBe(true);
    expect(recorded(answerQuestion(typingQ('kirei', 'def-to-term'), { kind: 'typed', text: '美しい' }, deck)).correct).toBe(true);
    expect(recorded(answerQuestion(q, { kind: 'typed', text: '犬' }, deck)).correct).toBe(false);
  });

  it('перевод по слову: регистр, ё/е и пробелы не важны; чужой перевод неверен', () => {
    const q = typingQ('inu', 'term-to-def');
    const ok = (text: string) => recorded(answerQuestion(q, { kind: 'typed', text }, deck)).correct;
    expect(ok('  СОБАКА ')).toBe(true);
    expect(ok('кошка')).toBe(false);
    expect(recorded(answerQuestion(typingQ('hashi1', 'term-to-def'), { kind: 'typed', text: 'мост' }, deck)).correct).toBe(true);
  });

  it('перевод по слову: два одинаково записанных слова принимают перевод любого из них', () => {
    const d = [card('x', 'はし', 'мост'), card('y', 'はし', 'палочки'), card('z', '犬', 'собака')];
    const q = typingQ('x', 'term-to-def');
    expect(recorded(answerQuestion(q, { kind: 'typed', text: 'палочки' }, d)).correct).toBe(true);
    expect(recorded(answerQuestion(q, { kind: 'typed', text: 'собака' }, d)).correct).toBe(false);
  });

  it('латиница или кириллица в японском поле: подсказка, ответ не записывается и ошибкой не считается', () => {
    const q = typingQ('mizu', 'def-to-term');
    expect(answerQuestion(q, { kind: 'typed', text: 'mizu' }, deck)).toEqual({ kind: 'hint' });
    expect(answerQuestion(q, { kind: 'typed', text: 'вода' }, deck)).toEqual({ kind: 'hint' });
  });

  it('в поле перевода латиница — обычный ответ (верный или неверный), без подсказки', () => {
    const d = [card('a', 'ビール', 'beer'), card('b', '犬', 'собака')];
    const q = typingQ('a', 'term-to-def');
    expect(recorded(answerQuestion(q, { kind: 'typed', text: 'Beer' }, d)).correct).toBe(true);
    expect(recorded(answerQuestion(q, { kind: 'typed', text: 'tea' }, d)).correct).toBe(false);
  });

  it('пустой ввод и ответ другого вида игнорируются', () => {
    const q = typingQ('mizu', 'def-to-term');
    expect(answerQuestion(q, { kind: 'typed', text: '   ' }, deck)).toEqual({ kind: 'ignored' });
    expect(answerQuestion(q, { kind: 'choice', index: 0 }, deck)).toEqual({ kind: 'ignored' });
    expect(answerQuestion(q, { kind: 'truefalse', saidTrue: true }, deck)).toEqual({ kind: 'ignored' });
  });

  it('запись хранит ответ без пробелов по краям, пропуск считается ошибкой', () => {
    const q = typingQ('inu', 'term-to-def');
    const wrong = recorded(answerQuestion(q, { kind: 'typed', text: '  кот ' }, deck));
    expect(wrong).toMatchObject({ given: 'кот', correct: false, skipped: false, overridden: false });
    const skip = recorded(answerQuestion(q, { kind: 'skip' }, deck));
    expect(skip).toMatchObject({ given: '', correct: false, skipped: true });
  });
});

describe('answerQuestion: выбор и верно/неверно', () => {
  const deck = plain(12);

  it('выбор: верным считается только вариант самой карточки, запись хранит выбранную карточку', () => {
    const q = only(generateTest(deck, settings({ count: 12, types: ['choice'] }), seededRng(4)), 'choice');
    const right = q.options.findIndex((o) => o.cardId === q.cardId);
    const rec = recorded(answerQuestion(q, { kind: 'choice', index: right }, deck));
    expect(rec).toMatchObject({ correct: true, givenCardId: q.cardId });
    const wrongIdx = q.options.findIndex((o) => o.cardId !== q.cardId);
    const bad = recorded(answerQuestion(q, { kind: 'choice', index: wrongIdx }, deck));
    expect(bad.correct).toBe(false);
    expect(bad.givenCardId).toBe(q.options[wrongIdx]?.cardId);
    expect(bad.given).toBe(q.options[wrongIdx]?.text);
  });

  it('выбор: неверный номер варианта игнорируется', () => {
    const q = only(generateTest(deck, settings({ count: 12, types: ['choice'] }), seededRng(4)), 'choice');
    expect(answerQuestion(q, { kind: 'choice', index: 4 }, deck)).toEqual({ kind: 'ignored' });
    expect(answerQuestion(q, { kind: 'choice', index: -1 }, deck)).toEqual({ kind: 'ignored' });
  });

  it('верно/неверно: ответ совпадает с утверждением только при правильном выборе', () => {
    const qs = generateTest(deck, settings({ count: 12, types: ['truefalse'] }), seededRng(8)).filter(
      (q): q is Extract<TestQuestion, { type: 'truefalse' }> => q.type === 'truefalse',
    );
    expect(qs.some((q) => q.isTrue)).toBe(true);
    expect(qs.some((q) => !q.isTrue)).toBe(true);
    for (const q of qs) {
      const yes = recorded(answerQuestion(q, { kind: 'truefalse', saidTrue: true }, deck));
      const no = recorded(answerQuestion(q, { kind: 'truefalse', saidTrue: false }, deck));
      expect(yes.correct).toBe(q.isTrue);
      expect(no.correct).toBe(!q.isTrue);
      expect(yes.given).toBe(TRUE_TEXT);
      expect(no.given).toBe(FALSE_TEXT);
    }
  });
});

describe('итог, «Я был прав» и повтор ошибок', () => {
  const deck = plain(10);
  const q = (cardId: string, type: 'typing' | 'truefalse' = 'typing'): TestQuestion =>
    type === 'typing'
      ? { type: 'typing', cardId, direction: 'term-to-def' }
      : { type: 'truefalse', cardId, direction: 'term-to-def', claimCardId: cardId, isTrue: true };
  const rec = (cardId: string, correct: boolean, over: Partial<TestRecord> = {}): TestRecord => ({
    question: q(cardId),
    given: 'x',
    correct,
    skipped: false,
    overridden: false,
    ...over,
  });

  it('проценты округляются, ошибки идут с номерами записей', () => {
    const records = [rec('c0', true), rec('c1', false), rec('c2', true)];
    const sum = summarizeTest(records);
    expect(sum).toMatchObject({ total: 3, correct: 2, percent: 66 });
    expect(sum.mistakes.map((m) => m.index)).toEqual([1]);
    expect(summarizeTest([rec('c0', true)]).percent).toBe(100);
    // 100% только если верны все: 199 из 200 это 99%, а не «100%»
    const many = (wrong: number) => Array.from({ length: 200 }, (_, i) => rec(`c${i}`, i >= wrong));
    expect(summarizeTest(many(1)).percent).toBe(99);
    expect(summarizeTest(many(0)).percent).toBe(100);
    expect(summarizeTest(Array.from({ length: 100 }, (_, i) => rec(`c${i}`, i < 58))).percent).toBe(58);
    expect(summarizeTest([rec('c0', false)]).percent).toBe(0);
    expect(summarizeTest([])).toEqual({ total: 0, correct: 0, percent: 0, mistakes: [] });
  });

  it('«Я был прав» только для неверного ввода: пересчитывает итог и не меняет входной массив', () => {
    const records = [rec('c0', true), rec('c1', false), rec('c2', false, { skipped: true, given: '' })];
    expect(canOverride(records[1] as TestRecord)).toBe(true);
    expect(canOverride(records[2] as TestRecord)).toBe(false);
    const after = markRight(records, 1);
    expect(after[1]).toMatchObject({ correct: true, overridden: true });
    expect(records[1]?.correct).toBe(false);
    expect(summarizeTest(after)).toMatchObject({ correct: 2, percent: 66 });
    // пропуск и верный ответ не исправляются
    expect(markRight(records, 2)[2]?.correct).toBe(false);
    expect(markRight(records, 0)[0]?.overridden).toBe(false);
    // неверное верно/неверно исправить нельзя
    const tf: TestRecord = { question: q('c3', 'truefalse'), given: 'Неверно', correct: false, skipped: false, overridden: false };
    expect(canOverride(tf)).toBe(false);
    expect(markRight([tf], 0)[0]?.correct).toBe(false);
  });

  it('карточки с ошибками без повторов и в порядке прохождения; исправленные не входят', () => {
    const records = [rec('c4', false), rec('c1', true), rec('c2', false), rec('c4', false), rec('c3', false)];
    expect(mistakeCardIds(records)).toEqual(['c4', 'c2', 'c3']);
    expect(mistakeCardIds(markRight(records, 2))).toEqual(['c4', 'c3']);
  });

  it('повтор ошибок: тест из тех же карточек с теми же настройками', () => {
    const base = settings({ count: 8, types: ['typing', 'truefalse'], directions: 'def-to-term' });
    const retry = retrySettings(base, 3);
    expect(retry).toEqual({ count: 3, types: ['typing', 'truefalse'], directions: 'def-to-term' });
    const qs = generateTest(deck, retry, seededRng(6), ['c2', 'c5', 'c9']);
    expect(qs.map((x) => x.cardId).sort()).toEqual(['c2', 'c5', 'c9']);
    for (const x of qs) {
      expect(['typing', 'truefalse']).toContain(x.type);
      expect(x.direction).toBe('def-to-term');
    }
    expect(retrySettings(base, 0).count).toBe(1);
  });

  it('полное прохождение: ответы по записям дают ожидаемый итог', () => {
    const d = plain(10);
    const qs = generateTest(d, settings({ count: 10, types: ['typing'], directions: 'term-to-def' }), seededRng(11));
    const records = qs.map((x, i) => {
      const c = byId(d, x.cardId);
      // первые 7 отвечаем верно, остальные нет
      return recorded(answerQuestion(x, { kind: 'typed', text: i < 7 ? c.definition : 'не то' }, d));
    });
    const sum = summarizeTest(records);
    expect(sum).toMatchObject({ total: 10, correct: 7, percent: 70 });
    expect(mistakeCardIds(records)).toHaveLength(3);
  });
});
