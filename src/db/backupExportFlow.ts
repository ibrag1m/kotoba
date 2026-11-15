// Логика экрана «Сохранить копию» без React: подготовка снимка заранее, обработчики нажатий, учёт «копия сохранена».
// Вынесена из компонента, чтобы проверяться тестами без браузера (fake-indexeddb и подделки navigator).
//
// Почему снимок готовится ЗАРАНЕЕ. На iPhone navigator.share (и запись в буфер обмена) требуют «свежего жеста»
// пользователя. Если после нажатия сначала асинхронно собирать копию (чтение базы, проверка, сборка файла), жест
// успевает «протухнуть», и браузер отвечает NotAllowedError. Поэтому копия собирается при открытии экрана и после
// каждого изменения данных (с паузой), а обработчик нажатия вызывает navigator.share СИНХРОННО, до любого await.
// Пока копия не готова, кнопки в состоянии «Готовлю копию…» и нажатие ничего не делает.
//
// Честная логика «копия сохранена» (см. backupShare.ts): «Поделиться» отмечает копию сохранённой только когда меню
// довели до конца; скачивание и буфер обмена: только после явного «Да, сохранил(а)».
import { copyBackupText, pickShareFile } from '../core/backupShare';
import type { CopyOutcome, ShareNavigatorLike } from '../core/backupShare';
import { errorMessage } from '../core/errors';
import { plural } from '../core/format';
import { BackupSnapshotError, createBackupSnapshot, markBackupSaved, shareSnapshot } from './backupRepo';
import type { BackupSnapshot } from './backupRepo';
import type { KotobaDB } from './db';

export type NoteKind = 'ok' | 'warn' | 'error' | 'info';
export interface Note {
  kind: NoteKind;
  text: string;
  /** Подробности (первые пункты проблемы). */
  details?: string[];
}

/** Ожидает подтверждения пользователя: браузер не может сам узнать, что файл или текст дошёл до надёжного места. */
export interface PendingConfirm {
  via: 'download' | 'copy' | 'manual';
  snap: BackupSnapshot;
}

export interface ExportState {
  /** Меню «Поделиться» с файлом доступно на этом устройстве. */
  canShare: boolean;
  /** Копия готовится (или ждёт паузы после изменений): кнопки в состоянии «Готовлю копию…». */
  preparing: boolean;
  /** Идёт действие (меню «Поделиться», буфер обмена, подтверждение). */
  busy: boolean;
  /** Браузер дважды подряд отказал в «Поделиться»: предложить скачивание или копирование текстом. */
  suggestAlt: boolean;
  /** Предупреждения о готовой копии (например, сколько записей журнала не вошло в неё). */
  warnings: string[];
  /** Копию не удалось собрать: причина и подробности. */
  prepareError: Note | null;
  note: Note | null;
  confirm: PendingConfirm | null;
  /** Текст для ручного копирования (если буфер обмена недоступен). */
  manualText: string | null;
}

export interface ExportDeps {
  db: KotobaDB;
  appVersion: string;
  nav: ShareNavigatorLike | undefined;
  /** Скачивание файла (браузер: ссылка с download). */
  download: (filename: string, text: string) => void;
  /** Вызывается, когда копия реально отмечена как сохранённая. */
  onSaved?: () => void;
  /** Подмена для тестов. */
  createSnapshot?: (db: KotobaDB, appVersion: string, now: number) => Promise<BackupSnapshot>;
  now?: () => number;
  /** Пауза после изменения данных перед повторной подготовкой, мс. */
  debounceMs?: number;
}

interface Prepared {
  snap: BackupSnapshot;
  /** Файл для «Поделиться» (application/json или запасной text/plain); null: файлы не поддерживаются. */
  shareFile: File | null;
}

interface Local {
  canShare: boolean;
  busy: boolean;
  suggestAlt: boolean;
  note: Note | null;
  confirm: PendingConfirm | null;
  manualText: string | null;
}

const summaryText = (snap: BackupSnapshot): string => {
  const c = snap.file.cards.length;
  const d = snap.file.decks.length;
  return `${d} ${plural(d, 'колода', 'колоды', 'колод')}, ${c} ${plural(c, 'карточка', 'карточки', 'карточек')}`;
};

export const DEFAULT_DEBOUNCE_MS = 700;

export class BackupExportController {
  private readonly deps: ExportDeps;
  private local: Local;
  private prepared: Prepared | null = null;
  private failed: Error | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private knownSeq: number | null = null;
  private shareBlocked = 0;
  /** Синхронные флаги от двойного нажатия: ставятся ДО любой асинхронной работы. */
  private actionLock = false;
  private confirmLock = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private state: ExportState;

  constructor(deps: ExportDeps) {
    this.deps = deps;
    this.local = {
      canShare: pickShareFile(deps.nav, 'probe.json', '{}') !== null,
      busy: false,
      suggestAlt: false,
      note: null,
      confirm: null,
      manualText: null,
    };
    this.state = this.compute();
  }

  // --- подписка (для useSyncExternalStore) ---

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): ExportState => this.state;

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private ready(): Prepared | null {
    const p = this.prepared;
    if (!p || this.failed) return null;
    // Снимок годится, пока в базе нет изменений новее него.
    if (this.knownSeq !== null && p.snap.seq < this.knownSeq) return null;
    return p;
  }

  private compute(): ExportState {
    const failed = this.failed;
    return {
      canShare: this.local.canShare,
      preparing: failed === null && this.ready() === null,
      busy: this.local.busy,
      suggestAlt: this.local.suggestAlt,
      warnings: this.prepared && !failed ? this.prepared.snap.warnings : [],
      prepareError: failed ? failureNote(failed) : null,
      note: this.local.note,
      confirm: this.local.confirm,
      manualText: this.local.manualText,
    };
  }

  private publish(): void {
    this.state = this.compute();
    if (this.disposed) return;
    for (const l of [...this.listeners]) l();
  }

  private patch(p: Partial<Local>): void {
    this.local = { ...this.local, ...p };
    this.publish();
  }

  // --- подготовка снимка ---

  /** Начать работу (открытие экрана): готовим копию сразу. Повторный вызов безвреден. */
  start(): void {
    this.disposed = false;
    void this.prepare();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Номер изменения данных из базы: если он новее подготовленного снимка, снимок устарел и будет собран заново. */
  dataChanged(seq: number): void {
    this.knownSeq = seq;
    const p = this.prepared;
    if (p && !this.failed && p.snap.seq >= seq) {
      this.publish();
      return;
    }
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.prepare();
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.publish();
  }

  /**
   * Собирает копию. Параллельные вызовы (двойное нажатие, повторные события) делят ОДНУ подготовку:
   * снимок создаётся один раз.
   */
  prepare(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.failed = null;
    this.publish();
    const create = this.deps.createSnapshot ?? createBackupSnapshot;
    const run = (async () => {
      try {
        const snap = await create(this.deps.db, this.deps.appVersion, this.now());
        this.prepared = { snap, shareFile: pickShareFile(this.deps.nav, snap.filename, snap.text) };
        this.failed = null;
      } catch (e) {
        console.error('Не удалось подготовить копию', e);
        this.prepared = null;
        this.failed = e instanceof Error ? e : new Error(errorMessage(e));
      } finally {
        this.inFlight = null;
      }
      this.publish();
      // Пока собирали, данные могли измениться снова: готовим заново (с паузой).
      const p = this.prepared as Prepared | null;
      if (p && this.knownSeq !== null && p.snap.seq < this.knownSeq) this.scheduleRefresh();
    })();
    this.inFlight = run;
    return run;
  }

  // --- обработчики нажатий (СИНХРОННЫЕ до обращения к браузеру) ---

  /** «Поделиться»: navigator.share вызывается синхронно, из подготовленного снимка. */
  share(): void {
    if (this.actionLock) return;
    const p = this.ready();
    if (!p) return;
    if (!p.shareFile) {
      this.patch({
        canShare: false,
        note: { kind: 'warn', text: 'Это устройство не принимает файл в меню «Поделиться». Используйте «Скачать файл» или «Скопировать текстом».' },
      });
      return;
    }
    this.actionLock = true;
    const snap = p.snap;
    // Первым делом, без await: жест пользователя ещё свежий.
    const pending = shareSnapshot(this.deps.db, this.deps.nav, snap, p.shareFile, this.now());
    this.patch({ busy: true, note: null, confirm: null, manualText: null });
    void pending
      .then(
        (outcome) => {
          switch (outcome.kind) {
            case 'shared':
              this.shareBlocked = 0;
              this.patch({
                suggestAlt: false,
                note: {
                  kind: 'ok',
                  text: `Меню «Поделиться» закрыто после выбора действия, копия (${summaryText(snap)}) записана как сохранённая. Проверьте, что файл лежит там, куда вы его отправили (например, в «Файлах»).`,
                },
              });
              this.deps.onSaved?.();
              break;
            case 'cancelled':
              this.shareBlocked = 0;
              this.patch({ note: { kind: 'warn', text: 'Вы закрыли меню, не выбрав действие. Копия НЕ сохранена, счётчик изменений не сброшен.' } });
              break;
            case 'blocked':
              this.shareBlocked++;
              if (this.shareBlocked >= 2) {
                this.patch({
                  suggestAlt: true,
                  note: {
                    kind: 'warn',
                    text: 'Браузер дважды отказался открыть меню «Поделиться». Скачайте файл или скопируйте копию текстом: так надёжнее. Копия пока НЕ сохранена.',
                  },
                });
              } else {
                // Запасной путь: копия уже готова, повторное нажатие откроет меню сразу.
                this.patch({ note: { kind: 'warn', text: 'Браузер не открыл меню «Поделиться». Нажмите кнопку ещё раз. Копия пока НЕ сохранена.' } });
              }
              break;
            case 'unsupported':
              this.patch({
                canShare: false,
                note: { kind: 'warn', text: 'Это устройство не принимает файл в меню «Поделиться». Используйте «Скачать файл» или «Скопировать текстом».' },
              });
              break;
            case 'error':
              this.patch({ note: { kind: 'error', text: `Не удалось открыть меню «Поделиться»: ${outcome.message}. Копия НЕ сохранена.` } });
              break;
          }
        },
        (e: unknown) => {
          // Меню довели до конца, но отметить копию в базе не удалось.
          this.patch({
            note: { kind: 'error', text: `Не удалось отметить копию как сохранённую: ${errorMessage(e)}. Файл при этом мог быть сохранён.` },
          });
        },
      )
      .finally(() => {
        this.actionLock = false;
        this.patch({ busy: false });
      });
  }

  /** «Скачать файл»: из подготовленного снимка, синхронно. Копия НЕ считается сохранённой до подтверждения. */
  download(): void {
    if (this.actionLock) return;
    const p = this.ready();
    if (!p) return;
    // Скачивание уже запущено и ждёт ответа «сохранил(а)»: двойное нажатие не создаёт второй файл.
    const pending = this.local.confirm;
    if (pending && pending.via === 'download' && pending.snap === p.snap) return;
    try {
      this.deps.download(p.snap.filename, p.snap.text);
      this.patch({
        confirm: { via: 'download', snap: p.snap },
        manualText: null,
        note: { kind: 'info', text: `Скачивание запущено: ${p.snap.filename} (${summaryText(p.snap)}).` },
      });
    } catch (e) {
      this.patch({
        confirm: null,
        note: { kind: 'error', text: `Не удалось скачать файл: ${errorMessage(e)}. Копия НЕ сохранена. Попробуйте «Скопировать текстом».` },
      });
    }
  }

  /** «Скопировать текстом»: запись в буфер вызывается синхронно. Копия НЕ считается сохранённой до подтверждения. */
  copy(): void {
    if (this.actionLock) return;
    const p = this.ready();
    if (!p) return;
    this.actionLock = true;
    const pending = copyBackupText(this.deps.nav, p.snap.text);
    this.patch({ busy: true, note: null, confirm: null });
    void pending
      .then((outcome: CopyOutcome) => {
        if (outcome.kind === 'copied') {
          this.patch({
            manualText: null,
            confirm: { via: 'copy', snap: p.snap },
            note: { kind: 'info', text: `Текст скопирован в буфер обмена (${summaryText(p.snap)}).` },
          });
        } else {
          // Буфер недоступен или отказал: показываем текст в поле, его можно скопировать руками.
          this.patch({
            manualText: p.snap.text,
            confirm: { via: 'manual', snap: p.snap },
            note: {
              kind: 'warn',
              text:
                outcome.kind === 'failed'
                  ? `Буфер обмена не сработал (${outcome.message}). Текст показан ниже, скопируйте его вручную.`
                  : 'Буфер обмена недоступен. Текст показан ниже, скопируйте его вручную.',
            },
          });
        }
      })
      .finally(() => {
        this.actionLock = false;
        this.patch({ busy: false });
      });
  }

  /** «Да, сохранил(а)»: единственное, что отмечает скачанный или скопированный текст как сохранённый. */
  async confirmSaved(): Promise<void> {
    const c = this.local.confirm;
    if (!c || this.confirmLock) return;
    this.confirmLock = true;
    try {
      await markBackupSaved(this.deps.db, c.snap, this.now());
      this.patch({
        confirm: null,
        manualText: null,
        note: { kind: 'ok', text: `Готово: копия (${summaryText(c.snap)}) отмечена как сохранённая.` },
      });
      this.deps.onSaved?.();
    } catch (e) {
      this.patch({ note: { kind: 'error', text: `Не удалось отметить копию как сохранённую: ${errorMessage(e)}` } });
    } finally {
      this.confirmLock = false;
    }
  }

  /** «Ещё нет»: ничего не отмечается, счётчик изменений не сбрасывается. */
  dismissConfirm(): void {
    this.patch({ confirm: null, note: { kind: 'warn', text: 'Копия не отмечена как сохранённая. Счётчик изменений не сброшен.' } });
  }

  /** После сбоя подготовки: попробовать снова. */
  retryPrepare(): void {
    void this.prepare();
  }

  /** Текст сведений об ошибке копии: его можно скопировать и показать разработчику. */
  errorReport(): string | null {
    return this.failed ? failureReport(this.failed, this.deps.appVersion) : null;
  }

  /** Копирует сведения об ошибке в буфер обмена (синхронный вызов из обработчика). */
  copyErrorReport(): void {
    const text = this.errorReport();
    if (text === null) return;
    void copyBackupText(this.deps.nav, text).then((o) => {
      this.patch({
        note:
          o.kind === 'copied'
            ? { kind: 'info', text: 'Сведения об ошибке скопированы в буфер обмена.' }
            : { kind: 'warn', text: 'Не удалось скопировать сведения. Перепишите текст ошибки вручную.' },
      });
    });
  }
}

function failureNote(e: Error): Note {
  const details = e instanceof BackupSnapshotError ? e.details : [];
  const text = e instanceof BackupSnapshotError ? e.message : `Не удалось собрать копию: ${errorMessage(e)}. Данные не изменены.`;
  const note: Note = { kind: 'error', text };
  if (details.length > 0) note.details = details;
  return note;
}

function failureReport(e: Error, appVersion: string): string {
  const n = failureNote(e);
  return [`Kotoba ${appVersion}: ${n.text}`, ...(n.details ?? []).map((d) => `- ${d}`)].join('\n');
}
