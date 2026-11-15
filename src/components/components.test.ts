// Проверки интерфейсных частей без браузера: серверная отрисовка React в строку.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorBoundary, ErrorFallback } from './ErrorBoundary';
import { UpdateBannerView } from './UpdateBanner';
import { attempt, deleteDeckErrorText, errorMessage } from '../core/errors';
import {
  applyUpdate,
  isUpdateAvailable,
  markUpdateAvailable,
  resetUpdateStoreForTests,
  setUpdateApplier,
  subscribeUpdate,
} from '../updateStore';

afterEach(() => {
  vi.restoreAllMocks();
  resetUpdateStoreForTests();
});

describe('баннер «Доступна новая версия»', () => {
  it('русский текст, доступная разметка и кнопка «Обновить»', () => {
    const html = renderToStaticMarkup(createElement(UpdateBannerView, { onApply: () => {} }));
    expect(html).toContain('Доступна новая версия');
    expect(html).toContain('>Обновить<');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('disabled');
  });

  it('во время обновления кнопка заблокирована, при ошибке показан текст и «Повторить»', () => {
    const busy = renderToStaticMarkup(createElement(UpdateBannerView, { busy: true, onApply: () => {} }));
    expect(busy).toContain('disabled');
    expect(busy).toContain('Обновляю');
    const failed = renderToStaticMarkup(createElement(UpdateBannerView, { error: 'нет сети', onApply: () => {} }));
    expect(failed).toContain('Не удалось обновить: нет сети');
    expect(failed).toContain('>Повторить<');
  });
});

describe('хранилище «есть обновление» (его заполняет onNeedRefresh из pwa.ts)', () => {
  it('сначала обновления нет; markUpdateAvailable включает его и будит подписчиков один раз', () => {
    const listener = vi.fn();
    const off = subscribeUpdate(listener);
    expect(isUpdateAvailable()).toBe(false);
    markUpdateAvailable();
    markUpdateAvailable();
    expect(isUpdateAvailable()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('applyUpdate вызывает функцию из registerSW с перезагрузкой страницы; без неё бросает понятную ошибку', async () => {
    await expect(applyUpdate()).rejects.toThrow('обновление недоступно');
    const apply = vi.fn().mockResolvedValue(undefined);
    setUpdateApplier(apply);
    await applyUpdate();
    expect(apply).toHaveBeenCalledWith(true);
  });

  it('после отписки подписчик не вызывается', () => {
    const listener = vi.fn();
    subscribeUpdate(listener)();
    markUpdateAvailable();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('ErrorBoundary', () => {
  it('сообщение по-русски, подробности и кнопка «Перезагрузить»', () => {
    const html = renderToStaticMarkup(
      createElement(ErrorFallback, { error: new Error('QuotaExceededError'), onReload: () => {} }),
    );
    expect(html).toContain('Что-то пошло не так');
    expect(html).toContain('>Перезагрузить<');
    expect(html).toContain('QuotaExceededError');
    expect(html).toContain('role="alert"');
  });

  it('getDerivedStateFromError переводит границу в состояние ошибки', () => {
    const err = new Error('база недоступна');
    expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err, failed: true });
  });

  it('без ошибки показывает детей как есть', () => {
    const html = renderToStaticMarkup(createElement(ErrorBoundary, null, createElement('p', null, 'экран')));
    expect(html).toBe('<p>экран</p>');
  });

  it('кнопка вызывает onReload', () => {
    const onReload = vi.fn();
    const el = ErrorFallback({ error: null, onReload }) as unknown as {
      props: { children: { type: string; props: { onClick?: () => void } }[] };
    };
    const button = el.props.children.find((c) => c.type === 'button');
    button?.props.onClick?.();
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe('ошибки базы: понятный текст и обёртка', () => {
  it('errorMessage', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('строка')).toBe('строка');
    expect(errorMessage(undefined)).toBe('неизвестная ошибка');
    expect(errorMessage(new Error(''))).toBe('Error');
  });

  it('attempt возвращает ошибку значением и не бросает', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await attempt(async () => 1)).toEqual({ ok: true });
    expect(
      await attempt(() => {
        throw new Error('диск полон');
      }),
    ).toEqual({ ok: false, message: 'диск полон' });
    expect(await attempt(() => Promise.reject(new Error('отказ')))).toEqual({ ok: false, message: 'отказ' });
  });

  it('текст ошибки удаления колоды понятный и по-русски', () => {
    const text = deleteDeckErrorText('сбой');
    expect(text).toContain('Не удалось удалить колоду');
    expect(text).toContain('Ничего не изменилось');
    expect(text).toContain('сбой');
  });
});
