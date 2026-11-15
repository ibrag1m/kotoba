// Интерфейс резервной копии без браузера: серверная отрисовка React в строку (как в components.test.ts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BackupBannerView } from './BackupBanner';
import { BackupExportView } from './BackupExport';
import type { BackupExportViewProps } from './BackupExport';
import { ALREADY_LOADED_TEXT, BackupRestoreView, defaultRestoreMode, reportText, summaryLine } from './BackupRestore';
import type { BackupRestoreViewProps, PreviewData } from './BackupRestore';
import { BackupStatus, StorageBlock } from '../screens/SettingsScreen';
import type { BackupSnapshot } from '../db/backupRepo';

const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const noop = () => {};

describe('баннер напоминания', () => {
  it('текст по причине, ссылка в настройки и кнопка «Напомнить позже»', () => {
    const out = html(createElement(BackupBannerView, { status: { show: true, reason: 'age', daysSince: 9 }, changes: 0, onSnooze: noop }));
    expect(out).toContain('Последняя копия была 9 дн. назад');
    expect(out).toContain('href="/settings"');
    expect(out).toContain('Сохранить копию');
    expect(out).toContain('Напомнить позже');
    expect(out).toContain('type="button"');
    const byChanges = html(createElement(BackupBannerView, { status: { show: true, reason: 'changes', daysSince: 1 }, changes: 52, onSnooze: noop }));
    expect(byChanges).toContain('52 изменения');
  });
});

const baseExport: BackupExportViewProps = {
  canShare: true,
  preparing: false,
  busy: false,
  suggestAlt: false,
  warnings: [],
  prepareError: null,
  note: null,
  confirm: null,
  manualText: null,
  onShare: noop,
  onDownload: noop,
  onCopy: noop,
  onConfirmSaved: noop,
  onDismissConfirm: noop,
  onRetryPrepare: noop,
  onCopyErrorReport: noop,
};

describe('экспорт: три способа', () => {
  it('когда «Поделиться» доступно: три кнопки', () => {
    const out = html(createElement(BackupExportView, baseExport));
    expect(out).toContain('Поделиться (сохранить в «Файлы»)');
    expect(out).toContain('Скачать файл');
    expect(out).toContain('Скопировать текстом');
    expect(out).not.toContain('недоступно');
  });

  it('когда «Поделиться» доступно: объяснено, что откроется и где искать файл', () => {
    const out = html(createElement(BackupExportView, baseExport));
    expect(out).toContain('Откроется меню «Поделиться». Выберите «Сохранить в Файлы»');
    expect(out).toContain('«Файлы» → «На iPhone»');
    expect(out).toContain('iCloud Drive');
    const unavailable = html(createElement(BackupExportView, { ...baseExport, canShare: false }));
    expect(unavailable).not.toContain('Откроется меню');
  });

  it('когда файлы через «Поделиться» недоступны: кнопки нет, есть пояснение', () => {
    const out = html(createElement(BackupExportView, { ...baseExport, canShare: false }));
    expect(out).not.toContain('Поделиться (сохранить');
    expect(out).toContain('Меню «Поделиться» с файлом на этом устройстве недоступно');
    expect(out).toContain('Скачать файл');
  });

  it('пока способ не определён, кнопка «Поделиться» заблокирована', () => {
    const out = html(createElement(BackupExportView, { ...baseExport, canShare: null }));
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Поделиться/);
  });

  it('«нажмите ещё раз» больше не основной путь: подпись кнопки одна и та же, пока копия готова', () => {
    const out = html(createElement(BackupExportView, baseExport));
    expect(out).not.toContain('нажмите ещё раз');
    expect(out).toContain('Поделиться (сохранить в «Файлы»)');
  });

  it('пока копия готовится: все три кнопки «Готовлю копию…» и заблокированы', () => {
    const out = html(createElement(BackupExportView, { ...baseExport, preparing: true }));
    expect((out.match(/Готовлю копию…/g) ?? []).length).toBe(3);
    expect((out.match(/disabled/g) ?? []).length).toBe(3);
    expect(out).not.toContain('Поделиться (сохранить');
    expect(out).not.toContain('Скачать файл');
  });

  it('после второго отказа браузера основной способ: скачивание', () => {
    const normal = html(createElement(BackupExportView, baseExport));
    expect(normal).toMatch(/class="[^"]*primary[^"]*"[^>]*>Поделиться/);
    const alt = html(createElement(BackupExportView, { ...baseExport, suggestAlt: true }));
    expect(alt).toMatch(/class="[^"]*primary[^"]*"[^>]*>Скачать файл/);
    expect(alt).not.toMatch(/class="[^"]*primary[^"]*"[^>]*>Поделиться/);
  });

  it('предупреждения о копии (сиротские записи журнала) показываются', () => {
    const out = html(createElement(BackupExportView, { ...baseExport, warnings: ['2 записи журнала без карточки не вошли в копию.'] }));
    expect(out).toContain('2 записи журнала без карточки не вошли в копию.');
    expect(out).toContain('role="status"');
  });

  it('копию собрать не удалось: причина, подробности, «Попробовать ещё раз», «Скопировать сведения», кнопки заблокированы', () => {
    const out = html(
      createElement(BackupExportView, {
        ...baseExport,
        prepareError: { kind: 'error', text: 'Не удалось собрать надёжную копию: нарушены связи. Данные не изменены.', details: ['Запись журнала 1 относится к другой колоде'] },
      }),
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain('Не удалось собрать надёжную копию');
    expect(out).toContain('Запись журнала 1 относится к другой колоде');
    expect(out).toContain('Попробовать ещё раз');
    expect(out).toContain('Скопировать сведения об ошибке');
    expect((out.match(/<button[^>]*disabled/g) ?? []).length).toBe(3);
  });

  const snap = { filename: 'kotoba-backup-2026-11-14-2015.json' } as BackupSnapshot;

  it('скачивание и буфер: копия НЕ считается сохранённой без подтверждения, видны оба ответа', () => {
    for (const via of ['download', 'copy', 'manual'] as const) {
      const out = html(createElement(BackupExportView, { ...baseExport, confirm: { via, snap } }));
      expect(out).toContain('Вы сохранили копию в надёжное место?');
      expect(out).toContain('Да, сохранил(а)');
      expect(out).toContain('Ещё нет');
      expect(out).toMatch(/не может проверить|само этого не знает/);
    }
  });

  it('запасное поле с текстом: только чтение, без автоисправлений, подпись', () => {
    const out = html(createElement(BackupExportView, { ...baseExport, manualText: '{"app":"kotoba"}' }));
    expect(out).toContain('<textarea');
    expect(out).toContain('readOnly');
    expect(out).toContain('autoCapitalize="off"');
    expect(out).toContain('spellCheck="false"');
    expect(out).toContain('Текст копии для ручного копирования');
    expect(out).toContain('{&quot;app&quot;:&quot;kotoba&quot;}');
  });

  it('сообщения: ошибка с role=alert, остальные role=status', () => {
    const err = html(createElement(BackupExportView, { ...baseExport, note: { kind: 'error', text: 'сломалось' } }));
    expect(err).toContain('role="alert"');
    const warn = html(createElement(BackupExportView, { ...baseExport, note: { kind: 'warn', text: 'Копия НЕ сохранена' } }));
    expect(warn).toContain('role="status"');
    expect(warn).toContain('Копия НЕ сохранена');
  });

  it('во время работы кнопки заблокированы', () => {
    const out = html(createElement(BackupExportView, { ...baseExport, busy: true }));
    expect((out.match(/disabled/g) ?? []).length).toBe(3);
  });
});

const preview: PreviewData = {
  summary: { decks: 2, cards: 40, reviews: 7, exportedAt: Date.UTC(2026, 10, 3, 12, 0, 0), appVersion: '0.1.0', formatVersion: 1, dbSchemaVersion: 1 },
  sourceFormatVersion: 1,
  merge: { conflictDecks: 1, conflictCards: 3, alreadyLoaded: false },
  hasExisting: true,
  source: 'файл «kotoba-backup-2026-11-03-1200.json»',
  warnings: [],
};

const baseRestore: BackupRestoreViewProps = {
  text: '',
  loadError: null,
  preview: null,
  mode: 'merge',
  busy: false,
  safetyDone: false,
  skipSafety: false,
  restoreError: null,
  report: null,
  onText: noop,
  onCheckText: noop,
  onFile: noop,
  onMode: noop,
  onSkipSafety: noop,
  onSafetySaved: noop,
  onRestore: noop,
  onCancel: noop,
};

describe('восстановление: ввод', () => {
  it('выбор файла и вставка текста; шрифт поля не меньше 16px задан глобально', () => {
    const out = html(createElement(BackupRestoreView, baseRestore));
    expect(out).toContain('type="file"');
    expect(out).toContain('accept="application/json,.json,text/plain,.txt"');
    expect(out).toContain('Выбрать файл копии');
    expect(out).toContain('Или вставьте текст копии');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Проверить вставленный текст/);
    expect(out).toContain('ничего не меняется');
    const filled = html(createElement(BackupRestoreView, { ...baseRestore, text: '{}' }));
    expect(filled).not.toMatch(/<button[^>]*disabled[^>]*>Проверить вставленный текст/);
  });

  it('ошибка проверки: понятный текст, «данные не изменились», подробности', () => {
    const out = html(
      createElement(BackupRestoreView, {
        ...baseRestore,
        loadError: { message: 'Это не файл копии Kotoba', details: ['Карточка 3 («水») ссылается на несуществующую колоду'] },
      }),
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain('Это не файл копии Kotoba');
    expect(out).toContain('Ваши данные не изменились');
    expect(out).toContain('ссылается на несуществующую колоду');
  });
});

describe('восстановление: предпросмотр и подтверждение', () => {
  it('сводка: колоды, карточки, журнал, дата создания', () => {
    const out = html(createElement(BackupRestoreView, { ...baseRestore, preview }));
    expect(out).toContain('колод: 2, карточек: 40, записей журнала: 7');
    expect(out).toContain('3 ноября 2026');
    expect(out).toContain('версия приложения 0.1.0');
    expect(out).toContain('Файл проверен и подходит');
    expect(summaryLine(preview.summary)).toBe('колод: 2, карточек: 40, записей журнала: 7');
  });

  it('режим «добавить»: объясняет конфликты, кнопка «Добавить данные из файла»', () => {
    const out = html(createElement(BackupRestoreView, { ...baseRestore, preview, mode: 'merge' }));
    expect(out).toContain('Ничего не удаляется и не перезаписывается');
    expect(out).toContain('1 колода, 3 карточки');
    expect(out).toContain('Добавить данные из файла');
    expect(out).not.toContain('Сначала сохраните копию текущих данных');
  });

  it('режим «заменить» при наличии данных: сначала копия текущих данных, кнопка заблокирована', () => {
    const out = html(createElement(BackupRestoreView, { ...baseRestore, preview, mode: 'replace' }));
    expect(out).toContain('Сначала сохраните копию текущих данных');
    expect(out).toContain('Готовлю копию…'); // встроенный блок экспорта (в серверной отрисовке копия ещё не готова)
    expect(out).toContain('Продолжить без копии текущих данных');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Заменить всё данными из файла/);
  });

  it('кнопка «Заменить всё» открывается после копии текущих данных или явного отказа от неё', () => {
    const afterSafety = html(createElement(BackupRestoreView, { ...baseRestore, preview, mode: 'replace', safetyDone: true }));
    expect(afterSafety).not.toMatch(/<button[^>]*disabled[^>]*>Заменить всё данными из файла/);
    expect(afterSafety).toContain('Копия текущих данных сохранена');
    const skipped = html(createElement(BackupRestoreView, { ...baseRestore, preview, mode: 'replace', skipSafety: true }));
    expect(skipped).not.toMatch(/<button[^>]*disabled[^>]*>Заменить всё данными из файла/);
  });

  it('замена в пустую базу: предупреждения о потере нет', () => {
    const out = html(createElement(BackupRestoreView, { ...baseRestore, preview: { ...preview, hasExisting: false }, mode: 'replace' }));
    expect(out).not.toContain('Сначала сохраните копию текущих данных');
    expect(out).toContain('Текущих данных нет');
    expect(out).not.toMatch(/<button[^>]*disabled[^>]*>Заменить всё данными из файла/);
  });

  it('копия уже загружена: явное предупреждение о дубликатах, ни один режим не выбран, кнопка заблокирована (М4)', () => {
    const loaded = { ...preview, merge: { conflictDecks: 2, conflictCards: 40, alreadyLoaded: true } };
    const out = html(createElement(BackupRestoreView, { ...baseRestore, preview: loaded, mode: null }));
    expect(out).toContain('Эта копия уже загружена');
    expect(out).toContain('получатся дубликаты');
    expect(out).toContain(ALREADY_LOADED_TEXT);
    expect(out).not.toMatch(/<input[^>]*type="radio"[^>]*checked/);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Сначала выберите, что сделать/);
    // Если копия не загружена целиком, предупреждения нет.
    expect(html(createElement(BackupRestoreView, { ...baseRestore, preview, mode: 'merge' }))).not.toContain('уже загружена');
  });

  it('режим по умолчанию: без данных «заменить»; с данными «добавить»; уже загруженную копию не выбираем (М4)', () => {
    expect(defaultRestoreMode(false, { alreadyLoaded: false })).toBe('replace');
    expect(defaultRestoreMode(true, { alreadyLoaded: false })).toBe('merge');
    expect(defaultRestoreMode(true, { alreadyLoaded: true })).toBeNull();
  });

  it('предупреждения проверки файла (пропущенные записи и настройки) видны в предпросмотре', () => {
    const out = html(
      createElement(BackupRestoreView, {
        ...baseRestore,
        preview: { ...preview, warnings: ['2 записи журнала без карточки или колоды пропущены (остальные данные загружаются).', 'Настройка «dailyNewLimit (новых слов в день)» имеет недопустимое значение и пропущена.'] },
      }),
    );
    expect(out).toContain('2 записи журнала без карточки или колоды пропущены');
    expect(out).toContain('dailyNewLimit');
  });

  it('ошибка восстановления: данные остались как были', () => {
    const out = html(
      createElement(BackupRestoreView, { ...baseRestore, preview, restoreError: 'Не удалось загрузить данные. Ничего не изменилось, ваши данные остались как были.' }),
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain('Ничего не изменилось');
  });

  it('итог: замена и добавление', () => {
    const rep = { mode: 'replace' as const, decks: 2, cards: 40, reviews: 7, reidDecks: 0, reidCards: 0 };
    expect(reportText(rep)).toBe('Готово: данные заменены. Восстановлено: колод: 2, карточек: 40, записей журнала: 7.');
    const merged = reportText({ ...rep, mode: 'merge', reidDecks: 1, reidCards: 3 });
    expect(merged).toContain('добавлено колод: 2');
    expect(merged).toContain('Прежние данные не тронуты');
    expect(merged).toContain('колод 1, карточек 3');
    expect(html(createElement(BackupRestoreView, { ...baseRestore, report: rep }))).toContain('Загрузить ещё одну копию');
  });
});

describe('настройки: состояние копий и хранилища', () => {
  const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

  it('копий не было: так и написано, плюс счётчик', () => {
    const out = html(createElement(BackupStatus, { now: NOW, state: { hasData: true, changesSinceBackup: 3, oldestDataAt: NOW - 86_400_000 } }));
    expect(out).toContain('копий ещё не было');
    expect(out).toContain('3 изменения');
  });

  it('есть дата копии и счётчик; при превышении порога совет сохранить', () => {
    const out = html(createElement(BackupStatus, { now: NOW, state: { hasData: true, changesSinceBackup: 51, lastBackupAt: NOW - 3_600_000 } }));
    expect(out).toContain('14 ноября 2026');
    expect(out).toContain('51 изменение');
    expect(out).toContain('Пора сохранить свежую копию');
  });

  it('хранилище: результат persist (да, нет, недоступно) и объём, с честной оговоркой', () => {
    const yes = html(createElement(StorageBlock, { persist: 'granted', estimate: { usage: 2048, quota: 5 * 1024 ** 3 } }));
    expect(yes).toContain('Да: браузер отметил хранилище как постоянное');
    expect(yes).toContain('2 КБ из 5 ГБ');
    expect(yes).toContain('Резервная копия нужна всё равно');
    expect(html(createElement(StorageBlock, { persist: 'denied', estimate: null }))).toContain('Нет: браузер не дал гарантии');
    const none = html(createElement(StorageBlock, { persist: 'unavailable', estimate: null }));
    expect(none).toContain('Недоступно в этом браузере');
    expect(none).toContain('недоступно в этом браузере');
    expect(html(createElement(StorageBlock, { persist: undefined, estimate: undefined }))).toContain('узнаю…');
  });

  it('хранилище: сбой запроса показывается как «не удалось узнать», а не «Нет» (М7)', () => {
    const out = html(createElement(StorageBlock, { persist: 'unknown', estimate: null }));
    expect(out).toContain('Не удалось узнать');
    expect(out).not.toContain('Нет: браузер не дал гарантии');
  });
});

describe('мобильная вёрстка (проверка исходников CSS)', () => {
  const css = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const backup = css('./Backup.module.css');
  const ui = css('../styles/ui.module.css');
  const tokens = css('../styles/tokens.css');
  const base = css('../styles/base.css');

  it('кнопки, строки выбора и флажки не ниже 44px', () => {
    expect(/--tap:\s*(\d+)px/.exec(tokens)?.[1]).toBeDefined();
    expect(Number(/--tap:\s*(\d+)px/.exec(tokens)?.[1])).toBeGreaterThanOrEqual(44);
    expect(/\.btn\s*\{[^}]*min-height:\s*var\(--tap\)/.test(ui)).toBe(true);
    expect(/\.choice\s*\{[^}]*min-height:\s*44px/.test(backup)).toBe(true);
    expect(/\.check\s*\{[^}]*min-height:\s*44px/.test(backup)).toBe(true);
  });

  it('поля ввода не меньше 16px (иначе iOS приближает страницу)', () => {
    expect(base).toMatch(/input,\s*textarea,\s*select\s*\{[^}]*font-size:\s*max\(16px/);
    expect(backup).toMatch(/\.fileInput\s*\{[^}]*font-size:\s*16px/);
    expect(backup).toMatch(/\.manual\s*\{[^}]*font-size:\s*16px/);
  });

  it('безопасные зоны экрана учтены на странице', () => {
    expect(ui).toContain('var(--safe-left)');
    expect(ui).toContain('var(--safe-bottom)');
  });
});
