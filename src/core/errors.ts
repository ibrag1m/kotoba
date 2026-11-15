// Обработка ошибок базы: понятный текст для экрана и единая обёртка «выполнить и не упасть».

/** Текст ошибки для показа (и для журнала): сообщение, а не «[object Object]». */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string' && err !== '') return err;
  return 'неизвестная ошибка';
}

export type ActionResult = { ok: true } | { ok: false; message: string };

/** Выполняет действие с базой; ошибку возвращает значением, чтобы экран мог её показать. */
export async function attempt(action: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await action();
    return { ok: true };
  } catch (err) {
    console.error('Операция с базой не удалась', err);
    return { ok: false, message: errorMessage(err) };
  }
}

/** Что показать, если не удалось удалить колоду. Транзакция откатывается, данные целы. */
export function deleteDeckErrorText(message: string): string {
  return `Не удалось удалить колоду. Ничего не изменилось, можно попробовать ещё раз. (${message})`;
}
