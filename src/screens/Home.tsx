import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Page } from '../components/Page';
import { BackupBanner } from '../components/BackupBanner';
import { db } from '../db/db';
import { listDeckSummaries } from '../db/repo';
import { plural } from '../core/format';
import ui from '../styles/ui.module.css';

export function Home() {
  const decks = useLiveQuery(() => listDeckSummaries(db), []);

  return (
    <Page
      title="Kotoba"
      actions={
        <Link to="/deck/new" className={`${ui.btn} ${ui.primary}`}>
          Новая колода
        </Link>
      }
    >
      <BackupBanner />
      {decks === undefined ? (
        <p className={ui.muted}>Загрузка…</p>
      ) : decks.length === 0 ? (
        <div className={ui.empty}>
          <p>Колод пока нет. Создайте первую и вставьте в неё слова текстом.</p>
        </div>
      ) : (
        <ul className={ui.list}>
          {decks.map((d) => (
            <li key={d.id}>
              <Link to={`/deck/${d.id}`} className={`${ui.item} ${ui.itemLink}`}>
                <div className={ui.itemTitle}>{d.name}</div>
                <div className={ui.muted}>
                  {d.cardCount} {plural(d.cardCount, 'карточка', 'карточки', 'карточек')}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/settings" className={ui.btn}>
        Настройки и резервная копия
      </Link>
      <p className={ui.hint}>
        <Link to="/diag">Диагностика</Link>
      </p>
    </Page>
  );
}
