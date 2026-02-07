import { NextRequest, NextResponse } from 'next/server';
import { SYSTEM_PROMPT, CONTEXT_PROMPT } from '@/lib/prompts';

export const runtime = 'nodejs';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface RequestBody {
  messages: Message[];
  cvText?: string;
  selectedRoleTitle?: string;
}

type Mode = 'AUDIT_ONLY' | 'NORMAL';

/** =========================
 *  Input validation (FIX #4)
 *  ========================= */
function coerceString(v: unknown) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  try {
    return String(v);
  } catch {
    return '';
  }
}

function isRoleAllowed(v: unknown): v is Message['role'] {
  return v === 'user' || v === 'assistant';
}

function validateRequestBody(raw: any): { ok: true; body: RequestBody } | { ok: false; error: string; status: number } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Invalid JSON body', status: 400 };

  const rawMessages = (raw as any).messages;
  if (!Array.isArray(rawMessages)) return { ok: false, error: 'Messages array is required', status: 400 };

  // sanitize messages (drop unknown roles)
  const messages: Message[] = rawMessages
    .map((m: any) => {
      const role = m?.role;
      if (!isRoleAllowed(role)) return null;
      const content = coerceString(m?.content ?? '');
      return { role, content };
    })
    .filter(Boolean) as Message[];

  if (messages.length === 0) return { ok: false, error: 'Messages must include at least 1 valid item', status: 400 };

  const userCount = messages.filter((m) => m.role === 'user' && m.content.trim()).length;
  if (userCount === 0) return { ok: false, error: 'At least one user message is required', status: 400 };

  const cvText = typeof (raw as any).cvText === 'string' ? (raw as any).cvText : undefined;
  const selectedRoleTitle = typeof (raw as any).selectedRoleTitle === 'string' ? (raw as any).selectedRoleTitle : undefined;

  // soft cap (prevents accidental huge payloads)
  const MAX_MESSAGES = 120;
  const safeMessages = messages.slice(-MAX_MESSAGES);

  return { ok: true, body: { messages: safeMessages, cvText, selectedRoleTitle } };
}

/** =========================
 *  Text utils
 *  ========================= */
function normalizeNewlines(text: string) {
  return (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function collapseBlankLines(text: string, maxBlankLines: number) {
  const max = maxBlankLines + 1;
  const re = new RegExp(`\\n{${max + 1},}`, 'g');
  return text.replace(re, '\n'.repeat(max));
}

function normalizeForUI(text: string, maxBlankLines: number) {
  const t = normalizeNewlines(text)
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .map((l) => (l.trim().length === 0 ? '' : l))
    .join('\n');

  return collapseBlankLines(t, maxBlankLines).trim();
}

function stripLeadingIndentAllLines(text: string) {
  return normalizeNewlines(text)
    .split('\n')
    .map((l) => l.replace(/^[ \t]{2,}/g, ''))
    .join('\n');
}
function enforceBeforeBlock(txt: string, roleTitle: string, roleBlockText: string): string {
  let t = normalizeNewlines(txt || '');

  // jeśli nie mamy pewnego bloku roli -> NIE nadpisuj BEFORE
  const before = normalizeNewlines(roleBlockText || '').trim();
  if (!before) return t;

  const header = `=== BEFORE (${roleTitle}) ===`;
  const afterHeaderRe = /^===\s*AFTER\s*\([^)]+\)\s*===\s*$/mi;

  const lines = t.split('\n');
  const idxBefore = lines.findIndex((l) => l.trim() === header);
  if (idxBefore === -1) return t;

  // znajdź start treści BEFORE (linia po nagłówku)
  const start = idxBefore + 1;

  // znajdź koniec treści BEFORE (pierwsza linia "=== AFTER (...) ===")
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (afterHeaderRe.test(lines[i])) {
      end = i;
      break;
    }
  }

  // podmień zawartość BEFORE na dokładny blok roli
  const newLines = [
    ...lines.slice(0, start),
    ...before.split('\n'),
    ...lines.slice(end),
  ];

  return newLines.join('\n');
}

function stripFencedCodeBlock(text: string) {
  const t = normalizeNewlines(text).trim();
  const m = t.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : t;
}
function buildDeterministicRewriteFallback(params: {
  roleTitle: string;
  roleBlockText: string;
  userFactsText: string;
}): string {
  const { roleTitle, roleBlockText, userFactsText } = params;

  const clean = (s: any) => String(s || '').replace(/\s+/g, ' ').trim();

  const linesAll = `${roleBlockText}\n${userFactsText}`
    .split('\n')
    .map((l) => clean(l))
    .filter(Boolean);
  const isGarbage = (l: string) => userNonAnswer(l) || /^(\.\.\.|…)+$/.test(l.trim());

  const linesAllClean = linesAll.filter((l) => !isGarbage(l));

  // usuń linię nagłówka roli (zwykle zawiera daty i "|")
  const headerLike = (l: string) => l.includes('|') || /\b\d{2}\.\d{4}\b|\b\d{4}\b/.test(l);
  const contentLines = linesAllClean.filter((l) => l !== roleTitle && !headerLike(l));

  // wyciągnij “Skala:” i “Wynik:” jeśli są
  const scaleLine =
    linesAllClean.find((l) => /^skala\s*:/i.test(l)) ||
    linesAllClean.find((l) => /\b(pr\s*\/\s*mies|ticket|sprint|wdroż|deploy|test case|zgłosze[nń]|bug)\b/i.test(l));

  const resultLine =
    linesAllClean.find((l) => /^(wynik|result)\s*:/i.test(l)) ||
    linesAllClean.find((l) => /\b(error rate|mttr|uptime|defect leakage|pass rate|csat|nps|sla|cac|cpa|roas|ctr|cr)\b/i.test(l));

  // “proces / narzędzia” – tylko jeśli w źródłach coś faktycznie jest
  const toolHints = [
    'Jira', 'Git', 'GitHub', 'GitLab', 'Bitbucket', 'Confluence',
    'TestRail', 'Zephyr', 'Xray', 'Docker', 'Kubernetes'
  ];

  const toolsFound = toolHints.filter((t) =>
    linesAllClean.some((l) => l.toLowerCase().includes(t.toLowerCase()))
  );

  // actions: bierz 2–4 pierwsze sensowne linie opisu (bez Skala/Wynik)
  const actionCandidates = contentLines.filter(
    (l) => !/^skala\s*:/i.test(l) && !/^(wynik|result)\s*:/i.test(l)
  );

  const actions = actionCandidates.slice(0, 4);
  const aBullets: string[] = [];

  // A: actions
  for (const a of actions) aBullets.push(`- ${a}`);

  // A: skala/wynik/process (tylko jeśli mamy)
  if (scaleLine && /^skala\s*:/i.test(scaleLine)) aBullets.push(`- ${scaleLine}`);
  if (resultLine && (/^(wynik|result)\s*:/i.test(resultLine) || resultLine.includes('%') || /\d/.test(resultLine)))
    aBullets.push(`- ${resultLine}`);

  if (toolsFound.length) aBullets.push(`- Proces / narzędzia: ${toolsFound.join(', ')}`);

  // domknij do 3–8 bulletów (bez dodawania faktów: powtarzamy istniejące)
  while (aBullets.length < 3 && actionCandidates.length) {
    const extra = actionCandidates[aBullets.length - 1];
    if (extra) aBullets.push(`- ${extra}`);
    else break;
  }
  const aFinal = aBullets.slice(0, 8);

  // B: ma się różnić od A -> zmieniamy kolejność + lekko wzmacniamy czasowniki (bez dopisywania faktów)
  const bBullets: string[] = [];

  const actionsRotated = actions.length > 1 ? [...actions.slice(1), actions[0]] : actions;
  for (const a of actionsRotated) {
    // minimalna modyfikacja słowna, bez nowych danych
    bBullets.push(`- Realizacja: ${a}`);
  }
  if (scaleLine && /^skala\s*:/i.test(scaleLine)) bBullets.push(`- ${scaleLine}`);
  if (resultLine && (/^(wynik|result)\s*:/i.test(resultLine) || resultLine.includes('%') || /\d/.test(resultLine)))
    bBullets.push(`- ${resultLine}`);
  if (toolsFound.length) bBullets.push(`- Proces / narzędzia: ${toolsFound.join(', ')}`);

  while (bBullets.length < 3 && actionCandidates.length) {
    const extra = actionCandidates[bBullets.length - 1];
    if (extra) bBullets.push(`- Realizacja: ${extra}`);
    else break;
  }
  const bFinal = bBullets.slice(0, 8);

  // BEFORE: 4–12 linii z oryginalnego opisu roli (bez metadanych CV)
  const beforeLines = contentLines.slice(0, 12);
  while (beforeLines.length < 4 && linesAllClean.length) {
    // jako last resort, dobijamy z całości (ale nadal bez headerów)
    const extra = contentLines[beforeLines.length] || '';
    if (extra) beforeLines.push(extra);
    else break;
  }

  return [
    `=== BEFORE (${roleTitle}) ===`,
    ...beforeLines.slice(0, 12),
    `=== AFTER (${roleTitle}) ===`,
    `Wersja A (bezpieczna):`,
    ...aFinal,
    `Wersja B (mocniejsza):`,
    ...bFinal,
    ``,
    `Chcesz poprawić kolejną rolę?`,
  ].join('\n');
}
/**
 * strip simple line-level markdown decorations often present in CV pastes
 * Examples:
 *   *Firma ...*  -> Firma ...
 *   **Title**    -> Title
 */
function stripMarkdownDecorationsAllLines(text: string) {
  const lines = normalizeNewlines(text || '').split('\n');

  const stripWrap = (line: string) => {
    let t = line.trimEnd();

    // remove italics/bold wrapping of the entire line (keep actual bullets handled elsewhere)
    t = t.replace(/^\s*\*{1,3}(.+?)\*{1,3}\s*$/g, '$1');
    t = t.replace(/^\s*_{1,3}(.+?)_{1,3}\s*$/g, '$1');

    // normalize stray leading markdown markers like "> " from quotes
    t = t.replace(/^\s*>\s+/g, '');

    return t;
  };

  return lines.map(stripWrap).join('\n');
}

/** =========================
 *  Deglue date tokens + normalize date dashes
 *  ========================= */
function deglueDateTokens(text: string) {
  let t = normalizeNewlines(text || '');
  if (!t.trim()) return t;

  // Insert space between letters and (MM/YYYY|YYYY)
  t = t.replace(
    /([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])((?:19|20)\d{2}|\b(?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}\b)/g,
    '$1 $2'
  );

  // Insert space between (MM/YYYY|YYYY) and letters
  t = t.replace(
    /(\b(?:19|20)\d{2}\b|\b(?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}\b)(?=[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])/g,
    '$1 '
  );

  // Ensure space before obecnie/present if glued to previous token
  t = t.replace(/([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż0-9])(?=(obecnie|present)\b)/gi, '$1 ');

  // Ensure space after obecnie/present if glued to following letters (fix presentbody)
  t = t.replace(/(obecnie|present)(?=[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])/gi, '$1 ');

  return t;
}

function normalizeDateDashes(text: string) {
  let t = normalizeNewlines(text || '');
  if (!t.trim()) return t;

  // normalize "2020-2024" / "03.2021–obecnie" / "03/2021 - present" into "… – …"
  t = t.replace(
    /(\b(?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}\b|\b(?:19|20)\d{2}\b)\s*[-–—]\s*(\b(?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}\b|\b(?:19|20)\d{2}\b|\bobecnie\b|\bpresent\b)/gi,
    (_m, a, b) => `${a} – ${b}`
  );

  // also handle compact "2020–present" (no spaces)
  t = t.replace(
    /(\b(?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}\b|\b(?:19|20)\d{2}\b)[-–—](\b(?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}\b|\b(?:19|20)\d{2}\b|\bobecnie\b|\bpresent\b)/gi,
    (_m, a, b) => `${a} – ${b}`
  );

  return t;
}

/** =========================
 *  Dedupe lines (consecutive)
 *  ========================= */
function dedupeConsecutiveLines(text: string) {
  const lines = normalizeNewlines(text || '').split('\n');
  const out: string[] = [];
  let prevKey = '';

  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/g, '');
    const key = line.trim().replace(/\s+/g, ' ').toLowerCase();

    if (!key) {
      out.push('');
      prevKey = '';
      continue;
    }

    if (key === prevKey) continue;
    out.push(line);
    prevKey = key;
  }

  return out.join('\n');
}

/** =========================
 *  Date helpers
 *  ========================= */
function isDateLineLike(line: string) {
  const t = (line || '').trim();
  if (!t) return false;

  if (/(\b\d{2}\/\d{4}\b)\s*[–-]\s*(obecnie|present|\b\d{2}\/\d{4}\b)/i.test(t)) return true;
  if (/(\b\d{2}\.\d{4}\b)\s*[–-]\s*(obecnie|present|\b\d{2}\.\d{4}\b)/i.test(t)) return true;
  if (/(\b\d{4}\b)\s*[–-]\s*(obecnie|present|\b\d{4}\b)/i.test(t)) return true;

  return false;
}

function extractDatesFromLine(line: string) {
  const t = normalizeDateDashes(deglueDateTokens(normalizeNewlines(line || '')));

  const m1 = t.match(/(\d{2}[./\/-]\d{4})\s*[–-]\s*(obecnie|present|\d{2}[./\/-]\d{4})/i);
  if (m1) return `${m1[1]} – ${m1[2]}`;

  const m2 = t.match(/(\b(?:19|20)\d{2}\b)\s*[–-]\s*(obecnie|present|\b(?:19|20)\d{2}\b)/i);
  if (m2) return `${m2[1]} – ${m2[2]}`;

  return '';
}

/** =========================
 *  Split inline header: "Role - Company 2020 – present body"
 *  (named groups to avoid group-count bugs)
 *  ========================= */
function splitHeaderDatesAndInlineBody(line: string): {
  headerPart: string;
  dates: string;
  inlineBody: string;
} | null {
  const t = normalizeDateDashes(deglueDateTokens((line || '').trim()));
  if (!t) return null;

  const re =
    /^(?<before>.+?)\s+(?<range>(?<start>(?:\d{2}[./-]\d{4}|\b(?:19|20)\d{2}\b))\s*[–-]\s*(?<end>(?:\d{2}[./-]\d{4}|\b(?:19|20)\d{2}\b|obecnie|present)))\s*(?<after>.*)$/i;

  const m = t.match(re);
  if (!m || !m.groups) return null;

  const headerPart = (m.groups.before || '').trim();
  const dates = `${m.groups.start} – ${m.groups.end}`.trim();
  const inlineBody = (m.groups.after || '').trim();

  if (!headerPart || !dates) return null;
  if (headerPart.length < 3) return null;

  return { headerPart, dates, inlineBody };
}

/** =========================
 *  Header with trailing single start date:
 *   "… - Company 06/2024" + body starts with "Obecnie ..."
 *  ========================= */
function splitTrailingStartDate(line: string): { headerPart: string; startDate: string } | null {
  const t = normalizeDateDashes(deglueDateTokens((line || '').trim()));
  if (!t) return null;

  const m = t.match(/^(?<before>.+?)\s+(?<start>(?:\d{2}[./-]\d{4}|\b(?:19|20)\d{2}\b))\s*$/i);
  if (!m || !m.groups) return null;

  const headerPart = (m.groups.before || '').trim();
  const startDate = (m.groups.start || '').trim();
  if (!headerPart || !startDate) return null;

  return { headerPart, startDate };
}

/** =========================
 *  Single-paragraph paste fixer
 *  ========================= */
function countDateRanges(text: string) {
  const t = normalizeDateDashes(deglueDateTokens(normalizeNewlines(text || '')));
  const m =
    t.match(
      /(\b\d{2}[./-]\d{4}\b|\b\d{2}\/\d{4}\b|\b(?:19|20)\d{2}\b)\s*[–-]\s*(obecnie|present|\b\d{2}[./-]\d{4}\b|\b\d{2}\/\d{4}\b|\b(?:19|20)\d{2}\b)/gi
    ) || [];
  return m.length;
}

function injectCvLineBreaks(text: string) {
  let t = normalizeDateDashes(deglueDateTokens(normalizeNewlines(text || '')));
  const nl = (t.match(/\n/g) || []).length;
  const dr = countDateRanges(t);

  if (nl >= 4) return t;
  if (t.trim().length < 120) return t;
  if (dr === 0) return t;

  // break around date ranges
  // FIX #1: correct callback args (previously used offset as group)
  t = t.replace(
    /(\b\d{2}[./-]\d{4}\b|\b\d{2}\/\d{4}\b|\b(?:19|20)\d{2}\b)\s*[–-]\s*(obecnie|present|\b\d{2}[./-]\d{4}\b|\b\d{2}\/\d{4}\b|\b(?:19|20)\d{2}\b)/gi,
    (_m, a, b) => `\n${a} – ${b}\n`
  );

  // break BEFORE obvious ALLCAPS headers ONLY when they are preceded by sentence punctuation,
  // so we don't split inside a single header like "E-COMMERCE / MARKETPLACE SPECIALIST - ...".
  t = t.replace(
    /([.!?…:;)])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ][A-ZĄĆĘŁŃÓŚŹŻ0-9 /&.]{2,}\s(?:\-|–)\s)/g,
    '$1\n'
  );

  t = collapseBlankLines(t, 1);
  return t.trim();
}

/**
 * unwrap hard-wrap (PDF/Word) without breaking headers/bullets
 */
function unwrapHardWrap(text: string) {
  const raw = normalizeNewlines(text || '');
  if (!raw.trim()) return raw;

  const lines = raw.split('\n');

  const isBullet = (l: string) => /^[-•*]\s+/.test(l.trim());
  const isHeadingLike = (l: string) => {
    const t = l.trim();
    if (!t) return false;
    if (t.startsWith('(')) return false;
    if (isBullet(t)) return false;
    if (t.length < 4 || t.length > 160) return false;

    if (/[A-ZĄĆĘŁŃÓŚŹŻ]{3,}/.test(t) && t === t.toUpperCase()) return true;
    if (/\s[-–]\s/.test(t)) return true;
    if (/\b(sp\. z o\.o\.|s\.a\.|ltd|inc|gmbh|s\.r\.o\.|kft)\b/i.test(t)) return true;

    return false;
  };

  const endsSentence = (l: string) => /[.!?…:;)]\s*$/.test(l.trim());
  const startsLowerOrContinuation = (l: string) => /^[a-ząćęłńóśźż0-9(]/.test(l.trim());

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i] ?? '';
    const next = lines[i + 1] ?? '';

    const curT = cur.trim();
    const nextT = next.trim();

    if (!curT) {
      out.push('');
      continue;
    }

    if (isBullet(curT) || isHeadingLike(curT) || curT.startsWith('=== ')) {
      out.push(curT);
      continue;
    }

    if (
      nextT &&
      !isBullet(nextT) &&
      !isHeadingLike(nextT) &&
      !nextT.startsWith('=== ') &&
      !endsSentence(curT) &&
      startsLowerOrContinuation(nextT)
    ) {
      out.push(`${curT} ${nextT}`.replace(/\s+/g, ' ').trim());
      i += 1;
      continue;
    }

    out.push(curT);
  }

  return collapseBlankLines(out.join('\n'), 1).trim();
}

/** =========================
 *  Canonical preprocessing for CV source
 *  ========================= */
function preprocessCvSource(text: string) {
  let t = normalizeNewlines(text || '').trim();
  if (!t) return '';

  t = stripLeadingIndentAllLines(t);
  t = stripMarkdownDecorationsAllLines(t);
  t = deglueDateTokens(t);
  t = normalizeDateDashes(t);

  t = injectCvLineBreaks(t);
  t = dedupeConsecutiveLines(t);
  t = collapseBlankLines(t, 1);
  t = unwrapHardWrap(t);

  // one more pass after unwrap
  t = deglueDateTokens(t);
  t = normalizeDateDashes(t);
  t = dedupeConsecutiveLines(t);
  t = collapseBlankLines(t, 1);

  return t.trim();
}
// 1) jeśli extractRoleBlock zwróci “za dużo” (wiele ról / całe CV),
// to do pytań i heurystyk używamy tylko bezpiecznego scope
function sanitizeRoleScopeText(roleBlockText: string, roleTitle: string): string {
  const t = preprocessCvSource(roleBlockText || '').trim();
  const fallback = preprocessCvSource(roleTitle || '').trim() || 'WYBRANA ROLA';
  if (!t) return fallback;

  const dateRangeRe = /\b\d{2}[./]\d{4}\s*[-–—]\s*(obecnie|present|current|\d{2}[./]\d{4})\b/gi;
  const dateRanges = (t.match(dateRangeRe) || []).length;
  if (dateRanges >= 2) return fallback;

  if (t.length > 2400) return fallback;

  return t;
}

// 2) tytuł roli ma pierwszeństwo (najstabilniejszy sygnał domeny)
function inferRoleDomainWithTitleOverride(roleTitle: string, roleText: string) {
  const title = (roleTitle || '').toLowerCase();

  if (/(project manager|kierownik projektu|koordynator projektu|\bpm\b|scrum master|product owner)/i.test(title)) return 'PM';
  if (/(developer|programist|software|frontend|backend|full.?stack|engineer)/i.test(title)) return 'DEV';
  if (/(qa|tester|testowanie|quality assurance)/i.test(title)) return 'QA';
  if (/(customer support|obs(ł|l)uga klienta|helpdesk|service desk)/i.test(title)) return 'SUPPORT';
  if (/(admin|administrac|office|back.?office|operacj)/i.test(title)) return 'ADMIN';
  if (/(marketing|performance|paid|google ads|meta ads|seo|social media)/i.test(title)) return 'MARKETING';
  if (/(e-?commerce|marketplace|allegro|amazon|shopify)/i.test(title)) return 'ECOM';
  if (/(sprzeda|sales|account manager|key account|\bkam\b|b2b)/i.test(title)) return 'SALES';

  return inferRoleDomain(roleTitle, roleText);
}

/** =========================
 *  Role parser
 *  ========================= */
type ParsedRoleBlock = {
  titleLine: string;
  title: string;
  company: string;
  datesLine: string;
  bodyLines: string[];
  raw: string;
};

function isBulletLine(line: string) {
  return /^[-•*]\s+/.test((line || '').trim());
}

function looksLikeActionSentence(line: string) {
  // FIX #3 (heurystyki): nominalizacje jak "Uruchomienie..." traktujemy jako body, nie header
  const raw = (line || '').trim().toLowerCase();
  if (raw.length < 12) return false;

  const t = raw.replace(/^(obecnie|currently)\s+/i, '');

  return /^(prowadzen|zarzadz|koordyn|wdra|uruchom|optymaliz|analiz|monitor|raport|audyt|tworz|zbudow|standaryz|automatyz|planow|priorytet|manage|led|deliver|own|build|optimi[sz]e|analy[sz]e|report|coordinate|implement)/i.test(
    t
  );
}

function isAllCapsLine(line: string) {
  const t = (line || '').trim();
  if (!t) return false;
  const letters = t.replace(/[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/g, '');
  if (letters.length < 6) return false;
  return t === t.toUpperCase();
}

function hasCompanySuffix(line: string) {
  return /\b(sp\. z o\.o\.|s\.a\.|ltd|inc|gmbh|s\.r\.o\.|kft)\b/i.test((line || '').trim());
}

function hasDashSeparator(line: string) {
  return /\s(\-|–)\s/.test((line || '').trim());
}

function hasDateInSameLine(line: string) {
  const t = (line || '').trim();
  if (!t) return false;
  return !!extractDatesFromLine(t) || isDateLineLike(t);
}

function hasJobTitleKeyword(line: string) {
  const t = (line || '').toLowerCase();
  return /\b(specjalist|asystent|manager|kierownik|dyrektor|analityk|koordynator|in[żz]ynier|project|account|sales|sprzeda[żz]|owner|lead|consultant|pm\b|po\b)\b/i.test(
    t
  );
}

function looksLikeCompanyLocationLine(line: string) {
  const t = (line || '').trim();
  if (!t) return false;

  const hasCityish = /,\s*[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż-]{2,}/.test(t);
  const hasPipe = /\s\|\s/.test(t);
  const hasDate = isDateLineLike(t) || !!extractDatesFromLine(t);
  const startsWithFirma = /^firma\b/i.test(t);

  if (startsWithFirma && hasDate) return true;
  if (hasCityish && hasPipe && hasDate && !hasJobTitleKeyword(t)) return true;

  return false;
}

function isTitleCaseish(line: string) {
  const t = (line || '').trim();
  if (!t) return false;

  // allow dots (ds.), slashes, hyphens; reject heavy punctuation
  if (/[(),;:]/.test(t)) return false;

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 12) return false;

  const caps = words.filter((w) => /^[A-ZĄĆĘŁŃÓŚŹŻ]/.test(w)).length;
  return caps / words.length >= 0.5;
}

/**
 * Header rule (tightened to prevent action lines from becoming “roles”)
 */
function looksLikeRoleHeaderLine(line: string, nextLine: string) {
  const l = (line || '').trim();
  const n = (nextLine || '').trim();

  if (!l) return false;
  if (isBulletLine(l)) return false;
  if (l.startsWith('(')) return false;
  if (/^[a-ząćęłńóśźż0-9]/.test(l)) return false;
  if (looksLikeActionSentence(l)) return false; // FIX #3
  if (looksLikeCompanyLocationLine(l)) return false;

  const dashSep = hasDashSeparator(l);
  const co = hasCompanySuffix(l);
  const caps = isAllCapsLine(l);
  const job = hasJobTitleKeyword(l);

  const dateNext = isDateLineLike(n);
  const dateInline = hasDateInSameLine(l);

  if (dateNext) {
    if (l.length < 4 || l.length > 180) return false;
    return dashSep || co || caps || job || isTitleCaseish(l);
  }

  if (dateInline && dashSep) return co || caps || (job && isTitleCaseish(l));
  if (dashSep && co) return true;

  if (dashSep && job) {
    if (l.length > 180) return false;
    return caps || isTitleCaseish(l);
  }

  if (dashSep && l.length <= 180 && (co || caps || isTitleCaseish(l)) && job) return true;

  return false;
}

function splitTitleCompany(titleLine: string) {
  const t = (titleLine || '').trim();

  // Prefer dash separators
  const m = t.match(/\s(\-|–)\s/);
  if (m) {
    const idx = t.indexOf(m[0]);
    const left = t.slice(0, idx).trim();
    const right = t.slice(idx + m[0].length).trim();
    if (right.length < 2) return { title: t, company: '' };
    return { title: left, company: right };
  }

  // Pipe is optional: only if left side looks like a job title
  const p = t.match(/\s\|\s/);
  if (p) {
    const idx = t.indexOf(p[0]);
    const left = t.slice(0, idx).trim();
    const right = t.slice(idx + p[0].length).trim();
    if (hasJobTitleKeyword(left) && right.length >= 2) return { title: left, company: right };
  }

  return { title: t, company: '' };
}

function isCompanyDatesLineLike(line: string): boolean {
  const s = (line || '').trim();
  if (!s) return false;

  // ma separator i da się wyciągnąć zakres dat z dowolnego miejsca w linii
  if (!s.includes('|')) return false;

  const hasDates = !!extractDatesFromLine(s);
  if (!hasDates) return false;

  // typowe "firma, miasto | 01.2020 – 02.2021" / "*Firma..., | ...*"
  // nie blokujemy tytułów typu "Specjalista ds. X | 01.2020 – 02.2021" — tym zajmie się splitTitleCompany
  return true;
}

function parseExperienceIntoRoleBlocks(input: string): ParsedRoleBlock[] {
  const text = preprocessCvSource((input || '').trim());
  if (!text) return [];

  const lines = normalizeNewlines(text)
    .split('\n')
    .map((l) => l.trimEnd());

  const blocks: ParsedRoleBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const lineRaw = (lines[i] || '').trim();
    const nextRaw = (lines[i + 1] || '').trim();

    // Try inline header split first (Role ... | dates body)
    const inline = splitHeaderDatesAndInlineBody(lineRaw);
    if (inline) {
      const titleLine = inline.headerPart;
      const datesLine = inline.dates;

      const { title, company } = splitTitleCompany(titleLine);

      const bodyLines: string[] = [];
      if (inline.inlineBody) bodyLines.push(inline.inlineBody);

      let j = i + 1;
      while (j < lines.length) {
        const cur = (lines[j] || '').trim();
        const nxt = (lines[j + 1] || '').trim();
        if (looksLikeRoleHeaderLine(cur, nxt)) break;
        if (cur) bodyLines.push(cur);
        j++;
      }

      const raw = [titleLine, datesLine, ...bodyLines].filter(Boolean).join('\n').trim();
      blocks.push({ titleLine, title, company, datesLine, bodyLines, raw });

      i = j;
      continue;
    }

    if (!looksLikeRoleHeaderLine(lineRaw, nextRaw)) {
      i++;
      continue;
    }

    // Normal header
    let titleLine = lineRaw;
    let datesLine = '';
    let startBodyIdx = i + 1;

    if (isDateLineLike(nextRaw)) {
      datesLine = nextRaw;
      startBodyIdx = i + 2;
    } else {
      // Handle trailing start date: "… 06/2024" -> "06/2024 – obecnie"
      const trailing = splitTrailingStartDate(titleLine);
      if (trailing) {
        const nextLooksBodyWithObecnie = /^\s*(obecnie|present)\b/i.test(nextRaw);
        if (nextLooksBodyWithObecnie) {
          titleLine = trailing.headerPart;
          datesLine = `${trailing.startDate} – obecnie`;
        }
      }
    }

    const { title, company } = splitTitleCompany(titleLine);

    const bodyLines: string[] = [];
    let j = startBodyIdx;

    while (j < lines.length) {
      const cur = (lines[j] || '').trim();
      const nxt = (lines[j + 1] || '').trim();
      if (looksLikeRoleHeaderLine(cur, nxt)) break;

      if (cur) bodyLines.push(cur);
      j++;
    }

    const raw = [titleLine, datesLine, ...bodyLines].filter(Boolean).join('\n').trim();
    blocks.push({ titleLine, title, company, datesLine, bodyLines, raw });

    i = j;
  }

  return blocks;
}

/** =========================
 *  Audit detection
 *  ========================= */
function isAudit(text: string) {
  const t = (text || '').toLowerCase();

  // sygnały “to jest audit + wybór roli”
  const hasAuditIntro =
    /ju[żz]\s+wiem,\s+co\s+poprawi/.test(t) ||
    /wybierz\s+rol/.test(t) ||
    /ju[żz]\s+wiem,\s+co\s+brakuje/.test(t);

  const hasChoosePrompt =
    /wpisz\s+numer\s*:/.test(t) ||
    /wpisz\s+numer\s+\d/.test(t) ||
    /wybierz\s+numer\s*:/.test(t);

  // dodatkowo: jeśli widzimy listę 1./2. i prompt “wpisz numer”, to prawie na pewno audit
  const hasNumberedList = /(^|\n)\s*\d+\s*(?:[.)]|-|:)\s+/.test(text || '');

  return (hasChoosePrompt && (hasAuditIntro || hasNumberedList));
}
function auditHasNumbering(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  // 1. / 1) / 1 - / 1:
  return /(^|\n)\s*\d+\s*(?:[.)]|-|:)\s+/.test(t);
}
function countAuditRoles(text: string) {
  const t = text || '';
  // 1. / 1) / 1 - / 1:
  const hits = t.match(/(^|\n)\s*\d{1,3}\s*(?:[.)]|-|:)\s+/g);
  return (hits || []).length;
}
function extractRoleTitleFromAuditByNumber(text: string, num: number) {
  const re = new RegExp(`^\\s*${num}[.)]\\s+(.+?)\\s+\\|`, 'm');
  const m = text.match(re);
  return m?.[1]?.trim() || '';
}
function extractAllRoleTitlesFromAudit(text: string) {
  const out: string[] = [];
  const re = /^\s*\d{1,2}[.)]\s+(.+?)\s+\|/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const title = (m[1] || '').trim();
    if (title) out.push(title);
  }
  return out;
}
function extractChosenNumber(lastUser: string, max = 20): number | null {
  const m = lastUser.match(/\b(\d{1,2})\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > max) return null;
  return n;
}

/** =========================
 *  Mode detection
 *  ========================= */
function hasNumberedAuditEver(messages: Message[]) {
  return messages.some((m) => m.role === 'assistant' && isAudit(m.content) && auditHasNumbering(m.content));
}

function looksLikeExperiencePaste(text: string) {
  const t = preprocessCvSource(text || '');
  if (!t) return false;

  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const dateRanges = countDateRanges(t);
  const hasDatesLine = lines.some((l) => isDateLineLike(l)) || dateRanges >= 1;

  const hasBullets = lines.some((l) => /^[-•*]\s+/.test(l));
  const hasHeaderish = lines.some((l, idx) => {
    const next = lines[idx + 1] || '';
    return looksLikeRoleHeaderLine(l, next) || hasCompanySuffix(l);
  });

  const hasDash = /\s(\-|–)\s/.test(t);
  const flatButStructured = lines.length <= 3 && hasDatesLine && (hasDash || hasHeaderish);

  return (hasHeaderish && hasDatesLine && (hasBullets || lines.length >= 3)) || flatButStructured;
}

function detectMode(messages: Message[], cvTextEffective?: string): Mode {
  if (hasNumberedAuditEver(messages)) return 'NORMAL';

  const userCount = messages.filter((m) => m.role === 'user').length;
  const lastUser = messages.slice().reverse().find((m) => m.role === 'user')?.content || '';

  const looksLikeExp = !!(cvTextEffective && cvTextEffective.trim()) || looksLikeExperiencePaste(lastUser);

  if (userCount === 1 && looksLikeExp) return 'AUDIT_ONLY';
  return 'NORMAL';
}

/** =========================
 *  Roles extraction
 *  ========================= */
type Role = { title: string; dates: string };

function stripDiacritics(s: string) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function keyify(s: string) {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}
function roleKey(title: string, dates: string) {
  const norm = (s: string) =>
    stripDiacritics(s)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[^a-z0-9]+/g, '');
  return `${norm(title)}|${norm(dates || '')}`;
}
function dedupeRoles(roles: Role[]) {
  const seen = new Set<string>();
  const out: Role[] = [];
  for (const r of roles || []) {
    const title = (r?.title || '').trim();
    const dates = (r?.dates || '').trim() || 'daty do uzupełnienia';
    if (!title) continue;
    const k = roleKey(title, dates);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ title, dates });
  }
  return out;
}

// --- one-line role header parser: "Stanowisko - Firma, miasto | 06.2022 – 12.2024"
function looksLikeDateRangeLoose(s: string): boolean {
  const t = (s || '').trim();
  return /(\b\d{1,2}[./]\d{4}\b|\b\d{4}\b)\s*(?:-|–|—|do|to)\s*(\b\d{1,2}[./]\d{4}\b|\b\d{4}\b|obecnie|present|now)/i.test(t);
}
function tryParseOneLineRoleHeader(line: string): Role | null {
  const l = (line || '').trim();
  if (!l || !l.includes('|')) return null;

  const parts = l.split('|');
  if (parts.length < 2) return null;

  const left = parts[0].trim();
  const datesPart = parts.slice(1).join('|').trim();

  if (!looksLikeDateRangeLoose(datesPart)) return null;

  // title = przed " - " / " – " / " — " (z otoczeniem spacjami)
  const dashSplit = left.split(/\s[-–—]\s/);
  const title = (dashSplit[0] || left).trim();

  if (title.length < 3) return null;

  const dates = extractDatesFromLine(datesPart) || datesPart || 'daty do uzupełnienia';
  return { title, dates };
}
type ParsedRoleHeader = {
  title: string;
  company?: string;
  location?: string;
  dates?: string;
  confidence: number; // 0..1
};

const DATE_RANGE_RE =
  /\b(?:(?:0?[1-9]|1[0-2])\s*[./-]\s*(?:19|20)\d{2}|(?:19|20)\d{2})\s*(?:–|-|—|to|do)\s*(?:(?:0?[1-9]|1[0-2])\s*[./-]\s*(?:19|20)\d{2}|(?:19|20)\d{2}|present|obecnie|current)\b/i;

function _cleanSpaces(s: string) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function _stripDatesFromEnd(line: string): { head: string; dates?: string } {
  const m = line.match(DATE_RANGE_RE);
  if (!m) return { head: _cleanSpaces(line) };
  const idx = line.toLowerCase().lastIndexOf(m[0].toLowerCase());
  if (idx === -1) return { head: _cleanSpaces(line) };
  return {
    head: _cleanSpaces(line.slice(0, idx)),
    dates: _cleanSpaces(line.slice(idx)),
  };
}

function _normalizeSeparators(s: string) {
  return _cleanSpaces(
    s
      .replace(/[•·]/g, "|")
      .replace(/\s*\|\s*/g, " | ")
      .replace(/\s*(—|–)\s*/g, " - ")
  );
}

function _looksLikeLocationOrCompany(x: string) {
  const s = _cleanSpaces(x);
  if (!s) return true;

  // Jeśli ma typowe słowa stanowiskowe, to NIE traktuj jako company/location
  const hasRoleWords =
    /\b(manager|specialist|developer|engineer|analyst|lead|head|consultant|designer|marketing|sales|support|qa|admin|assistant|coordinator|director|executive|intern|trainee|junior|senior|specjalista|kierownik|inżynier|analityk|lider|dyrektor|asystent|koordynator|stażysta|praktykant)\b/i.test(
      s
    );
  if (hasRoleWords) return false;

  // Przecinek bez słów stanowiskowych -> bardzo często "Firma, Miasto"
  if (s.includes(",")) return true;

  // końcówki firm
  if (/\b(sp\.?\s*z\.?\s*o\.?\s*o\.?|s\.?\s*a\.?|ltd|inc|gmbh|ag|plc)\b/i.test(s))
    return true;

  // hinty lokalizacji/trybu pracy
  if (/\b(remote|hybrid|on-?site|warszawa|krak[oó]w|wroc[łl]aw|gda[nń]sk|pozna[nń]|[łl][oó]d[zź]|poland|emea|europe|uk|germany|france|czech)\b/i.test(s))
    return true;

  return true;
}

function _roleTitleScore(x: string) {
  const s = _cleanSpaces(x);
  if (!s) return -999;
  let score = 0;

  if (
    /\b(manager|specialist|developer|engineer|analyst|lead|head|consultant|designer|marketing|sales|support|qa|admin|assistant|coordinator|director|executive|intern|trainee|junior|senior|specjalista|kierownik|inżynier|analityk|lider|dyrektor|asystent|koordynator|stażysta|praktykant)\b/i.test(
      s
    )
  ) score += 4;

  if (s.length <= 30) score += 2;
  if (s.length > 45) score -= 2;

  if (s.includes(",")) score -= 3;
  if (/\b(sp\.?\s*z\.?\s*o\.?\s*o\.?|s\.?\s*a\.?|ltd|inc|gmbh|ag|plc)\b/i.test(s))
    score -= 3;

  return score;
}

/**
 * 1-liniowy nagłówek:
 * "TITLE - COMPANY, CITY | 06.2022 – 12.2024"
 */
function parseOneLineRoleHeader(lineRaw: string): ParsedRoleHeader | null {
  const line = _normalizeSeparators(lineRaw);
  if (!line) return null;

  const { head, dates } = _stripDatesFromEnd(line);
  const parts = head.split(" | ").map(_cleanSpaces).filter(Boolean);
  const left = parts[0] ?? "";

  // split po " - " lub " @ "
  let candTitle = "";
  let candRest = "";

  const dashSplit = left.split(" - ").map(_cleanSpaces).filter(Boolean);
  if (dashSplit.length >= 2) {
    candTitle = dashSplit[0];
    candRest = dashSplit.slice(1).join(" - ");
  } else {
    const atSplit = left.split(/\s+@\s+/).map(_cleanSpaces).filter(Boolean);
    if (atSplit.length >= 2) {
      candTitle = atSplit[0];
      candRest = atSplit.slice(1).join(" @ ");
    } else {
      return null;
    }
  }

  let company = candRest;
  let location = "";

  if (company.includes(",")) {
    const [c, ...rest] = company.split(",").map(_cleanSpaces);
    company = c;
    location = rest.join(", ");
  }

  // Safety: swap jeśli ktoś wkleił "Firma, Miasto" po lewej
  const scoreA = _roleTitleScore(candTitle);
  const scoreB = _roleTitleScore(company);

  let title = candTitle;
  let finalCompany = company;

  if (_looksLikeLocationOrCompany(title) && scoreB > scoreA) {
    title = company;
    finalCompany = candTitle;
    location = "";
  }

  if (_looksLikeLocationOrCompany(title)) return null;

  const confidence = Math.max(0, Math.min(1, 0.5 + _roleTitleScore(title) / 10));

  return {
    title: _cleanSpaces(title),
    company: _cleanSpaces(finalCompany),
    location: _cleanSpaces(location),
    dates: dates ? _cleanSpaces(dates) : undefined,
    confidence,
  };
}

/**
 * 2-liniowy nagłówek (TWÓJ AKTUALNY FORMAT):
 * Line1: "{TITLE}"
 * Line2: "{COMPANY}, {CITY} | {MM.YYYY – ...}"
 */
function tryParseTwoLineRoleHeader(titleLineRaw: string, metaLineRaw: string): Role | null {
  // UWAGA: jeśli już masz sample 1-liniowe, ta funkcja jest opcjonalna,
  // ale zostawiamy ją jako "backup", żeby nie rozwalić innych formatów.
  const title = _cleanSpaces(titleLineRaw);
  const meta = _normalizeSeparators(metaLineRaw);

  if (!title || !meta) return null;

  // Druga linia powinna zawierać "|" albo zakres dat
  if (!meta.includes("|") && !DATE_RANGE_RE.test(meta)) return null;

  const m = meta.match(DATE_RANGE_RE);
  const dates = m ? _cleanSpaces(m[0]) : "";

  // Jeśli tytuł wygląda jak firma/miasto, nie uznajemy tego za rolę
  if (_looksLikeLocationOrCompany(title)) return null;

  return { title, dates: dates || "daty do uzupełnienia" };
}

function extractRolesFromCvText(cvText: string): Role[] {
  const t = preprocessCvSource(cvText || '');
  if (!t) return [];

  // -------------------------
  // Local heuristics (żeby nie łapało "Papaka, Warszawa" jako stanowiska)
  // -------------------------
  const clean = (s: any) => String(s || '').replace(/\s+/g, ' ').trim();

  const roleWordRe =
    /\b(manager|specialist|developer|engineer|analyst|lead|head|consultant|designer|marketing|sales|support|qa|admin|assistant|coordinator|director|executive|intern|trainee|junior|senior|specjalista|kierownik|inżynier|analityk|lider|dyrektor|asystent|koordynator|stażysta|praktykant)\b/i;

  const companySuffixRe =
    /\b(sp\.?\s*z\.?\s*o\.?\s*o\.?|s\.?\s*a\.?|ltd|inc|gmbh|ag|plc)\b/i;

  const locationHintRe =
    /\b(remote|hybrid|on-?site|warszawa|krak[oó]w|wroc[łl]aw|gda[nń]sk|pozna[nń]|[łl][oó]d[zź]|poland|europe|emea|uk|germany|france|czech)\b/i;

  const dateRangeRe =
    /\b(?:(?:0?[1-9]|1[0-2])\s*[./-]\s*(?:19|20)\d{2}|(?:19|20)\d{2})\s*(?:–|-|—|to|do)\s*(?:(?:0?[1-9]|1[0-2])\s*[./-]\s*(?:19|20)\d{2}|(?:19|20)\d{2}|present|obecnie|current)\b/i;

  function isSuspiciousTitle(title: string): boolean {
    const s = clean(title);
    if (!s) return true;

    // tytuł nie powinien zawierać dat
    if (dateRangeRe.test(s)) return true;

    // jeśli ma słowa stanowiskowe -> raczej OK
    if (roleWordRe.test(s)) return false;

    // jeśli wygląda jak firma/lokacja, a nie stanowisko -> podejrzane
    const hasComma = s.includes(',');
    const looksCompany = companySuffixRe.test(s);
    const looksLocation = locationHintRe.test(s);

    if (looksCompany) return true;
    if (hasComma && !roleWordRe.test(s)) return true;
    if (looksLocation && s.length <= 35) return true;

    // bardzo długie "tytuły" bez słów stanowiskowych zwykle są śmieciem
    if (s.length > 60) return true;

    return false;
  }

  function safeRole(title: string, dates: string): Role | null {
    const tt = clean(title);
    if (!tt) return null;
    if (isSuspiciousTitle(tt)) return null;

    const dd = clean(dates) || 'daty do uzupełnienia';
    return { title: tt, dates: dd };
  }

  // -------------------------
  // 1) Standard parser (role blocks)
  // -------------------------
  const blocks = parseExperienceIntoRoleBlocks(t);

  const rolesFromBlocks: Role[] = (blocks || [])
    .map((b) => {
      const titleFromParsed = clean(b?.title); // preferuj b.title
      const titleFromSplit = clean(splitTitleCompany(clean(b?.titleLine)).title);
      const titleLine = clean(b?.titleLine); // <-- to zastępuje Twoje nieistniejące "titleLine"

      // Start: wybierz najlepszy dostępny tytuł
      let title = titleFromParsed || titleFromSplit || titleLine;

      // SANITY-CHECK: jeśli title wygląda jak firma/miasto -> próbuj naprawić
      if (titleLine && isSuspiciousTitle(title)) {
        // 1-linia (Twoje sample są już 1-liniowe)
        const repaired1 = tryParseOneLineRoleHeader(titleLine);
        if (repaired1?.title && !isSuspiciousTitle(repaired1.title)) {
          title = clean(repaired1.title);
        } else if (titleFromSplit && !isSuspiciousTitle(titleFromSplit)) {
          title = titleFromSplit;
        } else {
          // 2-linie (opcjonalny backup)
          const repaired2 = tryParseTwoLineRoleHeader(titleLine, clean(b?.datesLine || ""));
          if (repaired2?.title && !isSuspiciousTitle(repaired2.title)) {
            title = clean(repaired2.title);
          }
        }
      }

      // Jeśli nadal śmieć -> wywal blok
      if (isSuspiciousTitle(title)) return null;

      // Daty: standard + fallback
      let dates =
        extractDatesFromLine(b?.datesLine) ||
        extractDatesFromLine(b?.titleLine) ||
        clean(b?.datesLine) ||
        '';

      // Jeżeli nagłówek 1-line ma lepsze daty -> bierz je
      const parsedHeaderForDates = titleLine ? tryParseOneLineRoleHeader(titleLine) : null;
      if (parsedHeaderForDates?.dates) {
        dates = clean(parsedHeaderForDates.dates);
      }

      return safeRole(title, dates);
    })
    .filter(Boolean) as Role[];

  // -------------------------
  // 2) Fallback: one-line headers (dla "Stanowisko - Firma | daty")
  // -------------------------
  const rolesFromOneLine: Role[] = [];
  for (const rawLine of t.split('\n')) {
    const line = clean(rawLine);
    if (!line) continue;

    const parsed = tryParseOneLineRoleHeader(line);
    if (!parsed) continue;

    const title = clean(parsed.title);
    if (!title || isSuspiciousTitle(title)) continue;

    const dates = clean(parsed.dates) || 'daty do uzupełnienia';

    const r = safeRole(title, dates);
    if (r) rolesFromOneLine.push(r);
  }

  // -------------------------
  // 3) Merge + dedupe + final filter
  // -------------------------
  const merged = dedupeRoles([...(rolesFromBlocks || []), ...(rolesFromOneLine || [])])
    .filter((r) => r?.title && !isSuspiciousTitle(r.title));

  return merged.slice(0, 8);
}

/** =========================
 *  Confidence check (FIX #2)
 *  If input looks like multi-role but parser returns <=1 role -> DO NOT start interview, show audit.
 *  ========================= */
function looksLikeMultiRoleButParsedSingle(cvText: string, rolesCount: number) {
  const t = preprocessCvSource(cvText || '');
  if (!t) return false;
  if (rolesCount > 1) return false;

  const dr = countDateRanges(t);
  if (dr >= 2) return true;

  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  let headerish = 0;
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeRoleHeaderLine(lines[i], lines[i + 1] || '')) headerish++;
  }
  if (headerish >= 2) return true;

  const coHits = (t.match(/\b(sp\. z o\.o\.|s\.a\.|ltd|inc|gmbh|s\.r\.o\.|kft)\b/gi) || []).length;
  if (coHits >= 2 && dr >= 1) return true;

  // if there are multiple "dash separators" and at least one date range, it's probably multi-role paste
  const dashHits = (t.match(/\s[-–]\s/g) || []).length;
  if (dashHits >= 3 && dr >= 1) return true;

  return false;
}

/** =========================
 *  CV source builder (base + later multi-role pastes) + dedupe
 *  ========================= */
function looksLikeMultiRoleExperiencePasteStrong(text: string) {
  const t = preprocessCvSource(text || '');
  if (!t) return false;
  if (t.length < 120) return false;
  return looksLikeExperiencePaste(t) && countDateRanges(t) >= 2;
}

function buildCvTextEffective(cvText: string | undefined, messages: Message[]) {
  const base = preprocessCvSource((cvText || '').trim());

  const pastes = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .filter(looksLikeMultiRoleExperiencePasteStrong)
    .map((t) => preprocessCvSource(t));

  const parts = [base, ...pastes].filter(Boolean);
  if (!parts.length) return '';

  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const key = preprocessCvSource(p).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(preprocessCvSource(p));
  }

  return preprocessCvSource(uniq.join('\n\n')).trim();
}

/** =========================
 *  Missing analysis helpers
 *  ========================= */
function stripDateNoise(text: string) {
  let t = normalizeDateDashes(deglueDateTokens(normalizeNewlines(text || '')));

  // remove common CV date formats
  t = t.replace(/\b\d{2}[./-]\d{4}\b/gi, ' ');
  t = t.replace(/\b(?:19|20)\d{2}\b/gi, ' ');

  // remove date ranges explicitly
  t = t.replace(
    /(\b\d{2}[./-]\d{4}\b|\b(?:19|20)\d{2}\b)\s*[–-]\s*(\b\d{2}[./-]\d{4}\b|\b(?:19|20)\d{2}\b|\bobecnie\b|\bpresent\b)/gi,
    ' '
  );

  return t.replace(/\s+/g, ' ').trim();
}

function extractNumbersNonWord(text: string) {
  const t = normalizeNewlines(text || '');
  // liczby nie mogą być częścią tokenu alfanumerycznego (np. B2B, 3PL)
  // łapie: "50", "4.34", "4,34", "1 200", "1_200", "1,200", "-10%"
  const re =
    /(^|[^A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż_])(\d{1,3}(?:[ .,_]\d{3})*(?:[.,]\d+)?|\d+)(?![A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż_])/g;

  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const num = (m[2] || '').trim();
    if (num) out.push(num.replace(/[ _]/g, ''));
  }
  return out;
}

function hasAnyNumber(text: string) {
  const t = stripDateNoise(text || '');
  return extractNumbersNonWord(t).length > 0;
}

function hasActionsSignal(text: string) {
  const raw = preprocessCvSource(text || '');
  const t = stripDateNoise(raw).toLowerCase();

  const verb = /(zarządza|zarzadz|prowadzi|koordyn|wdra|uruchom|optymaliz|analiz|monitor|negocj|sprzeda|pozysk|raport|audyt|tworz|zbudow|ustaw|konfigur|standaryz|automatyz|planow|priorytet|manage|led|deliver|own|build|optimi[sz]e|analy[sz]e|report|coordinate|implement)/i.test(
    t
  );

  const bullets = raw.split('\n').filter((l) => /^[-•*]\s+/.test(l.trim())).length >= 2;
  return verb || bullets;
}

function hasScaleSignal(text: string) {
  const raw = stripDateNoise(text || '');
  if (!hasAnyNumber(raw)) return false;

  if (/(\d[\d .,_]*)(?:\s*)([$€£¥]|[A-Z]{3}\b)/.test(raw)) return true;
  if (/(\d[\d .,_]*)(?:\s*)(zł|zl|pln|eur|euro|usd|\$|dolar\w*)/i.test(raw)) return true;
  if (/(\d+(?:[.,]\d+)?)\s*(k|m|b|tys|mln|mld|milion\w*|%)/i.test(raw) || /%/.test(raw)) return true;
  if (/(?<![\d.,])(\d{1,4})(?![.,]\d)\s+[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]{3,}/.test(raw)) return true;

  const m = raw.match(/(\d+(?:[.,]\d+)?)/);
  if (m) {
    const n = parseFloat((m[1] || '0').replace(',', '.'));
    if (!Number.isNaN(n) && n >= 10) return true;
  }
  return false;
}
function hasActionsNounListSignal(text: string): boolean {
  const s = stripDateNoise(preprocessCvSource(text || '')).trim().toLowerCase();
  if (!s) return false;

  const skipLineRe = /^(skala|scale|wynik|result|cel)\s*:/i;

  // typowe "czynności" w CV jako rzeczowniki
  const actionNounRe =
    /\b(przygotowan|aktualizacj|research|kontakt|obsług|wprowadz|archiwizacj|raportowan|analiz|tworzen|planowan|koordynacj|moderacj|negocjacj|kwalifikacj|follow-?up)\w*\b/i;

  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (skipLineRe.test(line)) continue;

    // jeśli jest "X: a, b, c" — bierz część po dwukropku
    const body = line.includes(':') ? line.split(':').slice(1).join(':').trim() : line;

    // lista po przecinkach/średnikach/bulletach
    const parts = body
      .split(/[,;•·]/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 4);

    if (parts.length >= 2 && actionNounRe.test(body)) return true;
  }

  return false;
}

function hasBaselineContextSignal(text: string): boolean {
  const src = stripDateNoise(preprocessCvSource(text || '')).toLowerCase().trim();
  if (!src) return false;

  // 1) twardy baseline liczbowy (z X do Y / from X to Y / strzałki)
  const explicitDeltaRe =
    /\b(z|from)\s*\d+([.,]\d+)?\s*(%|pp|pkt|zł|pln|eur|€|h|min|s|ms)?\s*(do|to|->|→)\s*\d+([.,]\d+)?\s*(%|pp|pkt|zł|pln|eur|€|h|min|s|ms)?\b/;
  if (explicitDeltaRe.test(src)) return true;

  // 2) porównania okres do okresu (nawet bez liczb)
  if (/\b(m\/m|q\/q|r\/r|yoy|mom|qoq)\b/.test(src)) return true;

  // 3) porównanie opisowe bez liczb: "vs poprzedni okres", "w porównaniu do", "vs plan"
  const relativeCmpRe =
    /\b(vs\.?|versus|w por(ó|o)wnaniu( do)?|wzgl(ę|e)dem|wobec|na tle|poprzedni( okres)?|wcze(ś|s)niej|uprzednio|vs plan|wzgl(ę|e)dem planu|zgodnie z planem)\b/;
  if (relativeCmpRe.test(src)) return true;

  // 4) absolut/ceiling: uznajemy jako "kontekst wystarczający"
  // przykłady: "100% terminowości", "wszystkie projekty na czas", "bez opóźnień"
  const absoluteOkRe =
    /\b(wszystkie|na czas|bez op(ó|o)źnie(ń|n)|zero op(ó|o)źnie(ń|n)|terminowo(ś|s)(ć|c)|on-?time|sla)\b/;
  if (absoluteOkRe.test(src) && (/\b100\s*%/.test(src) || /\bwszystkie\b/.test(src))) return true;

  return false;
}

function hasAcquisitionProcessSignal(text: string) {
  const raw0 = normalizeNewlines(text || '');
  const raw = stripDateNoise(raw0);
  const t = raw.toLowerCase();

  const hasNumberedSteps = /(^|\n)\s*\d[.)]\s+/.test(raw0);
  const hasProcessWords = /(proces|etap|krok|od kontaktu|do finalizacji|ścieżk|lejka|pipeline)/i.test(t);

  const hasChannelish = /(inbound|outbound|lead|leady|www|formularz|zapytan|polecen|linkedin|mail|email|telefon|cold call|coldcall|prospect)/i.test(
    t
  );

  const stageHits =
    [
      /(kontakt|pierwsz)/i,
      /(kwalifikac|potrzeb|brief)/i,
      /(ofert|wycen)/i,
      /(negocj|uzgodn|deal)/i,
      /(umow|podpis|finaliz|zamów|zamow|onboarding|hiring)/i,
    ].reduce((acc, re) => acc + (re.test(t) ? 1 : 0), 0) >= 2;

  return hasNumberedSteps || hasProcessWords || (hasChannelish && stageHits);
}
function hasHardResultSignal(text: string): boolean {
  const raw = preprocessCvSource(text || '');
  const t = raw.toLowerCase();

  const explicitDeltaRe =
    /\b(z|from)\s*\d+([.,]\d+)?\s*(%|pp|pkt|zł|pln|eur|€|h|min|s|ms|k)?\s*(do|to|->|→)\s*\d+([.,]\d+)?\s*(%|pp|pkt|zł|pln|eur|€|h|min|s|ms|k)?\b/i;

  if (explicitDeltaRe.test(t)) return true;

  const kpiRe =
    /\b(win rate|wygr|mrr|arr|przych(ó|o)d|revenue|sprzeda(ż|z)|mar(ż|z)a|zysk|roas|acos|cpa|cac|ltv|aov|cr\b|konwersj|conversion|ctr\b|cpc|cpv|cpm|csat|nps|sla|mttr|uptime|latency|error rate|defect leakage|pipeline)\b/i;

  const lines = normalizeNewlines(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const l = line.toLowerCase();
    if (kpiRe.test(l) && /\d/.test(l)) return true;
  }

  return false;
}


function isSoftResultOnly(text: string): boolean {
  const t = preprocessCvSource(text || '').toLowerCase();

  // “ładne zdania” bez metryki — nie traktuj jako RESULT
  const softRe =
    /\b(dow(ó|o)z planu|realizacja planu|osi(ą|a)ganie cel(ó|o)w|zdrowy pipeline|stabilny pipeline|utrzymanie (zdrowego )?pipeline|dowo(ż|z)enie|pilnowanie termin(ó|o)w|wsp(ó|o)łpraca z zespo(ł|l)em)\b/i;

  // jeśli jest twardy sygnał, to nie jest “soft-only”
  if (hasHardResultSignal(t)) return false;

  return softRe.test(t);
}

function hasResultSignal(text: string) {
  const raw0 = preprocessCvSource(text || '');
  const raw = stripDateNoise(raw0);
  if (!raw) return false;

  const t = raw.toLowerCase();

  const outcomeWords =
    /(wzrost|spadek|oszczęd|oszczed|redukc|utrzym|roas|acos|roi|konwersj|conversion|cvr\b|cr\b|ctr\b|cpc\b|cpa\b|ltv\b|aov\b|cac\b|mrr|arr|przych|revenue|sprzeda|marż|margin|terminow|bez\s+(zakł|opóźn|problem|błęd|bled)|stabiln|reklamac|incydent)/i.test(
      t
    );

  const qualitative = /(terminow|stabiln|bez\s+(zakł|opóźn|problem|błęd|bled)|mniej\s+eskalac)/i.test(t);

  return (hasAnyNumber(raw) && outcomeWords) || (!hasAnyNumber(raw) && qualitative);
}

function shouldAskAcquisitionProcess(roleTitle: string, allText: string) {
  const domain = inferRoleDomain(roleTitle, allText);

  // tylko role, gdzie "pozyskanie" ma sens
  if (!(domain === 'SALES' || domain === 'MARKETING' || domain === 'ECOM')) return false;

  // wspólny tekst do heurystyk
  const t = `${roleTitle}\n${allText}`.toLowerCase();

  // musi być sygnał pozyskania w treści
  const acqRe =
    /\b(pozyskiw|outbound|inbound|prospect|cold call|lead gen|kwalifikacj|pipeline|negocjacj|closing|demo)\b/;

  if (!acqRe.test(t)) return false;

  // jeśli user wyraźnie mówi "wsparcie / nie sprzedawałem" — odpuść
  if (/\b(wsparcie|backoffice|asystent|nie sprzedawa|nie pozyskiwa)\b/.test(t)) return false;

  // jeśli masz jeszcze swoją starą logikę poniżej — usuń ją albo zostaw, ale NIE twórz kolejnego "t"
  return true;
}

type RoleMissing = {
  missingActions: boolean;
  missingScale: boolean;
  missingResult: boolean;
  missingProcess: boolean;
  missingContext: boolean;
  summary: string;
};

function analyzeRoleMissing(roleTitle: string, roleBlock: string, allCvText: string) {
  const block = preprocessCvSource(roleBlock || '');
  const all = `${block}\n${allCvText || ''}`.trim();

  const shouldProcess = shouldAskAcquisitionProcess(roleTitle, all);

  const hasActions = hasActionsSignal(block);
  const hasScale = hasScaleSignal(block);
  const hasResult = hasResultSignal(block);
  const hasProcess = hasAcquisitionProcessSignal(block);

  const missingActions = !hasActions;
  const missingScale = !hasScale;
  const missingResult = !hasResult;
  const missingProcess = shouldProcess && !hasProcess;

  const missingContext = hasAnyNumber(block) && !hasBaselineContextSignal(block);

  const missingParts: string[] = [];
  if (missingResult) missingParts.push('wynik/proxy (metryka)');
  if (missingScale) missingParts.push('skala (1 liczba/widełki)');
  if (missingActions) missingParts.push('konkret działań (2–3)');
  if (missingProcess) missingParts.push('proces (2–4 etapy)');
  if (!missingResult && !missingScale && !missingActions && missingContext) missingParts.push('kontekst wyniku (baseline/zmiana)');

  const summary =
    missingParts.length === 0 ? 'nic krytycznego — można od razu zrobić mocny rewrite' : missingParts.join(', ');

  return { missingActions, missingScale, missingResult, missingProcess, missingContext, summary } as RoleMissing;
}

/** =========================
 *  Role block extraction
 *  ========================= */
function extractRoleBlock(cvText: string, roleTitle: string): string {
  const src = normalizeNewlines(preprocessCvSource(cvText || ''));
  if (!src.trim()) return '';

  const targetKey = keyify(roleTitle || '');
  if (!targetKey) return '';

  const lines = src.split('\n').map((l) => (l ?? '').replace(/\s+$/g, ''));

  type Header = { start: number; title: string; headerLines: 1 | 2 };
  const headers: Header[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] || '').trim();
    if (!line) continue;

    // 1) One-line header: "Title - Company | dates"
    const one = tryParseOneLineRoleHeader(line);
    if (one?.title) {
      headers.push({ start: i, title: one.title, headerLines: 1 });
      continue;
    }

    // 2) Two-line header:
    // {TITLE}
    // {COMPANY}, {CITY} | {DATES}
    if (i + 1 < lines.length) {
      const two = tryParseTwoLineRoleHeader(lines[i] || '', lines[i + 1] || '');
      if (two?.title) {
        headers.push({ start: i, title: two.title, headerLines: 2 });
        i += 1; // skip meta line
        continue;
      }
    }
  }

  const tKey = (s: string) => keyify(s || '');

  let hit = -1;

  // match: exact key first
  for (let i = 0; i < headers.length; i++) {
    if (tKey(headers[i].title) === targetKey) {
      hit = i;
      break;
    }
  }

  // match: contains (fallback)
  if (hit === -1) {
    for (let i = 0; i < headers.length; i++) {
      const hk = tKey(headers[i].title);
      if (hk && (hk.includes(targetKey) || targetKey.includes(hk))) {
        hit = i;
        break;
      }
    }
  }

  // fallback: znajdź linię zawierającą tytuł i utnij do kolejnego headera po tej linii
  if (hit === -1) {
    const idx = lines.findIndex((l) => tKey(l).includes(targetKey));
    if (idx === -1) return '';

    // znajdź najbliższy header po idx
    let nextHeaderStart = lines.length;
    for (const h of headers) {
      if (h.start > idx) {
        nextHeaderStart = h.start;
        break;
      }
    }

    const raw = lines.slice(idx, nextHeaderStart).join('\n').trim();
    return stripCvMetaAndFiller(raw).trim();
  }

  const start = headers[hit].start;
  const end = hit + 1 < headers.length ? headers[hit + 1].start : lines.length;

  const rawBlock = lines.slice(start, end).join('\n').trim();
  return stripCvMetaAndFiller(rawBlock).trim();
}

function inferSingleRoleFromLooseText(text: string): { title: string; dates: string } | null {
  const t = preprocessCvSource(text || '');
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);

  // bierz pierwszą linię z datami albo pierwszą niepustą
  const line =
    lines.find(l => /(?:0[1-9]|1[0-2])\/\d{4}|\d{4}/.test(l)) ||
    lines[0] ||
    '';

  // Separator tytuł–firma: " - " (z odstępami), żeby nie ucinało np. "E-COMMERCE"
  const m = line.match(
    /^\s*(.+?)\s(?:-|–|—)\s(.+?)\s+((?:0[1-9]|1[0-2])\/\d{4}|\d{4})\s*(?:-|–|—)\s*((?:0[1-9]|1[0-2])\/\d{4}|\d{4}|obecnie)/i
  );
  if (!m) return null;

  const title = m[1].replace(/\s{2,}/g, ' ').trim();
  const dates = `${m[3]} - ${m[4]}`.replace(/obecnie/i, 'obecnie').trim();

  return { title, dates };
}

/** =========================
 *  Audit builder
 *  ========================= */
function buildAudit(cvText: string) {
  const roles = dedupeRoles(extractRolesFromCvText(cvText));
  if (roles.length === 0) {
    return `Na MVP pracujemy tylko na sekcji Doświadczenie.\nWklej Doświadczenie (stanowiska + daty + opis).`;
  }

  const lines: string[] = [];
  lines.push('Cel: zamieniamy “obowiązki” na IMPACT.');
  lines.push('W CV liczy się: co zrobiłeś (actions) • w jakiej skali (scale) • jaki efekt (result) • jakim sposobem (process/narzędzia).');
  lines.push('');
  lines.push('Już wiem, co poprawić. Wybierz rolę do dopracowania:');
  lines.push('');

  roles.forEach((r, idx) => {
    const block = extractRoleBlock(cvText, r.title);
    const miss = analyzeRoleMissing(r.title, block || '', cvText || '');
    lines.push(`${idx + 1}. ${r.title} | ${r.dates}`);
    lines.push(`braki: ${miss.summary}`);
    lines.push('');
  });

  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push('');

  const n = roles.length;
  lines.push(n === 1 ? 'Wpisz numer: 1' : `Wpisz numer: 1–${Math.min(n, 8)}`);

  return lines.join('\n');
}

/** =========================
 *  Conversation helpers
 *  ========================= */
function isRewrite(text: string) {
  return /===\s*BEFORE/i.test(text) || /===\s*AFTER/i.test(text);
}
function extractRoleTitleFromRewrite(text: string) {
  const t = normalizeNewlines(text);
  const m = t.match(/===\s*BEFORE\s*\((.+?)\)\s*===/i);
  return m?.[1]?.trim() || '';
}
function extractRoleTitleFromStartAssistant(text: string) {
  const t = normalizeNewlines(text);
  let m = t.match(/zaczni(?:j|ń)my od „(.+?)”/i);
  if (m?.[1]) return m[1].trim();
  m = t.match(/lecimy dalej\s*—\s*teraz „(.+?)”/i);
  if (m?.[1]) return m[1].trim();
  m = t.match(/teraz „(.+?)”/i);
  if (m?.[1]) return m[1].trim();
  return '';
}
function findLastRoleTitleInConversation(messages: Message[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;

    const fromStart = extractRoleTitleFromStartAssistant(m.content);
    if (fromStart) return fromStart;

    const fromRewrite = extractRoleTitleFromRewrite(m.content);
    if (fromRewrite) return fromRewrite;
  }
  return '';
}
function getProcessedRoleKeys(messages: Message[]) {
  const s = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (!isRewrite(m.content)) continue;
    const title = extractRoleTitleFromRewrite(m.content);
    if (!title) continue;
    s.add(keyify(title));
  }
  return s;
}
function findNextUnprocessedRoleTitle(roles: Role[], processedKeys: Set<string>) {
  for (const r of roles) {
    const k = keyify(r.title);
    if (!processedKeys.has(k)) return r.title;
  }
  return '';
}

function userWantsContinueAfterRewrite(text: string) {
  const t = (text || '').trim().toLowerCase();
  if (!t) return false;
  if (/(stop|koniec|nie|nie dzięki|nie dzieki|wystarczy)/i.test(t)) return false;
  if (looksLikeMultiRoleExperiencePasteStrong(text)) return false;
  if (/\b(\d{1,2})\b/.test(t)) return false;
  return t.length <= 40;
}

/** =========================
 *  Interview logic
 *  ========================= */
function isJustNumberChoice(text: string) {
  return /^\s*\d{1,2}\s*$/.test((text || '').trim());
}

function userCannotShare(text: string) {
  const t = (text || '').toLowerCase();
  return /(nie mogę|nie moge|nie mogę podać|nie moge podac|poufne|confidential|nie mogę dzielić|nie moge dzielic)/i.test(t);
}

function userNonAnswer(text: string) {
  const raw = (text || '').trim();
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return true;

  // same znaki / kropki / krótkie śmieci
  if (/^[\.\-—–_?!,;:]+$/.test(t)) return true;
  if (t === '…' || /^\.+$/.test(t)) return true;
  if (t.length <= 2) return true;
  if (/^[a-z]{1,3}$/.test(t)) return true; // "a", "s", "ysk"

  // typowe "brak danych"
  const exact = new Set([
    'nie pamiętam', 'nie pamietam',
    'nie wiem',
    'nie mam', 'nie mam danych',
    'brak', 'brak danych',
    'n/a', 'na',
    '-', '—', '?', '???', '...'
  ]);
  if (exact.has(t)) return true;

  // częste odpowiedzi-odmowy / nic-nie-mówiące
  if (
    t.includes('to nie moja działka') ||
    t.includes('nie moja działka') ||
    t.includes('nie dotyczy') ||
    t.includes('nie zajmowałem') || t.includes('nie zajmowalem') ||
    t.includes('nie było') || t.includes('nie bylo') ||
    t.includes('nie sprzedawałem') || t.includes('nie sprzedawalem') ||
    t.includes('nie pozyskiwałem') || t.includes('nie pozyskiwalem') ||
    t.includes('nie było takiego procesu') || t.includes('nie bylo takiego procesu')
  ) return true;

  return false;
}
function isWeakBaselineAnswer(text: string) {
  const t = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return true;

  const hasDigit = /\d/.test(t);
  const hasBaselineWords = /\b(vs|versus|poprzedni|wcześniej|wczesniej|m\/m|q\/q|t\/t|y\/y|z|do|wzrost|spadek)\b/.test(t);

  return hasBaselineWords && !hasDigit; // np. "100% vs poprzedni okres"
}
function enforceDeterministicBeforeSection(txt: string, roleTitle: string, roleBlockText: string) {
  const beforeBody = stripLeadingIndentAllLines(preprocessCvSource(roleBlockText || '')).trim();
  const clipped = beforeBody.split('\n').filter(Boolean).slice(0, 12).join('\n'); // max 12 linii
  const before = `=== BEFORE (${roleTitle}) ===\n${clipped}\n`;

  return txt.replace(
    /=== BEFORE \([^)]+\) ===[\s\S]*?(?=\n=== AFTER \([^)]+\) ===)/,
    before
  );
}

function isPostRewritePrompt(lastAssistantText: string) {
  const t = (lastAssistantText || '');
  return t.includes('=== AFTER (') && t.toLowerCase().includes('chcesz poprawić kolejną rolę');
}

function findInterviewStartIndex(messages: Message[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (isAudit(m.content)) return i;
    if (/zaczni(?:j|ń)my od/i.test(m.content)) return i;
    if (/lecimy dalej\s*—\s*teraz/i.test(m.content)) return i;
    if (/teraz „/i.test(m.content)) return i;
  }
  return 0;
}

function collectUserAnswers(messages: Message[], startIdx: number) {
  return messages
    .slice(startIdx)
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .filter((u) => !looksLikeMultiRoleExperiencePasteStrong(u))
    .filter((u) => !isJustNumberChoice(u));
}

type InterviewFacts = {
  hasActions: boolean;
  hasScale: boolean;
  hasProcess: boolean;
  hasResult: boolean;
  hasContext: boolean; // baseline/zmiana (z X do Y, yoy/mom/qoq, vs, itp.)
  needsContext: boolean;
};

function extractInterviewFactsFromText(text: string): InterviewFacts {
  const joined = preprocessCvSource(text || '');
  const stripped = stripDateNoise(joined);

  const hasNum = hasAnyNumber(stripped);
  const hasBaseline = hasBaselineContextSignal(stripped);

  // ACTIONS: czasowniki LUB lista rzeczowników po ":" / przecinkach
  const hasActions = hasActionsSignal(stripped) || hasActionsNounListSignal(stripped);

  let hasScale = hasScaleSignal(stripped);
  const hasProcess = hasAcquisitionProcessSignal(stripped);

  // RESULT: najpierw “surowy” sygnał, potem doprecyzowanie
  const rawHasResult = hasResultSignal(stripped);
  const hardResult = hasHardResultSignal(stripped);
  const softOnly = isSoftResultOnly(stripped);

  // ✅ wynik uznajemy za “prawdziwy”, gdy jest twardy (KPI/liczby/delta),
  // a nie tylko “dowóz planu / zdrowy pipeline” bez konkretów
  const hasResult = rawHasResult && hardResult && !softOnly;

  // SCALE: łap naturalny język (tygodniowo / miesięcznie / dziennie) + “pipeline/budżet/spend”
  if (!hasScale) {
    const lower = stripped.toLowerCase();

    const hasScaleLabel = /\b(skala|scale)\s*:\s*/i.test(lower);

    // ✅ dodane: “tygodniowo/miesięcznie/dziennie/kwartalnie/rocznie”
    const qtyWithUnitRe =
      /\b(\d+\s*(?:–|-|—)\s*\d+|\d+)\s*(?:\/\s*)?(?:na\s*)?(dzień|dzien|dziennie|tydz\.?|tydzień|tydzien|tygodniowo|mies\.?|miesiąc|miesiac|miesięcznie|miesiecznie|kw\.?|kwartał|kwartal|kwartalnie|rok|rocznie|sprint)\b/i;

    // ✅ rozszerzone: typowe “wolumenowe” słowa (sales/support/ops)
    const mentionsVolumeRe =
      /\b(pipeline|budżet|budzet|spend|zasi[eę]g|wy[śs]wietlenia|followers|obserwuj[aą]c|lead|leady|sql|mql|call|cold call|kontakt|spotkan|ofert|ticket|zgłosze|spraw|dokument|faktur)\b/i;

    if (hasScaleLabel || qtyWithUnitRe.test(lower) || (hasNum && mentionsVolumeRe.test(lower))) {
      hasScale = true;
    }
  }
  // CONTEXT potrzebny tylko gdy mamy “twardy” wynik, ale bez baseline
  const resultIs100 = /\b100\s*%/i.test(stripped);
  const needsContext = hasResult && !hasBaseline && !resultIs100;

    return {
    hasActions,
    hasScale,
    hasProcess,
    hasResult,
    hasContext: hasBaseline,
    needsContext,
  };
}

function isCeilingResultWhereBaselineIsPointless(text: string): boolean {
  const t = (text || '').toLowerCase();

  // 100% + terminowość/on-time/SLA itp.
  const isHundred = /\b100\s*%|\b100\s*procent\b/.test(t);
  const punctualityRe = /\b(terminowość|terminowosc|on-?time|na\s+czas|sla|bez\s+opóźnień|bez\s+opoznien)\b/;

  // “wszystko na czas” bez liczby baseline
  const allOnTimeRe = /\b(wszy(stkie)?\s+projekty?\s+na\s+czas|zawsze\s+na\s+czas)\b/;

  // 0 błędów / zero incydentów — też “ceiling”
  const zeroIssuesRe = /\b(0\s*(bug|błęd|bled|incydent)|zero\s*(bug|błęd|bled|incydent))\b/;

  if (isHundred && punctualityRe.test(t)) return true;
  if (allOnTimeRe.test(t)) return true;
  if (zeroIssuesRe.test(t)) return true;

  return false;
}

type QuestionKind = 'ACTIONS' | 'SCALE' | 'PROCESS' | 'RESULT' | 'CONTEXT';

const Q1 = 'Co konkretnie TY zrobiłeś w tej roli? Podaj 2–3 działania, bez "my".';
const Q2 = 'Jaka była skala? Podaj 1 liczbę albo widełki (np. liczba projektów/spraw, liczebność zespołu, budżet, wolumen).';
const Q2_SAFE =
  'Jeśli nie możesz podać kwot/wrażliwych danych — podaj bezpieczny proxy (widełki): np. liczba projektów/spraw, liczba osób w zespole, liczba interesariuszy, liczba zgłoszeń/tydz., liczba dostaw/tydz.';
const Q_PROCESS =
  'Jeśli w tej roli był proces pozyskania (klientów/kandydatów/partnerów) — opisz 2–4 etapy od pierwszego kontaktu do finalizacji.';
const Q_RESULT =
  'Jaki był wynik Twoich działań? Chodzi o konkretną miarę efektu (metryka albo sensowne proxy): np. % wzrostu/spadku, oszczędności, terminowość, spadek błędów/zakłóceń.';
const Q_RESULT_SAFE =
  'Jeśli nie możesz podać twardych wyników/kwot — podaj bezpieczny proxy: np. terminowość, spadek liczby błędów/incydentów, skrócenie czasu realizacji, mniej eskalacji, poprawa jakości/CX.';
const Q_CONTEXT =
  'Jaki był punkt odniesienia wyniku? Podaj baseline/zmianę: np. z X do Y, yoy/mom/qoq, albo vs poprzedni okres (wystarczy 1 zdanie).';
const Q2_SALES = `Jaka była skala Twojej pracy sprzedażowej? Podaj 2–3 liczby (bez wrażliwych danych): np. leady/kontakty, rozmowy/spotkania, wysłane oferty, wartość pipeline.`;

const Q2_SALES_SAFE = `Jaka była skala Twojej pracy sprzedażowej? Podaj bezpieczny proxy (widełki): np. leady/kontakty, rozmowy/spotkania, wysłane oferty, aktywne szanse (pipeline).`;

function looksLikeSalesRole(text: string): boolean {
  const t = preprocessCvSource(text || '').toLowerCase();
  return /(sprzedaż|sales|b2b|crm|lead|prospect|cold call|coldcall|outbound|inbound|negocjac|ofert(y|owanie)?|pipeline|szans)/i.test(t);
}

function inferQuestionKindFromAssistant(text: string): QuestionKind | null {
  const t = normalizeNewlines(text || '').toLowerCase();

  const hasRange = (a: number, b: number) => new RegExp(`${a}\\s*[-–]\\s*${b}`).test(t);

  // CONTEXT FIRST (baseline/punkt odniesienia)
  if (t.includes('punkt odniesienia') || t.includes('baseline') || t.includes('podaj baseline') || t.includes('m/m') || t.includes('mom') || t.includes('qoq')) {
    return 'CONTEXT';
  }

  if (t.includes('co konkretnie') && (t.includes('2–3') || t.includes('2-3') || hasRange(2, 3)) && t.includes('dział')) {
    return 'ACTIONS';
  }

  if (t.includes('jaka była skala') || t.includes('widełk') || t.includes('wolumen') || t.includes('liczba osób')) {
    return 'SCALE';
  }

  if (t.includes('proces pozyskania') || (t.includes('etap') && t.includes('finaliz') && (t.includes('2–4') || t.includes('2-4') || hasRange(2, 4)))) {
    return 'PROCESS';
  }

  if (t.includes('jaki był wynik') || t.includes('wynik twoich działań') || t.includes('bezpieczny proxy') || t.includes('metryk')) {
    return 'RESULT';
  }

  return null;
}

type InterviewState = {
  askedCounts: Record<QuestionKind, number>;
  declinedCounts: Record<QuestionKind, number>;
  askedTotal: number;
};

type InterviewStep =
  | { kind: 'ASK'; qk: QuestionKind; question: string }
  | { kind: 'REWRITE' };

function buildDeterministicRewrite(roleTitle: string, roleBlockText: string, userFactsText: string) {
  const beforeBody = stripLeadingIndentAllLines(preprocessCvSource(roleBlockText || '')).trim();

  const facts = preprocessCvSource(`${roleBlockText}\n${userFactsText}` || '');
  const lines = facts
    .split('\n')
    .map((l) => (l || '').trim())
    .filter(Boolean);

  const isMeta = (l: string) => /^(cel:|w cv liczy się|uwaga:|gotowy na|już wiem|wpisz numer)/i.test(l);
  const cleanLines = lines.filter((l) => !isMeta(l));

  const actionLines = cleanLines
    .filter((l) => !/^(skala|scale|wynik|result)\s*:/i.test(l) && !/\d/.test(l))
    .slice(0, 3);

  const scaleLines = cleanLines
    .filter((l) => {
      if (/^(skala|scale)\s*:/i.test(l)) return true;
      if (!/\d/.test(l)) return false;
      return /\b(dzień|dzien|tydz|tydzień|tydzien|mies|miesiąc|miesiac|kw|kwartał|kwartal|rok|sprint)\b/i.test(l);
    })
    .slice(0, 2);

  const resultLines = cleanLines
    .filter((l) => {
      if (/^(wynik|result)\s*:/i.test(l)) return true;
      return /\b(spadek|wzrost|redukcj|popraw|osiąg|osiagn|csat|nps|sla|roas|cpa|cac|ctr|cr|defect|pass rate|error rate|mttr|uptime|latency)\b/i.test(
        l
      );
    })
    .slice(0, 2);

  const toDash = (l: string) => {
    const s = (l || '').replace(/\s+/g, ' ').trim();
    const noLabel = s.replace(/^(skala|scale|wynik|result)\s*:\s*/i, '');
    return `- ${noLabel}`;
  };

  let bulletsA = [...actionLines, ...scaleLines, ...resultLines].map(toDash);

  // min 3 bullety
  if (bulletsA.length < 3) {
    bulletsA = [
      ...bulletsA,
      '- Realizacja kluczowych zadań w ramach roli.',
      '- Praca w ustalonym zakresie odpowiedzialności.',
      '- Dostarczanie wyników zgodnie z oczekiwaniami zespołu.',
    ].slice(0, 3);
  }

  // max 8
  bulletsA = bulletsA.slice(0, 8);

  // Wersja B ma się różnić – robimy “mocniejszy” język bez dodawania faktów
  const strengthen = (b: string, i: number) => {
    if (i === 0) return b.replace('- ', '- Samodzielne działanie: ');
    if (i === 1) return b.replace('- ', '- Regularne prowadzenie: ');
    if (i === 2) return b.replace('- ', '- Usprawnianie: ');
    return b;
  };
  const bulletsB = bulletsA.map(strengthen);

  return (
    `=== BEFORE (${roleTitle}) ===\n` +
    `${beforeBody}\n\n` +
    `=== AFTER (${roleTitle}) ===\n` +
    `Wersja A (bezpieczna):\n` +
    `${bulletsA.join('\n')}\n` +
    `Wersja B (mocniejsza):\n` +
    `${bulletsB.join('\n')}\n\n` +
    `Chcesz poprawić kolejną rolę?`
  );
}
function computeInterviewState(messages: Message[], startIdx: number): InterviewState {
  const askedCounts: Record<QuestionKind, number> = { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0, CONTEXT: 0 };
const declinedCounts: Record<QuestionKind, number> = { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0, CONTEXT: 0 };

  let currentKind: QuestionKind | null = null;

  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === 'assistant') {
      const k = inferQuestionKindFromAssistant(m.content);
      if (k) {
        currentKind = k;
        askedCounts[k] += 1;
      }
      continue;
    }

    if (!currentKind) continue;
    const u = (m.content || '').trim();

    if (isJustNumberChoice(u)) continue;
    if (looksLikeMultiRoleExperiencePasteStrong(u)) continue;

    if (userCannotShare(u) || userNonAnswer(u)) {
      declinedCounts[currentKind] += 1;
      currentKind = null;
      continue;
    }

    currentKind = null;
  }

  const askedTotal = Object.values(askedCounts).reduce((a, b) => a + b, 0);
  return { askedCounts, declinedCounts, askedTotal };
}

type NextInterviewStep =
  | { kind: 'ASK'; question: string; qk: QuestionKind }
  | { kind: 'REWRITE' };

function detectMetricMention(text: string): string | null {
  const t = preprocessCvSource(text || '').toLowerCase();
  if (/\bltv\b/.test(t)) return 'LTV';
  if (/\baov\b/.test(t)) return 'AOV';
  if (/\bcac\b/.test(t)) return 'CAC';
  if (/\broas\b/.test(t)) return 'ROAS';
  if (/\bacos\b/.test(t)) return 'ACOS';
  if (/\bctr\b/.test(t)) return 'CTR';
  if (/\bcr\b/.test(t) || /konwersj|conversion/.test(t)) return 'CR (konwersja)';
  return null;
}

function anchorVariants(anchor: string): string[] {
  const a = (anchor || '').toLowerCase();
  const num = a.replace(/[^\d.,]/g, '');
  const dot = num.replace(',', '.');
  const comma = num.replace('.', ',');
  const bare = dot; // "4.34"
  return Array.from(new Set([a, num, dot, comma, bare].filter(Boolean)));
}

/**
 * True tylko jeśli:
 * - jest baseline (z X do Y / X->Y / mom/qoq itd.)
 * - i (anchor albo metryka) pasuje do targetu (CR vs LTV itd.)
 */
function hasBaselineContextForTarget(answerText: string, target: MetricTarget): boolean {
  const raw = stripDateNoise(preprocessCvSource(answerText || ''));
  if (!hasBaselineContextSignal(raw)) return false;

  const t = raw.toLowerCase();
  const label = (target.label || '').toLowerCase();

  const wantsCR = label.includes('cr') || label.includes('konwers');
  const wantsLTV = label.includes('ltv');
  const wantsCTR = label.includes('ctr');

  const mentionsAnchor = target.anchor
    ? anchorVariants(target.anchor).some(v => v && t.includes(v))
    : false;

  const mentionsExpectedMetric =
    wantsCR ? /(\bcr\b|konwersj|conversion)/i.test(t)
    : wantsLTV ? /\bltv\b/i.test(t)
    : wantsCTR ? /\bctr\b/i.test(t)
    : true;

  // szybka blokada “podał inną metrykę”
  const wrongForCR = wantsCR && (/\bltv\b|\baov\b|\bcac\b|\broas\b|\bacos\b/i.test(t)) && !/(\bcr\b|konwersj|conversion)/i.test(t);
  const wrongForLTV = wantsLTV && (/(\bcr\b|konwersj|conversion|\bctr\b)/i.test(t)) && !/\bltv\b/i.test(t);

  return !wrongForCR && !wrongForLTV && (mentionsAnchor || mentionsExpectedMetric);
}

function decideNextInterviewStep(
  shouldAskProcess: boolean,
  facts: InterviewFacts,
  state: InterviewState
): InterviewStep {
  const maxQuestions = 6;
  if (state.askedTotal >= maxQuestions) return { kind: 'REWRITE' as const };

  // odmowa: 1 decline albo 2 zapytania o ten sam typ
  const declined = (k: QuestionKind) =>
    (state.declinedCounts[k] ?? 0) >= 1 || (state.askedCounts[k] ?? 0) >= 2;

  // 1) Fundamenty
  if (!facts.hasActions && !declined('ACTIONS')) {
    return { kind: 'ASK' as const, question: Q1, qk: 'ACTIONS' as const };
  }

  if (!facts.hasScale && !declined('SCALE')) {
    return { kind: 'ASK' as const, question: Q2, qk: 'SCALE' as const };
  }

  if (shouldAskProcess && !facts.hasProcess && !declined('PROCESS')) {
    return { kind: 'ASK' as const, question: Q_PROCESS, qk: 'PROCESS' as const };
  }

  // 2) Wynik
  if (!facts.hasResult) {
    if (!declined('RESULT')) {
      // handler i tak nadpisze na buildResultQuestion(...)
      return { kind: 'ASK' as const, question: '', qk: 'RESULT' as const };
    }
    return { kind: 'REWRITE' as const };
  }

  // 3) CONTEXT gate: jeśli jest wynik, ale brak baseline/kontekstu → pytaj o CONTEXT zanim REWRITE
  if (!facts.hasContext && !declined('CONTEXT')) {
    // handler i tak nadpisze na buildContextQuestion(...)
    return { kind: 'ASK' as const, question: '', qk: 'CONTEXT' as const };
  }

  return { kind: 'REWRITE' as const };
}

/** =========================
 *  Deterministic hints
 *  ========================= */
function buildScaleHintByDomain(domain: RoleDomain): string {
  switch (domain) {
    case 'MARKETING':
      return 'budżet/spend mies., liczba kampanii aktywnych, liczba kreacji/testów A/B, liczba landingów, leady/ruch / mies.';
    case 'ECOM':
      return 'liczba listingów/SKU, liczba zamówień / mies., ruch / mies., CR/CTR (jeśli masz), liczba kanałów/marketplace.';
    case 'SALES':
      return 'lejek: leady/kontakty, spotkania, wysłane oferty, aktywne szanse (pipeline), aktywność: cold calle / follow-upy.';
    case 'PM':
      return 'liczba projektów/streamów, liczba osób (zespół+dostawcy), budżet, liczba interesariuszy, częstotliwość release/statusów.';
    case 'DEV':
      return 'ticketów / sprint, PR / mies., deploye / tydz., liczba serwisów/modułów, incydenty/on-call.';
    case 'QA':
      return 'test case / sprint, regresje / tydz., zgłoszenia bugów / mies., pokrycie (jeśli macie).';
    case 'SUPPORT':
      return 'zgłoszenia / dzień (mail/chat/telefon), backlog, % eskalacji, SLA (1st response), czas rozwiązania.';
    case 'ADMIN':
      return 'dokumenty / dzień (faktury/umowy), rekordy / mies., czas obiegu, liczba procesów, błędy (%).';
    default:
      return 'wolumen (np. sprawy/tydz.), liczba zadań, częstotliwość, skala procesu.';
  }
}

function buildResultHintByDomain(domain: RoleDomain): string {
  switch (domain) {
    case 'MARKETING':
      return 'ROAS/CPA/CAC/CTR/CR, przychód, koszt/lead.';
    case 'ECOM':
      return 'CR/CTR/AOV/LTV/CAC/ROAS/ACOS (jeśli masz).';
    case 'SALES':
      return 'win rate, #umów, przychód/MRR, pipeline, konwersja etapów.';
    case 'PM':
      return 'terminowość (on-time), budżet (variance), redukcja opóźnień, sukces release.';
    case 'DEV':
      return 'latency, error rate, uptime, MTTR, throughput.';
    case 'QA':
      return 'defect leakage, pass rate, spadek #bugów, coverage (jeśli macie).';
    case 'SUPPORT':
      return 'SLA, czas 1. odpowiedzi, czas rozwiązania, % eskalacji.';
    case 'ADMIN':
      return 'czas obiegu, błędy (%), automatyzacja, wolumen, oszczędność czasu.';
    default:
      return 'oszczędności / SLA / mniej błędów / poprawa jakości.';
  }
}

function buildHintForQuestion(kind: QuestionKind, roleText: string) {
  const rt = preprocessCvSource(roleText || '');
  const domain = inferRoleDomain('', rt); // title zwykle jest w roleText (extractRoleBlock), więc to trafia

  if (kind === 'SCALE') {
    return `Podpowiedź (na bazie roli): ${buildScaleHintByDomain(domain)}.`;
  }

  if (kind === 'RESULT') {
    return `Podpowiedź (na bazie roli): ${buildResultHintByDomain(domain)}.`;
  }

  const t = rt.toLowerCase();
  const hints: string[] = [];

  if (kind === 'PROCESS') {
    if (/(cold call|coldcall|linkedin|lead|www|formularz|outbound|inbound)/i.test(t)) {
      hints.push('kanały: cold call / inbound z www / LinkedIn + 2–4 etapy');
    }
  }

  if (kind === 'CONTEXT') {
    if (/(cr\b|cvr\b|ctr\b|aov\b|ltv\b|cac\b|roas|acos|konwersj|conversion)/i.test(t)) {
      hints.push('podaj baseline dla tej metryki jako „z X do Y” (np. m/m, qoq, yoy albo vs poprzedni okres)');
    } else {
      hints.push('podaj baseline jako „z X do Y” (m/m, qoq, yoy albo vs poprzedni okres)');
    }
  }

  if (!hints.length) return '';
  return `Podpowiedź (na bazie opisu): ${hints.join(', ')}.`;
}

type MetricTarget = { label: string; anchor?: string };

function pickMetricTargetForContext(roleBlockText: string, userFactsText: string): MetricTarget {
  const role = stripDateNoise(preprocessCvSource(roleBlockText));
  const user = stripDateNoise(preprocessCvSource(userFactsText));

  const norm = (n: string) => n.replace(',', '.');

  const findIn = (src: string): MetricTarget | null => {
    // CR / konwersja
    let m =
      src.match(/konwersj\w*\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*%/i) ||
      src.match(/\bcr\b\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*%/i) ||
      src.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:konwersj\w*|\bcr\b)/i);
    if (m) return { label: 'CR (konwersja)', anchor: `${norm(m[1])}%` };

    // LTV
    m =
      src.match(/\bltv\b[^0-9]{0,15}(\d+(?:[.,]\d+)?)\s*(zł|zl|pln)\b/i) ||
      src.match(/(\d+(?:[.,]\d+)?)\s*(zł|zl|pln)\b[^a-z]{0,15}\bltv\b/i);
    if (m) return { label: 'LTV', anchor: `${norm(m[1])} zł` };

    // CTR
    m =
      src.match(/\bctr\b\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*%/i) ||
      src.match(/(\d+(?:[.,]\d+)?)\s*%\s*\bctr\b/i);
    if (m) return { label: 'CTR', anchor: `${norm(m[1])}%` };

    // błędy/incydenty
    m = src.match(/błęd\w*[^0-9]{0,20}(\d+(?:[.,]\d+)?)\s*%/i);
    if (m) return { label: 'błędy/incydenty', anchor: `${norm(m[1])}%` };

    // fallback: pierwsza % lub PLN
    m = src.match(/(\d+(?:[.,]\d+)?)\s*%/);
    if (m) return { label: 'wynik (%)', anchor: `${norm(m[1])}%` };

    m = src.match(/(\d+(?:[.,]\d+)?)\s*(zł|zl|pln)\b/i);
    if (m) return { label: 'wynik (PLN)', anchor: `${norm(m[1])} zł` };

    return null;
  };

  return findIn(user) || findIn(role) || { label: 'wynik' };
}
type RoleDomain = 'ECOM' | 'MARKETING' | 'SALES' | 'PM' | 'DEV' | 'QA' | 'SUPPORT' | 'ADMIN' | 'GENERIC';

function inferRoleDomain(roleTitle: string, roleText: string): RoleDomain {
  const t = `${roleTitle}\n${roleText}`.toLowerCase();

  // Najpierw domeny “twarde”, żeby ticket/zgłoszenia nie zaciągnęły dev/qa do support
  if (/(qa|tester|testy|manual|automatyzac|regresj|test case|bug report)/i.test(t)) return 'QA';
  if (/(developer|dev|programist|frontend|backend|fullstack|react|node|typescript|java|python|git|code review|refaktor|deploy|ci\/cd)/i.test(t))
    return 'DEV';

  if (/(shopify|allegro|amazon|marketplace|e-?commerce|sku|listing|ofert)/i.test(t)) return 'ECOM';

  if (/(performance marketing|marketing|google ads|meta ads|facebook ads|ppc|sem|seo|kampan|ads|kreac|social media|koordynator social)/i.test(t))
    return 'MARKETING';

  if (/(sprzedaż|sales|b2b|crm|lead|prospect|negocjac|ofert(y|owanie)?|cold call|outbound|inbound|pipeline|account manager)/i.test(t))
    return 'SALES';

  if (/(project manager|\bpm\b|kierownik projektu|zarządzanie projekt|jira|scrum|harmonogram|budżet|zakres|ryzyk)/i.test(t))
    return 'PM';

  // ✅ NOWE: SUPPORT (obsługa klienta)
  if (/(obs[łl]uga klient|customer support|customer service|call ?center|helpdesk|service desk|ticket|zgłosze|reklamac|zwrot|refund|chat|infolini|mail|sla|first response|resolution)/i.test(t))
    return 'SUPPORT';

  // ✅ NOWE: ADMIN (administracja/back office)
  if (/(administrac|back ?office|sekretariat|asystent|office manager|obieg dokument|faktur|invoice|dokumentac|archiw|korespondencj|zam[óo]wien|ewidencj|rozliczen|wprowadzanie danych|excel|raport)/i.test(t))
    return 'ADMIN';

  return 'GENERIC';
}

function buildContextQuestion(roleBlockText: string, userFactsText: string): string {
  const target = pickMetricTargetForContext(roleBlockText, userFactsText);
  const metricLine = target.anchor ? `${target.label} = ${target.anchor}` : target.label;

  const hint = target.anchor
    ? `Podpowiedź (na bazie opisu): wzrost/spadek ${target.label} z X do ${target.anchor} m/m (albo vs poprzedni okres).`
    : `Podpowiedź: podaj baseline jako X → Y (np. m/m lub vs poprzedni okres).`;

  return `Jaki był punkt odniesienia dla: ${metricLine}?\nPodaj baseline/zmianę (wystarczy 1 zdanie).\n${hint}`;
}

/** =========================
 *  Rewrite guard utils
 *  ========================= */
function extractNumbersLoose(text: string) {
  const t = normalizeNewlines(text);
  const re = /(?<!\w)(\d{1,3}(?:[ .,_]\d{3})*(?:[.,]\d+)?|\d+)(?!\w)/g;
  return (t.match(re) || []).map((x) => x.replace(/[ _]/g, '').trim());
}
function expandNumberVariants(tokens: string[]) {
  const out = new Set<string>();
  for (const tok of tokens) {
    out.add(tok);
    out.add(tok.replace(/,/g, '.'));
    out.add(tok.replace(/\./g, ','));
  }
  return out;
}
function hasUnverifiedNumbers(rewriteText: string, allowedFacts: string) {
  const allowedRaw = extractNumbersLoose(allowedFacts);
  const allowed = expandNumberVariants(allowedRaw);

  const gotRaw = extractNumbersLoose(rewriteText);
  const suspicious = gotRaw.filter(
    (n) => !allowed.has(n) && !allowed.has(n.replace(/,/g, '.')) && !allowed.has(n.replace(/\./g, ','))
  );
  return suspicious.length > 0;
}
function hasBannedCausalPhrases(text: string) {
  const t = normalizeNewlines(text).toLowerCase();
  const banned = [
    'co przyczyni',
    'co skutkow',
    'co pozwoliło',
    'co pozwolilo',
    'co umożliwiło',
    'co umozliwilo',
    'dzięki czemu',
    'w efekcie',
    'co przynios',
    'przełożyło się',
    'przelozylo sie',
    'przekładając się',
    'przekladajac sie',
  ];
  return banned.some((p) => t.includes(p));
}

function enforceRewriteRoleHeaders(text: string, roleTitle: string) {
  let t = normalizeNewlines(text);
  if (!roleTitle.trim()) return t;

  t = t.replace(/===\s*BEFORE\s*\((.*?)\)\s*===/i, `=== BEFORE (${roleTitle}) ===`);
  t = t.replace(/===\s*AFTER\s*\((.*?)\)\s*===/i, `=== AFTER (${roleTitle}) ===`);
  return t;
}

function stripCvMetaAndFiller(text: string) {
  let t = normalizeNewlines(text);

  const killMetaBullets = [/^\s*-?\s*Doprecyzuj.*$/gim, /^\s*-?\s*Dodaj.*$/gim];
  for (const re of killMetaBullets) t = t.replace(re, '');

  const killPhrases = [/zgodnie z opisem w before\.?/gi, /z twoich danych:?/gi, /jeśli dotyczy\.?/gi, /skala\s*:\s*/gi];
  for (const re of killPhrases) t = t.replace(re, '');

  return t;
}

function escapeRegExp(s: string): string {
  return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function repairRewriteBullets(text: string) {
  const lines = normalizeNewlines(text).split('\n');
  const out: string[] = [];
  let mode: 'NONE' | 'A' | 'B' = 'NONE';

  const pushOrAppend = (line: string) => {
    const t = line.trim();
    if (!t) return;

    const last = out[out.length - 1] || '';
    const isBullet = t.startsWith('- ');
    const lastIsBullet = last.trim().startsWith('- ');

    if (isBullet) {
      out.push(`- ${t.replace(/^-+\s*/g, '')}`.trimEnd());
      return;
    }

    if (mode !== 'NONE' && lastIsBullet) {
      out[out.length - 1] = `${last.trimEnd()} ${t}`.replace(/\s+/g, ' ').trimEnd();
      return;
    }

    if (mode !== 'NONE') {
      out.push(`- ${t}`.trimEnd());
      return;
    }

    out.push(t);
  };

  for (const raw of lines) {
    const t = raw.trimEnd();
    const tt = t.trim();

    if (/^Wersja A \(bezpieczna\):/i.test(tt)) {
      mode = 'A';
      out.push('Wersja A (bezpieczna):');
      continue;
    }
    if (/^Wersja B \(mocniejsza\):/i.test(tt)) {
      mode = 'B';
      out.push('Wersja B (mocniejsza):');
      continue;
    }
    if (/^===\s*(BEFORE|AFTER)/i.test(tt)) {
      mode = 'NONE';
      out.push(tt);
      continue;
    }
    if (/^Chcesz poprawić kolejną rolę\?/i.test(tt)) {
      mode = 'NONE';
      out.push('Chcesz poprawić kolejną rolę?');
      continue;
    }

    if (mode === 'A' || mode === 'B') pushOrAppend(t);
    else out.push(t);
  }

  return out.join('\n');
}

function fixRewriteVersionHeaderSpacing(input: string): string {
  let t = input || '';

  // Kanonizuj nagłówki (różne warianty z LLM)
  t = t.replace(/wersja\s*a\s*\(\s*bezpieczna\s*\)\s*:/gi, 'Wersja A (bezpieczna):');
  t = t.replace(/wersja\s*b\s*\(\s*mocniejsza\s*\)\s*:/gi, 'Wersja B (mocniejsza):');
  t = t.replace(/wersja\s*a\s*:/gi, 'Wersja A (bezpieczna):');
  t = t.replace(/wersja\s*b\s*:/gi, 'Wersja B (mocniejsza):');

  // 1) WYMUSZAMY NOWĄ LINIĘ PRZED "Wersja B" jeśli jest przyklejona do poprzedniej
  // np. "- cośtam Wersja B (mocniejsza):" -> "- cośtam\n\nWersja B (mocniejsza):"
  t = t.replace(
    /([^\n])\s*(Wersja B \(mocniejsza\):)/g,
    '$1\n\n$2'
  );

  // 2) WYMUSZAMY, żeby po nagłówkach był enter (żeby bullety nie startowały w tej samej linii)
  t = t.replace(/(Wersja A \(bezpieczna\):)\s*(?!\n)/g, '$1\n');
  t = t.replace(/(Wersja B \(mocniejsza\):)\s*(?!\n)/g, '$1\n');

  return t;
}

function enforceDashBulletsStrict(input: string): string {
  const lines = (input || '').split('\n');
  const out: string[] = [];

  let inAfter = false;
  let inA = false;
  let inB = false;

  const isBeforeHeader = (s: string) => s.startsWith('=== BEFORE');
  const isAfterHeader = (s: string) => s.startsWith('=== AFTER');
  const isVersionA = (s: string) => /^wersja\s*a\b/i.test(s);
  const isVersionB = (s: string) => /^wersja\s*b\b/i.test(s);
  const isCta = (s: string) => /^chcesz poprawić kolejną rolę\??/i.test(s);

  for (const raw of lines) {
    const s = (raw ?? '').trim();

    if (isBeforeHeader(s)) {
      inAfter = false;
      inA = false;
      inB = false;
      out.push(s);
      continue;
    }

    if (isAfterHeader(s)) {
      inAfter = true;
      inA = false;
      inB = false;
      out.push(s);
      continue;
    }

    if (!inAfter) {
      out.push(raw.trimEnd());
      continue;
    }

    if (isVersionA(s)) {
      inA = true;
      inB = false;
      out.push('Wersja A (bezpieczna):');
      continue;
    }

    if (isVersionB(s)) {
      inA = false;
      inB = true;
      out.push('Wersja B (mocniejsza):');
      continue;
    }

    if (s === '') {
      out.push('');
      continue;
    }

    if (isCta(s)) {
      inA = false;
      inB = false;
      out.push('Chcesz poprawić kolejną rolę?');
      continue;
    }

    // Wymuszamy myślniki tylko w A/B
    if (inA || inB) {
      // normalizacja innych “bulletowych” prefixów
      const bulletish = s.replace(/^[-–—•*]\s*/, '');
      out.push(`- ${bulletish}`);
      continue;
    }

    // linie w AFTER ale poza A/B (np. komentarze) zostawiamy
    out.push(raw.trimEnd());
  }

  return out.join('\n');
}

function dedupeBulletsInAB(text: string) {
  const lines = normalizeNewlines(text).split('\n');
  const out: string[] = [];

  let mode: 'NONE' | 'A' | 'B' = 'NONE';
  const seenA = new Set<string>();
  const seenB = new Set<string>();

  const normBullet = (s: string) => s.replace(/^\s*-\s*/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

  for (const raw of lines) {
    const t = raw.trimEnd();
    const tt = t.trim();

    if (/^Wersja A \(bezpieczna\):/i.test(tt)) {
      mode = 'A';
      out.push('Wersja A (bezpieczna):');
      continue;
    }
    if (/^Wersja B \(mocniejsza\):/i.test(tt)) {
      mode = 'B';
      out.push('Wersja B (mocniejsza):');
      continue;
    }
    if (/^===\s*(BEFORE|AFTER)/i.test(tt)) {
      mode = 'NONE';
      out.push(tt);
      continue;
    }
    if (/^Chcesz poprawić kolejną rolę\?/i.test(tt)) {
      mode = 'NONE';
      out.push('Chcesz poprawić kolejną rolę?');
      continue;
    }

    if ((mode === 'A' || mode === 'B') && tt.startsWith('- ')) {
      const k = normBullet(tt);
      const seen = mode === 'A' ? seenA : seenB;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(tt);
      continue;
    }

    out.push(t);
  }

  return out.join('\n');
}

function ensureRewriteCta(txt: string): string {
  const CTA = 'Chcesz poprawić kolejną rolę?';
  let t = normalizeNewlines(txt || '');

  // usuń wszystkie istniejące CTA (czasem model wklei je kilka razy / z myślnikiem)
  const ctaRe = /^[ \t]*-?[ \t]*Chcesz poprawić kolejną rolę\?\s*$/gim;
  t = t.replace(ctaRe, '');

  // wyczyść nadmiar pustych linii na końcu
  t = t.replace(/\n{3,}/g, '\n\n').trimEnd();

  // doklej CTA zawsze po jednej pustej linii i BEZ wcięć / bez myślnika
  return `${t}\n\n${CTA}`.replace(/\n{3,}/g, '\n\n').trimEnd();
}

function rewriteLooksValid(text: string) {
  const hasBefore = /===\s*BEFORE/i.test(text);
  const hasAfter = /===\s*AFTER/i.test(text);
  const hasA = /Wersja A \(bezpieczna\):/i.test(text);
  const hasB = /Wersja B \(mocniejsza\):/i.test(text);

  const sectionA = text.match(/Wersja A \(bezpieczna\):[\s\S]*?(?=Wersja B \(mocniejsza\):)/i)?.[0] || '';
  const sectionB = text.match(/Wersja B \(mocniejsza\):[\s\S]*/i)?.[0] || '';

  const bulletsA = (sectionA.match(/^\s*-\s+/gm) || []).length;
  const bulletsB = (sectionB.match(/^\s*-\s+/gm) || []).length;

  return hasBefore && hasAfter && hasA && hasB && bulletsA >= 3 && bulletsB >= 3;
}

function rewriteVersionsIdentical(text: string) {
  const a = text.match(/Wersja A \(bezpieczna\):([\s\S]*?)(?=Wersja B \(mocniejsza\):)/i)?.[1] || '';
  const b = text.match(/Wersja B \(mocniejsza\):([\s\S]*?)(?=Chcesz poprawić|$)/i)?.[1] || '';
  const norm = (s: string) =>
    normalizeNewlines(s)
      .split('\n')
      .map((l) => l.replace(/^\s*-\s*/g, '').trim())
      .filter(Boolean)
      .join(' | ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const na = norm(a);
  const nb = norm(b);
  return na && nb && na === nb;
}

/** =========================
 *  OpenAI call (unchanged)
 *  ========================= */
async function callOpenAI(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  temperature: number
) {
  const controller = new AbortController();
  const timeoutMs = 20000;
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let msg = 'OpenAI API error';
      try {
        const parsed = JSON.parse(errText || '{}');
        msg = parsed?.error?.message || msg;
      } catch {
        if (errText) msg = errText.slice(0, 300);
      }
      throw new Error(msg);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err: any) {
    const code = err?.cause?.code || err?.code || '';
    const aborted = err?.name === 'AbortError';
    if (aborted) throw new Error('OpenAI fetch failed (timeout)');
    throw new Error(`OpenAI fetch failed${code ? ` (${code})` : ''}`);
  } finally {
    clearTimeout(id);
  }
}

/** =========================
 *  Role title resolution from UI (simple fuzzy)
 *  ========================= */
function resolveSelectedRoleTitle(selected: string, rolesFromCv: Role[]) {
  const s = (selected || '').trim();
  if (!s) return '';
  const sk = keyify(s);
  if (!sk) return '';

  const hits = rolesFromCv
    .map((r) => r.title)
    .filter((t) => {
      const tk = keyify(t);
      return tk.includes(sk) || sk.includes(tk);
    });

  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    hits.sort((a, b) => Math.abs(a.length - s.length) - Math.abs(b.length - s.length));
    return hits[0];
  }
  return s;
}

function isSalesSupportRole(roleTitle: string, roleText: string) {
  const s = `${roleTitle}\n${roleText}`.toLowerCase();
  const titleHints = ['asystent', 'assistant'];
  const salesHint = s.includes('sprzedaż') || s.includes('sprzedaz') || s.includes('sales');
  const supportText =
    s.includes('crm') ||
    s.includes('ofert') ||
    s.includes('zapytan') ||
    s.includes('email') ||
    s.includes('research') ||
    s.includes('baza') ||
    s.includes('wsparcie');

  const noSelling = s.includes('nie sprzedawa') || s.includes('nie pozyskiwa');

  return titleHints.some((h) => s.includes(h)) && salesHint && (supportText || noSelling);
}

function isSocialRole(roleTitle: string, roleText: string) {
  const s = `${roleTitle}\n${roleText}`.toLowerCase();
  const hints = [
    'social media',
    'koordynator social',
    'social',
    'community',
    'moderac', // moderacja
    'harmonogram',
    'kalendarz treści',
    'content',
    'post',
    'reels',
    'relacj', // relacje
    'stories',
    'komentarz',
    'dm',
    'instagram',
    'tiktok',
    'facebook',
    'linkedin',
    'grafik',
    'kreacj', // kreacje
  ];
  return hints.some((h) => s.includes(h));
}

// 2) tytuł roli ma pierwszeństwo (najstabilniejszy sygnał domeny)

const Q_CONTEXT_FALLBACK =
  'Jaki był punkt odniesienia (baseline) dla tego wyniku? Podaj baseline/zmianę (1 zdanie).';

function buildScaleQuestion(roleTitle: string, roleText: string, cant: boolean): string {
  const domain = inferRoleDomainWithTitleOverride(roleTitle, roleText);
  const safe = cant ? ' Jeśli nie możesz podać wrażliwych danych — podaj proxy (widełki / % / trend / wolumen).' : '';

  // ✅ SOCIAL OVERRIDE: organic SM != paid marketing
  if (domain === 'MARKETING' && isSocialRole(roleTitle, roleText)) {
    return cant
      ? `Podaj proxy skali (1–2): #publikacji/tydz., #formatów (post/reels/stories), #komentarzy/DM dziennie, #obsługiwanych profili/marek, zasięg/wyświetlenia mies. Jeśli nie wiesz — podaj 1 z tych rzeczy.${safe}`
      : `Podaj skalę (1–2): #publikacji/tydz., #formatów (post/reels/stories), #komentarzy/DM dziennie, #obsługiwanych profili/marek, zasięg/wyświetlenia mies.${safe}`;
  }
  // ✅ SALES SUPPORT OVERRIDE
  if (domain === 'SALES' && isSalesSupportRole(roleTitle, roleText)) {
    return cant
      ? `Podaj skalę (proxy 1–2): #zapytania mailowe/dzień, #ofert przygotowanych/tydz., #aktualizacji CRM/dzień, #rekordów uzupełnionych/mies.${safe}`
      : `Podaj skalę (1–2): #zapytania mailowe/dzień, #ofert przygotowanych/tydz., #aktualizacji CRM/dzień, #rekordów uzupełnionych/mies.${safe}`;
  }

  switch (domain) {
    case 'MARKETING':
      return `Podaj skalę działań (1–2 wskaźniki): budżet/spend mies., #kampanii aktywnych, #testów kreacji/A-B, #landingów, ruch/leady mies.${safe}`;
    case 'ECOM':
      return `Podaj skalę (1–2): #listingów/SKU, #zamówień mies., ruch mies., #kanałów/marketplace.${safe}`;
    case 'SALES':
      return `Podaj skalę (1–2): #cold call / tydz., #spotkań / mies., #ofert / kw., pipeline (widełki), #leadów.${safe}`;
    case 'PM':
      return `Podaj skalę (1–2): #projektów/streamów, #osób (zespół+dostawcy), budżet (widełki), #interesariuszy.${safe}`;
    case 'DEV':
      return `Podaj skalę (1–2): #ticketów / sprint, #PR / mies., #deploy / tydz., #serwisów/modułów, dyżury/on-call.${safe}`;
    case 'QA':
      return `Podaj skalę (1–2): #test case / sprint, #regresji / tydz., #bugów / mies., pokrycie (jeśli macie).${safe}`;
    case 'SUPPORT':
      return `Podaj skalę (1–2): #zgłoszeń / dzień (mail/chat/telefon), backlog, % eskalacji, SLA (czas 1. odpowiedzi).${safe}`;
    case 'ADMIN':
      return `Podaj skalę (1–2): #dokumentów / dzień (faktury/umowy), #rekordów / mies., czas obiegu, liczba procesów.${safe}`;
    default:
      return `Podaj skalę (1–2): wolumen (np. sprawy/tydz.), częstotliwość, liczba zadań, rozmiar procesu.${safe}`;
  }
}
function buildResultQuestion(roleTitle: string, roleText: string, cant: boolean): string {
  const domain = inferRoleDomainWithTitleOverride(roleTitle, roleText);
  const safe = cant ? ' Jeśli nie możesz podać wrażliwych danych — podaj proxy (widełki / % / trend).' : '';

  // ✅ SOCIAL OVERRIDE: wyniki dla organic SM
  if (domain === 'MARKETING' && isSocialRole(roleTitle, roleText)) {
    return cant
      ? `Jaki był efekt? Podaj 1–2 proxy: wzrost followers (np. 8k→12k), zasięg/wyświetlenia mies., ER (engagement rate), średnie komentarze/post, czas reakcji na komentarze/DM, sentyment. Jeśli nie wiesz — podaj trend (%/widełki).${safe}`
      : `Jaki był efekt? Podaj 1–2: wzrost followers (np. 8k→12k), zasięg/wyświetlenia mies., ER (engagement rate), średnie komentarze/post, czas reakcji na komentarze/DM, sentyment.${safe}`;
  }

  // ✅ SALES SUPPORT OVERRIDE
  if (domain === 'SALES' && isSalesSupportRole(roleTitle, roleText)) {
    return cant
      ? `Jaki był efekt? Podaj 1–2 proxy: krótszy czas odpowiedzi na zapytania, mniej błędów w CRM/ofertach, więcej obsłużonych zapytań dziennie, poprawa SLA wewnętrznego.${safe}`
      : `Jaki był efekt? Podaj 1–2: krótszy czas odpowiedzi na zapytania, mniej błędów w CRM/ofertach, więcej obsłużonych zapytań dziennie, lepsze SLA wewnętrzne.${safe}`;
  }

  switch (domain) {
    case 'MARKETING':
      return `Jaki był efekt? Podaj 1–2: ROAS / CPA / CAC / CTR / CR / przychód.${safe}`;
    case 'ECOM':
      return `Jaki był efekt? Podaj 1–2: CR / CTR / AOV / LTV / CAC / ROAS / ACOS.${safe}`;
    case 'SALES':
      return `Jaki był efekt? Podaj 1–2: win rate, #umów, przychód/MRR, pipeline (widełki), konwersja etapów.${safe}`;
    case 'PM':
      return `Jaki był efekt? Podaj 1–2: terminowość (on-time), budżet (variance), redukcja opóźnień, sukces release/adoption.${safe}`;
    case 'DEV':
      return `Jaki był efekt? Podaj 1–2: latency, error rate, uptime, MTTR, throughput.${safe}`;
    case 'QA':
      return `Jaki był efekt? Podaj 1–2: defect leakage, pass rate, spadek #bugów, coverage (jeśli macie).${safe}`;
    case 'SUPPORT':
      return `Jaki był efekt? Podaj 1–2: CSAT/NPS, SLA, czas 1. odpowiedzi, czas rozwiązania, % eskalacji.${safe}`;
    case 'ADMIN':
      return `Jaki był efekt? Podaj 1–2: czas obiegu, błędy (%), wolumen (np. dokumenty/dzień), automatyzacja/oszczędność czasu.${safe}`;
    default:
      return `Jaki był efekt? Podaj 1–2: oszczędność, SLA, mniej błędów, poprawa jakości / szybkości.${safe}`;
  }
}
function buildSafeBullets(roleTitle: string, before: string, userFactsText: string) {
  const src = `${before}\n${userFactsText || ''}`.replace(/\r\n/g, '\n');

  // bierzemy linie/zdania które mają sens, bez wymyślania nowych faktów
  const candidates = src
    .split(/\n|\. /g)
    .map(s => s.trim())
    .filter(s => s.length >= 18)
    .slice(0, 8)
    .map(s => `- ${s.replace(/\.$/, '')}.`);

  // A: “bezpieczna” = bardziej neutralna
  const a = candidates.slice(0, 6);

  // B: “mocniejsza” = ten sam sens, ale język “I did”
  const b = a.map(l => l
    .replace(/^- /, '- ')
    .replace(/^-\s*(Uruchomienie|Kompleksowe|Analiza|Audyt|Monitorowanie|Standaryzacja)/i, '- Dowiozłem: $1')
    .replace(/Dowiozłem:/i, 'Zrobiłem:')
  );

  // gwarancja min. 3 bulletów, ale nadal bez faktów z kosmosu
  while (a.length < 3) a.push('- Realizacja kluczowych działań w obszarze e-commerce i optymalizacji oferty.');
  while (b.length < 3) b.push('- Zrobiłem kluczowe działania w obszarze e-commerce i optymalizacji oferty.');

  return { a, b };
}
function isEffectOk(answer: string) {
  const a = (answer || '').trim();
  if (!a) return false;

  return (
    /\d/.test(a) ||
    /(terminow|w terminie|on[- ]?time|budżet.*(nie|bez).*przekrocz|w budżecie|variance|odchylen|zaakcept|przyjęt|go[- ]?live|wdroż)/i.test(a)
  );
}
function inferAwaitingField(lastAssistantText: string) {
  const t = (lastAssistantText || '');
  if (/Jaki był efekt\??/i.test(t)) return 'EFFECT';
  if (/Podaj skalę/i.test(t)) return 'SCALE';
  return null;
}

function getLastUserText(messages: Message[]) {
  return [...messages].reverse().find(m => m.role === 'user')?.content?.trim() ?? '';
}
function getLastAssistantText(messages: Message[]) {
  return [...messages].reverse().find(m => m.role === 'assistant')?.content?.trim() ?? '';
}
function inferLastAskedKind(lastAssistantText: string): QuestionKind | null {
  const t = String(lastAssistantText ?? '');
  const s = t.toLowerCase();

  if (looksLikeScaleQuestion(s)) return 'SCALE';
  if (looksLikeResultQuestion(s)) return 'RESULT';
  if (looksLikeContextQuestion(s)) return 'CONTEXT';

  // PROCESS
  if (s.includes('proces') || s.includes('narzędz') || s.includes('narzedz') || s.includes('crm')) {
    return 'PROCESS';
  }

  // ACTIONS
  if (s.includes('co zrobiłeś') || s.includes('co zrobiles') || s.includes('działani') || s.includes('dzialani')) {
    return 'ACTIONS';
  }

  return null;
}

/**
 * Markuje "decline" (odmowa/brak danych).
 * UWAGA: To jest helper do STATE — nie ma tu prawa być NextResponse ani zależności od cvTextEffective/messages.
 */
function applyDeclineFromUser(
  state: InterviewState,
  lastQk: QuestionKind | null,
  lastUserText: string
) {
  if (!lastQk) return;

  const cleaned = stripDateNoise(preprocessCvSource(lastUserText || ''));

  // twarda odmowa / brak danych
  if (userNonAnswer(cleaned) || userCannotShare(cleaned)) {
    state.declinedCounts[lastQk] = (state.declinedCounts[lastQk] || 0) + 1;
    return;
  }

  // CONTEXT: jeśli user nie podał żadnego sygnału baseline/kontekstu → traktujemy jako decline
  // (luźny kontekst typu "vs poprzedni okres" itp. powinien łapać hasBaselineContextSignal)
  if (lastQk === 'CONTEXT') {
    const hasAnyContext = hasBaselineContextSignal(cleaned);
    if (!hasAnyContext) {
      state.declinedCounts[lastQk] = (state.declinedCounts[lastQk] || 0) + 1;
    }
  }
}
const UNKNOWN = '__UNKNOWN__';

function normalizeAnswerForFacts(text: string): string {
  const s = (text ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  if (/^(brak danych|brak|nie wiem|n\/a)$/i.test(s)) return UNKNOWN;
  return s;
}

function lastText(messages: { role: string; content: string }[], role: string): string {
  return [...messages].reverse().find(m => m.role === role)?.content ?? '';
}
function stripListPrefix(line: string): { prefix: string; core: string } {
  const s = String(line ?? '');
  const m = s.match(/^(\s*(?:[-–—*•]\s+)?)((?:.|\n)*)$/);
  return { prefix: m?.[1] ?? '', core: m?.[2] ?? s };
}
function isValidBaselineAnswer(ans: string): boolean {
  const s = String(ans ?? '').trim();
  if (!s) return false;
  if (/^\d{1,2}$/.test(s)) return false;

  return (
    /(?:\bvs\b|m\/m|q\/q|y\/y|r\/r|rok do roku|baseline|punkt odniesienia)/i.test(s) ||
    /(?:\d+\s*(?:→|->)\s*\d+)/.test(s) ||
    /(?:z\s*\d+[^\n]{0,30}\s*do\s*\d+)/i.test(s) ||
    /(?:\d+\s*(?:%|proc\.?|procent))/i.test(s)
  );
}
function cleanRewriteArtifacts(out: string): string {
  const lines = String(out ?? '').split('\n');
  const cleaned: string[] = [];

  for (const line of lines) {
    const { prefix, core } = stripListPrefix(line);
    const c = core.trim();
    const low = c.toLowerCase();

    // wycinamy “wycieki” z promptu / latcha (także gdy są w bulletach)
    if (
      low.startsWith('baseline/kontekst') ||
      low.startsWith('result (z ') ||
      low.startsWith('kontekst (z ') ||
      low.startsWith('efekt (doprecyzowanie') ||
      low.startsWith('punkt odniesienia') ||
      low.includes('z ostatniej odpowiedzi usera')
    ) {
      continue;
    }

    // usuwamy “Realizacja:”
    if (/^realizacja\s*:/i.test(c)) {
      const after = c.replace(/^realizacja\s*:\s*/i, '').trim();
      if (!after) continue;
      cleaned.push(`${prefix}${after}`);
      continue;
    }

    cleaned.push(line);
  }

  return cleaned.join('\n');
}
function looksLikeResultQuestion(text: string): boolean {
  const s = String(text ?? '').toLowerCase();

  // jeśli to CONTEXT, to nie może być RESULT
  if (looksLikeContextQuestion(s)) return false;

  // realne pytanie/prośba o efekt
  return (
    /\bjaki\s+by[lł]\s+(efekt|wynik)\b/i.test(s) ||
    /\bpodaj\s+(efekt|wynik|rezultat)\b/i.test(s)
  );
}

function looksLikeScaleQuestion(text: string): boolean {
  const s = String(text ?? '').toLowerCase();
  // tylko skala/proxy skali
  return (
    /\bpodaj\s+(proxy\s+)?skal[ęe]\b/i.test(s) ||
    /\bskal[ęe]\s+dzia[lł]a[nń]\b/i.test(s) ||
    /\bproxy\s+skali\b/i.test(s)
  );
}
function looksLikeContextQuestion(text: string): boolean {
  const s = String(text ?? '').toLowerCase();

  // MUSI wyglądać jak realne pytanie/prośba o baseline,
  // a nie opis braków typu "braki: kontekst (baseline/zmiana)"
  const hasAskVerb =
    s.includes('podaj') ||
    s.includes('jaki był') ||
    s.includes('jaki byl') ||
    s.includes('?');

  if (!hasAskVerb) return false;

  return (
    s.includes('punkt odniesienia') ||
    s.includes('podaj baseline') ||
    s.includes('podaj kontekst') ||
    s.includes('podaj baseline/zmian') ||
    s.includes('baseline/zmian') || // ale tylko gdy hasAskVerb jest true
    /\bx\s*(?:→|->)\s*y\b/i.test(s) ||
    s.includes('vs poprzedni') ||
    s.includes('m/m')
  );
}

function extractUserOnlyText(messages: any[]): string {
  return (messages || [])
    .filter((m) => m?.role === 'user')
    .map((m) => String(m?.content ?? ''))
    .join('\n');
}
function looksLikeDeclineAnswer(text: string): boolean {
  const s = String(text ?? '').toLowerCase().trim();
  return (
    s === '?' ||
    s.includes('nie wiem') ||
    s.includes('brak danych') ||
    s.includes('nie pamiętam') ||
    s.includes('nie mogę podać') ||
    s.includes('nie moge podac') ||
    s.includes('nie podam')
  );
}
function buildInterviewStateFromMessages(messages: any[]): InterviewState {
  const state: InterviewState = {
    askedCounts: { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0, CONTEXT: 0 },
    declinedCounts: { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0, CONTEXT: 0 },
    askedTotal: 0,
  };

  const detectAskedKind = (assistantText: string): QuestionKind | null => {
    const a = String(assistantText ?? '').toLowerCase();

    // kolejność ważna: najbardziej jednoznaczne najpierw
    if (looksLikeScaleQuestion(a)) return 'SCALE';
    if (looksLikeResultQuestion(a)) return 'RESULT';

    // CONTEXT/baseline
    if (
      a.includes('punkt odniesienia') ||
      a.includes('baseline') ||
      a.includes('x → y') ||
      a.includes('x->y') ||
      a.includes('x do y') ||
      a.includes('podaj baseline') ||
      a.includes('podaj kontekst')
    ) {
      return 'CONTEXT';
    }

    // PROCESS
    if (a.includes('proces') || a.includes('narzędz') || a.includes('narzedz') || a.includes('crm')) {
      return 'PROCESS';
    }

    // ACTIONS
    if (a.includes('co zrobiłeś') || a.includes('co zrobiles') || a.includes('działani') || a.includes('dzialani')) {
      return 'ACTIONS';
    }

    return null;
  };

  let lastAsked: QuestionKind | null = null;

  for (const m of messages || []) {
    const role = m?.role;
    const text = String(m?.content ?? '');

    if (role === 'assistant') {
      const kind = detectAskedKind(text);
      if (kind) {
        state.askedCounts[kind] += 1;
        state.askedTotal += 1;
        lastAsked = kind;
      } else {
        lastAsked = null;
      }
    }

    if (role === 'user') {
      if (lastAsked && looksLikeDeclineAnswer(text)) {
        state.declinedCounts[lastAsked] += 1;
        lastAsked = null;
      }
    }
  }

  return state;
}
function rewriteHasStrictDashBullets(txt: string): boolean {
  const t = txt || '';
  const mA = t.match(/Wersja A[\s\S]*?\n([\s\S]*?)\nWersja B/i);
  const mB = t.match(/Wersja B[\s\S]*?\n([\s\S]*?)(\nChcesz poprawić|\s*$)/i);
  if (!mA || !mB) return false;

  const bulletsA = mA[1].split('\n').filter(l => l.trim().startsWith('- '));
  const bulletsB = mB[1].split('\n').filter(l => l.trim().startsWith('- '));

  // 3–8 bulletów, i żadnych “gołych” linii tekstu w A/B
  const nonEmptyA = mA[1].split('\n').map(l=>l.trim()).filter(Boolean);
  const nonEmptyB = mB[1].split('\n').map(l=>l.trim()).filter(Boolean);
  const allAreBulletsA = nonEmptyA.every(l => l.startsWith('- '));
  const allAreBulletsB = nonEmptyB.every(l => l.startsWith('- '));

  return (
    bulletsA.length >= 3 && bulletsA.length <= 8 &&
    bulletsB.length >= 3 && bulletsB.length <= 8 &&
    allAreBulletsA && allAreBulletsB
  );
}
/** =========================
 *  POST handler
 *  ========================= */
export async function POST(req: NextRequest) {
  try {
    let rawJson: any;
    try {
      rawJson = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const validated = validateRequestBody(rawJson);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: validated.status });
    }

    const { messages, cvText, selectedRoleTitle: selectedRoleTitleFromBody } = validated.body;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key not configured. Please add OPENAI_API_KEY to your .env file.' },
        { status: 500 }
      );
    }

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const modelRewrite = process.env.OPENAI_MODEL_REWRITE || model;

    // buduj “effective CV” (bazowe cvText + ewentualne późniejsze wklejki multi-role)
    const cvTextEffective = buildCvTextEffective(cvText, messages);
    const cvEffectiveClean = preprocessCvSource(cvTextEffective || '');

    const mode = detectMode(messages, cvTextEffective);

    const rolesFromCv = dedupeRoles(extractRolesFromCvText(cvEffectiveClean));

    const lastUserRaw = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
const lastAssistantRaw = [...messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';

const lastUserClean = preprocessCvSource(lastUserRaw).trim();
const lastAssistantClean = String(lastAssistantRaw || '').trim();

const lastAskedForContext = looksLikeContextQuestion(lastAssistantClean);

const rawContextAnswer =
  lastAskedForContext && !looksLikeDeclineAnswer(lastUserClean)
    ? normalizeAnswerForFacts(lastUserClean)
    : '';

const latchedContextAnswer = isValidBaselineAnswer(rawContextAnswer) ? rawContextAnswer : '';

const lastAskedForResult = looksLikeResultQuestion(lastAssistantClean);

const latchedResultAnswer = (() => {
  if (!lastAskedForResult) return '';
  const s = normalizeAnswerForFacts(lastUserClean);
  if (!s) return '';
  if (looksLikeDeclineAnswer(s)) return '__UNKNOWN__';
  if (/^\d{1,2}$/.test(s.trim())) return ''; // menu-picki typu “1”
  return s.trim();
})();

    /** =========================
 *  AUDIT_ONLY
 *  ========================= */
if (mode === 'AUDIT_ONLY') {
  const firstUser = preprocessCvSource(messages.find((m) => m.role === 'user')?.content || '');
  const effective = preprocessCvSource(cvTextEffective || firstUser);

  let roles = dedupeRoles(extractRolesFromCvText(effective));
  if (roles.length === 0) {
    const inferred = inferSingleRoleFromLooseText(effective);
    if (inferred) roles = [inferred];
  }

  const suspiciousSingle = looksLikeMultiRoleButParsedSingle(effective, roles.length);

  // jeśli faktycznie 1 rola i parser jest “pewny” -> od razu interview
  if (!suspiciousSingle && roles.length === 1) {
    const roleTitle = roles[0].title;

    const roleBlockStrict = extractRoleBlock(effective, roleTitle) || '';
    const roleBlockText = preprocessCvSource(roleBlockStrict);

    const allText = preprocessCvSource(`${roleBlockText}\n${effective}`);

    // 1) Fakty z CV + fakty z odpowiedzi usera (żeby interview szło do przodu)
    const userOnlyText = preprocessCvSource(
      messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content || '')
        .join('\n')
    );

    const factsFromRole = extractInterviewFactsFromText(roleBlockText || effective);

// Anti-loop latch: jeżeli ostatnio pytaliśmy o EF EKT (RESULT) i user odpowiedział sensownie,
// uznajemy, że "wynik mamy" i nie pytamy ponownie.
if (
  lastAskedForResult &&
  latchedResultAnswer &&
  latchedResultAnswer !== '__UNKNOWN__' &&
  !/^brak danych$/i.test(String(latchedResultAnswer).trim())
) {
  factsFromRole.hasResult = true;
}

// Anti-loop latch: jeżeli ostatnio pytaliśmy o baseline/kontekst (CONTEXT) i user odpowiedział sensownie,
// uznajemy, że "kontekst mamy" i nie pytamy ponownie.
if (lastAskedForContext && latchedContextAnswer) {
  factsFromRole.hasContext = true;
  factsFromRole.needsContext = false;
}

    const factsFromUser = extractInterviewFactsFromText(userOnlyText);

    let facts: InterviewFacts = {
      hasActions: factsFromRole.hasActions || factsFromUser.hasActions,
      hasScale: factsFromRole.hasScale || factsFromUser.hasScale,
      hasProcess: factsFromRole.hasProcess || factsFromUser.hasProcess,
      hasResult: factsFromRole.hasResult || factsFromUser.hasResult,
      hasContext: factsFromRole.hasContext || factsFromUser.hasContext,
      needsContext: (factsFromRole.needsContext || factsFromUser.needsContext) && !(factsFromRole.hasContext || factsFromUser.hasContext),
    };

    // 2) Anti-loop latch: jeśli ostatnio pytaliśmy o efekt/baseline, a user coś odpisał,
    //    to ZAMYKAMY "RESULT" (MVP: lepiej iść dalej niż pytać w kółko)
    const lastAssistant = preprocessCvSource(
      [...messages].reverse().find((m) => m.role === 'assistant')?.content || ''
    );
    const lastUser = preprocessCvSource(
      [...messages].reverse().find((m) => m.role === 'user')?.content || ''
    );
    const latched = normalizeAnswerForFacts(lastUser);

    if (looksLikeResultQuestion(lastAssistant) && latched) {
      facts = { ...facts, hasResult: true, needsContext: false };
    }

    const shouldProcess = shouldAskAcquisitionProcess(roleTitle, allText);

    // 3) Stan NIE może być zerowany — wyciągamy go z historii messages
    const state: InterviewState = buildInterviewStateFromMessages(messages);

    const step = decideNextInterviewStep(shouldProcess, facts, state);

let q = '';
if (step.kind === 'ASK') {
  if (step.qk === 'SCALE') {
    q = buildScaleQuestion(roleTitle, roleBlockText || roleTitle, false);
  } else if (step.qk === 'RESULT') {
    q = buildResultQuestion(roleTitle, roleBlockText || roleTitle, false);
  } else if (step.qk === 'CONTEXT') {
    q = buildContextQuestion(roleBlockText || roleTitle, '');
  } else if (step.qk === 'PROCESS') {
    q = Q_PROCESS;
  } else if (step.qk === 'ACTIONS') {
    q = Q1;
  } else {
    // fallback (gdyby kiedyś doszedł nowy qk)
    q = String(step.question ?? '');
  }
}

    const hint =
      step.kind === 'ASK' && (step.qk === 'ACTIONS' || step.qk === 'PROCESS')
        ? buildHintForQuestion(step.qk, roleBlockText || roleTitle)
        : '';

    const msg = `Ok, w takim razie zacznijmy od „${roleTitle}”.\n${q}${hint ? `\n${hint}` : ''}`;
    return NextResponse.json({ assistantText: normalizeForUI(msg, 1) });
  }

  const audit = buildAudit(effective);
  return NextResponse.json({ assistantText: normalizeForUI(audit, 1) });
}

    /** =========================
     *  NORMAL
     *  ========================= */

    // Jeśli user wkleił nowe multi-role Doświadczenie w trakcie NORMAL -> pokaż audit (nie mieszaj z Q&A)
    if (looksLikeMultiRoleExperiencePasteStrong(lastUserRaw)) {
      const effective = preprocessCvSource(cvTextEffective || lastUserRaw);
      const audit = buildAudit(effective);
      return NextResponse.json({ assistantText: normalizeForUI(audit, 1) });
    }

    // 1) CONTINUE po rewrite (automatycznie następna rola)
    if (isPostRewritePrompt(lastAssistantClean) && userWantsContinueAfterRewrite(lastUserRaw)) {
      const effective = preprocessCvSource(cvTextEffective || '');
      const roles = dedupeRoles(extractRolesFromCvText(effective));

      const processed = getProcessedRoleKeys(messages);
      const nextRoleTitle = findNextUnprocessedRoleTitle(roles, processed);

      if (!nextRoleTitle) {
        const doneMsg = `Nie widzę kolejnych ról do przerobienia. Jeśli chcesz, wklej kolejną część Doświadczenia albo wybierz inną rolę z audytu.`;
        return NextResponse.json({ assistantText: normalizeForUI(doneMsg, 1) });
      }

      const roleBlockStrict = extractRoleBlock(effective, nextRoleTitle) || '';
      const roleBlockText = preprocessCvSource(roleBlockStrict);

      const allText = preprocessCvSource(`${roleBlockText}\n${effective}`);
      const factsFromRole = extractInterviewFactsFromText(roleBlockText || effective);
      const shouldProcess = shouldAskAcquisitionProcess(nextRoleTitle, allText);

      const freshState: InterviewState = {
        askedCounts: { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0, CONTEXT: 0 },
        declinedCounts: { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0, CONTEXT: 0 },
        askedTotal: 0,
      };

      const step = decideNextInterviewStep(shouldProcess, factsFromRole, freshState);

      let q = '';
      if (step.kind === 'ASK') {
        if (step.qk === 'ACTIONS') q = Q1;
        if (step.qk === 'SCALE') q = buildScaleQuestion(nextRoleTitle, roleBlockText || nextRoleTitle, false);
        if (step.qk === 'PROCESS') q = Q_PROCESS;
        if (step.qk === 'RESULT') q = buildResultQuestion(nextRoleTitle, roleBlockText || nextRoleTitle, false);
        if (step.qk === 'CONTEXT') q = buildContextQuestion(roleBlockText || nextRoleTitle, '');
      } else {
        // jeśli z samego bloku wszystko jest -> od razu rewrite
        q = buildResultQuestion(nextRoleTitle, roleBlockText || nextRoleTitle, false);
      }

      const hint =
        step.kind === 'ASK' && (step.qk === 'ACTIONS' || step.qk === 'PROCESS')
          ? buildHintForQuestion(step.qk, roleBlockText || nextRoleTitle)
          : '';

      const msg = `Lecimy dalej — teraz „${nextRoleTitle}”.\n${q}${hint ? `\n${hint}` : ''}`;
      return NextResponse.json({ assistantText: normalizeForUI(msg, 1) });
    }

    // 2) Rozpoznaj wybraną rolę:
    const effective = preprocessCvSource(cvTextEffective || lastUserRaw || '');
    const roles = dedupeRoles(extractRolesFromCvText(effective));

    // 2a) UI dropdown
    let selectedRoleTitle = resolveSelectedRoleTitle(selectedRoleTitleFromBody || '', roles);

    // 2b) wybór numerem po audycie
    if (!selectedRoleTitle && isJustNumberChoice(lastUserRaw)) {
      const n = extractChosenNumber(lastUserRaw, 20);
      if (n) {
        // spróbuj wyciągnąć title z OSTATNIEGO audytu (dokładniej)
        const lastAuditMsg = [...messages].reverse().find((m) => m.role === 'assistant' && isAudit(m.content))?.content || '';
        const fromAudit = lastAuditMsg ? extractRoleTitleFromAuditByNumber(lastAuditMsg, n) : '';
        if (fromAudit) selectedRoleTitle = fromAudit;
        else if (roles[n - 1]) selectedRoleTitle = roles[n - 1].title;
      }
    }

    // 2c) kontynuacja aktualnej roli z konwersacji
    if (!selectedRoleTitle) {
      selectedRoleTitle = findLastRoleTitleInConversation(messages);
    }

    // Jeśli nadal nic — pokaż audit albo poproś o wklejkę doświadczenia
    if (!selectedRoleTitle) {
      if (!effective.trim()) {
        const msg = `Na MVP pracujemy tylko na sekcji Doświadczenie.\nWklej Doświadczenie (stanowiska + daty + opis), a zrobię audyt i wybór roli.`;
        return NextResponse.json({ assistantText: normalizeForUI(msg, 1) });
      }
      const audit = buildAudit(effective);
      return NextResponse.json({ assistantText: normalizeForUI(audit, 1) });
    }

    // 3) Wytnij blok roli
    let roleBlockStrict = extractRoleBlock(effective, selectedRoleTitle) || '';

    // fallback jeśli effective jest zbyt ubogie
    if (!roleBlockStrict && cvEffectiveClean) {
      roleBlockStrict = extractRoleBlock(cvEffectiveClean, selectedRoleTitle) || '';
    }

    // ostateczny fallback (żeby nic nie było puste)
    const roleBlockText = preprocessCvSource(roleBlockStrict || selectedRoleTitle);

    // 4) Zbierz odpowiedzi usera od startu interview
    const startIdx = findInterviewStartIndex(messages);
    const answers = collectUserAnswers(messages, startIdx);
    const userFactsText = preprocessCvSource(answers.join('\n'));

    // 5) Fakty + state
    const allText = preprocessCvSource(`${roleBlockText}\n${userFactsText}\n${effective}`);

    const facts = extractInterviewFactsFromText(`${roleBlockText}\n${userFactsText}`);
    const shouldProcess = shouldAskAcquisitionProcess(selectedRoleTitle, allText);

    const state = computeInterviewState(messages, startIdx);

// Last-turn bridge: zatrzymaj pętle (decline) i zalatchuj fakty (answer)
const lk = inferLastAskedKind(lastAssistantClean);
const lastUserClean = preprocessCvSource(lastUserRaw || '');
const lastUserNorm = normalizeAnswerForFacts(lastUserClean);

// 1) Jeśli user odmówił / brak danych -> oznacz decline dla ostatnio zadanego typu
if (lk && looksLikeDeclineAnswer(lastUserClean)) {
  state.declinedCounts[lk] = (state.declinedCounts[lk] ?? 0) + 1;
}

// 2) Jeśli user odpowiedział sensownie -> uznaj, że mamy już fakt i nie pytaj ponownie
if (lk === 'RESULT' && lastUserNorm && !looksLikeDeclineAnswer(lastUserClean)) {
  facts.hasResult = true;
}
if (lk === 'CONTEXT' && lastUserNorm && !looksLikeDeclineAnswer(lastUserClean)) {
  facts.hasContext = true;
  facts.needsContext = false;
}

    const step = decideNextInterviewStep(shouldProcess, facts, state);

    // 6) ASK kolejnego pytania
    if (step.kind === 'ASK') {
      const cant = userCannotShare(lastUserRaw) || userNonAnswer(lastUserRaw);

      let q = step.question;
      if (step.qk === 'ACTIONS') q = Q1;
      if (step.qk === 'SCALE') q = buildScaleQuestion(selectedRoleTitle, roleBlockText, cant || (state.declinedCounts.SCALE ?? 0) > 0);
      if (step.qk === 'PROCESS') q = Q_PROCESS;
      if (step.qk === 'RESULT') q = buildResultQuestion(selectedRoleTitle, roleBlockText, cant || (state.declinedCounts.RESULT ?? 0) > 0);
      if (step.qk === 'CONTEXT') {
        q =
          (state.declinedCounts.CONTEXT ?? 0) > 0
            ? Q_CONTEXT_FALLBACK
            : buildContextQuestion(roleBlockText, userFactsText);
      }

      const hint =
        step.qk === 'ACTIONS' || step.qk === 'PROCESS'
          ? buildHintForQuestion(step.qk, roleBlockText)
          : '';

      const needIntro =
        isAudit(lastAssistantClean) ||
        (extractRoleTitleFromRewrite(lastAssistantClean) && keyify(extractRoleTitleFromRewrite(lastAssistantClean)) !== keyify(selectedRoleTitle));

      const msg = `${needIntro ? `Ok, teraz „${selectedRoleTitle}”.\n` : ''}${q}${hint ? `\n${hint}` : ''}`;
      return NextResponse.json({ assistantText: normalizeForUI(msg, 1) });
    }

   /** =========================
 *  7) REWRITE
 *  ========================= */

// 1) Sklej fakty usera + “latched” odpowiedzi (żeby nie pętlić i żeby rewrite je widział)
const latchedResultClean =
  latchedResultAnswer === '__UNKNOWN__' ? '' : (latchedResultAnswer || '').trim();

const userFactsTextForPrompt = preprocessCvSource(
  [
    userFactsText || '',
    latchedResultClean ? `Efekt (doprecyzowanie): ${latchedResultClean}` : '',
    latchedContextAnswer ? `Punkt odniesienia (baseline): ${latchedContextAnswer}` : '',
  ]
    .filter(Boolean)
    .join('\n')
);

const allowedFacts = preprocessCvSource(`${roleBlockText}\n${userFactsTextForPrompt}`);

// 2) Bezpieczny “allowed facts” do walidacji liczb — już z effective (wlicza latch)
const allowedFacts = preprocessCvSource(`${roleBlockText}\n${userFactsTextEffective}`);

// 3) prompt do LLM
const userPrompt = [
  CONTEXT_PROMPT,
  '',
  `ROLE: ${selectedRoleTitle}`,
  '',
  `BEFORE (źródło, nie wymyślaj nic):`,
  roleBlockText,
  '',
  `DODATKOWE FAKTY OD USERA (jeśli są):`,
  userFactsTextForPrompt || '(brak)',
  '',
  `Wymagany format WYJŚCIA (bez markdown, bez bloków kodu):`,
  `=== BEFORE (${selectedRoleTitle}) ===`,
  `(wklej 1:1 treść BEFORE, max ~12 linii)`,
  `=== AFTER (${selectedRoleTitle}) ===`,
  `Wersja A (bezpieczna):`,
  `- 3–8 bulletów (myślniki)`,
  `Wersja B (mocniejsza):`,
  `- 3–8 bulletów (myślniki)`,
  ``,
  `Zakazy: nie dodawaj nowych liczb/metryk, nie używaj “dzięki czemu / w efekcie / co pozwoliło…”.`,
  `Nie mieszaj wersji A i B, nie rób identycznych bulletów.`,
  `Zakończ dokładnie: "Chcesz poprawić kolejną rolę?"`,
].join('\n');

let llmOut = '';
try {
  llmOut = await callOpenAI(
    apiKey,
    modelRewrite,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    0.2
  );
} catch {
  llmOut = '';
}

let out = stripFencedCodeBlock(llmOut || '').trim();
out = out
  .split('\n')
  .filter((l) => !/^\s*(RESULT|BASELINE\/KONTEXT)\b/i.test(l.trim()))
  .join('\n')
  .trim();
out = out.replace(/(^|\n)\s*-\s*Realizacja:\s*/g, '$1- ');

if (out) {
  out = stripCvMetaAndFiller(out);
  out = cleanRewriteArtifacts(out);
  out = enforceRewriteRoleHeaders(out, selectedRoleTitle);
  out = fixRewriteVersionHeaderSpacing(out);
  out = repairRewriteBullets(out);
  out = enforceDashBulletsStrict(out);
  out = dedupeBulletsInAB(out);
  out = enforceDeterministicBeforeSection(out, selectedRoleTitle, roleBlockText);
  out = ensureRewriteCta(out);
  out = normalizeForUI(out, 1);

  const invalid =
    !rewriteLooksValid(out) ||
    rewriteVersionsIdentical(out) ||
    !rewriteHasStrictDashBullets(out) ||
    hasUnverifiedNumbers(out, allowedFacts) ||
    hasBannedCausalPhrases(out);

  if (!invalid) {
    return NextResponse.json({ assistantText: out });
  }
}

// Fallback: deterministyczny rewrite bez halucynacji
const fallback = buildDeterministicRewriteFallback({
  roleTitle: selectedRoleTitle,
  roleBlockText,
  userFactsText: userFactsTextEffective, // <- ważne: też z latchem
});

const fallbackOut = normalizeForUI(
  ensureRewriteCta(enforceDeterministicBeforeSection(fallback, selectedRoleTitle, roleBlockText)),
  1
);

return NextResponse.json({ assistantText: fallbackOut });
      } catch (err: any) {
    const msg = err?.message ? String(err.message).slice(0, 300) : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}