import { describe, expect, it } from 'vitest';
import {
  BACKUP_REMINDER_CHANGES,
  BACKUP_REMINDER_DAYS,
  BACKUP_SNOOZE_MS,
  DAY_MS,
  reminderStatus,
  reminderText,
} from './backupReminder';
import type { ReminderInput } from './backupReminder';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const base: ReminderInput = { now: NOW, hasData: true, lastBackupAt: NOW - DAY_MS, changesSinceBackup: 0 };

describe('константы напоминания', () => {
  it('7 дней, 50 изменений, отсрочка сутки', () => {
    expect(BACKUP_REMINDER_DAYS).toBe(7);
    expect(BACKUP_REMINDER_CHANGES).toBe(50);
    expect(BACKUP_SNOOZE_MS).toBe(DAY_MS);
  });
});

describe('когда показывать баннер', () => {
  it('свежая копия и мало изменений: не показывать', () => {
    expect(reminderStatus(base).show).toBe(false);
  });

  it('граница 7 дней: 7 суток минус миллисекунда нет, ровно 7 суток да (при наличии изменений)', () => {
    const edge = NOW - 7 * DAY_MS;
    const changed = { ...base, changesSinceBackup: 1 };
    expect(reminderStatus({ ...changed, lastBackupAt: edge + 1 }).show).toBe(false);
    const hit = reminderStatus({ ...changed, lastBackupAt: edge });
    expect(hit).toMatchObject({ show: true, reason: 'age', daysSince: 7 });
    expect(reminderStatus({ ...changed, lastBackupAt: NOW - 30 * DAY_MS }).show).toBe(true);
  });

  it('прошло 7 дней, но с последней копии ничего не менялось: баннера нет (В5)', () => {
    for (const days of [7, 8, 30, 400]) {
      expect(reminderStatus({ ...base, lastBackupAt: NOW - days * DAY_MS, changesSinceBackup: 0 })).toMatchObject({
        show: false,
        reason: null,
      });
    }
    // Хотя бы одно изменение возвращает причину «age».
    expect(reminderStatus({ ...base, lastBackupAt: NOW - 8 * DAY_MS, changesSinceBackup: 1 })).toMatchObject({ show: true, reason: 'age' });
  });

  it('причина «копий не было» (never) не требует изменений', () => {
    const noBackup: ReminderInput = { now: NOW, hasData: true, changesSinceBackup: 0, oldestDataAt: NOW - 9 * DAY_MS };
    expect(reminderStatus(noBackup)).toMatchObject({ show: true, reason: 'never', daysSince: 9 });
  });

  it('граница 50 изменений: 49 нет, 50 да', () => {
    expect(reminderStatus({ ...base, changesSinceBackup: 49 }).show).toBe(false);
    expect(reminderStatus({ ...base, changesSinceBackup: 50 })).toMatchObject({ show: true, reason: 'changes' });
    expect(reminderStatus({ ...base, changesSinceBackup: 500 }).show).toBe(true);
  });

  it('нет данных: никогда не показывать (ни по дням, ни по изменениям)', () => {
    expect(reminderStatus({ ...base, hasData: false, lastBackupAt: 0, changesSinceBackup: 999 }).show).toBe(false);
  });

  it('копий не было: отсчёт от самой ранней колоды, а не сразу после первой', () => {
    const noBackup: ReminderInput = { now: NOW, hasData: true, changesSinceBackup: 3, oldestDataAt: NOW - 2 * DAY_MS };
    expect(reminderStatus(noBackup).show).toBe(false);
    const old = reminderStatus({ ...noBackup, oldestDataAt: NOW - 7 * DAY_MS });
    expect(old).toMatchObject({ show: true, reason: 'never', daysSince: 7 });
    // Много изменений без единой копии напоминают сразу.
    expect(reminderStatus({ ...noBackup, changesSinceBackup: 50 }).show).toBe(true);
  });

  it('отсрочка: пока snoozeUntil в будущем, не показывать; ровно в момент окончания показывать', () => {
    const due: ReminderInput = { ...base, changesSinceBackup: 60 };
    expect(reminderStatus({ ...due, snoozeUntil: NOW + 1 }).show).toBe(false);
    expect(reminderStatus({ ...due, snoozeUntil: NOW }).show).toBe(true);
    expect(reminderStatus({ ...due, snoozeUntil: NOW - 1 }).show).toBe(true);
    // Сутки отсрочки от момента нажатия: через 24 часа баннер возвращается.
    const snoozeUntil = NOW + BACKUP_SNOOZE_MS;
    expect(reminderStatus({ ...due, now: snoozeUntil - 1, snoozeUntil }).show).toBe(false);
    expect(reminderStatus({ ...due, now: snoozeUntil, snoozeUntil }).show).toBe(true);
  });

  it('отсрочка дальше чем на сутки от «сейчас» недействительна и баннер не прячет (М3)', () => {
    const due: ReminderInput = { ...base, changesSinceBackup: 60 };
    // Ровно сутки вперёд: ещё действует; на миллисекунду дальше: уже нет.
    expect(reminderStatus({ ...due, snoozeUntil: NOW + BACKUP_SNOOZE_MS }).show).toBe(false);
    expect(reminderStatus({ ...due, snoozeUntil: NOW + BACKUP_SNOOZE_MS + 1 }).show).toBe(true);
    expect(reminderStatus({ ...due, snoozeUntil: NOW + 400 * DAY_MS }).show).toBe(true);
    expect(reminderStatus({ ...due, snoozeUntil: Number.MAX_SAFE_INTEGER }).show).toBe(true);
  });

  it('часы ушли назад: дни не отрицательные', () => {
    expect(reminderStatus({ ...base, lastBackupAt: NOW + DAY_MS }).daysSince).toBe(0);
  });
});

describe('тексты баннера по-русски', () => {
  it('по изменениям: склонение', () => {
    expect(reminderText({ show: true, reason: 'changes', daysSince: 1 }, 51)).toContain('51 изменение');
    expect(reminderText({ show: true, reason: 'changes', daysSince: 1 }, 52)).toContain('52 изменения');
    expect(reminderText({ show: true, reason: 'changes', daysSince: 1 }, 55)).toContain('55 изменений');
  });
  it('по возрасту и «копий не было»', () => {
    expect(reminderText({ show: true, reason: 'age', daysSince: 9 }, 0)).toContain('9 дн. назад');
    expect(reminderText({ show: true, reason: 'never', daysSince: 8 }, 0)).toContain('ещё не было');
  });
});
