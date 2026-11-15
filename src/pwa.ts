import { registerSW } from 'virtual:pwa-register';
import { markUpdateAvailable, setUpdateApplier } from './updateStore';

/** Регистрирует service worker. В режиме разработки не используется (работает только в сборке). */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const update = registerSW({
    immediate: true,
    // Новая версия скачана и ждёт: показываем баннер «Доступна новая версия» (UpdateBanner).
    onNeedRefresh() {
      markUpdateAvailable();
    },
    onRegisterError(error) {
      console.error('Не удалось зарегистрировать service worker', error);
    },
  });
  // Кнопка «Обновить» вызывает это: активирует ждущий service worker и перезагружает страницу.
  setUpdateApplier(update);
}
