// Ключи таблицы meta (ключ-значение) и разделение их на два рода.

/** Дата последней сохранённой копии (мс UTC). Состояние устройства, в копию не попадает. */
export const META_LAST_BACKUP_AT = 'lastBackupAt';
/**
 * Монотонный номер изменения данных: растёт на каждое изменение, в той же транзакции, что и сама правка.
 * Состояние устройства, в копию не попадает. Никогда не уменьшается.
 */
export const META_CHANGE_SEQ = 'changeSeq';
/**
 * Номер изменения, которое уже вошло в сохранённую копию (наибольший из подтверждённых снимков).
 * «Несохранённых изменений» = changeSeq − backedUpSeq. Состояние устройства, в копию не попадает.
 */
export const META_BACKED_UP_SEQ = 'backedUpSeq';
/**
 * СТАРЫЙ счётчик «изменений с последней копии» (до перехода на changeSeq/backedUpSeq).
 * Только для миграции у существующих устройств: читается, если новых ключей ещё нет, и затем удаляется.
 */
export const META_CHANGES_SINCE_BACKUP = 'changesSinceBackup';
/** До какого момента (мс UTC) баннер напоминания отложен. Состояние устройства. */
export const META_BACKUP_SNOOZE_UNTIL = 'backupSnoozeUntil';
/** Результат запроса постоянного хранилища: { result, at }. Состояние устройства. */
export const META_PERSIST_RESULT = 'persistResult';

/**
 * Настройки пользователя: ЭТО входит в резервную копию, и их изменение считается изменением данных
 * (увеличивает changeSeq). Остальные ключи meta принадлежат устройству, в файл не пишутся.
 * `installHintDismissed` намеренно не здесь: подсказка относится к конкретной установке на экран «Домой».
 */
export const BACKED_UP_META_KEYS = ['dailyNewLimit', 'answerDirection', 'voiceByLang'] as const;
export type BackedUpMetaKey = (typeof BACKED_UP_META_KEYS)[number];

export function isBackedUpMetaKey(key: string): key is BackedUpMetaKey {
  return (BACKED_UP_META_KEYS as readonly string[]).includes(key);
}

/** Допустимые значения настройки «направление ответа» (раздел 10 архитектуры: по умолчанию оба, вперемешку). */
export const ANSWER_DIRECTIONS = ['both', 'term-to-def', 'def-to-term'] as const;
export type AnswerDirectionSetting = (typeof ANSWER_DIRECTIONS)[number];

/** Пределы настроек: их же проверяет импорт копии. */
export const DAILY_NEW_LIMIT_MAX = 1000;
export const VOICE_KEY_MAX_LENGTH = 64;
export const VOICE_VALUE_MAX_LENGTH = 64;
export const VOICE_MAX_ENTRIES = 200;
