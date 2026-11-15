// Тесты исправлений по замечаниям ревью (шаги 0 и 1). Основные тесты парсера: importParser.test.ts.
import { describe, expect, it } from 'vitest';
import { duplicateKey, looksLikeReading, parseImport } from './importParser';

describe('parseImport: японская запятая 、, полноширинный пробел, японские тире', () => {
  it('、 разделяет колонки: «食べる、たべる、есть»', () => {
    const r = parseImport('食べる、たべる、есть');
    expect(r.columnDelimiter).toBe('comma');
    expect(r.rows).toEqual([{ line: 1, term: '食べる', reading: 'たべる', definition: 'есть' }]);
    expect(r.warnings).toEqual([]);
  });

  it('、 в две колонки; следующие 、 остаются в определении', () => {
    const r = parseImport('水、вода\n食べる、есть、кушать');
    expect(r.rows[0]).toEqual({ line: 1, term: '水', definition: 'вода' });
    expect(r.rows[1]).toEqual({ line: 2, term: '食べる', definition: 'есть、кушать' });
  });

  it('согласование с чтением: 、 в поле чтения допустима там, где колонки режет другой разделитель', () => {
    expect(looksLikeReading('きょう、こんにち')).toBe(true);
    const dash = parseImport('今日 - きょう、こんにち - сегодня');
    expect(dash.columnDelimiter).toBe('dash');
    expect(dash.rows[0]).toEqual({ line: 1, term: '今日', reading: 'きょう、こんにち', definition: 'сегодня' });
    const tab = parseImport('今日\tきょう、こんにち\tсегодня');
    expect(tab.rows[0]?.reading).toBe('きょう、こんにち');
    // а при запятой как разделителе 、 режет колонки: чтением будет только первый вариант
    const comma = parseImport('今日、きょう、こんにち、сегодня');
    expect(comma.rows[0]).toEqual({ line: 1, term: '今日', reading: 'きょう', definition: 'こんにち、сегодня' });
  });

  it('полноширинный пробел: «水\u3000みず\u3000вода» (три колонки) и «水\u3000вода» (две)', () => {
    const r = parseImport('水\u3000みず\u3000вода\n火\u3000огонь');
    expect(r.columnDelimiter).toBe('space');
    expect(r.rows).toEqual([
      { line: 1, term: '水', reading: 'みず', definition: 'вода' },
      { line: 2, term: '火', definition: 'огонь' },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('два и более обычных пробела разделяют, один обычный пробел нет', () => {
    const r = parseImport('ありがとう ございます  спасибо\n水  みず  вода');
    expect(r.columnDelimiter).toBe('space');
    expect(r.rows[0]).toEqual({ line: 1, term: 'ありがとう ございます', definition: 'спасибо' });
    expect(r.rows[1]).toEqual({ line: 2, term: '水', reading: 'みず', definition: 'вода' });
    const one = parseImport('水 вода');
    expect(one.rows).toEqual([]);
    expect(one.issues).toMatchObject([{ kind: 'no-delimiter' }]);
  });

  it('явный выбор «пробелы»', () => {
    const r = parseImport('水\u3000вода, жидкость', { columnDelimiter: 'space' });
    expect(r.rows[0]).toEqual({ line: 1, term: '水', definition: 'вода, жидкость' });
  });

  it.each([
    ['－ (U+FF0D)', '水 － вода'],
    ['― (U+2015)', '水 ― вода'],
    ['− (U+2212)', '水 − вода'],
    ['ー (U+30FC) между пробелами', '水 ー вода'],
    ['– (U+2013)', '水 – вода'],
  ])('тире %s с пробелами разделяет', (_name, line) => {
    const r = parseImport(line);
    expect(r.columnDelimiter).toBe('dash');
    expect(r.rows[0]).toEqual({ line: 1, term: '水', definition: 'вода' });
  });

  it('ー внутри слова и без пробелов не разделитель', () => {
    const r = parseImport('コーヒー - кофе\nラーメン ー лапша');
    expect(r.columnDelimiter).toBe('dash');
    expect(r.rows.map((x) => [x.term, x.definition])).toEqual([
      ['コーヒー', 'кофе'],
      ['ラーメン', 'лапша'],
    ]);
    const none = parseImport('コーヒーー кофе', { columnDelimiter: 'dash' });
    expect(none.issues).toMatchObject([{ kind: 'no-delimiter' }]);
  });
});

describe('parseImport: автоопределение разделителя по позиции первого кандидата', () => {
  it('запятая левее тире: «いい, хороший - о погоде» режется по запятой', () => {
    const r = parseImport('いい, хороший - о погоде\n悪い, плохой - о погоде');
    expect(r.columnDelimiter).toBe('comma');
    expect(r.rows).toEqual([
      { line: 1, term: 'いい', definition: 'хороший - о погоде' },
      { line: 2, term: '悪い', definition: 'плохой - о погоде' },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('«行く, идти - ехать» и «水, вода»: запятая, обе карточки верные', () => {
    const r = parseImport('行く, идти - ехать\n水, вода');
    expect(r.columnDelimiter).toBe('comma');
    expect(r.rows.map((x) => [x.term, x.definition])).toEqual([
      ['行く', 'идти - ехать'],
      ['水', 'вода'],
    ]);
  });

  it('тире левее запятой: режется по тире', () => {
    const r = parseImport('水 - вода, жидкость\n火 - огонь, пламя');
    expect(r.columnDelimiter).toBe('dash');
    expect(r.rows[0]).toEqual({ line: 1, term: '水', definition: 'вода, жидкость' });
    expect(r.warnings).toEqual([]);
  });

  it('строки не согласны: побеждает чаще первый, и показывается предупреждение', () => {
    const r = parseImport('いい, хороший\n悪い, плохой\n水 - вода');
    expect(r.columnDelimiter).toBe('comma');
    expect(r.warnings).toMatchObject([{ kind: 'ambiguous-delimiter' }]);
    expect(r.warnings[0]?.message).toContain('запятая');
    // строка, не подходящая под победителя, не портится молча, а попадает в проблемные
    expect(r.rows.map((x) => x.term)).toEqual(['いい', '悪い']);
    expect(r.issues).toMatchObject([{ line: 3, kind: 'no-delimiter' }]);
  });

  it('ничья по числу строк: берётся запятая и показывается предупреждение', () => {
    const r = parseImport('水, вода\n火 - огонь');
    expect(r.columnDelimiter).toBe('comma');
    expect(r.warnings).toMatchObject([{ kind: 'ambiguous-delimiter' }]);
  });

  it('строки используют разные разделители поровну: разделитель не определён, но есть предупреждение', () => {
    const r = parseImport('行く, идти\n食べる - есть\n水\u3000вода\n火\tогонь\n木 - дерево\n犬, собака\n猫  кошка');
    expect(r.columnDelimiter).toBeNull();
    expect(r.rows).toEqual([]);
    expect(r.warnings).toMatchObject([{ kind: 'ambiguous-delimiter' }]);
    expect(r.warnings[0]?.message).toContain('вручную');
  });

  it('явный выбор разделителя не даёт предупреждения об определении', () => {
    const r = parseImport('水, вода\n火 - огонь', { columnDelimiter: 'dash' });
    expect(r.warnings).toEqual([]);
  });

  it('табуляция по-прежнему главнее, если она есть в половине строк', () => {
    const r = parseImport('食べる\tесть, кушать - глагол\n水\tвода');
    expect(r.columnDelimiter).toBe('tab');
    expect(r.warnings).toEqual([]);
  });
});

describe('parseImport: чтение в трёх колонках с табуляцией', () => {
  it('латиница во второй колонке не записывается как чтение', () => {
    const r = parseImport('食べる\ttaberu\tесть\n水\tみず\tвода');
    expect(r.rows).toEqual([{ line: 2, term: '水', reading: 'みず', definition: 'вода' }]);
    expect(r.issues).toMatchObject([{ line: 1, kind: 'bad-reading' }]);
    expect(r.issues[0]?.message).toContain('taberu');
  });

  it('русское слово во второй колонке не становится чтением', () => {
    const r = parseImport('食べる\tесть\tкушать');
    expect(r.rows).toEqual([]);
    expect(r.issues).toMatchObject([{ line: 1, kind: 'bad-reading' }]);
  });

  it('пустое чтение допустимо: «水<TAB><TAB>вода»', () => {
    const r = parseImport('水\t\tвода');
    expect(r.rows).toEqual([{ line: 1, term: '水', definition: 'вода' }]);
    expect(r.issues).toEqual([]);
  });

  it('явно 3 колонки: проверка чтения действует и для запятой', () => {
    const r = parseImport('食べる, eat, есть\n水, みず, вода', { columns: 3 });
    expect(r.rows.map((x) => x.term)).toEqual(['水']);
    expect(r.issues).toMatchObject([{ line: 1, kind: 'bad-reading' }]);
  });

  it('явно 2 колонки: всё после первой табуляции остаётся определением', () => {
    const r = parseImport('食べる\tесть\tкушать', { columns: 2 });
    expect(r.rows[0]).toEqual({ line: 1, term: '食べる', definition: 'есть\tкушать' });
    expect(r.issues).toEqual([]);
  });
});

describe('parseImport: невидимые символы и необычные переводы строк', () => {
  const ZWSP = '​';
  const ZWNJ = '‌';
  const WJ = '⁠';
  const BOM = '﻿';

  it('нулевая ширина и BOM вырезаются из слова, чтения и перевода', () => {
    const r = parseImport(`水${ZWSP}\tみ${ZWNJ}ず\tво${WJ}да${BOM}`);
    expect(r.rows).toEqual([{ line: 1, term: '水', reading: 'みず', definition: 'вода' }]);
  });

  it('невидимый символ рядом с тире не ломает определение разделителя', () => {
    const r = parseImport(`水 ${ZWSP}- вода\n火 - ${BOM}огонь`);
    expect(r.columnDelimiter).toBe('dash');
    expect(r.rows.map((x) => [x.term, x.definition])).toEqual([
      ['水', 'вода'],
      ['火', 'огонь'],
    ]);
  });

  it('duplicateKey игнорирует невидимые символы', () => {
    expect(duplicateKey(`水${ZWSP}`, `み${WJ}ず`)).toBe(duplicateKey('水', 'みず'));
    expect(duplicateKey(`${BOM}ab${ZWNJ}c`)).toBe(duplicateKey('abc'));
  });

  it('дубль находится и через невидимый символ', () => {
    const r = parseImport(`水\tвода\n水${ZWSP}\tещё вода`);
    expect(r.rows).toHaveLength(1);
    expect(r.issues).toMatchObject([{ line: 2, kind: 'duplicate' }]);
    const existing = new Set([duplicateKey('水')]);
    const e = parseImport(`水${ZWSP}\tвода`, { existingKeys: existing });
    expect(e.issues).toMatchObject([{ kind: 'duplicate-existing' }]);
  });

  it('U+2028, U+2029 и U+0085 разделяют строки', () => {
    const r = parseImport('水\tвода\u2028火\tогонь\u2029木\tдерево\u0085犬\tсобака');
    expect(r.rows.map((x) => [x.line, x.term])).toEqual([
      [1, '水'],
      [2, '火'],
      [3, '木'],
      [4, '犬'],
    ]);
  });

  it('новые переводы строк работают и при выборе точки с запятой, и со своим разделителем', () => {
    const a = parseImport('水, вода;\u2028火, огонь', { rowDelimiter: 'semicolon' });
    expect(a.rows).toHaveLength(2);
    const b = parseImport('水\tвода|火\tогонь\u2029木\tдерево', { rowDelimiter: 'custom', customRowDelimiter: '|' });
    expect(b.rows.map((x) => x.term)).toEqual(['水', '火', '木']);
  });
});

describe('parseImport: мелочи (хвосты, маркеры, кавычки, скобки, точка с запятой)', () => {
  it('хвостовые разделители в конце строки убираются', () => {
    const r = parseImport('水, вода,\n火, огонь,,\n木、дерево、');
    expect(r.rows.map((x) => x.definition)).toEqual(['вода', 'огонь', 'дерево']);
    const dash = parseImport('水 - вода -\n火 - огонь');
    expect(dash.rows.map((x) => x.definition)).toEqual(['вода', 'огонь']);
    const custom = parseImport('水=>вода=>\n火=>огонь', { columnDelimiter: 'custom', customColumnDelimiter: '=>' });
    expect(custom.rows.map((x) => x.definition)).toEqual(['вода', 'огонь']);
  });

  it('слово с одним хвостовым разделителем остаётся «пустым определением»', () => {
    const r = parseImport('水, вода\n火,');
    expect(r.issues).toMatchObject([{ line: 2, kind: 'empty-definition' }]);
  });

  it('маркеры списка в начале строки вырезаются', () => {
    const r = parseImport('- 水, вода\n• 火, огонь\n1. 木, дерево\n2) 犬, собака\n* 猫, кошка');
    expect(r.rows.map((x) => x.term)).toEqual(['水', '火', '木', '犬', '猫']);
    expect(r.issues).toEqual([]);
  });

  it('число-слово и дефис без пробела не принимаются за маркер', () => {
    const r = parseImport('3 - три\n-5 - минус пять\n10 - десять');
    expect(r.rows.map((x) => x.term)).toEqual(['3', '-5', '10']);
  });

  it('кавычки CSV вокруг ячеек снимаются, запятая внутри кавычек не разделитель', () => {
    const r = parseImport('"水","вода"\n"食べる", "есть, кушать"\n"say ""hi""", сказать\n火,"огонь, пламя"');
    expect(r.columnDelimiter).toBe('comma');
    expect(r.rows.map((x) => [x.term, x.definition])).toEqual([
      ['水', 'вода'],
      ['食べる', 'есть, кушать'],
      ['say "hi"', 'сказать'],
      ['火', 'огонь, пламя'],
    ]);
    expect(r.issues).toEqual([]);
  });

  it('кавычки в середине ячейки не снимаются', () => {
    const r = parseImport('5" pipe, труба\nsay "hi" now, сказать');
    expect(r.rows.map((x) => x.term)).toEqual(['5" pipe', 'say "hi" now']);
  });

  it('кавычки вокруг трёх колонок и запятая внутри слова', () => {
    const r = parseImport('"食べる","たべる","есть, кушать"\n"a, b","あ","c"');
    expect(r.rows[0]).toEqual({ line: 1, term: '食べる', reading: 'たべる', definition: 'есть, кушать' });
    expect(r.rows[1]).toEqual({ line: 2, term: 'a, b', reading: 'あ', definition: 'c' });
  });

  it('чтение в скобках: полноширинных и обычных, при запятой, тире и табуляции', () => {
    expect(parseImport('今日（きょう）, сегодня').rows).toEqual([
      { line: 1, term: '今日', reading: 'きょう', definition: 'сегодня' },
    ]);
    expect(parseImport('水(みず) - вода').rows).toEqual([{ line: 1, term: '水', reading: 'みず', definition: 'вода' }]);
    expect(parseImport('猫（ねこ）\tкошка').rows).toEqual([
      { line: 1, term: '猫', reading: 'ねこ', definition: 'кошка' },
    ]);
  });

  it('скобки без каны внутри и скобки в переводе остаются как есть', () => {
    const r = parseImport('猫（cat）, кошка\n犬, собака (いぬ)');
    expect(r.rows).toEqual([
      { line: 1, term: '猫（cat）', definition: 'кошка' },
      { line: 2, term: '犬', definition: 'собака (いぬ)' },
    ]);
  });

  it('если чтение уже есть колонкой, скобки в слове не трогаются', () => {
    const r = parseImport('今日（きょう）\tこんにち\tсегодня');
    expect(r.rows[0]).toEqual({ line: 1, term: '今日（きょう）', reading: 'こんにち', definition: 'сегодня' });
  });

  it('одна строка «言う, сказать; говорить» остаётся одной карточкой', () => {
    const r = parseImport('言う, сказать; говорить');
    expect(r.rowDelimiter).toBe('newline');
    expect(r.rows).toEqual([{ line: 1, term: '言う', definition: 'сказать; говорить' }]);
    expect(r.warnings).toEqual([]);
  });

  it('список в одну строку через «;» по-прежнему режется, и в предпросмотре есть пометка', () => {
    const r = parseImport('水, вода; 火, огонь');
    expect(r.rowDelimiter).toBe('semicolon');
    expect(r.rows).toHaveLength(2);
    expect(r.warnings).toMatchObject([{ kind: 'semicolon-split' }]);
    expect(r.warnings[0]?.message).toContain('точкой с запятой');
  });

  it('явная точка с запятой на «言う, сказать; говорить»: режет и честно предупреждает', () => {
    const r = parseImport('言う, сказать; говорить', { rowDelimiter: 'semicolon' });
    expect(r.rows).toHaveLength(1);
    expect(r.issues).toMatchObject([{ line: 2, kind: 'no-delimiter' }]);
    expect(r.warnings).toMatchObject([{ kind: 'semicolon-split' }]);
  });
});
