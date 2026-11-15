import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Page } from '../components/Page';
import { db } from '../db/db';
import { getDeck, listCards } from '../db/repo';
import { recordMatchTime } from '../db/matchRepo';
import type { MatchRecordResult } from '../db/matchRepo';
import type { Card, Deck } from '../db/types';
import type { LearnCard } from '../core/learn';
import {
  MATCH_PAIRS,
  MATCH_PENALTY_MS,
  MATCH_WRONG_FLASH_MS,
  MIN_MATCH_PAIRS,
  clearWrong,
  createMatchRound,
  elapsedMs,
  finalMs,
  formatMatchTime,
  isMatched,
  isRecordEligible,
  penaltyMs,
  selectTile,
} from '../core/match';
import type { MatchState, MatchTile } from '../core/match';
import { errorMessage } from '../core/errors';
import ui from '../styles/ui.module.css';
import s from './MatchScreen.module.css';

/** Минимум, что нужно игре от карточки. */
function toLearnCard(c: Card): LearnCard {
  const out: LearnCard = { id: c.id, term: c.term, definition: c.definition };
  if (c.reading) out.reading = c.reading;
  return out;
}

export function MatchScreen() {
  const { id = '' } = useParams();
  const deck = useLiveQuery(async () => (await getDeck(db, id)) ?? null, [id]);
  const cards = useLiveQuery(() => listCards(db, id), [id]);
  // Номер партии: «Ещё раз» пересоздаёт игру с новым выбором слов.
  const [game, setGame] = useState(0);
  const backTo = `/deck/${id}`;

  if (deck === undefined || cards === undefined) {
    return (
      <Page title="Подбор пар" backTo={backTo}>
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
  return <Game key={`${deck.id}:${game}`} deck={deck} cards={cards} backTo={backTo} onAgain={() => setGame((n) => n + 1)} />;
}

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'done'; result: MatchRecordResult }
  | { status: 'error'; message: string };

interface GameProps {
  deck: Deck;
  cards: Card[];
  backTo: string;
  onAgain: () => void;
}

function Game({ deck, cards, backTo, onAgain }: GameProps) {
  const navigate = useNavigate();
  // Раунд собирается один раз из снимка карточек на момент входа в партию.
  const [state, setState] = useState<MatchState | null>(() => createMatchRound(cards.map(toLearnCard)));
  const [save, setSave] = useState<SaveState>({ status: 'idle' });
  const savedRef = useRef(false);
  const wrong = state?.wrong ?? null;
  const finished = state ? finalMs(state) : null;
  // Рекорд считается только в раунде из полных 6 пар: короткий раунд (мало различных слов в колоде) несравним.
  const eligible = state ? isRecordEligible(state) : false;

  // Подсветка неверной пары гаснет сама.
  useEffect(() => {
    if (wrong === null) return;
    const timer = window.setTimeout(() => setState((cur) => (cur ? clearWrong(cur) : cur)), MATCH_WRONG_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [wrong]);

  const persist = useCallback(
    async (ms: number) => {
      setSave({ status: 'saving' });
      try {
        setSave({ status: 'done', result: await recordMatchTime(db, deck.id, ms) });
      } catch (err) {
        console.error('Подбор пар: не удалось записать время', err);
        setSave({ status: 'error', message: errorMessage(err) });
      }
    },
    [deck.id],
  );

  // Время записывается один раз, когда найдена последняя пара.
  useEffect(() => {
    if (finished === null || !eligible || savedRef.current) return;
    savedRef.current = true;
    void persist(finished);
  }, [finished, eligible, persist]);

  const onTile = useCallback((tileId: string) => {
    const now = Date.now();
    setState((cur) => (cur ? selectTile(cur, tileId, now) : cur));
  }, []);

  if (state === null) {
    return (
      <Page title="Подбор пар" backTo={backTo}>
        <div className={ui.empty}>
          {cards.length < MIN_MATCH_PAIRS ? (
            <p>Для игры нужно хотя бы {MIN_MATCH_PAIRS} слова в колоде.</p>
          ) : (
            <p>
              В колоде не нашлось двух слов с разными словами и разными переводами: пара получилась бы неоднозначной.
            </p>
          )}
          <Link to={`/deck/${deck.id}/import`} className={`${ui.btn} ${ui.primary}`}>
            Добавить слова
          </Link>
        </div>
      </Page>
    );
  }

  const pairs = state.tiles.length / 2;

  if (finished !== null) {
    const play = finished - penaltyMs(state);
    return (
      <Page title="Подбор пар" backTo={backTo}>
        <div className={s.result} role="status">
          <p className={s.resultLabel}>Ваше время</p>
          <p className={s.resultTime}>{formatMatchTime(finished)}</p>
          <p className={ui.muted}>
            {state.mistakes === 0
              ? 'Без ошибок.'
              : `Игра ${formatMatchTime(play)} + штраф ${formatMatchTime(penaltyMs(state))} (ошибок: ${state.mistakes}).`}
          </p>
          {eligible ? (
            <SaveNote save={save} onRetry={() => void persist(finished)} />
          ) : (
            <p className={ui.muted}>Рекорд считается при {MATCH_PAIRS} парах (в этом раунде их {pairs}).</p>
          )}
        </div>
        <div className={s.resultButtons}>
          <button type="button" className={`${ui.btn} ${ui.primary}`} onClick={onAgain}>
            Ещё раз
          </button>
          <button type="button" className={ui.btn} onClick={() => void navigate(backTo)}>
            К колоде
          </button>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Подбор пар" backTo={backTo} extra={`${state.matched.length} из ${pairs}`}>
      <div className={s.status}>
        <Timer startedAt={state.startedAt} mistakes={state.mistakes} />
        {deck.bestMatchMs !== undefined && <p className={s.best}>Лучшее: {formatMatchTime(deck.bestMatchMs)}</p>}
      </div>
      <p className={ui.hint}>
        {state.startedAt === null
          ? 'Соедините слово с его переводом: нажмите на две плитки. Время пойдёт с первого нажатия.'
          : `Неверная пара: +${MATCH_PENALTY_MS / 1000} с к времени.`}
      </p>
      <div className={s.grid} role="group" aria-label="Плитки">
        {state.tiles.map((t) => (
          <Tile
            key={t.id}
            tile={t}
            matched={isMatched(state, t)}
            selected={state.selected === t.id}
            wrong={state.wrong !== null && (state.wrong[0] === t.id || state.wrong[1] === t.id)}
            onTap={onTile}
          />
        ))}
      </div>
    </Page>
  );
}

/** Размер шрифта по длине строки: длинные не ломают сетку. */
function sizeClass(text: string): string {
  const len = [...text].length;
  if (len > 28) return s.textXs ?? '';
  if (len > 14) return s.textS ?? '';
  return s.textM ?? '';
}

interface TileProps {
  tile: MatchTile;
  matched: boolean;
  selected: boolean;
  wrong: boolean;
  onTap: (id: string) => void;
}

const Tile = memo(function Tile({ tile, matched, selected, wrong, onTap }: TileProps) {
  const cls = [s.tile];
  if (selected) cls.push(s.tileSelected ?? '');
  if (wrong) cls.push(s.tileWrong ?? '');
  if (matched) cls.push(s.tileDone ?? '');
  const isTerm = tile.side === 'term';
  return (
    <button
      type="button"
      className={cls.join(' ')}
      disabled={matched}
      aria-hidden={matched ? true : undefined}
      aria-pressed={selected}
      tabIndex={matched ? -1 : undefined}
      onClick={() => onTap(tile.id)}
    >
      <span className={s.tileInner} lang={isTerm ? 'ja' : undefined}>
        {isTerm && tile.reading && tile.reading !== tile.text && <span className={s.reading}>{tile.reading}</span>}
        <span className={`${s.tileText} ${isTerm ? s.termText : ''} ${sizeClass(tile.text)}`}>{tile.text}</span>
      </span>
    </button>
  );
});

/**
 * Таймер: время игры плюс штраф. Обновляется раз в 100 мс только пока игра идёт; состояние часов лежит здесь,
 * поэтому перерисовывается только он, а не весь экран.
 */
function Timer({ startedAt, mistakes }: { startedAt: number | null; mistakes: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const ms = elapsedMs(startedAt, null, mistakes, now);
  return (
    <p className={s.timer} aria-label="Время" role="timer">
      {formatMatchTime(ms)}
    </p>
  );
}

function SaveNote({ save, onRetry }: { save: SaveState; onRetry: () => void }) {
  if (save.status === 'idle' || save.status === 'saving') return <p className={ui.muted}>Сохраняю результат…</p>;
  if (save.status === 'error') {
    return (
      <div className={s.saveError} role="alert">
        <p className={ui.error}>Не удалось сохранить время: {save.message}. Данные не потеряны.</p>
        <button type="button" className={`${ui.btn} ${ui.small}`} onClick={onRetry}>
          Повторить
        </button>
      </div>
    );
  }
  const { isRecord, best, previous } = save.result;
  if (isRecord) {
    return (
      <div className={s.record}>
        <p className={s.recordTitle}>Новый рекорд!</p>
        <p className={ui.muted}>
          {previous === undefined ? 'Это первое время в этой колоде.' : `Прежний рекорд: ${formatMatchTime(previous)}.`}
        </p>
      </div>
    );
  }
  return <p className={s.bestResult}>Лучшее время колоды: {formatMatchTime(best)}</p>;
}
