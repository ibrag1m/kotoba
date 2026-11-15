import { describe, expect, it } from 'vitest';
import { duplicateKey, looksLikeReading, parseImport } from './importParser';

describe('parseImport: разделитель слова и определения', () => {
  it('табуляция, две колонки', () => {
    const r = parseImport('水\tвода\n火\tогонь');
    expect(r.columnDelimiter).toBe('tab');
    expect(r.rowDelimiter).toBe('newline');
    expect(r.rows).toEqual([
      { line: 1, term: '水', definition: 'вода' },
      { line: 2, term: '火', definition: 'огонь' },
    ]);
    expect(r.issues).toEqual([]);
  });

  it('запятая, две колонки; запятые внутри определения остаются в определении', () => {
    const r = parseImport('食べる, есть, кушать\n水, вода');
    expect(r.columnDelimiter).toBe('comma');
    expect(r.rows[0]).toEqual({ line: 1, term: '食べる', definition: 'есть, кушать' });
    expect(r.rows[1]).toEqual({ line: 2, term: '水', definition: 'вода' });
  });

  it('тире с пробелами', () => {
    const r = parseImport('水 - вода\n火 – огонь\n木 — дерево');
    expect(r.columnDelimiter).toBe('dash');
    expect(r.rows.map((x) => [x.term, x.definition])).toEqual([
      ['水', 'вода'],
      ['火', 'огонь'],
      ['木', 'дерево'],
    ]);
  });

  it('дефис внутри слова без пробелов не считается разделителем', () => {
    const r = parseImport('well-known - известный\nе-мейл - письмо');
    expect(r.columnDelimiter).toBe('dash');
    expect(r.rows[0]).toEqual({ line: 1, term: 'well-known', definition: 'известный' });
    expect(r.rows[1]).toEqual({ line: 2, term: 'е-мейл', definition: 'письмо' });
  });

  it('тире внутри определения: режем по первому', () => {
    const r = parseImport('水 - вода - жидкость');
    expect(r.rows[0]).toEqual({ line: 1, term: '水', definition: 'вода - жидкость' });
  });

  it('строка с одним дефисом без пробелов не режется и попадает в проблемные', () => {
    const r = parseImport('水 - вода\nwell-known');
    expect(r.rows).toHaveLength(1);
    expect(r.issues).toMatchObject([{ line: 2, kind: 'no-delimiter' }]);
  });

  it('табуляция приоритетнее запятой и тире', () => {
    const r = parseImport('食べる\tесть, кушать - глагол');
    expect(r.columnDelimiter).toBe('tab');
    expect(r.rows[0]?.definition).toBe('есть, кушать - глагол');
  });

  it('явный выбор разделителя перекрывает автоопределение', () => {
    const r = parseImport('水, вода - жидкость', { columnDelimiter: 'dash' });
    expect(r.columnDelimiter).toBe('dash');
    expect(r.rows[0]).toEqual({ line: 1, term: '水, вода', definition: 'жидкость' });
  });

  it('свой разделитель', () => {
    const r = parseImport('水=>вода\n火=>огонь', { columnDelimiter: 'custom', customColumnDelimiter: '=>' });
    expect(r.rows.map((x) => x.definition)).toEqual(['вода', 'огонь']);
  });

  it('свой разделитель без значения: все строки проблемные', () => {
    const r = parseImport('水=>вода', { columnDelimiter: 'custom', customColumnDelimiter: '' });
    expect(r.rows).toHaveLength(0);
    expect(r.issues).toHaveLength(1);
  });
});

describe('parseImport: разделитель карточек', () => {
  it('точка с запятой при отсутствии переводов строк', () => {
    const r = parseImport('水, вода; 火, огонь; 木, дерево');
    expect(r.rowDelimiter).toBe('semicolon');
    expect(r.rows.map((x) => x.term)).toEqual(['水', '火', '木']);
  });

  it('если есть перевод строки, авто выбирает новую строку, а ; остаётся в определении', () => {
    const r = parseImport('言う, сказать; говорить\n水, вода');
    expect(r.rowDelimiter).toBe('newline');
    expect(r.rows[0]?.definition).toBe('сказать; говорить');
  });

  it('явная точка с запятой понимает и переводы строк', () => {
    const r = parseImport('水, вода;\n火, огонь;\n', { rowDelimiter: 'semicolon' });
    expect(r.rows).toHaveLength(2);
    expect(r.emptyLines).toBeGreaterThan(0);
  });

  it('свой разделитель карточек', () => {
    const r = parseImport('水\tвода | 火\tогонь', { rowDelimiter: 'custom', customRowDelimiter: '|' });
    expect(r.rows.map((x) => x.term)).toEqual(['水', '火']);
  });

  it('переводы строк \\r\\n и пустые строки', () => {
    const r = parseImport('水\tвода\r\n\r\n火\tогонь\r\n');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1]?.line).toBe(3);
    expect(r.emptyLines).toBe(2);
  });

  it('пустой текст', () => {
    const r = parseImport('  \n \n');
    expect(r.rows).toEqual([]);
    expect(r.issues).toEqual([]);
    expect(r.columnDelimiter).toBeNull();
  });

  it('BOM в начале текста не попадает в слово', () => {
    const r = parseImport('﻿水\tвода');
    expect(r.rows[0]?.term).toBe('水');
  });
});

describe('parseImport: колонки (слово, чтение, определение)', () => {
  it('три колонки через табуляцию', () => {
    const r = parseImport('食べる\tたべる\tесть\n水\tみず\tвода');
    expect(r.rows).toEqual([
      { line: 1, term: '食べる', reading: 'たべる', definition: 'есть' },
      { line: 2, term: '水', reading: 'みず', definition: 'вода' },
    ]);
  });

  it('три колонки через запятую: чтение определяется по кане, запятые в определении сохраняются', () => {
    const r = parseImport('食べる, たべる, есть, кушать');
    expect(r.rows[0]).toEqual({ line: 1, term: '食べる', reading: 'たべる', definition: 'есть, кушать' });
  });

  it('запятая: вторая колонка не кана, значит две колонки', () => {
    const r = parseImport('食べる, есть, кушать');
    expect(r.rows[0]?.reading).toBeUndefined();
    expect(r.rows[0]?.definition).toBe('есть, кушать');
  });

  it('три колонки через тире', () => {
    const r = parseImport('大きい - おおきい - большой');
    expect(r.rows[0]).toEqual({ line: 1, term: '大きい', reading: 'おおきい', definition: 'большой' });
  });

  it('катакана и долгота в чтении', () => {
    const r = parseImport('コーヒー, コーヒー, кофе');
    expect(r.rows[0]).toEqual({ line: 1, term: 'コーヒー', reading: 'コーヒー', definition: 'кофе' });
  });

  it('смешение строк с чтением и без при автоопределении (табуляция)', () => {
    const r = parseImport('食べる\tたべる\tесть\n水\tвода');
    expect(r.rows[0]?.reading).toBe('たべる');
    expect(r.rows[1]?.reading).toBeUndefined();
    expect(r.rows[1]?.definition).toBe('вода');
  });

  it('хвостовая табуляция не создаёт третью колонку', () => {
    const r = parseImport('水\tвода\t');
    expect(r.rows[0]).toEqual({ line: 1, term: '水', definition: 'вода' });
  });

  it('явно 2 колонки: всё после первого разделителя уходит в определение', () => {
    const r = parseImport('食べる\tたべる\tесть', { columns: 2 });
    expect(r.rows[0]).toEqual({ line: 1, term: '食べる', definition: 'たべる\tесть' });
  });

  it('явно 3 колонки: строка с одним разделителем проблемная', () => {
    const r = parseImport('食べる\tたべる\tесть\n水\tвода', { columns: 3 });
    expect(r.rows).toHaveLength(1);
    expect(r.issues).toMatchObject([{ line: 2, kind: 'no-delimiter' }]);
  });

  it('looksLikeReading', () => {
    expect(looksLikeReading('たべる')).toBe(true);
    expect(looksLikeReading('タベル')).toBe(true);
    expect(looksLikeReading('おおきい')).toBe(true);
    expect(looksLikeReading('きょう/こんにち')).toBe(true);
    expect(looksLikeReading('есть')).toBe(false);
    expect(looksLikeReading('eat')).toBe(false);
    expect(looksLikeReading('食べる')).toBe(false);
    expect(looksLikeReading('')).toBe(false);
  });
});

describe('parseImport: проблемные строки и дубли', () => {
  it('строка без разделителя', () => {
    const r = parseImport('水\tвода\nпросто текст');
    expect(r.rows).toHaveLength(1);
    expect(r.issues).toEqual([
      expect.objectContaining({ line: 2, kind: 'no-delimiter', raw: 'просто текст' }),
    ]);
  });

  it('пустое слово и пустое определение', () => {
    const r = parseImport('\tвода\n水\t \n火\tогонь', { columnDelimiter: 'tab' });
    expect(r.rows).toHaveLength(1);
    expect(r.issues.map((i) => i.kind)).toEqual(['empty-term', 'empty-definition']);
  });

  it('дубли внутри текста: первая остаётся, остальные в проблемных', () => {
    const r = parseImport('水\tвода\n水\tводичка\n火\tогонь');
    expect(r.rows.map((x) => x.term)).toEqual(['水', '火']);
    expect(r.issues).toMatchObject([{ line: 2, kind: 'duplicate' }]);
  });

  it('дубль определяется после нормализации (полная ширина, регистр, пробелы)', () => {
    const r = parseImport('ＡＢＣ\tодин\nabc\tдва\n a  b \tтри\nA B\tчетыре');
    expect(r.rows.map((x) => x.definition)).toEqual(['один', 'три']);
    expect(r.issues.map((i) => i.kind)).toEqual(['duplicate', 'duplicate']);
  });

  it('одно слово с разным чтением — не дубль', () => {
    const r = parseImport('日\tひ\tдень\n日\tにち\tдень недели');
    expect(r.rows).toHaveLength(2);
  });

  it('дубль карточки, которая уже есть в колоде', () => {
    const existing = new Set([duplicateKey('水', 'みず')]);
    const r = parseImport('水\tみず\tвода\n火\tひ\tогонь', { existingKeys: existing });
    expect(r.rows.map((x) => x.term)).toEqual(['火']);
    expect(r.issues).toMatchObject([{ line: 1, kind: 'duplicate-existing' }]);
  });

  it('эмодзи и кириллица проходят без искажений', () => {
    const r = parseImport('🍣\tсуси\nпривет\tздравствуйте');
    expect(r.rows.map((x) => x.term)).toEqual(['🍣', 'привет']);
  });

  it('пробелы вокруг полей обрезаются, символы внутри не меняются', () => {
    const r = parseImport('  水  \t  вода  ');
    expect(r.rows[0]).toEqual({ line: 1, term: '水', definition: 'вода' });
  });
});
