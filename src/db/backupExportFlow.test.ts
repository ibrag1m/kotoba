// Обработчики экрана «Сохранить копию» (без браузера): подготовка заранее, синхронный navigator.share,
// «копия сохранена» только после реального успеха или подтверждения, защита от двойного нажатия.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupExportController } from './backupExportFlow';
import type { ExportDeps } from './backupExportFlow';
import { BackupSnapshotError, createBackupSnapshot, readBackupState, readChangeSeq } from './backupRepo';
import type { BackupSnapshot } from './backupRepo';
import { KotobaDB } from './db';
import { addCards, createDeck } from './repo';
import type { ShareNavigatorLike } from '../core/backupShare';
import type { Review } from './types';

let n = 0;
let db: KotobaDB;
const dbs: KotobaDB[] = [];

beforeEach(async () => {
  db = new KotobaDB(`kotoba-export-flow-${++n}`);
  dbs.push(db);
  // Данные с несохранёнными изменениями.
  const d = await createDeck(db, { name: 'N5' });
  await addCards(db, d.id, [
    { term: '水', definition: 'вода' },
    { term: '火', definition: 'огонь' },
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dbs.splice(0)) {
    d.close();
    await KotobaDB.delete(d.name);
  }
});

const unsaved = async () => (await readBackupState(db)).changesSinceBackup;
const idle = (ctl: BackupExportController) => vi.waitFor(() => expect(ctl.getState().busy).toBe(false));
const abort = () => Object.assign(new Error('отмена'), { name: 'AbortError' });
const notAllowed = () => Object.assign(new Error('нужен жест'), { name: 'NotAllowedError' });

interface Kit {
  ctl: BackupExportController;
  share: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  createSnapshot: ReturnType<typeof vi.fn>;
  onSaved: ReturnType<typeof vi.fn>;
}

/** Контроллер с подделками браузера. По умолчанию «Поделиться» и буфер обмена работают. */
function kit(over: { nav?: ShareNavigatorLike | undefined; share?: () => Promise<void>; createSnapshot?: ExportDeps['createSnapshot'] } = {}): Kit {
  const share = vi.fn(over.share ?? (() => Promise.resolve()));
  const writeText = vi.fn(() => Promise.resolve());
  const download = vi.fn();
  const onSaved = vi.fn();
  const createSnapshot = vi.fn(over.createSnapshot ?? ((d: KotobaDB, v: string, now: number) => createBackupSnapshot(d, v, now)));
  const nav: ShareNavigatorLike | undefined =
    'nav' in over ? over.nav : { share: share as never, canShare: () => true, clipboard: { writeText } };
  const ctl = new BackupExportController({
    db,
    appVersion: '0.1.0',
    nav,
    download,
    onSaved,
    createSnapshot: createSnapshot as never,
    now: () => Date.now(),
    debounceMs: 5,
  });
  return { ctl, share, writeText, download, createSnapshot, onSaved };
}

async function ready(k: Kit): Promise<void> {
  k.ctl.start();
  await k.ctl.prepare();
  expect(k.ctl.getState().preparing).toBe(false);
  expect(k.ctl.getState().prepareError).toBeNull();
}

describe('подготовка копии заранее (М5/М6)', () => {
  it('пока копия готовится: «Готовлю копию…», нажатия ничего не делают; когда готова: работают', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const k = kit({
      createSnapshot: async (d, v, now) => {
        await gate;
        return createBackupSnapshot(d, v, now);
      },
    });
    k.ctl.start();
    expect(k.ctl.getState().preparing).toBe(true);
    k.ctl.share();
    k.ctl.download();
    k.ctl.copy();
    expect(k.share).not.toHaveBeenCalled();
    expect(k.download).not.toHaveBeenCalled();
    expect(k.writeText).not.toHaveBeenCalled();
    release();
    await k.ctl.prepare();
    expect(k.ctl.getState().preparing).toBe(false);
    k.ctl.share();
    expect(k.share).toHaveBeenCalledTimes(1);
  });

  it('navigator.share вызывается СИНХРОННО из обработчика, только с { files }', async () => {
    const k = kit();
    await ready(k);
    k.ctl.share();
    // Ни одного await между нажатием и обращением к браузеру.
    expect(k.share).toHaveBeenCalledTimes(1);
    const arg = k.share.mock.calls[0]![0] as { files: File[] };
    expect(Object.keys(arg)).toEqual(['files']);
    expect(arg.files).toHaveLength(1);
    expect(arg.files[0]!.name).toMatch(/^kotoba-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(arg.files[0]!.type).toBe('application/json');
    await idle(k.ctl);
  });

  it('запись в буфер обмена тоже вызывается синхронно, из готового текста', async () => {
    const k = kit();
    await ready(k);
    k.ctl.copy();
    expect(k.writeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(k.writeText.mock.calls[0]![0] as string).app).toBe('kotoba');
    await idle(k.ctl);
  });

  it('application/json не принимается меню, text/plain принимается: файл уходит как text/plain с тем же именем .json', async () => {
    const share = vi.fn(() => Promise.resolve());
    const k = kit({ nav: { share: share as never, canShare: (d) => (d.files ?? []).every((f) => f.type === 'text/plain') } });
    await ready(k);
    expect(k.ctl.getState().canShare).toBe(true);
    k.ctl.share();
    const arg = (share.mock.calls[0] as unknown as [{ files: File[] }])[0];
    expect(arg.files[0]!.type).toBe('text/plain');
    expect(arg.files[0]!.name.endsWith('.json')).toBe(true);
    await idle(k.ctl);
  });

  it('«Поделиться» с файлами недоступно: canShare = false, нажатие ничего не вызывает', async () => {
    const k = kit({ nav: { clipboard: { writeText: vi.fn() } } });
    expect(k.ctl.getState().canShare).toBe(false);
    await ready(k);
    k.ctl.share();
    expect(k.ctl.getState().note?.kind).toBe('warn');
  });

  it('параллельные вызовы подготовки делят один снимок (создаётся один раз)', async () => {
    const k = kit();
    k.ctl.start();
    await Promise.all([k.ctl.prepare(), k.ctl.prepare(), k.ctl.prepare()]);
    expect(k.createSnapshot).toHaveBeenCalledTimes(1);
  });

  it('данные изменились после подготовки: копия устарела, кнопки ждут, затем она собирается заново', async () => {
    const k = kit();
    await ready(k);
    const first = (k.createSnapshot.mock.results[0]!.value as Promise<BackupSnapshot>);
    const firstSeq = (await first).seq;
    const [deck] = await db.decks.toArray();
    await addCards(db, deck!.id, [{ term: '木', definition: 'дерево' }]);
    const seq = await readChangeSeq(db);
    expect(seq).toBeGreaterThan(firstSeq);
    k.ctl.dataChanged(seq);
    expect(k.ctl.getState().preparing).toBe(true);
    k.ctl.share();
    expect(k.share).not.toHaveBeenCalled(); // устаревшую копию отдавать нельзя
    await vi.waitFor(() => expect(k.ctl.getState().preparing).toBe(false));
    expect(k.createSnapshot).toHaveBeenCalledTimes(2);
    k.ctl.share();
    expect(k.share).toHaveBeenCalledTimes(1);
    const file = (k.share.mock.calls[0]![0] as { files: File[] }).files[0]!;
    expect(JSON.parse(await file.text()).cards).toHaveLength(3);
    await idle(k.ctl);
  });

  it('много быстрых изменений подряд дают одну пересборку (пауза)', async () => {
    const k = kit();
    await ready(k);
    const [deck] = await db.decks.toArray();
    for (const term of ['一', '二', '三']) {
      await addCards(db, deck!.id, [{ term, definition: term }]);
      k.ctl.dataChanged(await readChangeSeq(db));
    }
    await vi.waitFor(() => expect(k.ctl.getState().preparing).toBe(false));
    expect(k.createSnapshot).toHaveBeenCalledTimes(2);
  });

  it('снимок не устарел (тот же номер изменения): повторной подготовки нет', async () => {
    const k = kit();
    await ready(k);
    k.ctl.dataChanged(await readChangeSeq(db));
    await new Promise((r) => setTimeout(r, 30));
    expect(k.createSnapshot).toHaveBeenCalledTimes(1);
    expect(k.ctl.getState().preparing).toBe(false);
  });

  it('сбой подготовки: причина и подробности, нажатия не работают; «ещё раз» восстанавливает; сведения копируются', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const k = kit({
      createSnapshot: async (d, v, now) => {
        if (fail) throw new BackupSnapshotError('Не удалось собрать надёжную копию: нарушены связи. Данные не изменены.', ['Запись журнала 1 относится к другой колоде', 'второй пункт']);
        return createBackupSnapshot(d, v, now);
      },
    });
    k.ctl.start();
    await k.ctl.prepare();
    const st = k.ctl.getState();
    expect(st.preparing).toBe(false);
    expect(st.prepareError?.text).toContain('Не удалось собрать надёжную копию');
    expect(st.prepareError?.details).toEqual(['Запись журнала 1 относится к другой колоде', 'второй пункт']);
    k.ctl.share();
    k.ctl.download();
    expect(k.share).not.toHaveBeenCalled();
    expect(k.download).not.toHaveBeenCalled();
    const report = k.ctl.errorReport()!;
    expect(report).toContain('Kotoba 0.1.0');
    expect(report).toContain('второй пункт');
    k.ctl.copyErrorReport();
    expect(k.writeText).toHaveBeenCalledWith(report);
    await vi.waitFor(() => expect(k.ctl.getState().note?.text).toContain('скопированы'));
    expect(await unsaved()).toBeGreaterThan(0); // ничего не отмечено
    fail = false;
    k.ctl.retryPrepare();
    await vi.waitFor(() => expect(k.ctl.getState().preparing).toBe(false));
    expect(k.ctl.getState().prepareError).toBeNull();
    k.ctl.download();
    expect(k.download).toHaveBeenCalledTimes(1);
  });

  it('сиротские записи журнала: копия делается, предупреждение показывается', async () => {
    const [deck] = await db.decks.toArray();
    const [card] = await db.cards.toArray();
    const rv: Review = { cardId: card!.id, deckId: deck!.id, ts: 1, rating: 3, mode: 'learn', durationMs: 1, prev: card! };
    await db.reviews.add(rv);
    await db.cards.delete(card!.id);
    const k = kit();
    await ready(k);
    expect(k.ctl.getState().warnings[0]).toBe('1 запись журнала без карточки не вошла в копию.');
    k.ctl.download();
    expect(k.download).toHaveBeenCalledTimes(1);
  });
});

describe('«Поделиться»: копия считается сохранённой только когда меню довели до конца', () => {
  it('успех: счётчик сброшен, дата копии есть, onSaved вызван', async () => {
    const k = kit();
    await ready(k);
    expect(await unsaved()).toBeGreaterThan(0);
    k.ctl.share();
    await idle(k.ctl);
    expect(await unsaved()).toBe(0);
    expect((await readBackupState(db)).lastBackupAt).toBeTypeOf('number');
    expect(k.onSaved).toHaveBeenCalledTimes(1);
    expect(k.ctl.getState().note?.kind).toBe('ok');
  });

  it('отмена меню: ничего не отмечено', async () => {
    const k = kit({ share: () => Promise.reject(abort()) });
    await ready(k);
    const before = await unsaved();
    k.ctl.share();
    await idle(k.ctl);
    expect(await unsaved()).toBe(before);
    expect((await readBackupState(db)).lastBackupAt).toBeUndefined();
    expect(k.onSaved).not.toHaveBeenCalled();
    expect(k.ctl.getState().note?.text).toContain('НЕ сохранена');
  });

  it('NotAllowedError: первый раз «нажмите ещё раз» (копия уже готова, повтор без новой подготовки); второй подряд: предложить скачивание', async () => {
    const k = kit({ share: () => Promise.reject(notAllowed()) });
    await ready(k);
    k.ctl.share();
    await idle(k.ctl);
    expect(k.ctl.getState().suggestAlt).toBe(false);
    expect(k.ctl.getState().note?.text).toContain('ещё раз');
    k.ctl.share();
    expect(k.share).toHaveBeenCalledTimes(2); // сразу, без асинхронной подготовки
    await idle(k.ctl);
    const st = k.ctl.getState();
    expect(st.suggestAlt).toBe(true);
    expect(st.note?.text).toContain('Скачайте файл');
    expect(st.note?.text).toContain('скопируйте копию текстом');
    expect(k.createSnapshot).toHaveBeenCalledTimes(1);
    expect(await unsaved()).toBeGreaterThan(0);
    expect(k.onSaved).not.toHaveBeenCalled();
  });

  it('успех после отказов сбрасывает предложение скачать и счётчик отказов', async () => {
    let mode: 'blocked' | 'ok' = 'blocked';
    const k = kit({ share: () => (mode === 'blocked' ? Promise.reject(notAllowed()) : Promise.resolve()) });
    await ready(k);
    k.ctl.share();
    await idle(k.ctl);
    k.ctl.share();
    await idle(k.ctl);
    expect(k.ctl.getState().suggestAlt).toBe(true);
    mode = 'ok';
    k.ctl.share();
    await idle(k.ctl);
    expect(k.ctl.getState().suggestAlt).toBe(false);
    expect(await unsaved()).toBe(0);
  });

  it('отказ, потом отмена, потом отказ: подряд отказов нет, предложения скачать нет', async () => {
    const outcomes = [notAllowed(), abort(), notAllowed()];
    const k = kit({ share: () => Promise.reject(outcomes.shift()) });
    await ready(k);
    for (let i = 0; i < 3; i++) {
      k.ctl.share();
      await idle(k.ctl);
    }
    expect(k.ctl.getState().suggestAlt).toBe(false);
  });

  it('устройство не принимает файл (TypeError): canShare = false', async () => {
    const k = kit({ share: () => Promise.reject(Object.assign(new Error('x'), { name: 'TypeError' })) });
    await ready(k);
    k.ctl.share();
    await idle(k.ctl);
    expect(k.ctl.getState().canShare).toBe(false);
    expect(await unsaved()).toBeGreaterThan(0);
  });

  it('двойное нажатие: navigator.share вызывается один раз, снимок один', async () => {
    let release!: () => void;
    const k = kit({ share: () => new Promise<void>((r) => (release = r)) });
    await ready(k);
    k.ctl.share();
    k.ctl.share(); // второй клик, пока меню открыто
    k.ctl.share();
    expect(k.share).toHaveBeenCalledTimes(1);
    expect(k.createSnapshot).toHaveBeenCalledTimes(1);
    expect(k.ctl.getState().busy).toBe(true);
    release();
    await idle(k.ctl);
    expect(k.onSaved).toHaveBeenCalledTimes(1);
  });

  it('изменения, сделанные пока меню открыто, остаются несохранёнными', async () => {
    const [deck] = await db.decks.toArray();
    const k = kit({ share: async () => void (await addCards(db, deck!.id, [{ term: '木', definition: 'дерево' }])) });
    await ready(k);
    k.ctl.share();
    await idle(k.ctl);
    expect(await unsaved()).toBe(1);
  });
});

describe('скачивание и буфер обмена: сохранённой считается только после «Да, сохранил(а)»', () => {
  it('скачивание: файл отдан, но копия НЕ отмечена; ждёт подтверждения', async () => {
    const k = kit();
    await ready(k);
    const before = await unsaved();
    k.ctl.download();
    expect(k.download).toHaveBeenCalledTimes(1);
    expect(k.download.mock.calls[0]![0]).toMatch(/^kotoba-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(k.ctl.getState().confirm?.via).toBe('download');
    expect(await unsaved()).toBe(before);
    expect((await readBackupState(db)).lastBackupAt).toBeUndefined();
    expect(k.onSaved).not.toHaveBeenCalled();
  });

  it('буфер обмена: текст скопирован, но копия НЕ отмечена', async () => {
    const k = kit();
    await ready(k);
    const before = await unsaved();
    k.ctl.copy();
    await idle(k.ctl);
    expect(k.ctl.getState().confirm?.via).toBe('copy');
    expect(await unsaved()).toBe(before);
    expect(k.onSaved).not.toHaveBeenCalled();
  });

  it('буфер недоступен: текст в поле для ручного копирования, подтверждение «manual», копия не отмечена', async () => {
    const k = kit({ nav: { share: vi.fn() as never, canShare: () => true } });
    await ready(k);
    k.ctl.copy();
    await idle(k.ctl);
    const st = k.ctl.getState();
    expect(st.confirm?.via).toBe('manual');
    expect(st.manualText).toContain('"app": "kotoba"');
    expect(await unsaved()).toBeGreaterThan(0);
  });

  it('«Ещё нет» не сбрасывает счётчик и убирает вопрос', async () => {
    const k = kit();
    await ready(k);
    const before = await unsaved();
    k.ctl.download();
    k.ctl.dismissConfirm();
    expect(k.ctl.getState().confirm).toBeNull();
    expect(k.ctl.getState().note?.text).toContain('не сброшен');
    expect(await unsaved()).toBe(before);
    expect((await readBackupState(db)).lastBackupAt).toBeUndefined();
    // «Да» теперь нечего подтверждать.
    await k.ctl.confirmSaved();
    expect(await unsaved()).toBe(before);
  });

  it('«Да, сохранил(а)» отмечает копию: счётчик 0, дата копии, onSaved', async () => {
    const k = kit();
    await ready(k);
    k.ctl.download();
    await k.ctl.confirmSaved();
    expect(await unsaved()).toBe(0);
    expect((await readBackupState(db)).lastBackupAt).toBeTypeOf('number');
    expect(k.onSaved).toHaveBeenCalledTimes(1);
    expect(k.ctl.getState().confirm).toBeNull();
  });

  it('двойное «Да, сохранил(а)»: отмечается один раз', async () => {
    const k = kit();
    await ready(k);
    k.ctl.download();
    await Promise.all([k.ctl.confirmSaved(), k.ctl.confirmSaved(), k.ctl.confirmSaved()]);
    expect(k.onSaved).toHaveBeenCalledTimes(1);
    expect(await unsaved()).toBe(0);
  });

  it('изменения между скачиванием и «Да» остаются несохранёнными (подтверждается именно снимок)', async () => {
    const k = kit();
    await ready(k);
    k.ctl.download();
    const [deck] = await db.decks.toArray();
    await addCards(db, deck!.id, [{ term: '木', definition: 'дерево' }, { term: '金', definition: 'золото' }]);
    await k.ctl.confirmSaved();
    expect(await unsaved()).toBe(2);
  });

  it('двойное нажатие «Скачать»: один файл, пока не отвечено на вопрос; после «Ещё нет» можно снова', async () => {
    const k = kit();
    await ready(k);
    k.ctl.download();
    k.ctl.download();
    expect(k.download).toHaveBeenCalledTimes(1);
    expect(k.createSnapshot).toHaveBeenCalledTimes(1);
    k.ctl.dismissConfirm();
    k.ctl.download();
    expect(k.download).toHaveBeenCalledTimes(2);
  });

  it('двойное нажатие «Скопировать»: запись в буфер один раз, пока идёт запись', async () => {
    const k = kit();
    await ready(k);
    k.ctl.copy();
    k.ctl.copy();
    expect(k.writeText).toHaveBeenCalledTimes(1);
    await idle(k.ctl);
  });

  it('сбой скачивания: копия НЕ отмечена, подтверждения нет, понятное сообщение', async () => {
    const k = kit();
    k.download.mockImplementation(() => {
      throw new Error('нет места');
    });
    await ready(k);
    k.ctl.download();
    const st = k.ctl.getState();
    expect(st.confirm).toBeNull();
    expect(st.note?.kind).toBe('error');
    expect(st.note?.text).toContain('нет места');
    expect(await unsaved()).toBeGreaterThan(0);
  });
});
