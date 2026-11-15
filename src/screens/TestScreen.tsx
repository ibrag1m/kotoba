import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Page } from '../components/Page';
import { db } from '../db/db';
import { getDeck, listCards } from '../db/repo';
import { getAnswerDirection } from '../db/learnRepo';
import type { Card, Deck } from '../db/types';
import type { Direction, DirectionMode, LearnCard } from '../core/learn';
import {
  TEST_QUESTION_TYPES,
  TYPE_LABELS,
  answerQuestion,
  canOverride,
  defaultTestSettings,
  generateTest,
  markRight,
  mistakeCardIds,
  normalizeTestSettings,
  retrySettings,
  summarizeTest,
  typeUnavailableReason,
} from '../core/test';
import type { TestAnswer, TestQuestion, TestQuestionType, TestRecord, TestSettings } from '../core/test';
import { ROMAJI_HINT_TEXT } from '../core/answerCheck';
import { plural } from '../core/format';
import ui from '../styles/ui.module.css';
import s from './TestScreen.module.css';

/** Один запуск теста: снимок карточек (на время теста колода не меняется), настройки и готовые вопросы. */
interface Run {
  key: number;
  cards: LearnCard[];
  settings: TestSettings;
  questions: TestQuestion[];
}

type Phase = { kind: 'setup' } | { kind: 'run'; run: Run } | { kind: 'result'; run: Run; records: TestRecord[] };

const DIRECTION_LABELS: Readonly<Record<DirectionMode, string>> = {
  'term-to-def': 'Японский → перевод',
  'def-to-term': 'Перевод → японский',
  both: 'Оба',
};
const DIRECTION_ORDER: readonly DirectionMode[] = ['term-to-def', 'def-to-term', 'both'];

/** Минимум, что нужно тесту от карточки (лишние поля из базы не копируются в снимок). */
function toLearnCard(c: Card): LearnCard {
  const out: LearnCard = { id: c.id, term: c.term, definition: c.definition };
  if (c.reading) out.reading = c.reading;
  if (c.example) out.example = c.example;
  return out;
}

export function TestScreen() {
  const { id = '' } = useParams();
  const deck = useLiveQuery(async () => (await getDeck(db, id)) ?? null, [id]);
  const cards = useLiveQuery(() => listCards(db, id), [id]);
  const savedDirection = useLiveQuery(() => getAnswerDirection(db), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  // Настройки первого запуска: «Новый тест» открывается с ними, а не с настройками теста из одних ошибок.
  const [lastSettings, setLastSettings] = useState<TestSettings | null>(null);
  const runKey = useRef(0);

  const backTo = `/deck/${id}`;

  if (deck === undefined || cards === undefined || savedDirection === undefined) {
    return (
      <Page title="Тест" backTo={backTo}>
        <p className={ui.muted}>Загрузка…</p>
      </Page>
    );
  }
  if (deck === null) {
    return (
      <Page title="Колода не найдена" backTo="/">
        <p className={ui.muted}>Такой колоды нет.</p>
      </Page>
    );
  }
  if (cards.length === 0 && phase.kind === 'setup') {
    return (
      <Page title="Тест" backTo={backTo}>
        <div className={ui.empty}>
          <p>В колоде нет карточек, тест составить не из чего.</p>
          <Link to={`/deck/${deck.id}/import`} className={`${ui.btn} ${ui.primary}`}>
            Добавить слова
          </Link>
        </div>
      </Page>
    );
  }

  function start(settings: TestSettings) {
    const snapshot = (cards ?? []).map(toLearnCard);
    const normalized = normalizeTestSettings(settings, snapshot.length);
    const questions = generateTest(snapshot, normalized);
    setLastSettings(normalized);
    setPhase({ kind: 'run', run: { key: ++runKey.current, cards: snapshot, settings: normalized, questions } });
  }

  function retryMistakes(run: Run, records: TestRecord[]) {
    const ids = mistakeCardIds(records);
    if (ids.length === 0) return;
    const questions = generateTest(run.cards, retrySettings(run.settings, ids.length), Math.random, ids);
    // В запуске остаются исходные настройки: «Новый тест» после ошибок открывается с ними.
    setPhase({ kind: 'run', run: { ...run, key: ++runKey.current, questions } });
  }

  if (phase.kind === 'setup') {
    return (
      <Setup
        deck={deck}
        cardCount={cards.length}
        savedDirection={savedDirection}
        previous={lastSettings}
        onStart={start}
        backTo={backTo}
      />
    );
  }
  if (phase.kind === 'run') {
    return (
      <Running
        key={phase.run.key}
        run={phase.run}
        backTo={backTo}
        onDone={(records) => setPhase({ kind: 'result', run: phase.run, records })}
      />
    );
  }
  const result = phase;
  return (
    <Result
      deck={deck}
      run={result.run}
      records={result.records}
      backTo={backTo}
      onOverride={(index) => setPhase({ ...result, records: markRight(result.records, index) })}
      onRetry={() => retryMistakes(result.run, result.records)}
      onNew={() => setPhase({ kind: 'setup' })}
    />
  );
}

// ---------- настройка ----------

interface SetupProps {
  deck: Deck;
  cardCount: number;
  savedDirection: DirectionMode;
  previous: TestSettings | null;
  onStart: (settings: TestSettings) => void;
  backTo: string;
}

function Setup({ deck, cardCount, savedDirection, previous, onStart, backTo }: SetupProps) {
  const defaults = previous ?? defaultTestSettings(cardCount, savedDirection);
  const [countText, setCountText] = useState(String(Math.min(defaults.count, cardCount)));
  const [types, setTypes] = useState<readonly TestQuestionType[]>(defaults.types);
  const [directions, setDirections] = useState<DirectionMode>(defaults.directions);

  const activeTypes = TEST_QUESTION_TYPES.filter((t) => types.includes(t) && typeUnavailableReason(t, cardCount) === null);
  const countValid = /^\d+$/.test(countText.trim()) && Number(countText) >= 1;
  const canStart = countValid && activeTypes.length > 0;

  function toggle(t: TestQuestionType) {
    setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canStart) return;
    onStart(normalizeTestSettings({ count: Number(countText), types: activeTypes, directions }, cardCount));
  }

  return (
    <Page title="Тест" backTo={backTo} extra={deck.name}>
      <form className={s.setup} onSubmit={onSubmit}>
        <p className={ui.muted}>
          Свободная тренировка: расписание повторений она не меняет. Результат и ошибки показываются в конце.
        </p>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="test-count">
            Сколько вопросов
          </label>
          <input
            id="test-count"
            className={ui.input}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={countText}
            onChange={(e) => setCountText(e.target.value)}
          />
          <p className={ui.hint}>
            В колоде {cardCount} {plural(cardCount, 'карточка', 'карточки', 'карточек')}. Вопросов будет не больше этого
            числа: карточки в тесте не повторяются.
          </p>
        </div>

        <fieldset className={s.group}>
          <legend className={ui.label}>Типы вопросов</legend>
          {TEST_QUESTION_TYPES.map((t) => {
            const reason = typeUnavailableReason(t, cardCount);
            const checked = reason === null && types.includes(t);
            return (
              <div key={t}>
                <label className={reason ? `${s.choice} ${s.choiceOff}` : s.choice}>
                  <input type="checkbox" checked={checked} disabled={reason !== null} onChange={() => toggle(t)} />
                  <span>{TYPE_LABELS[t]}</span>
                </label>
                {reason && <p className={`${ui.hint} ${s.reason}`}>{reason}</p>}
              </div>
            );
          })}
          {activeTypes.length === 0 && (
            <p className={ui.error} role="alert">
              Выберите хотя бы один тип вопросов.
            </p>
          )}
        </fieldset>

        <fieldset className={s.group}>
          <legend className={ui.label}>Направление</legend>
          {DIRECTION_ORDER.map((d) => (
            <label key={d} className={s.choice}>
              <input type="radio" name="test-direction" checked={directions === d} onChange={() => setDirections(d)} />
              <span>{DIRECTION_LABELS[d]}</span>
            </label>
          ))}
        </fieldset>

        {!countValid && (
          <p className={ui.error} role="alert">
            Введите число вопросов: целое число не меньше 1.
          </p>
        )}
        <button type="submit" className={`${ui.btn} ${ui.primary}`} disabled={!canStart}>
          Начать тест
        </button>
      </form>
    </Page>
  );
}

// ---------- отображение сторон карточки ----------

function showReading(c: LearnCard): boolean {
  return Boolean(c.reading) && c.reading !== c.term;
}

/** Японская сторона: чтение мелко над словом. */
function JpText({ card, big }: { card: LearnCard; big?: boolean }) {
  return (
    <span className={s.jp} lang="ja">
      {showReading(card) && <span className={s.reading}>{card.reading}</span>}
      <span className={big ? s.kanji : s.kanjiSmall}>{card.term}</span>
    </span>
  );
}

/** Сторона карточки: слово (term) или перевод (def). */
function Side({ card, side, big }: { card: LearnCard; side: 'term' | 'def'; big?: boolean }) {
  return side === 'term' ? <JpText card={card} big={big} /> : <span className={big ? s.promptDef : s.def}>{card.definition}</span>;
}

/** Сторона, которую спрашивают (то, что показано в вопросе), и сторона-ответ. */
const askedSide = (d: Direction): 'term' | 'def' => (d === 'term-to-def' ? 'term' : 'def');
const answerSide = (d: Direction): 'term' | 'def' => (d === 'term-to-def' ? 'def' : 'term');

// ---------- прохождение ----------

interface RunningProps {
  run: Run;
  backTo: string;
  onDone: (records: TestRecord[]) => void;
}

/** Нажатия чаще чем раз в столько мс после перехода к новому вопросу игнорируются (двойное касание). */
const TAP_GUARD_MS = 350;

function Running({ run, backTo, onDone }: RunningProps) {
  const [index, setIndex] = useState(0);
  const [records, setRecords] = useState<TestRecord[]>([]);
  const [typed, setTyped] = useState('');
  const [hint, setHint] = useState(false);
  // Синхронные замки: setState асинхронен, а два касания подряд могут прийти до перерисовки.
  const answeredIndex = useRef(-1);
  const lockUntil = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(run.cards.map((c) => [c.id, c])), [run.cards]);
  const total = run.questions.length;
  const q = run.questions[index];
  const card = q ? byId.get(q.cardId) : undefined;
  const typing = q?.type === 'typing';

  // Поле ввода остаётся смонтированным между подряд идущими вопросами на ввод: клавиатура iPhone не закрывается.
  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing, index]);

  if (!q || !card) {
    return (
      <Page title="Тест" backTo={backTo}>
        <p className={ui.muted}>Нет вопросов.</p>
      </Page>
    );
  }

  const keepFocus = typing ? (e: MouseEvent) => e.preventDefault() : undefined;

  function submit(answer: TestAnswer) {
    if (!q) return;
    if (answeredIndex.current >= index || Date.now() < lockUntil.current) return;
    const out = answerQuestion(q, answer, run.cards);
    if (out.kind === 'ignored') return;
    if (out.kind === 'hint') {
      // Латиница вместо японского не засчитана и ошибкой не считается: поле очищаем, вопрос остаётся.
      setHint(true);
      setTyped('');
      return;
    }
    answeredIndex.current = index;
    lockUntil.current = Date.now() + TAP_GUARD_MS;
    // Фокус возвращается синхронно, в обработчике касания: iOS открывает клавиатуру только по жесту.
    if (typing) inputRef.current?.focus();
    const all = [...records, out.record];
    setHint(false);
    setTyped('');
    if (index + 1 >= total) {
      onDone(all);
    } else {
      setRecords(all);
      setIndex(index + 1);
    }
  }

  /** Enter во время подбора иероглифов в японской клавиатуре подтверждает преобразование, а не отправляет ответ. */
  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
  }

  function onSubmitTyped(e: FormEvent) {
    e.preventDefault();
    if (typed.trim() === '') return;
    submit({ kind: 'typed', text: typed });
  }

  const termToDef = q.direction === 'term-to-def';

  return (
    <Page title="Тест" backTo={backTo} extra={`Вопрос ${index + 1} из ${total}`}>
      <div
        className={s.bar}
        role="progressbar"
        aria-label="Прогресс теста"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={index}
      >
        <div className={s.barFill} style={{ width: `${(index / total) * 100}%` }} />
      </div>

      {q.type === 'truefalse' ? (
        <TrueFalseCard q={q} card={card} claim={byId.get(q.claimCardId) ?? card} />
      ) : (
        <div className={s.prompt}>
          <Side card={card} side={askedSide(q.direction)} big />
          <p className={s.promptLabel}>
            {q.type === 'choice'
              ? termToDef
                ? 'Выберите перевод'
                : 'Выберите слово по-японски'
              : termToDef
                ? 'Введите перевод'
                : 'Введите по-японски (кана или кандзи)'}
          </p>
        </div>
      )}

      {q.type === 'choice' && (
        <div className={s.options} role="group" aria-label="Варианты ответа">
          {q.options.map((o, i) => {
            const optionCard = byId.get(o.cardId);
            return (
              <button
                key={`${o.cardId}-${i}`}
                type="button"
                className={s.option}
                onClick={() => submit({ kind: 'choice', index: i })}
              >
                {optionCard ? <Side card={optionCard} side={answerSide(q.direction)} /> : o.text}
              </button>
            );
          })}
        </div>
      )}

      {q.type === 'truefalse' && (
        <div className={s.tfButtons} role="group" aria-label="Верно или неверно">
          <button type="button" className={`${ui.btn} ${s.tfBtn}`} onClick={() => submit({ kind: 'truefalse', saidTrue: true })}>
            Верно
          </button>
          <button type="button" className={`${ui.btn} ${s.tfBtn}`} onClick={() => submit({ kind: 'truefalse', saidTrue: false })}>
            Неверно
          </button>
        </div>
      )}

      {q.type === 'typing' && (
        // Поле не размонтируется между вопросами на ввод: иначе клавиатура iPhone закрывалась бы на каждом вопросе.
        <form className={s.form} onSubmit={onSubmitTyped}>
          <input
            ref={inputRef}
            className={`${ui.input} ${s.input}`}
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={onInputKeyDown}
            lang={termToDef ? 'ru' : 'ja'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="done"
            aria-label={termToDef ? 'Перевод' : 'Слово по-японски'}
            placeholder={termToDef ? 'Перевод' : 'ひらがな / カタカナ / 漢字'}
          />
          {hint && (
            <p className={s.hintBox} role="alert">
              {ROMAJI_HINT_TEXT}: ответ латиницей или кириллицей не принимается. Ошибкой он не считается, введите ещё раз.
            </p>
          )}
          <button type="submit" className={`${ui.btn} ${ui.primary}`} disabled={typed.trim() === ''} onMouseDown={keepFocus}>
            Ответить
          </button>
        </form>
      )}

      <button
        type="button"
        className={`${ui.btn} ${s.skip}`}
        onMouseDown={keepFocus}
        onClick={() => submit({ kind: 'skip' })}
      >
        Не знаю
      </button>
    </Page>
  );
}

/** Утверждение «верно/неверно»: что спрашивают и что (возможно, ложно) утверждается. */
function TrueFalseCard({ q, card, claim }: { q: Extract<TestQuestion, { type: 'truefalse' }>; card: LearnCard; claim: LearnCard }) {
  return (
    <div className={s.prompt}>
      <Side card={card} side={askedSide(q.direction)} big />
      <p className={s.equals}>—</p>
      <div className={s.claim}>
        <Side card={claim} side={answerSide(q.direction)} />
      </div>
      <p className={s.promptLabel}>Это верная пара?</p>
    </div>
  );
}

// ---------- результат ----------

interface ResultProps {
  deck: Deck;
  run: Run;
  records: TestRecord[];
  backTo: string;
  onOverride: (index: number) => void;
  onRetry: () => void;
  onNew: () => void;
}

function Result({ deck, run, records, backTo, onOverride, onRetry, onNew }: ResultProps) {
  const navigate = useNavigate();
  const sum = summarizeTest(records);
  const byId = useMemo(() => new Map(run.cards.map((c) => [c.id, c])), [run.cards]);
  const mistakeCount = mistakeCardIds(records).length;

  return (
    <Page title="Результат теста" backTo={backTo} extra={deck.name}>
      <div className={s.summary} role="status">
        <p className={s.percent}>{sum.percent}%</p>
        <p className={s.summaryBig}>
          {sum.correct} из {sum.total}
        </p>
        {sum.mistakes.length === 0 && <p className={ui.muted}>Ошибок не было.</p>}
      </div>

      {sum.mistakes.length > 0 && (
        <section aria-label="Ошибки">
          <h2 className={ui.sectionTitle}>
            Ошибки: {sum.mistakes.length}
          </h2>
          <ul className={ui.list}>
            {sum.mistakes.map(({ index, record }) => (
              <li key={index} className={ui.item}>
                <MistakeEntry record={record} byId={byId} />
                {canOverride(record) && (
                  <button type="button" className={`${ui.btn} ${ui.small} ${s.right}`} onClick={() => onOverride(index)}>
                    Я был прав
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className={s.resultButtons}>
        <button type="button" className={`${ui.btn} ${ui.primary}`} disabled={mistakeCount === 0} onClick={onRetry}>
          Повторить ошибки{mistakeCount > 0 ? ` (${mistakeCount})` : ''}
        </button>
        <button type="button" className={ui.btn} onClick={onNew}>
          Новый тест
        </button>
        <button type="button" className={ui.btn} onClick={() => void navigate(backTo)}>
          К колоде
        </button>
      </div>
    </Page>
  );
}

function MistakeEntry({ record, byId }: { record: TestRecord; byId: ReadonlyMap<string, LearnCard> }) {
  const q = record.question;
  const card = byId.get(q.cardId);
  if (!card) return null;
  const asked = askedSide(q.direction);
  const answer = answerSide(q.direction);

  if (q.type === 'truefalse') {
    const claim = byId.get(q.claimCardId) ?? card;
    return (
      <div className={s.mistake}>
        <p className={s.mLabel}>Утверждение</p>
        <div className={s.mValue}>
          <Side card={card} side={asked} /> <span className={s.equalsInline}>—</span> <Side card={claim} side={answer} />
        </div>
        <p className={s.mLabel}>Ваш ответ</p>
        <p className={s.mValue}>{record.skipped ? 'Пропущено' : record.given}</p>
        <p className={s.mLabel}>Верный ответ</p>
        <div className={s.mValue}>
          {q.isTrue ? (
            'Верно'
          ) : (
            <>
              Неверно. На самом деле: <Side card={card} side="term" /> <span className={s.equalsInline}>—</span>{' '}
              <Side card={card} side="def" />
            </>
          )}
        </div>
      </div>
    );
  }

  const givenCard = record.givenCardId ? byId.get(record.givenCardId) : undefined;
  return (
    <div className={s.mistake}>
      <p className={s.mLabel}>Вопрос</p>
      <div className={s.mValue}>
        <Side card={card} side={asked} />
      </div>
      <p className={s.mLabel}>Ваш ответ</p>
      <div className={s.mValue}>
        {record.skipped ? (
          'Пропущено'
        ) : givenCard ? (
          <Side card={givenCard} side={answer} />
        ) : (
          <span lang={q.direction === 'def-to-term' ? 'ja' : 'ru'}>{record.given}</span>
        )}
      </div>
      <p className={s.mLabel}>Верный ответ</p>
      <div className={s.mValue}>
        <Side card={card} side={answer} />
      </div>
    </div>
  );
}
