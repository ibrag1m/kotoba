import { describe, expect, it } from 'vitest';
import {
  checkDefinitionAnswer,
  checkTermAnswer,
  definitionVariants,
  normalizeDefinition,
  normalizeJapanese,
} from './answerCheck';

// Идеографический пробел задан кодом, а не литералом: в исходниках литералов быть не должно.
const IDEO_SPACE = String.fromCodePoint(0x3000);

describe('normalizeJapanese', () => {
  it('катакана приводится к хирагане, долгий знак сохраняется', () => {
    expect(normalizeJapanese('ミズ')).toBe('みず');
    expect(normalizeJapanese('コーヒー')).toBe('こーひー');
    expect(normalizeJapanese('こーひー')).toBe('こーひー');
  });

  it('полноширинные и полукатакана: NFKC', () => {
    expect(normalizeJapanese('ｺｰﾋｰ')).toBe('こーひー');
    expect(normalizeJapanese('ＯＫ')).toBe('ok');
    expect(normalizeJapanese('ｶﾞｯｺｳ')).toBe('がっこう');
  });

  it('пробелы (обычные, полноширинные, внутри) и пунктуация убираются', () => {
    expect(normalizeJapanese(`  た べ${IDEO_SPACE}る  `)).toBe('たべる');
    expect(normalizeJapanese('「たべる」。')).toBe('たべる');
    expect(normalizeJapanese('たべる！')).toBe('たべる');
    expect(normalizeJapanese('た・べ、る')).toBe('たべる');
  });

  it('невидимые символы форматирования (нулевая ширина) убираются', () => {
    expect(normalizeJapanese(`た${String.fromCodePoint(0x200b)}べる`)).toBe('たべる');
  });
});

describe('checkTermAnswer: японский по переводу', () => {
  const water = { term: '水', reading: 'みず' };

  it('точное совпадение с term и с reading', () => {
    expect(checkTermAnswer('水', water)).toEqual({ correct: true, romajiHint: false });
    expect(checkTermAnswer('みず', water)).toEqual({ correct: true, romajiHint: false });
  });

  it('хирагана и катакана равнозначны', () => {
    expect(checkTermAnswer('ミズ', water).correct).toBe(true);
    expect(checkTermAnswer('コーヒー', { term: 'コーヒー' }).correct).toBe(true);
    expect(checkTermAnswer('こーひー', { term: 'コーヒー' }).correct).toBe(true);
    expect(checkTermAnswer('コーヒー', { term: '珈琲', reading: 'こーひー' }).correct).toBe(true);
  });

  it('кандзи плюс чтение: любой из двух вариантов; чужое чтение нет', () => {
    const eat = { term: '食べる', reading: 'たべる' };
    expect(checkTermAnswer('食べる', eat).correct).toBe(true);
    expect(checkTermAnswer('たべる', eat).correct).toBe(true);
    expect(checkTermAnswer('のむ', eat).correct).toBe(false);
    expect(checkTermAnswer('食べ', eat).correct).toBe(false);
  });

  it('reading необязателен', () => {
    expect(checkTermAnswer('ありがとう', { term: 'ありがとう' }).correct).toBe(true);
    expect(checkTermAnswer('ありがと', { term: 'ありがとう' }).correct).toBe(false);
  });

  it('полноширинные символы и полукатакана', () => {
    expect(checkTermAnswer('ｺｰﾋｰ', { term: 'コーヒー' }).correct).toBe(true);
    expect(checkTermAnswer('ＴＶ', { term: 'TV' }).correct).toBe(true);
    expect(checkTermAnswer('ｔｖ', { term: 'TV' }).correct).toBe(true);
  });

  it('пробелы по краям и внутри, пунктуация игнорируются', () => {
    const eat = { term: '食べる', reading: 'たべる' };
    expect(checkTermAnswer('  たべる  ', eat).correct).toBe(true);
    expect(checkTermAnswer('た べ る', eat).correct).toBe(true);
    expect(checkTermAnswer(`た${IDEO_SPACE}べる`, eat).correct).toBe(true);
    expect(checkTermAnswer('たべる。', eat).correct).toBe(true);
    expect(checkTermAnswer('「たべる」', eat).correct).toBe(true);
    expect(checkTermAnswer('たべる!', eat).correct).toBe(true);
  });

  it('пунктуация в эталоне тоже не мешает', () => {
    expect(checkTermAnswer('おはようございます', { term: 'おはよう、ございます。' }).correct).toBe(true);
  });

  it('романдзи не засчитывается и даёт подсказку про клавиатуру', () => {
    expect(checkTermAnswer('mizu', water)).toEqual({ correct: false, romajiHint: true });
    expect(checkTermAnswer('MIZU', water)).toEqual({ correct: false, romajiHint: true });
    expect(checkTermAnswer('ｍｉｚｕ', water)).toEqual({ correct: false, romajiHint: true });
    expect(checkTermAnswer('taberu', { term: '食べる', reading: 'たべる' }).romajiHint).toBe(true);
  });

  it('подсказки нет, если ответ японский (просто неверный), пустой или засчитан', () => {
    expect(checkTermAnswer('ひ', water)).toEqual({ correct: false, romajiHint: false });
    expect(checkTermAnswer('', water)).toEqual({ correct: false, romajiHint: false });
    expect(checkTermAnswer('   ', water)).toEqual({ correct: false, romajiHint: false });
    expect(checkTermAnswer('みず', water).romajiHint).toBe(false);
  });

  it('если сам term латиницей и введён верно, это правильный ответ без подсказки', () => {
    expect(checkTermAnswer('OK', { term: 'OK' })).toEqual({ correct: true, romajiHint: false });
    expect(checkTermAnswer('ok', { term: 'OK' })).toEqual({ correct: true, romajiHint: false });
  });

  it('поле из одной пунктуации («〜»): верный ответ возможен, пустой и чужой ввод нет', () => {
    expect(checkTermAnswer('〜', { term: '〜' }).correct).toBe(true);
    expect(checkTermAnswer(' 〜 ', { term: '〜' }).correct).toBe(true);
    expect(checkTermAnswer('~', { term: '〜' }).correct).toBe(false);
    expect(checkTermAnswer('。', { term: '〜' }).correct).toBe(false);
    expect(checkTermAnswer('', { term: '〜' }).correct).toBe(false);
    expect(checkTermAnswer('   ', { term: '〜' }).correct).toBe(false);
    // слово с кана и пустая пунктуация в вводе не совпадают
    expect(checkTermAnswer('。', { term: 'みず' }).correct).toBe(false);
  });

  it('варианты через «/»: 四 «よん/し»', () => {
    const four = { term: '四', reading: 'よん/し' };
    for (const ok of ['四', 'よん', 'し', 'ヨン', 'シ', 'よんし', 'よん/し', 'よん し']) {
      expect(checkTermAnswer(ok, four).correct).toBe(true);
    }
    expect(checkTermAnswer('よ', four).correct).toBe(false);
    expect(checkTermAnswer('よんな', four).correct).toBe(false);
  });

  it('варианты через «・»: 何 «なに・なん»', () => {
    const what = { term: '何', reading: 'なに・なん' };
    for (const ok of ['何', 'なに', 'なん', 'ナニ', 'なになん']) {
      expect(checkTermAnswer(ok, what).correct).toBe(true);
    }
    expect(checkTermAnswer('なな', what).correct).toBe(false);
  });

  it('варианты через «、»: 七 «しち、なな»', () => {
    const seven = { term: '七', reading: 'しち、なな' };
    for (const ok of ['七', 'しち', 'なな', 'しちなな']) {
      expect(checkTermAnswer(ok, seven).correct).toBe(true);
    }
    expect(checkTermAnswer('なし', seven).correct).toBe(false);
  });

  it('варианты через «,» и «;» и в самом term; полноширинные разделители', () => {
    expect(checkTermAnswer('し', { term: '四', reading: 'よん, し' }).correct).toBe(true);
    expect(checkTermAnswer('し', { term: '四', reading: 'よん；し' }).correct).toBe(true);
    expect(checkTermAnswer('わたし', { term: '私/わたくし', reading: 'わたし' }).correct).toBe(true);
    expect(checkTermAnswer('わたくし', { term: '私/わたくし' }).correct).toBe(true);
  });

  it('«・» как часть слова: засчитывается и целая запись без разделителей, и каждая часть', () => {
    const t = { term: 'ケーキ・バイキング' };
    expect(checkTermAnswer('ケーキバイキング', t).correct).toBe(true);
    expect(checkTermAnswer('ケーキ・バイキング', t).correct).toBe(true);
    expect(checkTermAnswer('ケーキ', t).correct).toBe(true);
  });

  it('скобки в чтении: «(お)かね» принимает с «お» и без', () => {
    const money = { term: 'お金', reading: '(お)かね' };
    expect(checkTermAnswer('おかね', money).correct).toBe(true);
    expect(checkTermAnswer('かね', money).correct).toBe(true);
    expect(checkTermAnswer('お金', money).correct).toBe(true);
    // разделитель внутри скобок вариант не делит
    expect(checkTermAnswer('かね', { term: '金', reading: 'かね(おかね、おあし)' }).correct).toBe(true);
    expect(checkTermAnswer('おあし', { term: '金', reading: 'かね(おかね、おあし)' }).correct).toBe(false);
  });

  it('кириллица вместо японского: не засчитано, подсказка про клавиатуру (как для романдзи)', () => {
    expect(checkTermAnswer('вода', { term: '水', reading: 'みず' })).toEqual({ correct: false, romajiHint: true });
    expect(checkTermAnswer('Ёж', { term: '水', reading: 'みず' }).romajiHint).toBe(true);
    expect(checkTermAnswer('みずa', { term: '水', reading: 'みず' }).romajiHint).toBe(true);
    expect(checkTermAnswer('ひ', { term: '水', reading: 'みず' }).romajiHint).toBe(false);
  });

  it('эквиваленты: слова других карточек с тем же переводом тоже верны', () => {
    const pretty = { term: 'きれい' };
    const other = [{ term: '美しい', reading: 'うつくしい' }];
    expect(checkTermAnswer('うつくしい', pretty, other).correct).toBe(true);
    expect(checkTermAnswer('美しい', pretty, other).correct).toBe(true);
    expect(checkTermAnswer('きれい', pretty, other).correct).toBe(true);
    expect(checkTermAnswer('うつくしい', pretty).correct).toBe(false);
    expect(checkTermAnswer('かわいい', pretty, other).correct).toBe(false);
  });
});

describe('checkDefinitionAnswer: перевод по японскому', () => {
  it('регистр не важен', () => {
    expect(checkDefinitionAnswer('ВОДА', 'вода')).toBe(true);
    expect(checkDefinitionAnswer('вода', 'Вода')).toBe(true);
  });

  it('ё равно е в обе стороны', () => {
    expect(checkDefinitionAnswer('еж', 'ёж')).toBe(true);
    expect(checkDefinitionAnswer('ёж', 'еж')).toBe(true);
    expect(checkDefinitionAnswer('ЁЖ', 'еж')).toBe(true);
  });

  it('лишние пробелы и пунктуация по краям', () => {
    expect(checkDefinitionAnswer('  вода  ', 'вода')).toBe(true);
    expect(checkDefinitionAnswer('вода.', 'вода')).toBe(true);
    expect(checkDefinitionAnswer('«вода»!', 'вода')).toBe(true);
    expect(checkDefinitionAnswer('красная   вода', 'красная вода')).toBe(true);
  });

  it('несколько вариантов в эталоне через , ; /', () => {
    expect(checkDefinitionAnswer('вода', 'вода, водица')).toBe(true);
    expect(checkDefinitionAnswer('водица', 'вода, водица')).toBe(true);
    expect(checkDefinitionAnswer('вода', 'вода; водица')).toBe(true);
    expect(checkDefinitionAnswer('водица', 'вода/водица')).toBe(true);
    expect(checkDefinitionAnswer('водица', 'вода / водица')).toBe(true);
    expect(checkDefinitionAnswer('вода', 'вода，водица')).toBe(true);
  });

  it('можно ввести несколько вариантов сразу, если каждый из них допустим', () => {
    expect(checkDefinitionAnswer('вода, водица', 'вода, водица, влага')).toBe(true);
    expect(checkDefinitionAnswer('вода; влага', 'вода, водица, влага')).toBe(true);
    expect(checkDefinitionAnswer('вода, огонь', 'вода, водица')).toBe(false);
  });

  it('неверный и пустой ответ', () => {
    expect(checkDefinitionAnswer('огонь', 'вода')).toBe(false);
    expect(checkDefinitionAnswer('вод', 'вода')).toBe(false);
    expect(checkDefinitionAnswer('', 'вода')).toBe(false);
    expect(checkDefinitionAnswer(' ,; ', 'вода')).toBe(false);
  });

  it('пояснение в скобках не обязательно, разделители внутри скобок не делят вариант', () => {
    expect(checkDefinitionAnswer('есть', 'есть (о еде, пище)')).toBe(true);
    expect(checkDefinitionAnswer('есть (о еде, пище)', 'есть (о еде, пище)')).toBe(true);
    expect(checkDefinitionAnswer('пище', 'есть (о еде, пище)')).toBe(false);
    expect(checkDefinitionAnswer('кушать', 'есть (о еде), кушать')).toBe(true);
  });

  it('дефис внутри слова не разделитель', () => {
    expect(checkDefinitionAnswer('что-то', 'что-то')).toBe(true);
    expect(checkDefinitionAnswer('что то', 'что-то')).toBe(false);
  });

  it('«(по)ехать»: принимается и «поехать», и «ехать»', () => {
    expect(checkDefinitionAnswer('поехать', '(по)ехать')).toBe(true);
    expect(checkDefinitionAnswer('ехать', '(по)ехать')).toBe(true);
    expect(checkDefinitionAnswer('(по)ехать', '(по)ехать')).toBe(true);
    expect(checkDefinitionAnswer('ехать', 'идти, (по)ехать')).toBe(true);
    expect(checkDefinitionAnswer('поехать', 'идти, (по)ехать')).toBe(true);
    expect(checkDefinitionAnswer('пойти', '(по)ехать')).toBe(false);
  });

  it('эквиваленты: переводы других карточек с тем же словом тоже верны', () => {
    expect(checkDefinitionAnswer('палочки', 'мост', ['палочки для еды'])).toBe(false);
    expect(checkDefinitionAnswer('палочки для еды', 'мост', ['палочки для еды'])).toBe(true);
    expect(checkDefinitionAnswer('мост', 'мост', ['палочки для еды'])).toBe(true);
    expect(checkDefinitionAnswer('край', 'мост', ['палочки для еды, край'])).toBe(true);
  });

  it('вспомогательные: нормализация и варианты', () => {
    expect(normalizeDefinition('  Ёлка!  ')).toBe('елка');
    expect(definitionVariants('Вода, водица')).toEqual(expect.arrayContaining(['вода', 'водица']));
    expect(definitionVariants('есть (о еде)')).toEqual(expect.arrayContaining(['есть (о еде', 'есть']));
  });
});
