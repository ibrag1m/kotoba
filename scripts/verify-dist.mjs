// Проверка собранной версии (dist/): всё ли попадёт в предзагрузку service worker,
// включая асинхронные чанки моделей ts-fsrs. Запуск: npm run build && npm run verify:dist
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const errors = [];
const fail = (msg) => errors.push(msg);
const ok = (msg) => console.log('  ок:', msg);

if (!existsSync(join(dist, 'sw.js'))) {
  console.error('Нет dist/sw.js. Сначала выполните: npm run build');
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p) => relative(dist, p).split('\\').join('/');

// 1. Манифест предзагрузки из sw.js
const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
const m = sw.match(/precacheAndRoute\(\[(.*?)\],\{/s);
if (!m) {
  console.error('Не найден список precacheAndRoute в dist/sw.js');
  process.exit(1);
}
const precacheList = [...m[1].matchAll(/url:"([^"]+)"/g)].map((x) => x[1]);
const precache = new Set(precacheList);
console.log(`Предзагрузка: ${precache.size} файлов`);
if (precacheList.length !== precache.size) {
  const dups = precacheList.filter((u, i) => precacheList.indexOf(u) !== i);
  fail(`В предзагрузке есть дубли: ${[...new Set(dups)].join(', ')}`);
} else ok('в списке предзагрузки нет дублей');

// 2. Все файлы dist (кроме самого sw и его рантайма) должны быть в предзагрузке
const files = walk(dist)
  .map(rel)
  .filter((f) => f !== 'sw.js' && !/^workbox-[^/]+\.js$/.test(f));
const notCached = files.filter((f) => !precache.has(f));
if (notCached.length) fail(`Файлы dist не в предзагрузке: ${notCached.join(', ')}`);
else ok(`все ${files.length} файлов dist (кроме sw.js и workbox-*.js) есть в предзагрузке`);

// 3. Все записи предзагрузки существуют на диске
const missing = [...precache].filter((u) => !existsSync(join(dist, u)));
if (missing.length) fail(`В предзагрузке есть несуществующие файлы: ${missing.join(', ')}`);
else ok('все записи предзагрузки существуют в dist');

// 4. Асинхронные чанки: на каждый import("./x.js") должен быть файл в предзагрузке
const jsFiles = files.filter((f) => f.endsWith('.js'));
const dynamicTargets = new Map();
for (const f of jsFiles) {
  const src = readFileSync(join(dist, f), 'utf8');
  for (const d of src.matchAll(/import\(\s*["'`]\.\/([^"'`]+)["'`]\s*\)/g)) {
    const target = join(dirname(f), d[1]).split('\\').join('/');
    dynamicTargets.set(target, f);
  }
}
console.log(`Динамических import() между чанками: ${dynamicTargets.size}`);
for (const [target, from] of dynamicTargets) {
  if (!precache.has(target)) fail(`Асинхронный чанк ${target} (из ${from}) не в предзагрузке`);
}
if ([...dynamicTargets.keys()].every((t) => precache.has(t))) ok('все асинхронные чанки в предзагрузке');

const fsrs6 = [...dynamicTargets.keys()].find((t) => /\/fsrs-6-[^/]+\.js$/.test(t));
if (!fsrs6) fail('Не найден асинхронный чанк модели FSRS-6 (assets/fsrs-6-*.js)');
else if (!precache.has(fsrs6)) fail(`Чанк модели FSRS-6 ${fsrs6} не в предзагрузке`);
else ok(`чанк модели FSRS-6 (${fsrs6}) загружается динамически и лежит в предзагрузке`);

// 4a. Тестовая функция resetSrsForTests не должна попадать в продакшн-сборку
// (её сообщение об ошибке было бы в бандле, если бы функция не выкинулась tree-shaking-ом).
const leaked = jsFiles.filter((f) => readFileSync(join(dist, f), 'utf8').includes('resetSrsForTests'));
if (leaked.length) fail(`В продакшн-сборке есть resetSrsForTests: ${leaked.join(', ')}`);
else ok('resetSrsForTests отсутствует в продакшн-сборке');

// 5. Манифест приложения
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
if (manifest.display !== 'standalone') fail(`manifest.display = ${manifest.display}, нужно standalone`);
else ok('manifest.display = standalone');
if (manifest.start_url !== manifest.scope) fail('manifest.start_url не равен manifest.scope');
for (const icon of manifest.icons ?? []) {
  if (!precache.has(icon.src)) fail(`Значок ${icon.src} не в предзагрузке`);
}
if (!precache.has('manifest.webmanifest')) fail('manifest.webmanifest не в предзагрузке');
if (!precache.has('index.html')) fail('index.html не в предзагрузке');

// 6. index.html
const html = readFileSync(join(dist, 'index.html'), 'utf8');
if (!/rel="manifest"/.test(html)) fail('В index.html нет ссылки на manifest');
if (!/rel="apple-touch-icon"/.test(html)) fail('В index.html нет apple-touch-icon');
if (!/viewport-fit=cover/.test(html)) fail('В index.html нет viewport-fit=cover');

// 7. Навигационный fallback и режим обновления
if (!/NavigationRoute\(.*createHandlerBoundToURL\("index\.html"\)/.test(sw)) fail('Нет navigateFallback на index.html');
else ok('navigateFallback на index.html есть');
if (!/SKIP_WAITING/.test(sw)) fail('Нет обработчика SKIP_WAITING (режим prompt)');
else ok('режим prompt: новая версия ждёт SKIP_WAITING');

if (errors.length) {
  console.error('\nОШИБКИ:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('\nПроверка dist пройдена.');
