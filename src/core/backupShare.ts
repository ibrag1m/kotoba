// Способы отдать файл копии пользователю: «Поделиться», скачивание, буфер обмена.
// Браузерные объекты передаются параметрами (а не берутся глобально), поэтому всё проверяется в Node.
//
// ЧЕСТНАЯ ЛОГИКА «копия сохранена» (решает вызывающий код, здесь только исходы):
//  - «Поделиться»: promise navigator.share выполнился, значит пользователь довёл действие в меню до конца
//    (сохранил в «Файлы», отправил сообщением и т.п.): копия считается сохранённой. Если пользователь закрыл
//    меню (AbortError), копия НЕ считается сохранённой, счётчик изменений не сбрасывается.
//  - Скачивание и буфер обмена: браузер не сообщает, дошёл ли файл или текст до надёжного места
//    (iOS мог показать окно скачивания и закрыть его; текст в буфере живёт до следующего копирования).
//    Поэтому такие способы считаются сохранёнными только после явного «Да, я сохранил(а)» пользователя.

export interface ShareNavigatorLike {
  share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
  canShare?: (data: { files?: File[]; title?: string; text?: string }) => boolean;
  clipboard?: { writeText?: (text: string) => Promise<void> };
}

export type ShareOutcome =
  /** Меню закрыто после выбора действия. */
  | { kind: 'shared' }
  /** Пользователь закрыл меню, не выбрав действие. */
  | { kind: 'cancelled' }
  /** Файлы через «Поделиться» на этом устройстве не поддерживаются. */
  | { kind: 'unsupported' }
  /** Браузер требует свежего нажатия: нужно нажать кнопку ещё раз (файл уже готов). */
  | { kind: 'blocked' }
  | { kind: 'error'; message: string };

export const BACKUP_MIME = 'application/json';
/** Запасной тип: некоторые браузеры не принимают application/json в меню «Поделиться», но принимают text/plain. */
export const BACKUP_FALLBACK_MIME = 'text/plain';

export function makeBackupFile(filename: string, text: string, type: string = BACKUP_MIME): File {
  return new File([text], filename, { type });
}

/**
 * Выбирает файл для меню «Поделиться»: сначала application/json; если canShare его не принимает, тот же файл
 * (то же имя с .json) с типом text/plain. null: файлы через «Поделиться» недоступны. Вызывается ЗАРАНЕЕ (при
 * подготовке копии), чтобы в обработчике нажатия navigator.share вызывался синхронно.
 */
export function pickShareFile(nav: ShareNavigatorLike | undefined, filename: string, text: string): File | null {
  for (const type of [BACKUP_MIME, BACKUP_FALLBACK_MIME]) {
    const file = makeBackupFile(filename, text, type);
    if (canShareBackupFile(nav, file)) return file;
  }
  return null;
}

/** Можно ли отправить именно файл через меню «Поделиться». */
export function canShareBackupFile(nav: ShareNavigatorLike | undefined, file: File): boolean {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  try {
    return nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function errName(e: unknown): string {
  return typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
}

export async function shareBackup(nav: ShareNavigatorLike | undefined, file: File): Promise<ShareOutcome> {
  if (!canShareBackupFile(nav, file)) return { kind: 'unsupported' };
  try {
    // Только files: title и text на iOS заставляют меню считать содержимое «текстом» и предлагать не те действия.
    await nav!.share!({ files: [file] });
    return { kind: 'shared' };
  } catch (e) {
    const name = errName(e);
    if (name === 'AbortError') return { kind: 'cancelled' };
    if (name === 'NotAllowedError') return { kind: 'blocked' };
    if (name === 'TypeError' || name === 'NotSupportedError') return { kind: 'unsupported' };
    return { kind: 'error', message: e instanceof Error ? e.message || name : 'неизвестная ошибка' };
  }
}

export type CopyOutcome = { kind: 'copied' } | { kind: 'unavailable' } | { kind: 'failed'; message: string };

/** Копирует текст копии в буфер обмена. unavailable: API нет (нужен запасной способ с полем). */
export async function copyBackupText(nav: ShareNavigatorLike | undefined, text: string): Promise<CopyOutcome> {
  const write = nav?.clipboard?.writeText;
  if (typeof write !== 'function') return { kind: 'unavailable' };
  try {
    await write.call(nav!.clipboard, text);
    return { kind: 'copied' };
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message || errName(e) : 'неизвестная ошибка' };
  }
}

export interface DownloadEnv {
  document: {
    createElement(tag: 'a'): {
      href: string;
      download: string;
      rel: string;
      style: { display: string };
      click(): void;
      remove(): void;
    };
    body: { appendChild(node: never): unknown };
  };
  URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
  setTimeout: (fn: () => void, ms: number) => unknown;
}

/** Скачивание: Blob и ссылка с атрибутом download. Адрес освобождается через минуту. */
export function downloadBackup(env: DownloadEnv, filename: string, text: string): void {
  const blob = new Blob([text], { type: BACKUP_MIME });
  const url = env.URL.createObjectURL(blob);
  const a = env.document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  env.document.body.appendChild(a as never);
  a.click();
  a.remove();
  env.setTimeout(() => env.URL.revokeObjectURL(url), 60_000);
}
