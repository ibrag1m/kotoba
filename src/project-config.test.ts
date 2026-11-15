// Проверки конфигурации проекта (публикация, сборка) и помощников скриптов проверки.
// Читают файлы репозитория как текст: отдельного разбора YAML в зависимостях нет.
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInside, parseDevToolsActivePort } from '../scripts/lib.mjs';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('deploy.yml: права и защита адреса', () => {
  const yml = read('.github/workflows/deploy.yml');
  const buildJob = yml.slice(yml.indexOf('\n  build:'), yml.indexOf('\n  deploy:'));
  const deployJob = yml.slice(yml.indexOf('\n  deploy:'));
  const topLevel = yml.slice(0, yml.indexOf('\njobs:'));

  it('на верхнем уровне только contents: read', () => {
    const block = /\npermissions:\n((?: {2}\S.*\n?)+)/.exec(topLevel)?.[1] ?? '';
    expect(block.trim().split('\n').map((l) => l.trim())).toEqual(['contents: read']);
    expect(topLevel).not.toMatch(/pages:\s*write/);
    expect(topLevel).not.toMatch(/id-token:\s*write/);
  });

  it('у сборки только contents: read', () => {
    expect(buildJob).toMatch(/permissions:\n\s+contents: read/);
    expect(buildJob).not.toMatch(/pages:\s*write/);
    expect(buildJob).not.toMatch(/id-token/);
  });

  it('pages: write и id-token: write только у задачи deploy', () => {
    expect(deployJob).toMatch(/permissions:\n\s+pages: write\n\s+id-token: write/);
    expect(yml.match(/pages:\s*write/g)).toHaveLength(1);
    expect(yml.match(/id-token:\s*write/g)).toHaveLength(1);
  });

  it('первым шагом сборки идёт проверка имени репозитория с понятным сообщением', () => {
    const steps = buildJob.slice(buildJob.indexOf('steps:'));
    expect(steps.indexOf('Проверить имя репозитория')).toBeGreaterThan(-1);
    expect(steps.indexOf('Проверить имя репозитория')).toBeLessThan(steps.indexOf('actions/checkout'));
    expect(steps).toContain('github.event.repository.name');
    expect(steps).toMatch(/!= "kotoba"/);
    expect(steps).toContain('exit 1');
    expect(steps).toContain('меняет адрес приложения и стирает данные на телефонах');
  });
});

describe('vite.config.ts: предзагрузка без дублей', () => {
  const cfg = read('vite.config.ts');
  it('иконки манифеста не добавляются второй раз, манифест не в маске', () => {
    expect(cfg).toMatch(/includeManifestIcons:\s*false/);
    const glob = /globPatterns:\s*\[\s*'([^']+)'/.exec(cfg)?.[1] ?? '';
    expect(glob).toContain('png');
    expect(glob).not.toContain('webmanifest');
  });
});

describe('scripts/lib.mjs', () => {
  const root = resolve('/tmp/app/dist');
  it('isInside: внутри каталога, сам каталог', () => {
    expect(isInside(root, resolve(root, 'index.html'))).toBe(true);
    expect(isInside(root, resolve(root, 'assets', 'a.js'))).toBe(true);
    expect(isInside(root, root)).toBe(true);
  });

  it('isInside: соседний каталог dist-evil и выход через .. не проходят', () => {
    expect(isInside(root, `${root}-evil${sep}secret.txt`)).toBe(false);
    expect(isInside(root, resolve(root, '..', 'dist-evil', 'x'))).toBe(false);
    expect(isInside(root, resolve(root, '..', 'package.json'))).toBe(false);
    expect(isInside(root, resolve(root, '..'))).toBe(false);
  });

  it('parseDevToolsActivePort: порт из первой строки', () => {
    expect(parseDevToolsActivePort('51234\n/devtools/browser/abc-123\n')).toEqual({
      port: 51234,
      wsPath: '/devtools/browser/abc-123',
    });
    expect(parseDevToolsActivePort('9222\r\n/devtools/browser/x')).toEqual({ port: 9222, wsPath: '/devtools/browser/x' });
  });

  it('parseDevToolsActivePort: пустой или битый файл — null (ещё не готов)', () => {
    expect(parseDevToolsActivePort('')).toBeNull();
    expect(parseDevToolsActivePort('abc\n/x')).toBeNull();
    expect(parseDevToolsActivePort('0\n/x')).toBeNull();
    expect(parseDevToolsActivePort('99999\n/x')).toBeNull();
  });
});

describe('verify-offline.mjs: порт и очистка', () => {
  const script = read('scripts/verify-offline.mjs');
  it('порт отладки случайный, фиксированный 9333 не используется', () => {
    expect(script).toContain('--remote-debugging-port=0');
    expect(script).toContain('DevToolsActivePort');
    expect(script).not.toContain('9333');
  });
  it('путь проверяется через isInside (path.relative), а не startsWith', () => {
    expect(script).toContain('isInside(dist, file)');
    expect(script).not.toMatch(/file\.startsWith\(dist\)/);
  });
  it('на Windows убивается дерево процессов, профиль удаляется', () => {
    expect(script).toMatch(/taskkill/);
    expect(script).toMatch(/'\/T'/);
    expect(script).toMatch(/'\/F'/);
    expect(script).toMatch(/rmSync\(profile/);
  });
});
