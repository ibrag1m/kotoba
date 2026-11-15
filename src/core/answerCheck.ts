// Проверка ответа при вводе с клавиатуры. Чистые функции, без React и без базы.
//
// Два направления (раздел 10 архитектуры):
//  - «японский по переводу» (def-to-term): ввод японского; засчитывается совпадение с term ИЛИ с reading;
//    различия хирагана/катакана, пробелы и пунктуация не важны; ввод латиницей (романдзи)
//    или кириллицей не засчитывается и даёт признак romajiHint («переключите клавиатуру на японскую»);
//    в term и reading допустимы варианты через «/» «・» «、» «,» «;» и пояснения в скобках;
//  - «перевод по японскому» (term-to-def): без учёта регистра, «ё» = «е», лишние пробелы и пунктуация по краям
//    не важны; в эталоне допустимы несколько вариантов через «,» «;» «/».

/** Подсказка, когда вместо японского введена латиница или кириллица. */
export const ROMAJI_HINT_TEXT = 'Переключите клавиатуру на японскую';

// ---------- японский ----------

/** Хирагана и катакана сводятся к хирагане: ァ-ヶ (U+30A1–30F6) и знаки повтора ヽヾ сдвигаются на 0x60 вниз. */
function foldKana(s: string): string {
  return s.replace(/[ァ-ヶヽヾ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/**
 * Нормализация японского текста для сравнения: NFKC (полноширинные буквы и цифры, полукатакана, идеографический пробел),
 * нижний регистр, удаление пробелов (в том числе внутри), знаков пунктуации, символов и невидимых
 * символов форматирования, катакана приводится к хирагане. Долгий знак «ー» сохраняется.
 */
export function normalizeJapanese(s: string): string {
  const cleaned = s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{Z}\p{P}\p{S}\p{Cf}]/gu, '');
  return foldKana(cleaned);
}

/** Разделители вариантов в полях term и reading: «よん/し», «なに・なん», «しち、なな», «a, b», «a; b». */
const JP_SEPARATORS: ReadonlySet<string> = new Set(['/', '・', '、', ',', ';']);

/** Делит строку на части по разделителям вне скобок (строка предварительно приводится к NFKC). */
function splitTopLevel(s: string, separators: ReadonlySet<string>): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s.normalize('NFKC')) {
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (depth === 0 && separators.has(ch)) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** Часть без пояснений в скобках: «(お)かね» → «かね», «есть (о еде)» → «есть». */
function withoutParens(s: string): string {
  return s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
}

/** Скобки убраны, а их содержимое оставлено: «(по)ехать» → «поехать». */
function expandParens(s: string): string {
  return s.replace(/[()[\]]/g, '');
}

/**
 * Допустимые формы записи одного поля (term или reading) в нормализованном виде. Строка делится на варианты ДО
 * нормализации. Засчитываются: каждый вариант, он же без скобок, и вся строка целиком без разделителей (так не
 * ломается слово, в котором «・» это часть записи, например «ケーキ・バイキング»).
 */
export function japaneseForms(raw: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const n = normalizeJapanese(s);
    if (n !== '') out.add(n);
  };
  add(raw);
  add(withoutParens(raw));
  for (const part of splitTopLevel(raw, JP_SEPARATORS)) {
    add(part);
    add(withoutParens(part));
  }
  return [...out];
}

/** Запись без пробелов в NFKC: для полей, которые целиком состоят из пунктуации (например, «〜») и нормализуются в пустоту. */
function rawKey(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '');
}

export interface TermCheck {
  correct: boolean;
  /**
   * Ответ не засчитан, и в нём латинские или кириллические буквы: скорее всего, не переключена клавиатура на
   * японскую. Такой ответ не считается ошибкой, нужно показать подсказку и дать ввести заново.
   */
  romajiHint: boolean;
}

export interface JapaneseTerm {
  term: string;
  reading?: string;
}

/**
 * Проверка ввода «японский по переводу»: совпадение с любым вариантом term или reading (reading необязателен).
 * `equivalents` — другие карточки, на которые вопрос отвечает так же (тот же перевод): их term и reading тоже верны.
 */
export function checkTermAnswer(input: string, card: JapaneseTerm, equivalents: readonly JapaneseTerm[] = []): TermCheck {
  const given = normalizeJapanese(input);
  const forms = new Set<string>();
  const rawForms = new Set<string>();
  for (const c of [card, ...equivalents]) {
    for (const field of [c.term, c.reading]) {
      if (field === undefined) continue;
      if (normalizeJapanese(field) === '') {
        const key = rawKey(field);
        if (key !== '') rawForms.add(key);
      } else {
        for (const f of japaneseForms(field)) forms.add(f);
      }
    }
  }
  if (given === '') {
    const key = rawKey(input);
    return { correct: key !== '' && rawForms.has(key), romajiHint: false };
  }
  if (forms.has(given)) return { correct: true, romajiHint: false };
  return { correct: false, romajiHint: /[a-zа-яё]/.test(given) };
}

// ---------- перевод ----------

const EDGE_JUNK = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;

/** Нормализация перевода: NFKC, нижний регистр, «ё» → «е», пробелы схлопнуты, пунктуация по краям убрана. */
export function normalizeDefinition(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .replace(EDGE_JUNK, '');
}

const VARIANT_SEPARATORS: ReadonlySet<string> = new Set([',', ';', '/', '、']);

/** Допустимые ответы (в нормализованном виде) для эталонного перевода: каждый вариант, он же без скобок и с раскрытыми скобками. */
export function definitionVariants(definition: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const n = normalizeDefinition(s);
    if (n !== '') out.add(n);
  };
  add(definition);
  for (const part of splitTopLevel(definition, VARIANT_SEPARATORS)) {
    add(part);
    add(withoutParens(part));
    add(expandParens(part));
  }
  return [...out];
}

/**
 * Проверка ввода «перевод по японскому». Засчитывается, если ввод целиком равен эталону, либо каждый введённый
 * через «,» «;» «/» вариант совпал с одним из вариантов эталона (можно назвать не все).
 * `equivalents` — переводы других карточек с тем же словом на лицевой стороне: они тоже верны.
 */
export function checkDefinitionAnswer(input: string, definition: string, equivalents: readonly string[] = []): boolean {
  const accepted = new Set([definition, ...equivalents].flatMap(definitionVariants));
  const whole = normalizeDefinition(input);
  if (whole === '') return false;
  if (accepted.has(whole)) return true;
  const parts = splitTopLevel(input, VARIANT_SEPARATORS)
    .map(normalizeDefinition)
    .filter((p) => p !== '');
  return parts.length > 0 && parts.every((p) => accepted.has(p));
}
