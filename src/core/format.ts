/** Человекочитаемый интервал по-русски: «10 мин», «2 дн.», «1,5 мес.». */
export function formatInterval(ms: number): string {
  const min = ms / 60_000;
  if (min < 1) return 'меньше минуты';
  if (min < 60) return `${Math.round(min)} мин`;
  const hours = min / 60;
  if (hours < 24) return `${Math.round(hours)} ч`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)} дн.`;
  const months = days / 30;
  if (months < 12) return `${(Math.round(months * 10) / 10).toString().replace('.', ',')} мес.`;
  return `${(Math.round((days / 365) * 10) / 10).toString().replace('.', ',')} г.`;
}

/** Склонение: plural(5, 'карточка', 'карточки', 'карточек') -> 'карточек'. */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** «14 ноября 2026 г.» по местному времени устройства. */
export function formatDateRu(ms: number): string {
  return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** «14 ноября 2026 г., 20:15» по местному времени устройства. */
export function formatDateTimeRu(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${formatDateRu(ms)}, ${time}`;
}
