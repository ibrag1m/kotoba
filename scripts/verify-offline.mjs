// Автоматическая проверка офлайн-режима собранной версии (dist/) без Playwright.
// Что делает:
//  1. поднимает свой статический сервер на 127.0.0.1 (только localhost, случайный порт) и отдаёт dist/ по пути /kotoba/;
//  2. запускает Chrome/Edge в headless-режиме с чистым временным профилем и управляет им по DevTools Protocol
//     (порт отладки случайный: --remote-debugging-port=0, порт читается из файла DevToolsActivePort профиля);
//  3. онлайн: ждёт установки service worker и предзагрузки, создаёт колоду, вставляет слова, листает карточки;
//  4. останавливает сервер, ПЕРЕЗАПУСКАЕТ браузер (тот же профиль), открывает приложение без сети:
//     проверяет, что страница, данные в IndexedDB и асинхронная модель FSRS-6 работают офлайн
//     и что чанк модели отдан именно service worker-ом.
// Запуск: npm run build && npm run verify:offline   (путь к браузеру: переменная CHROME_PATH)
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInside, parseDevToolsActivePort } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const BASE = '/kotoba/';
// Порт приложения выбирает система (порт 0) при первом запуске сервера и сохраняется:
// во второй фазе браузер должен открыть тот же адрес (IndexedDB привязана к адресу и порту).
let appPort = 0;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('Не найден Chrome/Edge. Задайте CHROME_PATH.');
  process.exit(2);
}
if (!existsSync(join(dist, 'sw.js'))) {
  console.error('Нет dist/. Сначала: npm run build');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'ок   ' : 'ОШИБКА'}: ${msg}${extra ? ` (${extra})` : ''}`);
  if (!cond) failures++;
};

// ---------- статический сервер ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const sockets = new Set();
let server = null;
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith(BASE)) {
        res.writeHead(404).end();
        return;
      }
      const rel = normalize(decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html');
      const file = join(dist, rel);
      if (!isInside(dist, file) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(readFileSync(file));
    });
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    server.listen(appPort, '127.0.0.1', () => {
      appPort = server.address().port;
      resolve();
    });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    server.close(() => resolve());
    for (const s of sockets) s.destroy();
  });
}

// ---------- Chrome + CDP ----------
const profile = mkdtempSync(join(tmpdir(), 'kotoba-offline-'));
let chrome = null;
async function launchChrome() {
  // Файл от прошлого запуска (профиль общий для двух фаз) устарел: удаляем, чтобы не прочитать чужой порт.
  const portFile = join(profile, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=390,844',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 150; i++) {
    try {
      const active = existsSync(portFile) ? parseDevToolsActivePort(readFileSync(portFile, 'utf8')) : null;
      if (active) {
        const r = await fetch(`http://127.0.0.1:${active.port}/json/list`);
        const list = await r.json();
        const page = list.find((t) => t.type === 'page');
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      /* ждём */
    }
    await sleep(100);
  }
  throw new Error('Chrome не запустился');
}
// Chrome запускает много процессов (GPU, сеть, рендереры). Простой p.kill() оставляет их работать
// и держать профиль, поэтому на Windows убиваем всё дерево процессов.
async function killChrome() {
  if (!chrome) return;
  const p = chrome;
  chrome = null;
  const done = new Promise((r) => p.once('exit', r));
  if (process.platform === 'win32' && p.pid) {
    spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    p.kill('SIGKILL');
  }
  await Promise.race([done, sleep(3000)]);
  await sleep(500); // освободить профиль
}

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(h) {
    this.handlers.push(h);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expression, what, timeout = 15000) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(150);
    }
    throw new Error(`Не дождались: ${what} (последнее значение: ${JSON.stringify(last)})`);
  }
  close() {
    this.ws.close();
  }
}

// Помощники работы со страницей (выполняются внутри страницы)
const setValue = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;
const clickText = (text, tag = 'button,a') => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(tag)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}));
  if (!el) return false;
  el.click();
  return true;
})()`;
const bodyText = `document.body.innerText`;

async function open(wsUrl) {
  const cdp = new Cdp(wsUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  // Экран iPhone: 390x844, плотность 2, мобильный режим.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  return cdp;
}

// Скриншоты (необязательно): SCREENSHOT_DIR=путь node scripts/verify-offline.mjs
async function shot(cdp, name) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await sleep(300);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, name + '.png'), Buffer.from(r.data, 'base64'));
}

const expectedPrecache = (() => {
  const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
  const m = sw.match(/precacheAndRoute\(\[(.*?)\],\{/s);
  return new Set([...m[1].matchAll(/url:"([^"]+)"/g)].map((x) => x[1])).size;
})();

async function main() {
  await startServer();

  // ===== Фаза 1: онлайн =====
  console.log('Фаза 1: онлайн, первая загрузка');
  let cdp = await open(await launchChrome());
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${appPort}${BASE}` });
  await cdp.waitFor(`document.body.innerText.includes('Kotoba')`, 'загрузка главной');

  await cdp.waitFor(`navigator.serviceWorker.ready.then(() => !!navigator.serviceWorker.controller)`, 'service worker управляет страницей', 20000);
  check(true, 'service worker активирован и управляет страницей');

  const cacheInfo = await cdp.waitFor(
    `caches.keys().then(async (names) => {
      const n = names.find((x) => x.includes('precache'));
      if (!n) return null;
      const keys = await (await caches.open(n)).keys();
      return keys.length >= ${expectedPrecache} ? { count: keys.length, urls: keys.map((k) => new URL(k.url).pathname) } : null;
    })`,
    'предзагрузка всех файлов',
    20000,
  );
  check(cacheInfo.count === expectedPrecache, `кеш предзагрузки содержит ${cacheInfo.count} файлов из ${expectedPrecache}`);
  const fsrs6Url = cacheInfo.urls.find((u) => /\/assets\/fsrs-6-[^/]+\.js$/.test(u));
  check(Boolean(fsrs6Url), 'чанк модели FSRS-6 лежит в кеше service worker', fsrs6Url);

  // Создание колоды через интерфейс
  await cdp.eval(`location.hash = '#/deck/new'`);
  await cdp.waitFor(`document.querySelector('input') !== null`, 'форма новой колоды');
  await cdp.eval(setValue('input', 'N5 глаголы'));
  await cdp.waitFor(`(() => { const b = document.querySelector('button[type=submit]'); return b && !b.disabled; })()`, 'кнопка создания активна');
  await cdp.eval(`document.querySelector('button[type=submit]').click()`);
  await cdp.waitFor(`/#\\/deck\\/[0-9a-f-]+\\/import$/.test(location.hash)`, 'переход на импорт');
  const deckId = await cdp.eval(`location.hash.match(/deck\\/([0-9a-f-]+)\\//)[1]`);

  const words = '食べる\tたべる\tесть\n水\tみず\tвода\n大きい\tおおきい\tбольшой\n猫\tねこ\tкошка, кот\n\n水\tみず\tвода';
  await cdp.waitFor(`document.querySelector('textarea') !== null`, 'поле импорта');
  await cdp.eval(setValue('textarea', words));
  const previewText = await cdp.waitFor(`document.body.innerText.includes('Распознано: 4') ? document.body.innerText : null`, 'предпросмотр: 4 карточки');
  await shot(cdp, '2-import');
  check(/проблемных: 1/.test(previewText), 'дубль помечен как проблемная строка');
  check(/Добавить 4 карточки/.test(previewText), 'кнопка «Добавить 4 карточки»');
  await cdp.eval(clickText('Добавить 4'));
  await cdp.waitFor(`location.hash === '#/deck/${deckId}'`, 'возврат в колоду');
  const deckText = await cdp.waitFor(`document.body.innerText.includes('большой') ? document.body.innerText : null`, 'список карточек');
  await shot(cdp, '3-deck');
  check(['食べる', 'たべる', 'есть', '水', 'вода', 'кошка, кот'].every((w) => deckText.includes(w)), 'карточки показаны в списке колоды');

  // Режим «Карточки»
  await cdp.eval(clickText('Карточки'));
  await cdp.waitFor(`location.hash === '#/deck/${deckId}/cards'`, 'экран Карточки');
  await cdp.waitFor(`document.body.innerText.includes('1 / 4')`, 'счётчик 1 / 4');
  let t = await cdp.eval(bodyText);
  check(t.includes('食べる') && !t.includes('есть'), 'лицевая сторона: слово без перевода');
  await shot(cdp, '4-card-front');
  await cdp.eval(`document.querySelector('[aria-label="Перевернуть карточку"]').click()`);
  t = await cdp.waitFor(`document.body.innerText.includes('есть') ? document.body.innerText : null`, 'переворот карточки');
  await shot(cdp, '5-card-back');
  check(t.includes('たべる') && t.includes('есть'), 'оборот: чтение и перевод');
  await cdp.eval(clickText('Ещё учу'));
  await cdp.waitFor(`document.body.innerText.includes('2 / 4')`, 'вторая карточка после «Ещё учу»');
  for (const label of ['Знаю', 'Знаю', 'Знаю']) await cdp.eval(clickText(label));
  t = await cdp.waitFor(`document.body.innerText.includes('Итог') ? document.body.innerText : null`, 'итог');
  await shot(cdp, '6-summary');
  check(/Знаю: 3 из 4/.test(t) && /Ещё учу: 1/.test(t), 'итог: знаю 3 из 4, ещё учу 1');
  await cdp.eval(clickText('Ещё учу ('));
  t = await cdp.waitFor(`document.body.innerText.includes('1 / 1') ? document.body.innerText : null`, 'повтор только «ещё учу»');
  check(t.includes('食べる'), 'в новом круге осталась карточка «食べる»');

  // Диагностика онлайн
  await cdp.eval(`location.hash = '#/diag'`);
  t = await cdp.waitFor(`document.body.innerText.includes('FSRS-6: загружена') ? document.body.innerText : null`, 'FSRS-6 загружена (онлайн)');
  check(/Хорошо: через 10 мин/.test(t) && /Легко: через 8 дн\./.test(t), 'preview оценок: 10 мин и 8 дн.');
  t = await cdp.waitFor(`/карточек 4/.test(document.body.innerText) ? document.body.innerText : null`, 'диагностика: данные базы');
  check(t.includes('версия схемы 1 (ожидается 1)'), 'версия схемы базы 1');
  await shot(cdp, '7-diag');
  check(/карточек 4/.test(t), 'в базе 4 карточки');

  cdp.close();
  await killChrome();

  // ===== Фаза 2: сервер остановлен, браузер перезапущен =====
  console.log('Фаза 2: сервер остановлен, браузер перезапущен (офлайн)');
  await stopServer();
  let reachable = true;
  try {
    await fetch(`http://127.0.0.1:${appPort}${BASE}`, { signal: AbortSignal.timeout(1500) });
  } catch {
    reachable = false;
  }
  check(!reachable, `сервер на 127.0.0.1:${appPort} недоступен`);

  cdp = await open(await launchChrome());
  const requests = new Map();
  const failed = [];
  cdp.on((msg) => {
    if (msg.method === 'Network.responseReceived') {
      requests.set(msg.params.response.url, { fromSW: msg.params.response.fromServiceWorker, status: msg.params.response.status });
    }
    if (msg.method === 'Network.loadingFailed') failed.push(msg.params);
  });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${appPort}${BASE}` });
  t = await cdp.waitFor(`document.body.innerText.includes('N5 глаголы') ? document.body.innerText : null`, 'главная офлайн: колода на месте');
  await shot(cdp, '8-home-offline');
  check(/4 карточки/.test(t), 'офлайн: колода «N5 глаголы» и 4 карточки на месте (данные в IndexedDB)');

  const html = [...requests.entries()].find(([u]) => u.endsWith(BASE));
  check(Boolean(html) && html[1].fromSW === true, 'офлайн: страница отдана service worker-ом');

  await cdp.eval(`location.hash = '#/deck/${deckId}/cards'`);
  await cdp.waitFor(`document.body.innerText.includes('1 / 4')`, 'Карточки офлайн');
  t = await cdp.eval(bodyText);
  check(t.includes('食べる'), 'офлайн: режим «Карточки» работает');

  await cdp.eval(`location.hash = '#/diag'`);
  t = await cdp.waitFor(`document.body.innerText.includes('FSRS-6: загружена') ? document.body.innerText : null`, 'FSRS-6 загружена офлайн', 20000);
  check(true, 'офлайн: планировщик FSRS-6 загружен (асинхронная модель)');
  check(/Снова: через 1 мин/.test(t) && /Трудно: через 6 мин/.test(t) && /Хорошо: через 10 мин/.test(t) && /Легко: через 8 дн\./.test(t), 'офлайн: preview оценок посчитан');

  const fsrsReq = [...requests.entries()].filter(([u]) => /\/assets\/fsrs-6-[^/]+\.js$/.test(u));
  check(fsrsReq.length === 1 && fsrsReq[0][1].fromSW === true && fsrsReq[0][1].status === 200, 'чанк модели FSRS-6 запрошен офлайн и отдан service worker-ом', fsrsReq[0]?.[0]);
  const notFromSW = [...requests.entries()].filter(([u, r]) => u.startsWith(`http://127.0.0.1:${appPort}`) && !r.fromSW);
  check(notFromSW.length === 0, 'офлайн: ни один файл приложения не пришёл мимо service worker-а', notFromSW.map(([u]) => u).join(', '));
  check(failed.length === 0, 'офлайн: нет неудавшихся сетевых запросов', JSON.stringify(failed.map((f) => f.errorText)));

  cdp.close();
  await killChrome();
}

try {
  await main();
} catch (e) {
  failures++;
  console.error('СБОЙ:', e.message);
} finally {
  await killChrome();
  if (server?.listening) await stopServer();
  // Временный профиль удаляем всегда; Chrome мог ещё держать файлы, поэтому с повторами.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    console.warn(`Не удалось удалить временный профиль ${profile}: ${e.message}`);
  }
}
console.log(failures === 0 ? '\nОфлайн-проверка пройдена.' : `\nОфлайн-проверка НЕ пройдена: ошибок ${failures}`);
process.exit(failures === 0 ? 0 : 1);
