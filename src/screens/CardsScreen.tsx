import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Page } from '../components/Page';
import { db } from '../db/db';
import { getDeck, listCards } from '../db/repo';
import type { Card, Deck } from '../db/types';
import {
  againIds,
  counts,
  createSession,
  currentId,
  isFinished,
  mark,
  retryAgain,
  shuffleRemaining,
  skippedCount,
  undo,
} from '../core/flashcards';
import type { FlashSession, Mark } from '../core/flashcards';
import { shuffle } from '../core/shuffle';
import { errorMessage } from '../core/errors';
import ui from '../styles/ui.module.css';
import s from './CardsScreen.module.css';

type Side = 'term' | 'definition';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; deck: Deck | null; cards: Card[] };

export function CardsScreen() {
  const { id = '' } = useParams();
  const [loaded, setLoaded] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // Читаем один раз: во время прохождения набор карточек не должен меняться под ногами.
  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: 'loading' });
    void (async () => {
      try {
        const [deck, cards] = await Promise.all([getDeck(db, id), listCards(db, id)]);
        if (!cancelled) setLoaded({ status: 'ready', deck: deck ?? null, cards });
      } catch (err) {
        console.error('Не удалось загрузить карточки', err);
        if (!cancelled) {
          setLoaded({ status: 'error', message: errorMessage(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  if (loaded.status === 'loading') {
    return (
      <Page title="Карточки" backTo={`/deck/${id}`}>
        <p className={ui.muted}>Загрузка…</p>
      </Page>
    );
  }
  if (loaded.status === 'error') {
    return (
      <Page title="Карточки" backTo={`/deck/${id}`}>
        <div className={ui.empty} role="alert">
          <p className={ui.error}>Не удалось загрузить карточки из памяти устройства.</p>
          <p className={ui.hint}>{loaded.message}</p>
          <button type="button" className={ui.btn} onClick={() => setAttempt((n) => n + 1)}>
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
  if (loaded.cards.length === 0) {
    return (
      <Page title={loaded.deck.name} backTo={`/deck/${id}`}>
        <div className={ui.empty}>
          <p>В колоде нет карточек.</p>
          <Link to={`/deck/${id}/import`} className={`${ui.btn} ${ui.primary}`}>
            Добавить слова
          </Link>
        </div>
      </Page>
    );
  }
  return <Flashcards deck={loaded.deck} cards={loaded.cards} />;
}

function Flashcards({ deck, cards }: { deck: Deck; cards: Card[] }) {
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const allIds = useMemo(() => cards.map((c) => c.id), [cards]);
  const [session, setSession] = useState<FlashSession>(() => createSession(allIds));
  const [flipped, setFlipped] = useState(false);
  const [front, setFront] = useState<Side>('term');

  const backTo = `/deck/${deck.id}`;
  const c = counts(session);
  const finished = isFinished(session);
  const card = byId.get(currentId(session) ?? '');

  function onMark(m: Mark) {
    setSession((prev) => mark(prev, m));
    setFlipped(false);
  }
  function onUndo() {
    setSession((prev) => undo(prev));
    setFlipped(false);
  }
  function onShuffle() {
    setSession((prev) => shuffleRemaining(prev));
    setFlipped(false);
  }
  function restart() {
    setSession(createSession(shuffle(allIds)));
    setFlipped(false);
  }
  function retry() {
    setSession((prev) => retryAgain(prev, { shuffle: true }));
    setFlipped(false);
  }

  if (finished) {
    const again = againIds(session).length;
    const skipped = skippedCount(session);
    return (
      <Page
        title="Итог"
        backTo={backTo}
        actions={
          <>
            {again > 0 && (
              <button type="button" className={`${ui.btn} ${ui.again}`} onClick={retry}>
                Ещё учу ({again})
              </button>
            )}
            <button type="button" className={`${ui.btn} ${ui.primary}`} onClick={restart}>
              Заново
            </button>
          </>
        }
      >
        <div className={s.summary}>
          <p className={s.summaryBig}>
            Знаю: {c.known} из {c.total}
          </p>
          <p className={ui.muted}>Ещё учу: {again}</p>
          {skipped > 0 && <p className={ui.muted}>Без отметки: {skipped}</p>}
        </div>
      </Page>
    );
  }

  if (!card) return null;

  // Лицевая сторона; в перевёрнутом виде показывается Back, поэтому flipped здесь не нужен.
  const showTerm = front === 'term';
  const progress = `${session.pos + 1} / ${c.total}`;

  return (
    <Page
      title={deck.name}
      backTo={backTo}
      extra={progress}
      actions={
        <>
          <button type="button" className={`${ui.btn} ${ui.again}`} onClick={() => onMark('again')}>
            Ещё учу
          </button>
          <button type="button" className={ui.btn} onClick={() => onMark('skip')}>
            Дальше
          </button>
          <button type="button" className={`${ui.btn} ${ui.ok}`} onClick={() => onMark('known')}>
            Знаю
          </button>
        </>
      }
    >
      <div className={s.toolbar}>
        <button
          type="button"
          className={`${ui.btn} ${ui.small}`}
          onClick={onUndo}
          disabled={session.pos === 0}
        >
          ← Назад
        </button>
        <button type="button" className={`${ui.btn} ${ui.small}`} onClick={onShuffle}>
          Перемешать
        </button>
        <button
          type="button"
          className={`${ui.btn} ${ui.small}`}
          onClick={() => {
            setFront((f) => (f === 'term' ? 'definition' : 'term'));
            setFlipped(false);
          }}
          aria-label="Какой стороной показывать карточку"
        >
          Сначала: {front === 'term' ? 'японский' : 'перевод'}
        </button>
      </div>

      <button
        type="button"
        className={s.card}
        onClick={() => setFlipped((f) => !f)}
        aria-label="Перевернуть карточку"
      >
        {flipped ? <Back card={card} /> : showTerm ? <TermSide card={card} /> : <DefinitionSide card={card} />}
        <span className={s.tapHint}>{flipped ? 'Нажмите, чтобы вернуть' : 'Нажмите, чтобы перевернуть'}</span>
      </button>
    </Page>
  );
}

function TermSide({ card }: { card: Card }) {
  return (
    <span className={s.face} lang="ja">
      <span className={s.kanji}>{card.term}</span>
    </span>
  );
}

function DefinitionSide({ card }: { card: Card }) {
  return (
    <span className={s.face}>
      <span className={s.definition}>{card.definition}</span>
    </span>
  );
}

/** Обратная сторона: вся карточка целиком (чтение, слово, перевод, пример). */
function Back({ card }: { card: Card }) {
  return (
    <span className={s.face}>
      <span lang="ja" className={s.backTerm}>
        {card.reading && <span className={s.reading}>{card.reading}</span>}
        <span className={s.kanji}>{card.term}</span>
      </span>
      <span className={s.definition}>{card.definition}</span>
      {card.example && (
        <span className={s.example} lang="ja">
          {card.example}
        </span>
      )}
    </span>
  );
}
