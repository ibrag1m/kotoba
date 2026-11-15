import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { readBackupState, snoozeBackupReminder } from '../db/backupRepo';
import { reminderStatus, reminderText } from '../core/backupReminder';
import type { ReminderStatus } from '../core/backupReminder';
import ui from '../styles/ui.module.css';
import s from './BackupBanner.module.css';

interface ViewProps {
  status: ReminderStatus;
  changes: number;
  onSnooze: () => void;
}

/** Внешний вид баннера (отдельно от базы, чтобы проверять без браузера). */
export function BackupBannerView({ status, changes, onSnooze }: ViewProps) {
  return (
    <section className={s.banner} role="status" aria-label="Напоминание о резервной копии">
      <p className={s.text}>{reminderText(status, changes)}</p>
      <div className={s.actions}>
        <Link to="/settings" className={`${ui.btn} ${ui.primary}`}>
          Сохранить копию
        </Link>
        <button type="button" className={ui.btn} onClick={onSnooze}>
          Напомнить позже
        </button>
      </div>
    </section>
  );
}

/** Ненавязчивый баннер на главной: не блокирует работу, откладывается на сутки. */
export function BackupBanner() {
  const state = useLiveQuery(() => readBackupState(db), []);
  if (!state) return null;
  const status = reminderStatus({ now: Date.now(), ...state });
  if (!status.show) return null;
  return (
    <BackupBannerView
      status={status}
      changes={state.changesSinceBackup}
      onSnooze={() => void snoozeBackupReminder(db).catch((e: unknown) => console.error('Не удалось отложить напоминание', e))}
    />
  );
}
