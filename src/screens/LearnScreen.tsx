import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Page } from '../components/Page';
import { CardRow } from '../components/CardRow';
import { db } from '../db/db';
import { getDeck } from '../db/repo';
import { getAnswerDirection, loadLearnInfo, recordCardRating, undoCardRating } from '../db/learnRepo';
import type { LearnInfo } from '../db/learnRepo';
import type { Deck } from '../db/types';
import {
  canUndo,
  currentCard,
  dontKnow,
  isDone,
  iWasRight,
  markTooEasy,
  next,
  startPortion,
  submitChoice,
  submitTyped,
  summarize,
  undo,
} from '../core/learn';
import type { DirectionMode, LearnCard, LearnSession } from '../core/learn';
import { ROMAJI_HINT_TEXT } from '../core/answerCheck';
import { loadSrs } from '../core/srs';
import { errorMessage } from '../core/errors';
import { formatInterval, plural } from '../core/format';
import ui from '../styles/ui.module.css';
import s from './LearnScreen.module.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; deck: Deck | null; info: LearnInfo; directions: DirectionMode; loadedAt: number };

export function LearnScreen() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<LoadState>({ status: 'loading' });
  // Каждая порция читает очередь заново: после «Ещё порция» учитываются новые сроки и остаток дневного лимита.
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: 'loading' });
    void (async () => {
      try {
        // Планировщик FSRS создаётся при запуске; здесь только убеждаемся, что он готов (повторный вызов дешёвый).
        await loadSrs();
        const now = Date.now();
        const [deck, info, directions] = await Promise.all([getDeck(db, id), loadLearnInfo(db, id, now), getAnswerDirection(db)]);
        if (!cancelled) setLoaded({ status: 'ready', deck: deck ?? null, info, directions, loadedAt: now });
      } catch (err) {
        console.error('Не удалось подготовить заучивание', err);
        if (!cancelled) setLoaded({ status: 'error', message: errorMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, round]);

  const backTo = `/deck/${id}`;

  if (loaded.status === 'loading') {
    return (
      <Page title="Заучивание" backTo={backTo}>
        <p className={ui.muted}>Загрузка…</p>
      </Page>
    );
  }
  if (loaded.status === 'error') {
    return (
      <Page title="Заучивание" backTo={backTo}>
        <div className={ui.empty} role="alert">
          <p className={ui.error}>Не удалось подготовить заучивание.</p>
          <p className={ui.hint}>{loaded.message}</p>
          <button type="button" className={ui.btn} onClick={() => setRound((n) => n + 1)}>
            Повторить
          </button>
        </div>
      </Page>
    );
  }
  if (loaded.deck === null) {
    return (
      <Page title="Колода не найдена" backTo="/">
        <p className={ui.muted}>Такой колоды нет.</p>
      </Page>
    );
  }
  if (loaded.info.queue.list.length === 0) {
    return <NothingToday deck={loaded.deck} info={loaded.info} now={loaded.loadedAt} />;
  }
  return (
    <Portion
      key={round}
      deck={loaded.deck}
      info={loaded.info}
      directions={loaded.directions}
      onMore={() => setRound((n) => n + 1)}
      onFinish={() => void navigate(backTo)}
    />
  );
}

/** Очередь пуста: понятное сообщение, почему. */
function NothingToday({ deck, info, now }: { deck: Deck; info: LearnInfo; now: number }) {
  const backTo = `/deck/${deck.id}`;
  if (info.cards.length === 0) {
    return (
      <Page title={deck.name} backTo={backTo}>
        <div className={ui.empty}>
          <p>В колоде нет карточек.</p>
          <Link to={`/deck/${deck.id}/import`} className={`${ui.btn} ${ui.primary}`}>
            Добавить слова
          </Link>
        </div>
      </Page>
    );
  }
  const limitReached = info.queue.newTotal > 0 && info.newRemaining === 0;
  return (
    <Page title={deck.name} backTo={backTo}>
      <div className={s.summary}>
        <p className={s.summaryBig}>На сегодня всё</p>
        {limitReached && (
          <p className={ui.muted}>
            Дневной лимит новых слов исчерпан ({info.newLimit}). Новые слова появятся завтра.
          </p>
        )}
        {info.queue.nextDueAt !== null && (
          <p className={ui.muted}>Ближайшее повторение через {formatInterval(info.queue.nextDueAt - now)}.</p>
        )}
        {!limitReached && info.queue.nextDueAt === null && <p className={ui.muted}>Все слова колоды уже разобраны.</p>}
        <Link to={backTo} className={`${ui.btn} ${ui.primary} ${s.wide}`}>
          К колоде
        </Link>
      </div>
    </Page>
  );
}

interface PortionProps {
  deck: Deck;
  info: LearnInfo;
  directions: DirectionMode;
  onMore: () => void;
  onFinish: () => void;
}

function Portion({ deck, info, directions, onMore, onFinish }: PortionProps) {
  const [session, setSession] = useState<LearnSession>(() =>
    startPortion(info.queue.list, info.cards, { now: Date.now() }, { directions }),
  );
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Строки журнала, уже записанные в этой порции: нужны, чтобы откатить запись при отмене ответа.
  const reviewIds = useRef(new Map<string, number>());
  // Замок от двойного нажатия: ставится синхронно, до любой асинхронной работы.
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const st = session.state;
  const q = st.question;
  const fb = st.feedback;
  const card = currentCard(session);
  const typingStage = q?.stage === 'typing';

  // Фокус (запасной путь): на поле ввода на этапе ввода (само поле НЕ удаляется из разметки при показе результата,
  // см. ниже); на «Дальше» после ответа на вопрос с выбором, где клавиатуры нет.
  useEffect(() => {
    if (typingStage) inputRef.current?.focus();
    else if (fb) nextRef.current?.focus();
  }, [typingStage, fb, q]);

  // Нажатие на кнопку не должно уводить фокус с поля ввода: пока идёт этап ввода, клавиатура iPhone остаётся открытой.
  const keepFocus = typingStage ? (e: MouseEvent) => e.preventDefault() : undefined;

  async function guarded(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      console.error('Заучивание: сбой записи', err);
      setError(`Не удалось сохранить ответ: ${errorMessage(err)}. Данные не потеряны, нажмите кнопку ещё раз.`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** «Дальше»: сначала запись завершённой карточки в расписание, и только потом новое состояние сессии. */
  function advance(from: LearnSession) {
    // Фокус возвращается на поле синхронно, в обработчике касания (до await): iOS открывает клавиатуру только по жесту.
    if (typingStage) inputRef.current?.focus();
    void guarded(async () => {
      const now = Date.now();
      const r = next(from, { now });
      for (const c of r.completions) {
        const res = await recordCardRating(
          db,
          { cardId: c.cardId, rating: c.rating, direction: c.direction, durationMs: c.durationMs },
          now,
        );
        reviewIds.current.set(c.cardId, res.reviewId);
      }
      setSession(r.session);
      setTyped('');
    });
  }

  function onUndo() {
    void guarded(async () => {
      const r = undo(session, { now: Date.now() });
      for (const c of r.rolledBack) {
        const reviewId = reviewIds.current.get(c.cardId);
        if (reviewId !== undefined) await undoCardRating(db, reviewId);
        reviewIds.current.delete(c.cardId);
      }
      setSession(r.session);
      setTyped('');
    });
  }

  /** Enter во время подбора иероглифов в японской клавиатуре подтверждает преобразование, а не отправляет ответ. */
  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
  }

  function onSubmitTyped(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current || !typingStage) return;
    // Результат уже показан: Enter идёт дальше только после верного ответа (неверный нужно успеть прочитать).
    if (fb) {
      if (fb.kind === 'correct') advance(session);
      return;
    }
    if (typed.trim() === '') return;
    const after = submitTyped(session, typed, { now: Date.now() });
    setSession(after);
    // Латиница вместо японского не засчитана: поле очищаем, чтобы ввести заново с японской клавиатуры.
    if (after.state.hint === 'romaji') setTyped('');
  }

  const undoButton = canUndo(session) && (
    <button type="button" className={`${ui.btn} ${ui.small}`} disabled={busy} onClick={onUndo}>
      ← Отменить последний ответ
    </button>
  );

  const errorNote = error && (
    <p className={ui.error} role="alert">
      {error}
    </p>
  );

  // ----- итог порции -----
  if (isDone(session)) {
    const sum = summarize(session);
    return (
      <Page
        title="Порция пройдена"
        backTo={`/deck/${deck.id}`}
        actions={
          <>
            <button type="button" className={ui.btn} onClick={onFinish}>
              Закончить
            </button>
            <button type="button" className={`${ui.btn} ${ui.primary}`} disabled={busy} onClick={onMore}>
              Ещё порция
            </button>
          </>
        }
      >
        <div className={s.summaryBlock}>
          <p className={s.summaryBig}>
            Верно с первого раза: {sum.firstTry} из {sum.total}
          </p>
          {sum.missed.length === 0 ? (
            <p className={ui.muted}>Ошибок не было.</p>
          ) : (
            <>
              <p className={ui.muted}>
                Ошибки были в {sum.missed.length} {plural(sum.missed.length, 'слове', 'словах', 'словах')}. Они скоро
                повторятся.
              </p>
              <ul className={ui.list}>
                {sum.missed.map((c) => (
                  <li key={c.id}>
                    <CardRow card={c} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        {errorNote}
        {undoButton}
      </Page>
    );
  }

  if (!q || !card) return null;

  const total = st.cards.length;
  const progress = `${st.completed.length} / ${total}`;
  // «Этап 2 из 2» только если этап выбора действительно был в этой порции.
  const stageText =
    q.stage === 'choice' ? 'Этап 1 из 2: выберите вариант' : st.choiceAsked ? 'Этап 2 из 2: ввод с клавиатуры' : 'Ввод с клавиатуры';
  const termToDef = q.direction === 'term-to-def';

  return (
    <Page title="Заучивание" backTo={`/deck/${deck.id}`} extra={progress}>
      <div className={s.top}>
        <div
          className={s.bar}
          role="progressbar"
          aria-label="Прогресс порции"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={st.completed.length}
        >
          <div className={s.barFill} style={{ width: `${(st.completed.length / total) * 100}%` }} />
        </div>
        <p className={s.stage}>{stageText}</p>
      </div>

      <div className={s.prompt}>
        {termToDef ? (
          <div className={s.promptTerm} lang="ja">
            {showReading(card) && <span className={s.reading}>{card.reading}</span>}
            <span className={s.kanji}>{card.term}</span>
          </div>
        ) : (
          <div className={s.promptDef}>{card.definition}</div>
        )}
        <p className={s.promptLabel}>
          {q.stage === 'choice'
            ? termToDef
              ? 'Выберите перевод'
              : 'Выберите слово по-японски'
            : termToDef
              ? 'Введите перевод'
              : 'Введите по-японски (кана или кандзи)'}
        </p>
      </div>

      {q.stage === 'choice' && (
        <div className={s.options} role="group" aria-label="Варианты ответа">
          {q.options.map((o, i) => {
            const isRight = o.cardId === q.cardId;
            const chosen = fb?.chosenIndex === i;
            const cls = [s.option];
            if (fb) {
              if (isRight) cls.push(s.optionRight);
              else if (chosen) cls.push(s.optionWrong);
              else cls.push(s.optionDim);
            }
            return (
              <button
                key={`${o.cardId}-${i}`}
                type="button"
                className={cls.join(' ')}
                disabled={busy || fb !== null}
                onClick={() => setSession(submitChoice(session, i, { now: Date.now() }))}
              >
                {termToDef ? (
                  <span className={s.optionDef}>{o.text}</span>
                ) : (
                  <span className={s.optionTerm} lang="ja">
                    {o.reading && o.reading !== o.text && <span className={s.reading}>{o.reading}</span>}
                    <span className={s.kanjiSmall}>{o.text}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {q.stage === 'typing' && (
        // Поле не размонтируется при показе результата: иначе клавиатура iPhone закрывалась бы на каждом вопросе.
        <form className={s.form} onSubmit={onSubmitTyped}>
          <input
            ref={inputRef}
            className={fb ? `${ui.input} ${s.input} ${s.inputLocked}` : `${ui.input} ${s.input}`}
            type="text"
            value={typed}
            onChange={(e) => {
              if (fb === null && !busy) setTyped(e.target.value);
            }}
            onKeyDown={onInputKeyDown}
            aria-readonly={fb !== null}
            lang={termToDef ? 'ru' : 'ja'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="done"
            aria-label={termToDef ? 'Перевод' : 'Слово по-японски'}
            placeholder={termToDef ? 'Перевод' : 'ひらがな / カタカナ / 漢字'}
          />
          {fb === null && st.hint === 'romaji' && (
            <p className={s.hintBox} role="alert">
              {ROMAJI_HINT_TEXT}: ответ латиницей или кириллицей не принимается. Ошибкой он не считается, введите ещё раз.
            </p>
          )}
          {fb === null && (
            <button
              type="submit"
              className={`${ui.btn} ${ui.primary}`}
              disabled={busy || typed.trim() === ''}
              onMouseDown={keepFocus}
            >
              Проверить
            </button>
          )}
        </form>
      )}

      {fb === null && (
        <button
          type="button"
          className={`${ui.btn} ${s.dontKnow}`}
          disabled={busy}
          onMouseDown={keepFocus}
          onClick={() => setSession(dontKnow(session, { now: Date.now() }))}
        >
          Не знаю
        </button>
      )}

      {fb && (
        <div
          className={`${s.feedback} ${fb.kind === 'correct' ? s.feedbackOk : s.feedbackBad}`}
          role="status"
          aria-live="polite"
        >
          <p className={s.feedbackTitle}>
            {fb.kind === 'correct' ? 'Верно!' : fb.kind === 'wrong' ? 'Неверно' : 'Вот правильный ответ'}
          </p>
          {fb.kind === 'wrong' && q.stage === 'typing' && fb.given !== '' && (
            <p className={s.given}>Вы ввели: {fb.given}</p>
          )}
          {!(q.stage === 'choice' && fb.kind === 'correct') && <AnswerCard card={card} />}
          {fb.kind !== 'correct' && <p className={ui.hint}>Эта карточка вернётся в порции ещё раз.</p>}
          {fb.tooEasy && <p className={ui.hint}>Отмечено как «слишком легко».</p>}
        </div>
      )}

      {fb && (
        <div className={s.buttons}>
          <button
            ref={nextRef}
            type="button"
            className={`${ui.btn} ${ui.primary}`}
            disabled={busy}
            onMouseDown={keepFocus}
            onClick={() => advance(session)}
          >
            Дальше
          </button>
          {fb.canOverride && (
            <button type="button" className={ui.btn} disabled={busy} onMouseDown={keepFocus} onClick={() => setSession(iWasRight(session))}>
              Я был прав
            </button>
          )}
          {fb.canTooEasy && !fb.tooEasy && (
            <button type="button" className={ui.btn} disabled={busy} onMouseDown={keepFocus} onClick={() => advance(markTooEasy(session))}>
              Слишком легко
            </button>
          )}
        </div>
      )}

      {errorNote}
      {undoButton}
    </Page>
  );
}

/** Чтение показываем, только если оно отличается от самого слова (у слов, записанных каной, оно совпадает). */
function showReading(c: LearnCard): boolean {
  return Boolean(c.reading) && c.reading !== c.term;
}

/** Вся карточка целиком: чтение рядом со словом, перевод, пример. */
function AnswerCard({ card }: { card: LearnCard }) {
  return (
    <div className={s.answer}>
      <div className={s.answerTerm} lang="ja">
        {showReading(card) && <span className={s.reading}>{card.reading}</span>}
        <span className={s.kanjiSmall}>{card.term}</span>
      </div>
      <div className={s.answerDef}>{card.definition}</div>
      {card.example && (
        <div className={s.example} lang="ja">
          {card.example}
        </div>
      )}
    </div>
  );
}
