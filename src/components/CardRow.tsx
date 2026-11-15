import type { CardContent } from '../db/types';
import s from './CardRow.module.css';

/** Строка карточки в списке: слово крупно, чтение и перевод рядом. */
export function CardRow({ card }: { card: CardContent }) {
  return (
    <div className={s.row}>
      <div className={s.termBlock} lang="ja">
        <span className={s.term}>{card.term}</span>
        {card.reading && <span className={s.reading}>{card.reading}</span>}
      </div>
      <div className={s.definition}>{card.definition}</div>
    </div>
  );
}
