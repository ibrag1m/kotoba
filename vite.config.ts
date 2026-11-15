import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

// Адрес приложения на GitHub Pages: https://<логин>.github.io/kotoba/
// Менять путь после первой публикации нельзя: данные в IndexedDB привязаны к адресу.
const base = process.env.BASE_PATH ?? '/kotoba/';

// Версия приложения из package.json: показывается в «Настройках» и записывается в файл резервной копии.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      // Обновление не молча: новый service worker ждёт, пока приложение само его активирует.
      registerType: 'prompt',
      // Регистрируем вручную в src/pwa.ts.
      injectRegister: null,
      manifest: {
        id: base,
        name: 'Kotoba — японские слова',
        short_name: 'Kotoba',
        description: 'Карточки для заучивания японских слов (N5), без подписки и без сервера.',
        lang: 'ru',
        // standalone, а не minimal-ui (баг WebKit 232302).
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        background_color: '#f6f3ec',
        theme_color: '#1f4e79',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Без дублей: иконки манифеста берутся по маске png, сам манифест добавляет плагин.
      includeManifestIcons: false,
      workbox: {
        // Предзагрузка ВСЕХ файлов сборки, включая асинхронные чанки моделей ts-fsrs.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
  },
});
