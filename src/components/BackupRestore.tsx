import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { BACKUP_FORMAT_VERSION, BACKUP_MAX_TEXT_LENGTH, parseBackupFor, summarizeBackup } from '../core/backup';
import type { BackupFile, BackupSummary } from '../core/backup';
import { errorMessage } from '../core/errors';
import { formatDateTimeRu, plural } from '../core/format';
import { checkReplaceGate, describeMerge, hasUserData, restoreMerge, restoreReplace } from '../db/backupRepo';
import type { MergePreview, RestoreReport } from '../db/backupRepo';
import { DB_SCHEMA_VERSION, db } from '../db/db';
import { BackupExport } from './BackupExport';
import ui from '../styles/ui.module.css';
import s from './Backup.module.css';

export type RestoreMode = 'replace' | 'merge';

/**
 * Какой режим выбран сразу после проверки файла. Без текущих данных: «заменить» (это просто загрузка).
 * С данными: «добавить», КРОМЕ случая, когда все колоды и карточки файла уже есть в базе (копию, скорее всего,
 * уже загружали): тогда не выбран никакой режим, пользователь выбирает сам, а «добавить» даст дубликаты.
 */
export function defaultRestoreMode(hasExisting: boolean, merge: Pick<MergePreview, 'alreadyLoaded'>): RestoreMode | null {
  if (!hasExisting) return 'replace';
  return merge.alreadyLoaded ? null : 'merge';
}

/** Предупреждение для файла, который уже загружен целиком. */
export const ALREADY_LOADED_TEXT =
  'Эта копия уже загружена: все колоды и карточки из файла уже есть в приложении. Если добавить, получатся дубликаты (колоды с пометкой «(копия)»). Обычно такой файл загружать повторно не нужно.';

export interface LoadError {
  message: string;
  details: string[];
}

export interface PreviewData {
  summary: BackupSummary;
  sourceFormatVersion: number;
  merge: MergePreview;
  /** Есть ли в базе текущие данные (их заменит режим «Заменить всё»). */
  hasExisting: boolean;
  /** Откуда файл: имя файла или «вставленный текст». */
  source: string;
  /** Предупреждения проверки (пропущенные записи журнала и настройки): файл всё равно загружается. */
  warnings: string[];
}

export interface BackupRestoreViewProps {
  text: string;
  loadError: LoadError | null;
  preview: PreviewData | null;
  /** null: режим не выбран (копия уже загружена, выбор за пользователем). */
  mode: RestoreMode | null;
  busy: boolean;
  safetyDone: boolean;
  skipSafety: boolean;
  restoreError: string | null;
  report: RestoreReport | null;
  onText: (v: string) => void;
  onCheckText: () => void;
  onFile: (e: ChangeEvent<HTMLInputElement>) => void;
  onMode: (m: RestoreMode) => void;
  onSkipSafety: (v: boolean) => void;
  onSafetySaved: () => void;
  onRestore: () => void;
  onCancel: () => void;
}

const n = (v: number, one: string, few: string, many: string) => `${v} ${plural(v, one, few, many)}`;

/** Сводка по-русски: «колод 2, карточек 4, журнал 5». */
export function summaryLine(sum: Pick<BackupSummary, 'decks' | 'cards' | 'reviews'>): string {
  return `колод: ${sum.decks}, карточек: ${sum.cards}, записей журнала: ${sum.reviews}`;
}

export function reportText(r: RestoreReport): string {
  if (r.mode === 'replace') {
    return `Готово: данные заменены. Восстановлено: ${summaryLine(r)}.`;
  }
  const reid =
    r.reidDecks + r.reidCards > 0
      ? ` Из-за совпадения номеров новые номера получили: колод ${r.reidDecks}, карточек ${r.reidCards}; такие колоды помечены «(копия)».`
      : '';
  return `Готово: добавлено ${summaryLine(r)}. Прежние данные не тронуты.${reid}`;
}

/** Внешний вид блока восстановления. Без базы и браузерных API: проверяется серверной отрисовкой. */
export function BackupRestoreView(p: BackupRestoreViewProps) {
  if (p.report) {
    return (
      <div className={s.inner}>
        <p className={`${s.note} ${s.noteOk}`} role="status">
          {reportText(p.report)}
        </p>
        <button type="button" className={ui.btn} onClick={p.onCancel}>
          Загрузить ещё одну копию
        </button>
      </div>
    );
  }

  if (!p.preview) {
    return (
      <div className={s.inner}>
        <label className={`${ui.btn} ${s.fileLabel}`}>
          Выбрать файл копии
          <input
            type="file"
            className={s.fileInput}
            accept="application/json,.json,text/plain,.txt"
            onChange={p.onFile}
            disabled={p.busy}
            aria-label="Выбрать файл резервной копии"
          />
        </label>
        <label className={ui.field}>
          <span className={ui.label}>Или вставьте текст копии</span>
          <textarea
            className={ui.textarea}
            value={p.text}
            onChange={(e) => p.onText(e.target.value)}
            placeholder='{"app": "kotoba", ...'
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={p.busy}
          />
        </label>
        <button type="button" className={`${ui.btn} ${ui.primary}`} disabled={p.busy || p.text.trim() === ''} onClick={p.onCheckText}>
          Проверить вставленный текст
        </button>
        <p className={ui.hint}>Сначала файл полностью проверяется, ничего не меняется. Загрузка начнётся только после вашего подтверждения.</p>
        {p.loadError && (
          <div className={`${s.note} ${s.noteError}`} role="alert">
            <p>{p.loadError.message}</p>
            <p>Ваши данные не изменились.</p>
            {p.loadError.details.length > 0 && (
              <ul className={s.details}>
                {p.loadError.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  }

  const { summary, merge, hasExisting } = p.preview;
  const replaceBlocked = p.mode === 'replace' && hasExisting && !p.safetyDone && !p.skipSafety;
  return (
    <div className={s.inner}>
      <div className={`${s.note} ${s.noteOk}`} role="status">
        <p>Файл проверен и подходит: {p.preview.source}.</p>
      </div>
      <dl className={s.facts}>
        <dt>В копии</dt>
        <dd>{summaryLine(summary)}</dd>
        <dt>Копия создана</dt>
        <dd>
          {formatDateTimeRu(summary.exportedAt)} (версия приложения {summary.appVersion})
        </dd>
      </dl>
      {p.preview.warnings.map((w) => (
        <p key={w} className={`${s.note} ${s.noteWarn}`} role="status">
          {w}
        </p>
      ))}
      {p.preview.sourceFormatVersion < BACKUP_FORMAT_VERSION && (
        <p className={ui.hint}>Файл в старом формате ({p.preview.sourceFormatVersion}), он будет преобразован автоматически.</p>
      )}

      {merge.alreadyLoaded && (
        <p className={`${s.note} ${s.noteWarn}`} role="status">
          {ALREADY_LOADED_TEXT}
        </p>
      )}

      <fieldset className={`${s.inner} ${s.fieldset}`}>
        <legend className={ui.label}>Что сделать</legend>
        <label className={`${s.choice} ${p.mode === 'merge' ? s.choiceOn : ''}`}>
          <input type="radio" name="restore-mode" checked={p.mode === 'merge'} onChange={() => p.onMode('merge')} />
          <span className={s.choiceText}>
            <span className={s.choiceTitle}>Добавить к существующим</span>
            <span className={ui.hint}>
              Ничего не удаляется и не перезаписывается.
              {merge.alreadyLoaded
                ? ' Все записи файла уже есть: добавятся дубликаты.'
                : merge.conflictDecks + merge.conflictCards > 0
                ? ` Совпадающие по номеру записи (${n(merge.conflictDecks, 'колода', 'колоды', 'колод')}, ${n(merge.conflictCards, 'карточка', 'карточки', 'карточек')}) добавятся как копии с новыми номерами.`
                : ' Совпадений с текущими данными нет.'}
            </span>
          </span>
        </label>
        <label className={`${s.choice} ${p.mode === 'replace' ? s.choiceOn : ''}`}>
          <input type="radio" name="restore-mode" checked={p.mode === 'replace'} onChange={() => p.onMode('replace')} />
          <span className={s.choiceText}>
            <span className={s.choiceTitle}>Заменить всё</span>
            <span className={ui.hint}>
              {hasExisting
                ? 'Все текущие колоды, карточки и журнал будут удалены и заменены содержимым файла. Всё или ничего: при сбое ничего не изменится.'
                : 'Текущих данных нет, файл просто загрузится. Всё или ничего: при сбое ничего не изменится.'}
            </span>
          </span>
        </label>
      </fieldset>

      {p.mode === 'replace' && hasExisting && (
        <div className={`${s.note} ${s.noteWarn}`}>
          <p className={ui.label}>Сначала сохраните копию текущих данных</p>
          <p>Замену нельзя отменить. Сохраните копию того, что есть сейчас: если файл окажется не тем, вы всё вернёте.</p>
          <BackupExport onSaved={p.onSafetySaved} />
          {p.safetyDone ? (
            <p className={`${s.note} ${s.noteOk}`}>Копия текущих данных сохранена, можно заменять.</p>
          ) : (
            <label className={s.check}>
              <input type="checkbox" checked={p.skipSafety} onChange={(e) => p.onSkipSafety(e.target.checked)} />
              <span>Продолжить без копии текущих данных: я понимаю, что они будут удалены безвозвратно</span>
            </label>
          )}
        </div>
      )}

      {p.restoreError && (
        <p className={`${s.note} ${s.noteError}`} role="alert">
          {p.restoreError}
        </p>
      )}

      <div className={s.stack}>
        <button
          type="button"
          className={`${ui.btn} ${p.mode === 'replace' ? ui.danger : p.mode === 'merge' ? ui.primary : ''}`}
          disabled={p.busy || replaceBlocked || p.mode === null}
          onClick={p.onRestore}
        >
          {p.busy
            ? 'Загружаю…'
            : p.mode === null
              ? 'Сначала выберите, что сделать'
              : p.mode === 'replace'
                ? 'Заменить всё данными из файла'
                : 'Добавить данные из файла'}
        </button>
        <button type="button" className={ui.btn} disabled={p.busy} onClick={p.onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}

/** Блок восстановления: выбор файла или вставка текста, проверка, предпросмотр, подтверждение. */
export function BackupRestore() {
  const [text, setText] = useState('');
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [backup, setBackup] = useState<BackupFile | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [mode, setMode] = useState<RestoreMode | null>('merge');
  const [busy, setBusy] = useState(false);
  const [safetyDone, setSafetyDone] = useState(false);
  const [skipSafety, setSkipSafety] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);

  function resetAll() {
    setText('');
    setLoadError(null);
    setBackup(null);
    setPreview(null);
    setMode('merge');
    setSafetyDone(false);
    setSkipSafety(false);
    setRestoreError(null);
    setReport(null);
  }

  /** Полная проверка текста и подготовка предпросмотра. В базу ничего не пишет. */
  async function check(input: string, source: string) {
    setBusy(true);
    setLoadError(null);
    try {
      const r = parseBackupFor(input, DB_SCHEMA_VERSION);
      if (!r.ok) {
        setLoadError({ message: r.message, details: r.details });
        return;
      }
      const [hasExisting, merge] = await Promise.all([hasUserData(db), describeMerge(db, r.backup)]);
      setBackup(r.backup);
      setMode(defaultRestoreMode(hasExisting, merge));
      setSafetyDone(false);
      setSkipSafety(false);
      setRestoreError(null);
      setPreview({
        summary: summarizeBackup(r.backup),
        sourceFormatVersion: r.sourceFormatVersion,
        merge,
        hasExisting,
        source,
        warnings: r.warnings,
      });
    } catch (e) {
      setLoadError({ message: `Не удалось проверить файл: ${errorMessage(e)}`, details: [] });
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = ''; // чтобы тот же файл можно было выбрать повторно
    if (!file) return;
    if (file.size > BACKUP_MAX_TEXT_LENGTH) {
      setLoadError({ message: 'Файл слишком большой для резервной копии Kotoba. Возможно, выбран не тот файл.', details: [] });
      return;
    }
    let content: string;
    try {
      content = await file.text();
    } catch (err) {
      setLoadError({ message: `Не удалось прочитать файл «${file.name}»: ${errorMessage(err)}`, details: [] });
      return;
    }
    await check(content, `файл «${file.name}»`);
  }

  async function onRestore() {
    if (!backup || busy || mode === null) return;
    setBusy(true);
    setRestoreError(null);
    try {
      if (mode === 'replace') {
        // Есть ли данные, читаем из базы ПРЯМО СЕЙЧАС (не из предпросмотра): за время чтения сводки они могли появиться.
        const opts = { safetyDone, skipSafety };
        let gate = await checkReplaceGate(db, opts);
        if (gate.kind === 'confirm') {
          if (!window.confirm('Все текущие колоды, карточки и журнал будут удалены и заменены данными из файла. Продолжить?')) return;
          // Пока открыт вопрос, данные тоже могли измениться: последняя проверка перед самой заменой.
          gate = await checkReplaceGate(db, opts);
        }
        if (gate.kind === 'need-safety') {
          setPreview((pv) => (pv ? { ...pv, hasExisting: true } : pv));
          setRestoreError(
            'В приложении появились данные, которых не было при проверке файла. Замена остановлена. Сначала сохраните копию текущих данных (или отметьте, что продолжаете без неё), затем повторите.',
          );
          return;
        }
      }
      const rep = mode === 'replace' ? await restoreReplace(db, backup) : await restoreMerge(db, backup);
      setReport(rep);
    } catch (e) {
      console.error('Восстановление не удалось', e);
      setRestoreError(`Не удалось загрузить данные. Ничего не изменилось, ваши данные остались как были. Можно попробовать ещё раз. (${errorMessage(e)})`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <BackupRestoreView
      text={text}
      loadError={loadError}
      preview={preview}
      mode={mode}
      busy={busy}
      safetyDone={safetyDone}
      skipSafety={skipSafety}
      restoreError={restoreError}
      report={report}
      onText={setText}
      onCheckText={() => void check(text, 'вставленный текст')}
      onFile={(e) => void onFile(e)}
      onMode={(m) => {
        setMode(m);
        setRestoreError(null);
      }}
      onSkipSafety={setSkipSafety}
      onSafetySaved={() => setSafetyDone(true)}
      onRestore={() => void onRestore()}
      onCancel={resetAll}
    />
  );
}
