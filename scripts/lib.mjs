// Небольшие помощники для скриптов проверки (отдельно, чтобы их можно было проверить тестом).
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Лежит ли file внутри каталога root (или это сам root).
 * Проверка через path.relative, а не startsWith: «dist-evil» не проходит как «dist».
 */
export function isInside(root, file) {
  const rel = relative(resolve(root), resolve(file));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Разбирает содержимое файла DevToolsActivePort, который Chrome кладёт в профиль при
 * --remote-debugging-port=0: первая строка — порт, вторая — путь браузерного WebSocket.
 */
export function parseDevToolsActivePort(content) {
  const [portLine, wsPath] = String(content).split(/\r?\n/);
  const port = Number.parseInt(portLine ?? '', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { port, wsPath: wsPath ?? '' };
}
