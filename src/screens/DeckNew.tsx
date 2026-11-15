import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Page } from '../components/Page';
import { db } from '../db/db';
import { createDeck } from '../db/repo';
import { persistOnFirstSave } from '../storage';
import ui from '../styles/ui.module.css';

export function DeckNew() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Язык слова ja-JP, язык определения ru-RU (решения пользователя, раздел 10).
      const deck = await createDeck(db, { name });
      persistOnFirstSave();
      void navigate(`/deck/${deck.id}/import`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать колоду');
      setBusy(false);
    }
  }

  return (
    <Page title="Новая колода" backTo="/">
      <form onSubmit={onSubmit} className={ui.main}>
        <label className={ui.field}>
          <span className={ui.label}>Название</span>
          <input
            className={ui.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например: N5, глаголы"
            autoComplete="off"
            autoCapitalize="sentences"
            enterKeyHint="done"
            maxLength={100}
            autoFocus
          />
        </label>
        <p className={ui.hint}>Язык слов: японский. Перевод: русский.</p>
        {error && <p className={ui.error}>{error}</p>}
        <button type="submit" className={`${ui.btn} ${ui.primary}`} disabled={name.trim() === '' || busy}>
          Создать и добавить слова
        </button>
      </form>
    </Page>
  );
}
