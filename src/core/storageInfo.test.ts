import { describe, expect, it, vi } from 'vitest';
import { PERSIST_TEXT, formatBytes, readEstimate, readPersisted, requestPersist } from './storageInfo';

describe('requestPersist', () => {
  it('API нет: unavailable', async () => {
    expect(await requestPersist(undefined)).toBe('unavailable');
    expect(await requestPersist({})).toBe('unavailable');
  });
  it('уже постоянное: повторный запрос не делается', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    expect(await requestPersist({ persist, persisted: async () => true })).toBe('granted');
    expect(persist).not.toHaveBeenCalled();
  });
  it('даёт и не даёт', async () => {
    expect(await requestPersist({ persist: async () => true, persisted: async () => false })).toBe('granted');
    expect(await requestPersist({ persist: async () => false })).toBe('denied');
  });
  it('ошибка запроса не бросается наружу и НЕ выдаётся за отказ (М7): unknown', async () => {
    expect(await requestPersist({ persist: () => Promise.reject(new Error('x')) })).toBe('unknown');
    // Не булево значение тоже не «отказ».
    expect(await requestPersist({ persist: (async () => undefined) as unknown as () => Promise<boolean> })).toBe('unknown');
  });
});

describe('readPersisted и readEstimate', () => {
  it('persisted: значение, null без API и при ошибке', async () => {
    expect(await readPersisted({ persisted: async () => false })).toBe(false);
    expect(await readPersisted(undefined)).toBeNull();
    expect(await readPersisted({ persisted: () => Promise.reject(new Error('x')) })).toBeNull();
  });
  it('estimate: числа, null без API, мусор отбрасывается', async () => {
    expect(await readEstimate({ estimate: async () => ({ usage: 1000, quota: 5000 }) })).toEqual({ usage: 1000, quota: 5000 });
    expect(await readEstimate({ estimate: async () => ({}) })).toEqual({ usage: null, quota: null });
    expect(await readEstimate({ estimate: async () => ({ usage: NaN, quota: -1 }) })).toEqual({ usage: null, quota: null });
    expect(await readEstimate(undefined)).toBeNull();
    expect(await readEstimate({ estimate: () => Promise.reject(new Error('x')) })).toBeNull();
  });
});

describe('formatBytes', () => {
  it('единицы по-русски', () => {
    expect(formatBytes(0)).toBe('0 Б');
    expect(formatBytes(512)).toBe('512 Б');
    expect(formatBytes(1536)).toBe('1,5 КБ');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 МБ');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 ГБ');
  });
});

describe('тексты результата запроса хранилища', () => {
  it('для каждого результата есть понятный текст; «нет» только у реального отказа', () => {
    expect(PERSIST_TEXT.granted).toMatch(/^Да/);
    expect(PERSIST_TEXT.denied).toMatch(/^Нет/);
    expect(PERSIST_TEXT.unavailable).toMatch(/^Недоступно/);
    expect(PERSIST_TEXT.unknown).toMatch(/^Не удалось узнать/);
    expect(PERSIST_TEXT.unknown).not.toMatch(/^Нет/);
  });
});
