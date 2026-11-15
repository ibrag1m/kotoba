// Парсер импорта слов из текста. Чистая функция, без React и IndexedDB.
//
// Правила (раздел 4 архитектуры и раздел 10 «Решения пользователя»):
//  - карточки разделяются новой строкой или точкой с запятой (или своим разделителем);
//  - слово и определение разделяются табуляцией, запятой (, ， 、), тире, пробелами или своим разделителем;
//  - строка режется по ПЕРВОМУ разделителю (по первым двум в режиме трёх колонок),
//    поэтому запятые и тире внутри определения не мешают;
//  - тире (- – — － ― − и ー) считается разделителем только с пробелами вокруг (well-known не ломается);
//  - «пробелы» как разделитель: два и более пробела или хотя бы один полноширинный пробел (U+3000);
//  - колонок 2 или 3: «слово, определение» либо «слово, чтение, определение»; чтение только каной,
//    иначе строка попадает в проблемные (латиница и русский не записываются как чтение);
//  - чтение можно написать в скобках после слова: 今日（きょう）;
//  - автоопределение: табуляция в половине строк и больше побеждает; иначе у каждой строки
//    берётся ПЕРВЫЙ по позиции кандидат (запятая, тире, пробелы), побеждает тот, кто чаще первый;
//    если строки не согласны друг с другом, выдаётся предупреждение;
//  - пустые строки пропускаются (считаются), дубли и плохие строки попадают в issues.

export type ColumnDelimiterChoice = 'auto' | 'tab' | 'comma' | 'dash' | 'space' | 'custom';
export type RowDelimiterChoice = 'auto' | 'newline' | 'semicolon' | 'custom';
export type ColumnsChoice = 'auto' | 2 | 3;

export type ResolvedColumnDelimiter = Exclude<ColumnDelimiterChoice, 'auto'>;
export type ResolvedRowDelimiter = Exclude<RowDelimiterChoice, 'auto'>;

export interface ParseOptions {
  columnDelimiter?: ColumnDelimiterChoice;
  customColumnDelimiter?: string;
  rowDelimiter?: RowDelimiterChoice;
  customRowDelimiter?: string;
  /** По умолчанию 'auto': три колонки, если вторая похожа на чтение (кана). */
  columns?: ColumnsChoice;
  /** Ключи (см. duplicateKey) карточек, которые уже есть в колоде. */
  existingKeys?: ReadonlySet<string>;
}

export interface ParsedRow {
  /** Номер записи в исходном тексте (с 1; для режима «новая строка» это номер строки). */
  line: number;
  term: string;
  reading?: string;
  definition: string;
}

export type IssueKind =
  | 'no-delimiter'
  | 'empty-term'
  | 'empty-definition'
  | 'bad-reading'
  | 'duplicate'
  | 'duplicate-existing';

export interface ParseIssue {
  line: number;
  raw: string;
  kind: IssueKind;
  message: string;
}

export type WarningKind = 'ambiguous-delimiter' | 'semicolon-split';

/** Предупреждение: разбор выполнен, но результат стоит проверить глазами. */
export interface ParseWarning {
  kind: WarningKind;
  message: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  issues: ParseIssue[];
  warnings: ParseWarning[];
  /** Сколько пустых записей пропущено. */
  emptyLines: number;
  /** Определённый (или выбранный) разделитель слова и определения; null, если не найден. */
  columnDelimiter: ResolvedColumnDelimiter | null;
  rowDelimiter: ResolvedRowDelimiter;
}

const DELIMITER_NAMES: Record<ResolvedColumnDelimiter, string> = {
  tab: 'табуляция',
  comma: 'запятая',
  dash: 'тире',
  space: 'пробелы',
  custom: 'свой разделитель',
};

// Невидимые символы: пробел нулевой ширины, ZWNJ, ZWJ, word joiner и BOM. Режем до разбора.
// Задаём через строку, чтобы в исходнике не было невидимых символов.
const INVISIBLES_RE = new RegExp('[\\u200B-\\u200D\\u2060\\uFEFF]', 'g');
// Переводы строк: CRLF, CR, LF, а также LS (U+2028), PS (U+2029) и NEL (U+0085).
const NEWLINE_RE = /\r\n|[\r\n\u2028\u2029\u0085]/;
const NEWLINE_OR_SEMICOLON_RE = /;|；|\r\n|[\r\n\u2028\u2029\u0085]/;

const IDEOGRAPHIC_SPACE = '\u3000';
const EDGE_SPACES = new RegExp('^[ ' + IDEOGRAPHIC_SPACE + ']+|[ ' + IDEOGRAPHIC_SPACE + ']+$', 'g');

// Тире с пробелами вокруг. ー (долгота катаканы) тоже тут, но пробелы обязательны: в コーヒー она не режет.
const DASH_CHARS = '\\-\\u2013\\u2014\\uFF0D\\u2015\\u2212\\u30FC';
const DASH_RE = new RegExp('\\s+[' + DASH_CHARS + ']\\s+');
const DASH_TRAILING_RE = new RegExp('(?:\\s+[' + DASH_CHARS + '])+\\s*$');
// Запятая: обычная, полноширинная и японская 、.
const COMMA_RE = /[,，、]/;
// Два и более пробела либо хотя бы один полноширинный пробел (вместе с соседними пробелами).
const SPACE_RE = /[ \u3000]*\u3000[ \u3000]*| {2,}/;

// Хирагана, катакана (включая ー и ・), расширение катаканы, полуширинная катакана, знаки ~ и /, пробелы.
// 、 разрешена: в поле, уже вырезанном табуляцией, тире или пробелами, это перечисление чтений.
// Если запятая (, ， 、) — разделитель колонок, внутри поля её не бывает, поэтому конфликта нет.
const KANA_READING_RE = /^[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ〜～/、\s]+$/u;

/** Похоже ли поле на чтение: только хирагана, катакана, ー, ・, пробелы. */
export function looksLikeReading(s: string): boolean {
  return s.length > 0 && KANA_READING_RE.test(s);
}

/** Ключ для поиска дублей: без невидимых символов, NFKC, пробелы, регистр. Слово и чтение вместе. */
export function duplicateKey(term: string, reading?: string): string {
  const norm = (s: string) =>
    s.replace(INVISIBLES_RE, '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${norm(term)}|${norm(reading ?? '')}`;
}

interface Matcher {
  /** Первое вхождение разделителя начиная с позиции from. */
  find(s: string, from: number): { index: number; length: number } | null;
}

function literalMatcher(delim: string): Matcher {
  return {
    find(s, from) {
      const index = s.indexOf(delim, from);
      return index < 0 ? null : { index, length: delim.length };
    },
  };
}

function regexMatcher(re: RegExp): Matcher {
  const global = new RegExp(re.source, 'g');
  return {
    find(s, from) {
      global.lastIndex = from;
      const m = global.exec(s);
      return m ? { index: m.index, length: m[0].length } : null;
    },
  };
}

const TAB = literalMatcher('\t');
const COMMA = regexMatcher(COMMA_RE);
const DASH = regexMatcher(DASH_RE);
const SPACE = regexMatcher(SPACE_RE);

const isBlank = (s: string) => s.trim() === '';

/** Если ячейка целиком в кавычках CSV ("..." с "" внутри), возвращает содержимое. */
function unquoteWhole(cell: string): string {
  const t = cell.trim();
  if (t.length >= 2 && /^"(?:[^"]|"")*"$/.test(t)) return t.slice(1, -1).replace(/""/g, '"');
  return cell;
}

/**
 * Ячейка в кавычках, начинающаяся в позиции pos: после закрывающей кавычки должен идти
 * разделитель (или конец строки). next === null — это была последняя ячейка.
 */
function readQuoted(s: string, pos: number, matcher: Matcher): { cell: string; next: number | null } | null {
  let i = pos;
  while (i < s.length && (s[i] === ' ' || s[i] === IDEOGRAPHIC_SPACE)) i++;
  if (s[i] !== '"') return null;
  let j = i + 1;
  let cell = '';
  for (;;) {
    if (j >= s.length) return null;
    if (s[j] === '"') {
      if (s[j + 1] === '"') {
        cell += '"';
        j += 2;
        continue;
      }
      break;
    }
    cell += s[j];
    j++;
  }
  const after = j + 1;
  if (isBlank(s.slice(after))) return { cell, next: null };
  const m = matcher.find(s, after);
  if (m && isBlank(s.slice(after, m.index))) return { cell, next: m.index + m.length };
  return null;
}

/**
 * Режет строку не более чем на maxParts частей; остаток целиком остаётся в последней.
 * Ячейки, целиком взятые в кавычки CSV, разделитель внутри кавычек не режут; кавычки снимаются.
 */
function splitLimited(s: string, matcher: Matcher, maxParts: number): string[] {
  const parts: string[] = [];
  let pos = 0;
  while (parts.length < maxParts - 1) {
    const q = readQuoted(s, pos, matcher);
    if (q) {
      parts.push(q.cell);
      if (q.next === null) return parts.map((p) => p.trim());
      pos = q.next;
      continue;
    }
    const m = matcher.find(s, pos);
    if (!m) break;
    parts.push(unquoteWhole(s.slice(pos, m.index)));
    pos = m.index + m.length;
  }
  parts.push(unquoteWhole(s.slice(pos)));
  return parts.map((p) => p.trim());
}

/** Есть ли в куске хоть один возможный разделитель колонок (для выбора разделителя карточек). */
function anyColumnDelimiter(s: string): boolean {
  return TAB.find(s, 0) !== null || COMMA.find(s, 0) !== null || DASH.find(s, 0) !== null || SPACE.find(s, 0) !== null;
}

function splitRecords(
  clean: string,
  choice: RowDelimiterChoice,
  custom: string | undefined,
  hasColumnDelimiter: (chunk: string) => boolean,
): { records: string[]; resolved: ResolvedRowDelimiter } {
  let resolved: ResolvedRowDelimiter;
  if (choice === 'auto') {
    // Точка с запятой режет карточки, только если нет переводов строк и КАЖДЫЙ кусок похож на
    // карточку. Так «言う, сказать; говорить» остаётся одной карточкой.
    const trimmed = clean.trim();
    resolved = 'newline';
    if (!NEWLINE_RE.test(trimmed) && /[;；]/.test(trimmed)) {
      const chunks = trimmed.split(/[;；]/).filter((c) => !isBlank(c));
      if (chunks.length >= 2 && chunks.every(hasColumnDelimiter)) resolved = 'semicolon';
    }
  } else {
    resolved = choice;
  }
  if (resolved === 'semicolon') return { records: clean.split(NEWLINE_OR_SEMICOLON_RE), resolved };
  if (resolved === 'custom' && custom) {
    return {
      records: clean.split(custom).flatMap((part) => part.split(NEWLINE_RE)),
      resolved,
    };
  }
  return { records: clean.split(NEWLINE_RE), resolved: resolved === 'custom' ? 'newline' : resolved };
}

// Маркер списка в начале строки: «- », «• », «* », «1. », «2) ».
const LIST_MARKER_RE = /^(?:[-–—•*・‣◦●○▪]|\d{1,3}[.)])(?:\s+|$)/;

interface Prepared {
  /** Запись без краёв-пробелов (для показа в списке проблем). */
  raw: string;
  /** То, что разбирается: без маркера списка. */
  body: string;
}

function prepare(record: string): Prepared {
  // Края режем только по пробелам: табуляция на краю — это пустое поле, а не мусор.
  const raw = record.replace(EDGE_SPACES, '');
  const body = raw.replace(LIST_MARKER_RE, '').replace(EDGE_SPACES, '');
  return { raw, body };
}

type Candidate = 'comma' | 'dash' | 'space';
const CANDIDATE_ORDER: readonly Candidate[] = ['comma', 'dash', 'space'];
const CANDIDATE_MATCHER: Record<Candidate, Matcher> = { comma: COMMA, dash: DASH, space: SPACE };

interface Detection {
  delimiter: ResolvedColumnDelimiter | null;
  /** Сколько строк начинаются с другого кандидата, чем победитель; из скольких непустых всего. */
  disagree: number;
  filled: number;
}

function detectColumnDelimiter(bodies: string[]): Detection {
  const filled = bodies.filter((r) => !isBlank(r));
  if (filled.length === 0) return { delimiter: null, disagree: 0, filled: 0 };

  // Табуляция — осознанный разделитель (Excel, Google Таблицы, Quizlet): достаточно половины строк.
  const withTab = filled.filter((r) => r.includes('\t')).length;
  if (withTab * 2 >= filled.length) return { delimiter: 'tab', disagree: 0, filled: filled.length };

  // Для каждой строки: какой кандидат стоит первым по позиции (при равной позиции: запятая, тире, пробелы).
  const firstCount: Record<Candidate, number> = { comma: 0, dash: 0, space: 0 };
  const firstOf: (Candidate | null)[] = filled.map((r) => {
    let best: Candidate | null = null;
    let bestIndex = Infinity;
    for (const c of CANDIDATE_ORDER) {
      const m = CANDIDATE_MATCHER[c].find(r, 0);
      if (m && m.index < bestIndex) {
        best = c;
        bestIndex = m.index;
      }
    }
    if (best) firstCount[best]++;
    return best;
  });

  let winner: Candidate | null = null;
  for (const c of CANDIDATE_ORDER) {
    if (firstCount[c] > 0 && (winner === null || firstCount[c] > firstCount[winner])) winner = c;
  }
  if (winner === null || firstCount[winner] * 2 < filled.length) {
    // Кандидаты в строках есть, но ни один не набрал половину: строки сильно расходятся.
    return { delimiter: null, disagree: winner === null ? 0 : filled.length, filled: filled.length };
  }
  const disagree = firstOf.filter((f) => f !== null && f !== winner).length;
  return { delimiter: winner, disagree, filled: filled.length };
}

function matcherFor(delim: ResolvedColumnDelimiter, custom: string | undefined): Matcher | null {
  switch (delim) {
    case 'tab':
      return TAB;
    case 'comma':
      return COMMA;
    case 'dash':
      return DASH;
    case 'space':
      return SPACE;
    case 'custom':
      return custom ? literalMatcher(custom) : null;
  }
}

/** Убирает хвостовые разделители («слово, перевод,» → «слово, перевод»). Табуляцию не трогает. */
function stripTrailingDelimiters(record: string, delim: ResolvedColumnDelimiter, custom: string | undefined): string {
  switch (delim) {
    case 'comma':
      return record.replace(/[\s,，、]+$/, '');
    case 'dash':
      return record.replace(DASH_TRAILING_RE, '');
    case 'custom': {
      if (!custom) return record;
      let out = record.trimEnd();
      while (out.endsWith(custom)) out = out.slice(0, -custom.length).trimEnd();
      return out;
    }
    default:
      return record;
  }
}

interface RawSplit {
  term: string;
  reading?: string;
  definition: string;
}

/** Делит запись на колонки; возвращает null, если разделителя в записи нет. */
function splitColumns(
  record: string,
  matcher: Matcher,
  delim: ResolvedColumnDelimiter,
  columns: ColumnsChoice,
): RawSplit | null {
  if (columns === 2 || columns === 3) {
    const parts = splitLimited(record, matcher, columns);
    if (parts.length < columns) return null;
    return columns === 2
      ? { term: parts[0] ?? '', definition: parts[1] ?? '' }
      : { term: parts[0] ?? '', reading: parts[1] ?? '', definition: parts[2] ?? '' };
  }

  // auto: смотрим на все части
  const all = splitLimited(record, matcher, Number.MAX_SAFE_INTEGER);
  // Хвостовой разделитель («слово<TAB>перевод<TAB>») не создаёт третью колонку.
  if (all.length >= 3 && all[all.length - 1] === '') all.pop();
  if (all.length < 2) return null;
  // Табуляция: три и больше частей — это три колонки (чтение проверяется позже и должно быть каной).
  // Остальные разделители: третья колонка только если вторая похожа на чтение.
  const threeCols = all.length >= 3 && (delim === 'tab' || looksLikeReading(all[1] ?? ''));
  const parts = splitLimited(record, matcher, threeCols ? 3 : 2);
  return threeCols
    ? { term: parts[0] ?? '', reading: parts[1] ?? '', definition: parts[2] ?? '' }
    : { term: parts[0] ?? '', definition: parts[1] ?? '' };
}

// Чтение в скобках после слова: 今日（きょう） или 今日(きょう).
const BRACKET_READING_RE = /^(.+?)\s*[（(]\s*([^（()）]+?)\s*[）)]$/u;

function extractBracketReading(term: string): { term: string; reading: string } | null {
  const m = BRACKET_READING_RE.exec(term);
  const base = m?.[1]?.trim();
  const reading = m?.[2];
  if (!m || !base || reading === undefined || !looksLikeReading(reading)) return null;
  return { term: base, reading };
}

export function parseImport(text: string, options: ParseOptions = {}): ParseResult {
  const clean = text.replace(INVISIBLES_RE, '');
  const choice = options.columnDelimiter ?? 'auto';

  const explicitMatcher = choice === 'auto' ? null : matcherFor(choice, options.customColumnDelimiter);
  const hasColumnDelimiter =
    choice === 'auto' ? anyColumnDelimiter : (chunk: string) => explicitMatcher?.find(chunk, 0) != null;

  const { records, resolved: rowDelimiter } = splitRecords(
    clean,
    options.rowDelimiter ?? 'auto',
    options.customRowDelimiter,
    hasColumnDelimiter,
  );
  const prepared = records.map(prepare);

  const warnings: ParseWarning[] = [];
  let columnDelimiter: ResolvedColumnDelimiter | null;
  if (choice === 'auto') {
    const d = detectColumnDelimiter(prepared.map((p) => p.body));
    columnDelimiter = d.delimiter;
    if (d.delimiter === null && d.disagree > 0) {
      warnings.push({
        kind: 'ambiguous-delimiter',
        message:
          'Разделитель не определён: в разных строках первыми стоят разные разделители. ' +
          'Выберите разделитель вручную в блоке «Разделители».',
      });
    }
    if (d.delimiter !== null && d.disagree > 0) {
      warnings.push({
        kind: 'ambiguous-delimiter',
        message:
          `Разделитель определён неуверенно: ${DELIMITER_NAMES[d.delimiter]} стоит первой в ${d.filled - d.disagree} ` +
          `из ${d.filled} строк, в остальных первой стоит другая. Проверьте таблицу ниже или выберите разделитель вручную.`,
      });
    }
  } else {
    columnDelimiter = choice;
  }
  const matcher = columnDelimiter ? matcherFor(columnDelimiter, options.customColumnDelimiter) : null;
  const columns = options.columns ?? 'auto';

  if (rowDelimiter === 'semicolon' && /[;；]/.test(clean)) {
    const n = prepared.filter((p) => !isBlank(p.body)).length;
    warnings.push({
      kind: 'semicolon-split',
      message:
        `Карточки разделены точкой с запятой: получилось записей ${n}. Если «;» стоит внутри перевода ` +
        'одной карточки, выберите «Новая строка» в разделителях.',
    });
  }

  const rows: ParsedRow[] = [];
  const issues: ParseIssue[] = [];
  let emptyLines = 0;
  const seen = new Set<string>();

  prepared.forEach(({ raw, body }, i) => {
    const line = i + 1;
    if (isBlank(body)) {
      emptyLines++;
      return;
    }
    const issue = (kind: IssueKind, message: string) => {
      issues.push({ line, raw, kind, message });
    };

    let split: RawSplit | null = null;
    if (matcher && columnDelimiter) {
      // Хвостовые разделители убираем, если запись и без них делится на колонки.
      const stripped = stripTrailingDelimiters(body, columnDelimiter, options.customColumnDelimiter);
      split =
        (stripped !== body ? splitColumns(stripped, matcher, columnDelimiter, columns) : null) ??
        splitColumns(body, matcher, columnDelimiter, columns);
    }
    if (!split) {
      issue(
        'no-delimiter',
        columnDelimiter
          ? 'Не найден разделитель между словом и определением'
          : 'Разделитель слова и определения не определён',
      );
      return;
    }

    let { term } = split;
    let reading = split.reading ? split.reading : undefined;
    const { definition } = split;
    if (term === '') return issue('empty-term', 'Пустое слово');
    if (definition === '') return issue('empty-definition', 'Пустое определение');
    if (reading !== undefined && !looksLikeReading(reading)) {
      return issue('bad-reading', `Чтение должно быть написано каной, а здесь «${reading}». Строка не добавлена`);
    }
    if (reading === undefined) {
      const bracket = extractBracketReading(term);
      if (bracket) {
        term = bracket.term;
        reading = bracket.reading;
      }
    }

    const key = duplicateKey(term, reading);
    if (options.existingKeys?.has(key)) return issue('duplicate-existing', 'Такая карточка уже есть в колоде');
    if (seen.has(key)) return issue('duplicate', 'Повтор в добавляемом тексте');
    seen.add(key);

    const row: ParsedRow = { line, term, definition };
    if (reading !== undefined) row.reading = reading;
    rows.push(row);
  });

  return { rows, issues, warnings, emptyLines, columnDelimiter, rowDelimiter };
}
