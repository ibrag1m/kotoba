import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Page } from '../components/Page';
import { db } from '../db/db';
import { addCards, getDeck, listCards } from '../db/repo';
import { persistOnFirstSave } from '../storage';
import { duplicateKey, parseImport } from '../core/importParser';
import type {
  ColumnDelimiterChoice,
  ColumnsChoice,
  ResolvedColumnDelimiter,
  ResolvedRowDelimiter,
  RowDelimiterChoice,
} from '../core/importParser';
import { plural } from '../core/format';
import ui from '../styles/ui.module.css';
import s from './ImportScreen.module.css';

const COLUMN_NAMES: Record<ResolvedColumnDelimiter, string> = {
  tab: 'табуляция',
  comma: 'запятая',
  dash: 'тире',
  space: 'пробелы',
  custom: 'свой',
};
const ROW_NAMES: Record<ResolvedRowDelimiter, string> = {
  newline: 'новая строка',
  semicolon: 'точка с запятой',
  custom: 'свой',
};

const PREVIEW_LIMIT = 50;
const ISSUES_LIMIT = 30;
const PLACEHOLDER = '食べる\tたべる\tесть\n水\tみず\tвода\n大きい\tбольшой';

export function ImportScreen() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const deck = useLiveQuery(async () => (await getDeck(db, id)) ?? null, [id]);
  const existing = useLiveQuery(() => listCards(db, id), [id]);

  const [text, setText] = useState('');
  const [colChoice, setColChoice] = useState<ColumnDelimiterChoice>('auto');
  const [customCol, setCustomCol] = useState('');
  const [rowChoice, setRowChoice] = useState<RowDelimiterChoice>('auto');
  const [customRow, setCustomRow] = useState('');
  const [columns, setColumns] = useState<ColumnsChoice>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existingKeys = useMemo(
    () => new Set((existing ?? []).map((c) => duplicateKey(c.term, c.reading))),
    [existing],
  );

  const result = useMemo(
    () =>
      parseImport(text, {
        columnDelimiter: colChoice,
        customColumnDelimiter: customCol,
        rowDelimiter: rowChoice,
        customRowDelimiter: customRow,
        columns,
        existingKeys,
      }),
    [text, colChoice, customCol, rowChoice, customRow, columns, existingKeys],
  );

  if (deck === undefined) {
    return (
      <Page title="Импорт" backTo={`/deck/${id}`}>
        <p className={ui.muted}>Загрузка…</p>
      </Page>
    );
  }
  if (deck === null) {
    return (
      <Page title="Колода не найдена" backTo="/">
        <p className={ui.muted}>Такой колоды нет.</p>
      </Page>
    );
  }

  const count = result.rows.length;
  const hasText = text.trim() !== '';

  async function onAdd() {
    if (count === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addCards(
        db,
        id,
        result.rows.map(({ term, reading, definition }) => ({ term, reading, definition })),
      );
      persistOnFirstSave();
      void navigate(`/deck/${id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось добавить карточки');
      setBusy(false);
    }
  }

  const detected =
    `${result.columnDelimiter ? COLUMN_NAMES[result.columnDelimiter] : 'не найден'}; ` +
    `карточки: ${ROW_NAMES[result.rowDelimiter]}`;

  return (
    <Page
      title="Добавить слова"
      backTo={`/deck/${id}`}
      extra={deck.name}
      actions={
        <button
          type="button"
          className={`${ui.btn} ${ui.primary}`}
          disabled={count === 0 || busy}
          onClick={() => void onAdd()}
        >
          {count === 0 ? 'Добавить' : `Добавить ${count} ${plural(count, 'карточку', 'карточки', 'карточек')}`}
        </button>
      }
    >
      <label className={ui.field}>
        <span className={ui.label}>Вставьте слова</span>
        <textarea
          className={ui.textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <span className={ui.hint}>
          Одна карточка в строке: слово, чтение (необязательно), перевод. Между ними табуляция, запятая (, или 、),
          тире с пробелами ( - ), два пробела или полноширинный пробел. Чтение пишите только каной (или в
          скобках после слова: 今日（きょう）); если вместо каны стоит другое, строка не добавится.
        </span>
      </label>

      <details className={s.details}>
        <summary>Разделители (определено: {detected})</summary>
        <div className={s.settings}>
          <label className={ui.field}>
            <span className={ui.label}>Между словом и переводом</span>
            <select
              className={ui.select}
              value={colChoice}
              onChange={(e) => setColChoice(e.target.value as ColumnDelimiterChoice)}
            >
              <option value="auto">Определить автоматически</option>
              <option value="tab">Табуляция</option>
              <option value="comma">Запятая</option>
              <option value="dash">Тире с пробелами ( - )</option>
              <option value="space">Пробелы (два и более или полноширинный)</option>
              <option value="custom">Свой…</option>
            </select>
          </label>
          {colChoice === 'custom' && (
            <input
              className={ui.input}
              value={customCol}
              onChange={(e) => setCustomCol(e.target.value)}
              placeholder="Свой разделитель, например =>"
              aria-label="Свой разделитель слова и перевода"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          )}
          <label className={ui.field}>
            <span className={ui.label}>Между карточками</span>
            <select
              className={ui.select}
              value={rowChoice}
              onChange={(e) => setRowChoice(e.target.value as RowDelimiterChoice)}
            >
              <option value="auto">Определить автоматически</option>
              <option value="newline">Новая строка</option>
              <option value="semicolon">Точка с запятой</option>
              <option value="custom">Свой…</option>
            </select>
          </label>
          {rowChoice === 'custom' && (
            <input
              className={ui.input}
              value={customRow}
              onChange={(e) => setCustomRow(e.target.value)}
              placeholder="Свой разделитель карточек, например |"
              aria-label="Свой разделитель карточек"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          )}
          <label className={ui.field}>
            <span className={ui.label}>Колонок</span>
            <select
              className={ui.select}
              value={String(columns)}
              onChange={(e) => {
                const v = e.target.value;
                setColumns(v === '2' ? 2 : v === '3' ? 3 : 'auto');
              }}
            >
              <option value="auto">Автоматически (три, если вторая колонка кана; с табуляцией: три колонки)</option>
              <option value="2">2: слово, перевод</option>
              <option value="3">3: слово, чтение (кана), перевод</option>
            </select>
          </label>
        </div>
      </details>

      {error && <p className={ui.error}>{error}</p>}

      {hasText && (
        <section className={s.preview} aria-label="Предпросмотр">
          <h2 className={ui.sectionTitle}>
            Распознано: {count}
            {result.issues.length > 0 && ` · проблемных: ${result.issues.length}`}
          </h2>
          {result.warnings.map((w) => (
            <p key={w.kind} className={s.warning} role="status">
              {w.message}
            </p>
          ))}
          {result.emptyLines > 0 && <p className={ui.hint}>Пустых строк пропущено: {result.emptyLines}</p>}

          {count > 0 && (
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Слово</th>
                    <th>Чтение</th>
                    <th>Перевод</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, PREVIEW_LIMIT).map((r) => (
                    <tr key={r.line}>
                      <td lang="ja" className={s.term}>
                        {r.term}
                      </td>
                      <td lang="ja">{r.reading ?? ''}</td>
                      <td>{r.definition}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {count > PREVIEW_LIMIT && <p className={ui.hint}>…и ещё {count - PREVIEW_LIMIT}</p>}
            </div>
          )}

          {result.issues.length > 0 && (
            <div className={s.issues}>
              <h3 className={ui.label}>Эти строки не будут добавлены</h3>
              <ul className={s.issueList}>
                {result.issues.slice(0, ISSUES_LIMIT).map((i) => (
                  <li key={`${i.line}-${i.kind}`}>
                    <span className={s.issueLine}>Строка {i.line}:</span> {i.message}
                    <div className={s.issueRaw}>{i.raw}</div>
                  </li>
                ))}
              </ul>
              {result.issues.length > ISSUES_LIMIT && (
                <p className={ui.hint}>…и ещё {result.issues.length - ISSUES_LIMIT}</p>
              )}
            </div>
          )}
        </section>
      )}
    </Page>
  );
}
