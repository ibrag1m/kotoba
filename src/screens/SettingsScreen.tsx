import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Page } from '../components/Page';
import { BackupExport } from '../components/BackupExport';
import { BackupRestore } from '../components/BackupRestore';
import { APP_VERSION, BACKUP_FORMAT_VERSION, DB_SCHEMA_VERSION } from '../appInfo';
import { reminderStatus } from '../core/backupReminder';
import { formatDateTimeRu, plural } from '../core/format';
import { PERSIST_TEXT, formatBytes, readEstimate } from '../core/storageInfo';
import type { PersistResult, StorageEstimate, StorageManagerLike } from '../core/storageInfo';
import { ensurePersist, readBackupState } from '../db/backupRepo';
import type { BackupState } from '../db/backupRepo';
import { db } from '../db/db';
import ui from '../styles/ui.module.css';
import s from '../components/Backup.module.css';

export interface StorageView {
  /** undefined: ещё узнаём. */
  persist: PersistResult | undefined;
  /** undefined: ещё узнаём; null: недоступно. */
  estimate: StorageEstimate | null | undefined;
}

/** Внешний вид блока «Хранилище на устройстве». */
export function StorageBlock({ persist, estimate }: StorageView) {
  const space =
    estimate === undefined
      ? 'узнаю…'
      : estimate === null || estimate.usage === null
        ? 'недоступно в этом браузере'
        : estimate.quota === null
          ? `${formatBytes(estimate.usage)} (общий лимит неизвестен)`
          : `${formatBytes(estimate.usage)} из ${formatBytes(estimate.quota)} (оценка браузера)`;
  return (
    <>
      <dl className={s.facts}>
        <dt>Постоянное хранилище</dt>
        <dd data-testid="persist-result">{persist === undefined ? 'узнаю…' : PERSIST_TEXT[persist]}</dd>
        <dt>Занято приложением</dt>
        <dd data-testid="storage-usage">{space}</dd>
      </dl>
      <p className={ui.hint}>
        Это не гарантия сохранности. Даже при «Да» iPhone может очистить данные приложения (например, при нехватке места,
        после удаления значка или если приложение долго не открывали). Резервная копия нужна всё равно.
      </p>
    </>
  );
}

export interface BackupStatusProps {
  state: BackupState | undefined;
  now: number;
}

/** Внешний вид блока состояния копий. */
export function BackupStatus({ state, now }: BackupStatusProps) {
  if (!state) return <p className={ui.muted}>Загрузка…</p>;
  const status = reminderStatus({ now, ...state });
  const changes = state.changesSinceBackup;
  return (
    <>
      <dl className={s.facts}>
        <dt>Последняя сохранённая копия</dt>
        <dd data-testid="last-backup">
          {state.lastBackupAt === undefined ? 'копий ещё не было' : formatDateTimeRu(state.lastBackupAt)}
        </dd>
        <dt>Изменений после последней копии</dt>
        <dd data-testid="changes-count">
          {changes} {plural(changes, 'изменение', 'изменения', 'изменений')}
        </dd>
      </dl>
      {status.show && (
        <p className={`${s.note} ${s.noteWarn}`}>
          {state.lastBackupAt === undefined
            ? 'Копий ещё не было. Сохраните первую копию, пока данных немного.'
            : 'Пора сохранить свежую копию.'}
        </p>
      )}
    </>
  );
}

function storageManager(): StorageManagerLike | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.storage;
}

export function SettingsScreen() {
  const state = useLiveQuery(() => readBackupState(db), []);
  const [persist, setPersist] = useState<PersistResult | undefined>(undefined);
  const [estimate, setEstimate] = useState<StorageEstimate | null | undefined>(undefined);

  // При открытии настроек запрашиваем постоянное хранилище и узнаём занятое место.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // «Нет» показываем только при реальном ответе браузера false. Сбой запроса или записи ответа в базу
      // «Нет» не выдумывает: ensurePersist возвращает настоящий ответ, а при отсутствии ответа это «unknown».
      const result = await ensurePersist(db, storageManager());
      if (!cancelled) setPersist(result ?? 'unknown');
      const est = await readEstimate(storageManager());
      if (!cancelled) setEstimate(est);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Page title="Настройки" backTo="/">
      <section className={s.block} aria-labelledby="backup-title">
        <h2 id="backup-title" className={ui.sectionTitle}>
          Резервная копия
        </h2>
        <p>
          Слова хранятся только на этом устройстве. Если iPhone их сотрёт, вернуть можно будет лишь из копии. Сохраняйте
          файл в «Файлы» (iCloud Drive) или отправляйте себе.
        </p>
        <BackupStatus state={state} now={Date.now()} />
        <BackupExport />
      </section>

      <section className={s.block} aria-labelledby="restore-title">
        <h2 id="restore-title" className={ui.sectionTitle}>
          Восстановление из копии
        </h2>
        <BackupRestore />
      </section>

      <section className={s.block} aria-labelledby="storage-title">
        <h2 id="storage-title" className={ui.sectionTitle}>
          Хранилище на устройстве
        </h2>
        <StorageBlock persist={persist} estimate={estimate} />
      </section>

      <section className={s.block} aria-labelledby="about-title">
        <h2 id="about-title" className={ui.sectionTitle}>
          О приложении
        </h2>
        <dl className={s.facts}>
          <dt>Версия приложения</dt>
          <dd data-testid="app-version">{APP_VERSION}</dd>
          <dt>Версия схемы базы</dt>
          <dd data-testid="schema-version">{DB_SCHEMA_VERSION}</dd>
          <dt>Формат файла копии</dt>
          <dd>{BACKUP_FORMAT_VERSION}</dd>
        </dl>
        <Link to="/diag" className={ui.btn}>
          Диагностика
        </Link>
      </section>
    </Page>
  );
}
