import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { errorMessage } from '../core/errors';
import ui from '../styles/ui.module.css';
import s from './ErrorBoundary.module.css';

/** Что видит пользователь, когда экран упал (ошибка рендера или базы данных). */
export function ErrorFallback({ error, onReload }: { error: unknown; onReload: () => void }) {
  return (
    <div className={s.wrap} role="alert">
      <h1 className={s.title}>Что-то пошло не так</h1>
      <p>
        Приложение не смогло показать этот экран. Нажмите «Перезагрузить». Если ошибка повторяется, закройте
        приложение полностью и откройте его снова.
      </p>
      <p className={ui.hint}>Подробности: {errorMessage(error)}</p>
      <button type="button" className={`${ui.btn} ${ui.primary}`} onClick={onReload}>
        Перезагрузить
      </button>
    </div>
  );
}

interface Props {
  children: ReactNode;
  /** Перезагрузка страницы; в тестах подменяется. */
  onReload?: () => void;
}
interface State {
  error: unknown;
  failed: boolean;
}

/**
 * Ловит ошибки отрисовки, в том числе ошибки базы данных из useLiveQuery
 * (он перебрасывает их во время рендера), чтобы вместо белого экрана или вечной «Загрузки…»
 * было понятное сообщение.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Ошибка интерфейса', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <ErrorFallback error={this.state.error} onReload={this.props.onReload ?? (() => location.reload())} />;
    }
    return this.props.children;
  }
}
