import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import ui from '../styles/ui.module.css';

interface PageProps {
  title: string;
  /** Куда ведёт стрелка «назад»; без неё стрелки нет. */
  backTo?: string;
  extra?: ReactNode;
  children: ReactNode;
  /** Прижатая к низу панель действий. */
  actions?: ReactNode;
}

export function Page({ title, backTo, extra, children, actions }: PageProps) {
  return (
    <div className={ui.page}>
      <header className={ui.header}>
        {backTo && (
          <Link to={backTo} className={ui.back} aria-label="Назад">
            ←
          </Link>
        )}
        <h1 className={ui.title}>{title}</h1>
        {extra && <span className={ui.headerExtra}>{extra}</span>}
      </header>
      <main className={ui.main}>{children}</main>
      {actions && <div className={ui.actionBar}>{actions}</div>}
    </div>
  );
}
