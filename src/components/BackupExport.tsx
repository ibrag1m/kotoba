import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { APP_VERSION } from '../appInfo';
import { downloadBackup } from '../core/backupShare';
import type { DownloadEnv } from '../core/backupShare';
import { readChangeSeq } from '../db/backupRepo';
import { BackupExportController } from '../db/backupExportFlow';
import type { Note, NoteKind, PendingConfirm } from '../db/backupExportFlow';
import { db } from '../db/db';
import ui from '../styles/ui.module.css';
import s from './Backup.module.css';

export type { Note, NoteKind, PendingConfirm };

export interface BackupExportViewProps {
  /** null: ещё проверяем; false: «Поделиться» с файлом недоступно на этом устройстве. */
  canShare: boolean | null;
  /** Копия ещё готовится: кнопки «Готовлю копию…». Обработчики нажатий работают только с готовой копией. */
  preparing: boolean;
  busy: boolean;
  /** Браузер дважды отказал в «Поделиться»: основной способ теперь скачивание. */
  suggestAlt: boolean;
  /** Предупреждения о готовой копии (например, записи журнала без карточки). */
  warnings: string[];
  /** Копию не удалось собрать. */
  prepareError: Note | null;
  note: Note | null;
  confirm: PendingConfirm | null;
  /** Текст для ручного копирования (если буфер обмена недоступен). */
  manualText: string | null;
  onShare: () => void;
  onDownload: () => void;
  onCopy: () => void;
  onConfirmSaved: () => void;
  onDismissConfirm: () => void;
  onRetryPrepare: () => void;
  onCopyErrorReport: () => void;
}

const CONFIRM_TEXT: Record<PendingConfirm['via'], string> = {
  download:
    'Файл скачан? Откройте приложение «Файлы» (или список загрузок) и убедитесь, что kotoba-backup лежит там. Браузер не сообщает, дошёл ли файл, поэтому приложение само этого не знает.',
  copy: 'Текст в буфере обмена хранится только до следующего копирования. Вставьте его в «Заметки» или в письмо самому себе. Приложение не может проверить, что вы это сделали.',
  manual:
    'Нажмите в поле, выберите «Выбрать всё», затем «Скопировать» и вставьте текст в «Заметки» или в письмо самому себе. Приложение не может проверить, что вы это сделали.',
};

function noteClass(kind: NoteKind): string {
  return `${s.note} ${kind === 'ok' ? s.noteOk : kind === 'warn' ? s.noteWarn : kind === 'error' ? s.noteError : ''}`;
}

const PREPARING = 'Готовлю копию…';

/** Внешний вид блока «Сохранить копию». Без базы и браузерных API: проверяется серверной отрисовкой. */
export function BackupExportView(p: BackupExportViewProps) {
  const locked = p.busy || p.preparing || p.prepareError !== null;
  const altPrimary = p.canShare === false || p.suggestAlt;
  return (
    <div className={s.inner}>
      <div className={s.stack}>
        {p.canShare !== false && (
          <button
            type="button"
            className={p.suggestAlt ? ui.btn : `${ui.btn} ${ui.primary}`}
            disabled={locked || p.canShare === null}
            aria-busy={p.preparing}
            onClick={p.onShare}
          >
            {p.preparing ? PREPARING : 'Поделиться (сохранить в «Файлы»)'}
          </button>
        )}
        <button type="button" className={altPrimary ? `${ui.btn} ${ui.primary}` : ui.btn} disabled={locked} aria-busy={p.preparing} onClick={p.onDownload}>
          {p.preparing ? PREPARING : 'Скачать файл'}
        </button>
        <button type="button" className={ui.btn} disabled={locked} aria-busy={p.preparing} onClick={p.onCopy}>
          {p.preparing ? PREPARING : 'Скопировать текстом'}
        </button>
      </div>
      {p.canShare === false && (
        <p className={ui.hint}>
          Меню «Поделиться» с файлом на этом устройстве недоступно. Используйте скачивание или копирование текстом.
        </p>
      )}
      {p.prepareError && (
        <div className={`${s.note} ${s.noteError}`} role="alert">
          <p>{p.prepareError.text}</p>
          {p.prepareError.details && p.prepareError.details.length > 0 && (
            <ul className={s.details}>
              {p.prepareError.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
          <div className={s.row}>
            <button type="button" className={ui.btn} onClick={p.onRetryPrepare}>
              Попробовать ещё раз
            </button>
            <button type="button" className={ui.btn} onClick={p.onCopyErrorReport}>
              Скопировать сведения об ошибке
            </button>
          </div>
        </div>
      )}
      {p.warnings.map((w) => (
        <p key={w} className={`${s.note} ${s.noteWarn}`} role="status">
          {w}
        </p>
      ))}
      {p.manualText !== null && (
        <label className={ui.field}>
          <span className={ui.label}>Текст копии для ручного копирования</span>
          <textarea
            className={`${ui.textarea} ${s.manual}`}
            readOnly
            value={p.manualText}
            onFocus={selectAll}
            onClick={selectAll}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Текст резервной копии"
          />
        </label>
      )}
      {p.note && (
        <p className={noteClass(p.note.kind)} role={p.note.kind === 'error' ? 'alert' : 'status'}>
          {p.note.text}
        </p>
      )}
      {p.confirm && (
        <div className={`${s.note} ${s.noteWarn}`} role="group" aria-label="Подтверждение сохранения">
          <p>{CONFIRM_TEXT[p.confirm.via]}</p>
          <p className={ui.label}>Вы сохранили копию в надёжное место?</p>
          <div className={s.row}>
            <button type="button" className={`${ui.btn} ${ui.ok}`} onClick={p.onConfirmSaved}>
              Да, сохранил(а)
            </button>
            <button type="button" className={ui.btn} onClick={p.onDismissConfirm}>
              Ещё нет
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function selectAll(e: { currentTarget: HTMLTextAreaElement }) {
  const el = e.currentTarget;
  el.select();
  // iOS Safari: select() сам по себе выделяет не всегда.
  el.setSelectionRange(0, el.value.length);
}

interface Props {
  /** Вызывается, когда копия реально отмечена как сохранённая (для сценария «копия перед заменой»). */
  onSaved?: () => void;
}

function browserDownload(filename: string, text: string): void {
  const env = { document, URL, setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms) };
  downloadBackup(env as unknown as DownloadEnv, filename, text);
}

/**
 * Блок «Сохранить копию»: три способа и честный учёт «копия сохранена». Вся логика в BackupExportController
 * (проверяется тестами): копия готовится при открытии и после изменений, нажатия обрабатываются синхронно, а флаги
 * от двойного нажатия живут в контроллере (он создаётся один раз на блок и не пересоздаётся при отрисовках).
 */
export function BackupExport({ onSaved }: Props) {
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const [ctl] = useState(
    () =>
      new BackupExportController({
        db,
        appVersion: APP_VERSION,
        nav: typeof navigator === 'undefined' ? undefined : navigator,
        download: browserDownload,
        onSaved: () => onSavedRef.current?.(),
      }),
  );
  const state = useSyncExternalStore(ctl.subscribe, ctl.getState, ctl.getState);

  useEffect(() => {
    ctl.start();
    return () => ctl.dispose();
  }, [ctl]);

  // Номер изменения данных: новее подготовленной копии — копия устарела и соберётся заново (с паузой).
  const seq = useLiveQuery(() => readChangeSeq(db), []);
  useEffect(() => {
    if (seq !== undefined) ctl.dataChanged(seq);
  }, [ctl, seq]);

  return (
    <BackupExportView
      canShare={state.canShare}
      preparing={state.preparing}
      busy={state.busy}
      suggestAlt={state.suggestAlt}
      warnings={state.warnings}
      prepareError={state.prepareError}
      note={state.note}
      confirm={state.confirm}
      manualText={state.manualText}
      onShare={() => ctl.share()}
      onDownload={() => ctl.download()}
      onCopy={() => ctl.copy()}
      onConfirmSaved={() => void ctl.confirmSaved()}
      onDismissConfirm={() => ctl.dismissConfirm()}
      onRetryPrepare={() => ctl.retryPrepare()}
      onCopyErrorReport={() => ctl.copyErrorReport()}
    />
  );
}
