import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { loadSrs } from './core/srs';
import { registerServiceWorker } from './pwa';
import './styles/tokens.css';
import './styles/base.css';

// Планировщик FSRS создаётся один раз при запуске (модель подгружается динамическим import).
loadSrs().catch((e: unknown) => console.error('Не удалось загрузить планировщик FSRS', e));
registerServiceWorker();

const root = document.getElementById('root');
if (!root) throw new Error('Не найден #root');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <App />
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>,
);
