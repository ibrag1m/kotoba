import { useState, useSyncExternalStore } from 'react';
import { errorMessage } from '../core/errors';
import { applyUpdate, isUpdateAvailable, subscribeUpdate } from '../updateStore';
import s from './UpdateBanner.module.css';

/** true, когда service worker скачал новую версию и она ждёт применения. */
export function useUpdateAvailable(): boolean {
  return useSyncExternalStore(subscribeUpdate, isUpdateAvailable, () => false);
}

interface ViewProps {
  busy?: boolean;
  error?: string | null;
  onApply: () => void;
}

/** Внешний вид баннера (отдельно от подписки, чтобы его можно было проверить без браузера). */
export function UpdateBannerView({ busy = false, error = null, onApply }: ViewProps) {
  return (
    <div className={s.banner} role="status" aria-live="polite">
      <span className={s.text}>{error ? `Не удалось обновить: ${error}` : 'Доступна новая версия'}</span>
      <button type="button" className={s.button} onClick={onApply} disabled={busy}>
        {busy ? 'Обновляю…' : error ? 'Повторить' : 'Обновить'}
      </button>
    </div>
  );
}

/** Ненавязчивая полоса в самом верху, пока есть новая версия. Не перекрывает кнопки управления. */
export function UpdateBanner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onApply() {
    setBusy(true);
    setError(null);
    try {
      await applyUpdate();
      // Страница перезагрузится сама; если нет, через секунду разблокируем кнопку.
      setTimeout(() => setBusy(false), 4000);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return <UpdateBannerView busy={busy} error={error} onApply={() => void onApply()} />;
}
