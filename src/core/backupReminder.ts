// Когда напоминать о резервной копии. Чистая логика, без базы и времени «изнутри» (now приходит снаружи).
import { plural } from './format';

export const DAY_MS = 86_400_000;
/** Напоминать, если с последней копии прошло столько дней (и есть данные). */
export const BACKUP_REMINDER_DAYS = 7;
/** Напоминать, если накопилось столько изменений и больше. */
export const BACKUP_REMINDER_CHANGES = 50;
/** На сколько откладывается баннер по кнопке «Напомнить позже». */
export const BACKUP_SNOOZE_MS = DAY_MS;

export interface ReminderInput {
  now: number;
  /** Есть ли что терять (хотя бы одна колода). Без данных напоминания нет. */
  hasData: boolean;
  /** Время последней сохранённой копии; нет, если копий не было. */
  lastBackupAt?: number;
  /** Самая ранняя дата создания колоды: точка отсчёта, пока копий ещё не было. */
  oldestDataAt?: number;
  changesSinceBackup: number;
  /** До какого момента баннер отложен. */
  snoozeUntil?: number;
}

export type ReminderReason = 'changes' | 'age' | 'never';

export interface ReminderStatus {
  show: boolean;
  reason: ReminderReason | null;
  /** Сколько целых дней прошло с точки отсчёта (с последней копии или с создания первой колоды). */
  daysSince: number | null;
}

/**
 * Правила:
 *  - нет данных: не напоминаем;
 *  - баннер отложен (now < snoozeUntil <= now + сутки): не напоминаем; более далёкая отсрочка недействительна;
 *  - накопилось 50 и более изменений: напоминаем (причина «changes»);
 *  - с последней копии прошло 7 дней и больше И есть хотя бы одно несохранённое изменение: напоминаем (причина «age»);
 *  - копий ещё не было: отсчёт идёт от создания самой ранней колоды (причина «never»), чтобы баннер
 *    не появлялся сразу после первой колоды.
 * Границы включительно: ровно 7 суток и ровно 50 изменений уже дают напоминание.
 */
export function reminderStatus(i: ReminderInput): ReminderStatus {
  const since = i.lastBackupAt ?? i.oldestDataAt;
  const daysSince = since === undefined ? null : Math.max(0, Math.floor((i.now - since) / DAY_MS));
  const none: ReminderStatus = { show: false, reason: null, daysSince };
  if (!i.hasData) return none;
  // Отсрочка действует, только если она в будущем и не дальше чем на сутки от «сейчас»: более далёкая отсрочка
  // (испорченное значение или часы, ушедшие вперёд) недействительна и не должна навсегда прятать баннер.
  if (i.snoozeUntil !== undefined && i.snoozeUntil > i.now && i.snoozeUntil <= i.now + BACKUP_SNOOZE_MS) return none;
  if (i.changesSinceBackup >= BACKUP_REMINDER_CHANGES) return { show: true, reason: 'changes', daysSince };
  if (since !== undefined && i.now - since >= BACKUP_REMINDER_DAYS * DAY_MS) {
    // Копий не было вообще: напоминаем и без изменений. Копия есть, но устарела: только если после неё что-то менялось.
    if (i.lastBackupAt === undefined) return { show: true, reason: 'never', daysSince };
    if (i.changesSinceBackup > 0) return { show: true, reason: 'age', daysSince };
  }
  return none;
}

/** Текст баннера. */
export function reminderText(status: ReminderStatus, changes: number): string {
  if (status.reason === 'changes') {
    return `С последней копии накопилось ${changes} ${plural(changes, 'изменение', 'изменения', 'изменений')}. Сохраните копию, чтобы не потерять слова.`;
  }
  if (status.reason === 'never') {
    return 'Резервной копии ещё не было. Если iPhone очистит данные приложения, слова пропадут. Сохраните копию.';
  }
  const days = status.daysSince ?? BACKUP_REMINDER_DAYS;
  return `Последняя копия была ${days} дн. назад. Сохраните новую, чтобы не потерять слова.`;
}
