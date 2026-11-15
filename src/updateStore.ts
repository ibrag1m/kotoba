// Маленькое хранилище «доступна новая версия приложения»: service worker (src/pwa.ts) сообщает сюда,
// интерфейс (UpdateBanner) подписывается. Без зависимостей от React и от virtual:pwa-register.

let available = false;
let applier: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<() => void>();

export function isUpdateAvailable(): boolean {
  return available;
}

export function markUpdateAvailable(): void {
  if (available) return;
  available = true;
  for (const l of [...listeners]) l();
}

/** pwa.ts передаёт сюда функцию применения обновления, полученную от registerSW. */
export function setUpdateApplier(fn: ((reload?: boolean) => Promise<void>) | null): void {
  applier = fn;
}

/** Применяет ждущую версию и перезагружает страницу. Бросает ошибку, если применять нечем. */
export async function applyUpdate(): Promise<void> {
  if (!applier) throw new Error('обновление недоступно в этом режиме');
  await applier(true);
}

/** Подписка для useSyncExternalStore; возвращает функцию отписки. */
export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Только для тестов. */
export function resetUpdateStoreForTests(): void {
  available = false;
  applier = null;
  listeners.clear();
}
