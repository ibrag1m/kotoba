import { useEffect, useState } from 'react';
import { Page } from '../components/Page';
import { db, DB_SCHEMA_VERSION } from '../db/db';
import { formatInterval } from '../core/format';
import { errorMessage } from '../core/errors';
import { isSrsReady, loadSrs, newState, preview, srsInfo } from '../core/srs';
import type { Rating, SrsPreviewItem } from '../core/srs';
import ui from '../styles/ui.module.css';
import s from './DiagScreen.module.css';

const RATING_NAMES: Record<Rating, string> = { 1: 'Снова', 2: 'Трудно', 3: 'Хорошо', 4: 'Легко' };

interface Diag {
  online: boolean;
  swSupported: boolean;
  swControlled: boolean;
  caches: string[];
  precacheEntries: number | null;
  fsrsChunkCached: boolean | null;
  dbVersion: number;
  dbCards: number;
  persisted: boolean | null;
}

async function collect(): Promise<Diag> {
  const swSupported = 'serviceWorker' in navigator;
  const cacheNames = 'caches' in globalThis ? await caches.keys() : [];
  let precacheEntries: number | null = null;
  let fsrsChunkCached: boolean | null = null;
  const precacheName = cacheNames.find((n) => n.includes('precache'));
  if (precacheName) {
    const keys = await (await caches.open(precacheName)).keys();
    precacheEntries = keys.length;
    // Асинхронный чанк модели FSRS-6 лежит в assets и содержит «fsrs-6» в имени.
    fsrsChunkCached = keys.some((r) => /fsrs-6/i.test(r.url));
  }
  return {
    online: navigator.onLine,
    swSupported,
    swControlled: swSupported && navigator.serviceWorker.controller !== null,
    caches: cacheNames,
    precacheEntries,
    fsrsChunkCached,
    dbVersion: db.verno,
    dbCards: await db.cards.count(),
    persisted: navigator.storage?.persisted ? await navigator.storage.persisted() : null,
  };
}

export function DiagScreen() {
  const [diag, setDiag] = useState<Diag | null>(null);
  const [srsError, setSrsError] = useState<string | null>(null);
  const [srsReady, setSrsReady] = useState(isSrsReady());
  const [prev, setPrev] = useState<SrsPreviewItem[] | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    collect()
      .then((d) => !cancelled && setDiag(d))
      .catch((e: unknown) => !cancelled && setDiagError(errorMessage(e)));
    loadSrs()
      .then(() => {
        if (cancelled) return;
        setSrsReady(true);
        const now = Date.now();
        const p = preview(newState(now), now);
        setPrev([p[1], p[2], p[3], p[4]]);
      })
      .catch((e: unknown) => !cancelled && setSrsError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const info = srsInfo();
  return (
    <Page title="Диагностика" backTo="/">
      <section className={s.block}>
        <h2 className={ui.sectionTitle}>Планировщик FSRS</h2>
        <p data-testid="srs-status">
          Модель {info.model}: {srsReady ? 'загружена' : srsError ? 'ошибка загрузки' : 'загружается…'}
        </p>
        {srsError && <p className={ui.error}>{srsError}</p>}
        {prev && (
          <ul className={s.list} data-testid="srs-preview">
            {prev.map((p) => (
              <li key={p.rating}>
                {RATING_NAMES[p.rating]}: через {formatInterval(p.intervalMs)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={s.block}>
        <h2 className={ui.sectionTitle}>Офлайн и хранилище</h2>
        {diagError ? (
          <p className={ui.error} role="alert">
            Не удалось прочитать состояние хранилища: {diagError}
          </p>
        ) : diag === null ? (
          <p className={ui.muted}>Загрузка…</p>
        ) : (
          <ul className={s.list} data-testid="diag-list">
            <li>Сеть: {diag.online ? 'есть' : 'нет'}</li>
            <li>Service worker: {diag.swSupported ? (diag.swControlled ? 'управляет страницей' : 'не управляет') : 'не поддерживается'}</li>
            <li>Файлов в предзагрузке: {diag.precacheEntries ?? 'нет кеша'}</li>
            <li>Чанк модели FSRS-6 в предзагрузке: {diag.fsrsChunkCached === null ? 'нет кеша' : diag.fsrsChunkCached ? 'да' : 'нет'}</li>
            <li>База: версия схемы {diag.dbVersion} (ожидается {DB_SCHEMA_VERSION}), карточек {diag.dbCards}</li>
            <li>Постоянное хранилище: {diag.persisted === null ? 'неизвестно' : diag.persisted ? 'да' : 'нет'}</li>
          </ul>
        )}
      </section>
    </Page>
  );
}
