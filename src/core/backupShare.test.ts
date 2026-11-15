import { describe, expect, it, vi } from 'vitest';
import { canShareBackupFile, copyBackupText, downloadBackup, makeBackupFile, pickShareFile, shareBackup } from './backupShare';
import type { DownloadEnv, ShareNavigatorLike } from './backupShare';

const file = makeBackupFile('kotoba-backup-2026-11-14-2015.json', '{"app":"kotoba"}');

function domErr(name: string, message = 'x'): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe('файл для «Поделиться»', () => {
  it('имя и тип файла', () => {
    expect(file.name).toBe('kotoba-backup-2026-11-14-2015.json');
    expect(file.type).toBe('application/json');
  });

  it('canShare: нет API, нет canShare, canShare вернул false или бросил', () => {
    expect(canShareBackupFile(undefined, file)).toBe(false);
    expect(canShareBackupFile({}, file)).toBe(false);
    expect(canShareBackupFile({ share: async () => {} }, file)).toBe(false);
    expect(canShareBackupFile({ share: async () => {}, canShare: () => false }, file)).toBe(false);
    expect(canShareBackupFile({ share: async () => {}, canShare: () => { throw new Error('x'); } }, file)).toBe(false);
    expect(canShareBackupFile({ share: async () => {}, canShare: (d) => (d.files?.length ?? 0) === 1 }, file)).toBe(true);
  });
});

describe('shareBackup: исходы', () => {
  const nav = (share: ShareNavigatorLike['share']): ShareNavigatorLike => ({ share, canShare: () => true });

  it('успех: меню довели до конца', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    expect(await shareBackup(nav(share), file)).toEqual({ kind: 'shared' });
    // Только files: без title и text (М5/М6).
    expect(share).toHaveBeenCalledWith({ files: [file] });
    expect(Object.keys(share.mock.calls[0]![0] as object)).toEqual(['files']);
  });

  it('navigator.share вызывается СИНХРОННО, до первого await (жест пользователя на iOS не успевает пропасть)', () => {
    const share = vi.fn().mockResolvedValue(undefined);
    void shareBackup(nav(share), file); // без await
    expect(share).toHaveBeenCalledTimes(1);
  });

  it('отмена меню (AbortError) — не успех', async () => {
    expect(await shareBackup(nav(() => Promise.reject(domErr('AbortError'))), file)).toEqual({ kind: 'cancelled' });
  });

  it('NotAllowedError: нужно нажать ещё раз', async () => {
    expect(await shareBackup(nav(() => Promise.reject(domErr('NotAllowedError'))), file)).toEqual({ kind: 'blocked' });
  });

  it('файлы не поддерживаются: нет API или TypeError', async () => {
    expect(await shareBackup(undefined, file)).toEqual({ kind: 'unsupported' });
    expect(await shareBackup({ share: async () => {}, canShare: () => false }, file)).toEqual({ kind: 'unsupported' });
    expect(await shareBackup(nav(() => Promise.reject(domErr('TypeError'))), file)).toEqual({ kind: 'unsupported' });
  });

  it('прочая ошибка сообщается текстом', async () => {
    expect(await shareBackup(nav(() => Promise.reject(domErr('DataError', 'сломалось'))), file)).toEqual({
      kind: 'error',
      message: 'сломалось',
    });
  });
});

describe('pickShareFile: запасной тип файла', () => {
  const NAME = 'kotoba-backup-2026-11-14-2015.json';
  const navTypes = (accepted: string[]): ShareNavigatorLike => ({
    share: async () => {},
    canShare: (d) => (d.files ?? []).every((f) => accepted.includes(f.type)),
  });

  it('application/json принимается: берётся он', () => {
    const f = pickShareFile(navTypes(['application/json', 'text/plain']), NAME, '{}');
    expect(f?.type).toBe('application/json');
    expect(f?.name).toBe(NAME);
  });

  it('application/json не принимается, text/plain принимается: тот же файл с .json в имени и типом text/plain', async () => {
    const f = pickShareFile(navTypes(['text/plain']), NAME, '{"a":1}');
    expect(f?.type).toBe('text/plain');
    expect(f?.name).toBe(NAME);
    expect(f?.name.endsWith('.json')).toBe(true);
    expect(await f?.text()).toBe('{"a":1}');
  });

  it('не принимается ни то, ни другое, или нет API: null', () => {
    expect(pickShareFile(navTypes(['image/png']), NAME, '{}')).toBeNull();
    expect(pickShareFile(undefined, NAME, '{}')).toBeNull();
    expect(pickShareFile({ share: async () => {} }, NAME, '{}')).toBeNull();
  });
});

describe('copyBackupText', () => {
  it('успех', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyBackupText({ clipboard: { writeText } }, 'текст')).toEqual({ kind: 'copied' });
    expect(writeText).toHaveBeenCalledWith('текст');
  });
  it('буфера нет: unavailable (нужен запасной способ с полем)', async () => {
    expect(await copyBackupText(undefined, 'a')).toEqual({ kind: 'unavailable' });
    expect(await copyBackupText({}, 'a')).toEqual({ kind: 'unavailable' });
    expect(await copyBackupText({ clipboard: {} }, 'a')).toEqual({ kind: 'unavailable' });
  });
  it('отказ браузера: failed с текстом', async () => {
    const r = await copyBackupText({ clipboard: { writeText: () => Promise.reject(domErr('NotAllowedError', 'нет разрешения')) } }, 'a');
    expect(r).toEqual({ kind: 'failed', message: 'нет разрешения' });
  });
});

describe('downloadBackup', () => {
  it('создаёт ссылку с download и нажимает её, адрес освобождается позже', () => {
    const anchor = { href: '', download: '', rel: '', style: { display: '' }, click: vi.fn(), remove: vi.fn() };
    const appended: unknown[] = [];
    const timers: Array<() => void> = [];
    const revoke = vi.fn();
    const env: DownloadEnv = {
      document: { createElement: () => anchor, body: { appendChild: (n) => appended.push(n) } },
      URL: { createObjectURL: () => 'blob:abc', revokeObjectURL: revoke },
      setTimeout: (fn) => timers.push(fn),
    };
    downloadBackup(env, 'kotoba-backup-2026-11-14-2015.json', '{}');
    expect(anchor.href).toBe('blob:abc');
    expect(anchor.download).toBe('kotoba-backup-2026-11-14-2015.json');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(appended).toEqual([anchor]);
    expect(revoke).not.toHaveBeenCalled();
    timers[0]!();
    expect(revoke).toHaveBeenCalledWith('blob:abc');
  });
});
