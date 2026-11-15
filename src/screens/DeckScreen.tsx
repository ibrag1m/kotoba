import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Page } from '../components/Page';
import { CardRow } from '../components/CardRow';
import { db } from '../db/db';
import { deleteDeck, getDeck, listCards } from '../db/repo';
import { plural } from '../core/format';
import { attempt, deleteDeckErrorText } from '../core/errors';
import ui from '../styles/ui.module.css';

export function DeckScreen() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  // null: колоды нет; undefined: ещё грузится.
  const deck = useLiveQuery(async () => (await getDeck(db, id)) ?? null, [id]);
  const cards = useLiveQuery(() => listCards(db, id), [id]);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (deck === undefined || cards === undefined) {
    return (
      <Page title="Колода" backTo="/">
        <p className={ui.muted}>Загрузка…</p>
      </Page>
    );
  }
  if (deck === null) {
    return (
      <Page title="Колода не найдена" backTo="/">
        <p className={ui.muted}>Такой колоды нет. Возможно, она была удалена.</p>
      </Page>
    );
  }

  async function onDelete() {
    if (!deck || deleting) return;
    const ok = window.confirm(
      `Удалить колоду «${deck.name}» вместе с ${cards?.length ?? 0} карточками? Это нельзя отменить.`,
    );
    if (!ok) return;
    setDeleting(true);
    setDeleteError(null);
    const res = await attempt(() => deleteDeck(db, deck.id));
    if (res.ok) {
      void navigate('/', { replace: true });
    } else {
      setDeleteError(deleteDeckErrorText(res.message));
      setDeleting(false);
    }
  }

  return (
    <Page
      title={deck.name}
      backTo="/"
      extra={`${cards.length} ${plural(cards.length, 'карточка', 'карточки', 'карточек')}`}
      actions={
        <>
          <Link to={`/deck/${deck.id}/import`} className={ui.btn}>
            Добавить слова
          </Link>
          <Link
            to={`/deck/${deck.id}/cards`}
            className={`${ui.btn} ${ui.primary}`}
            aria-disabled={cards.length === 0}
          >
            Карточки
          </Link>
        </>
      }
    >
      {cards.length === 0 ? (
        <div className={ui.empty}>
          <p>В колоде пока нет слов.</p>
        </div>
      ) : (
        <ul className={ui.list}>
          {cards.map((c) => (
            <li key={c.id}>
              <CardRow card={c} />
            </li>
          ))}
        </ul>
      )}
      {deleteError && (
        <p className={ui.error} role="alert">
          {deleteError}
        </p>
      )}
      <button
        type="button"
        className={`${ui.btn} ${ui.danger} ${ui.small}`}
        disabled={deleting}
        onClick={() => void onDelete()}
      >
        Удалить колоду
      </button>
    </Page>
  );
}
