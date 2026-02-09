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

function stripFencedCodeBlock(text: string) {
  const t = normalizeNewlines(text).trim();
  const m = t.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : t;
}

/**
 * NEW: strip simple line-level markdown decorations often present in CV pastes
 * Examples:
 *   *Firma ...*  -> Firma ...
 *   **Title**    -> Title
 */
function stripMarkdownDecorationsAllLines(text: string) {
  const lines = normalizeNewlines(text || '').split('\n');

  const stripWrap = (line: string) => {
    let t = line.trimEnd();

    // remove leading bullets that are only decoration (keep real bullets handled elsewhere)
    // keep "- " / "• " / "* " bullets
    // Here we only strip italics/bold wrapping of the entire line.
    t = t.replace(/^\s*\*{1,3}(.+?)\*{1,3}\s*$/g, '$1');
    t = t.replace(/^\s*_{1,3}(.+?)_{1,3}\s*$/g, '$1');

    // normalize stray leading markdown markers like "> " from quotes
    t = t.replace(/^\s*>\s+/g, '');

    return t;
  };

  return lines.map(stripWrap).join('\n');
}

/** =========================
 *  NEW: Deglue date tokens + normalize date dashes
 *  - fixes: Role2020–presentbody, obecnieOpis, 2020-2024 etc.
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
  t = t.replace(
    /([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż0-9])(?=(obecnie|present)\b)/gi,
    '$1 '
  );

  // Ensure space after obecnie/present if glued to following letters (fix presentbody)
  t = t.replace(
    /(obecnie|present)(?=[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])/gi,
    '$1 '
  );

  return t;
}

function normalizeDateDashes(text: string) {
  let t = normalizeNewlines(text || '');
  if (!t.trim()) return t;

  // normalize "2020-2024" / "03.2021–obecnie" / "03/2021 - present" into "… – …"
  // cover both '-' and '–' and '—'
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
 *  NEW: Dedupe lines as a separate step
 *  - safe: removes only consecutive duplicates after normalization
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
 *  NEW: Split inline header: "Role - Company 2020 – present body"
 *  Fixes the “capturing-group-count depends on end” bug by using named groups.
 *  ========================= */
function splitHeaderDatesAndInlineBody(line: string): {
  headerPart: string;
  dates: string;
  inlineBody: string;
} | null {
  const t = normalizeDateDashes(deglueDateTokens((line || '').trim()));
  if (!t) return null;

  // Accept:
  // - MM/YYYY – (MM/YYYY|YYYY|obecnie|present)
  // - YYYY – (YYYY|obecnie|present)
  const re =
    /^(?<before>.+?)\s+(?<range>(?<start>(?:\d{2}[./-]\d{4}|\b(?:19|20)\d{2}\b))\s*[–-]\s*(?<end>(?:\d{2}[./-]\d{4}|\b(?:19|20)\d{2}\b|obecnie|present)))\s*(?<after>.*)$/i;

  const m = t.match(re);
  if (!m || !m.groups) return null;

  const headerPart = (m.groups.before || '').trim();
  const dates = `${m.groups.start} – ${m.groups.end}`.trim();
  const inlineBody = (m.groups.after || '').trim();

  if (!headerPart || !dates) return null;
  // avoid false positives: header too short
  if (headerPart.length < 3) return null;

  return { headerPart, dates, inlineBody };
}

/** =========================
 *  NEW: handle header with trailing single start date:
 *   "E-COMMERCE ... - Company 06/2024"
 *   and body starts with "Obecnie ..."
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
 *  NEW: Fix single-paragraph pastes
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

  t = t.replace(
    /(\b\d{2}[./-]\d{4}\b|\b\d{2}\/\d{4}\b|\b(?:19|20)\d{2}\b)\s*[–-]\s*(obecnie|present|\b\d{2}[./-]\d{4}\b|\b\d{2}\/\d{4}\b|\b(?:19|20)\d{2}\b)/gi,
    (_m, a, b) => `\n${a} – ${b}\n`
  );

  // break before obvious headers (ALLCAPS-ish with dash separator)
  t = t.replace(/\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ][A-ZĄĆĘŁŃÓŚŹŻ0-9 /&.]{2,}\s(?:\-|–)\s)/g, '\n');

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
  const t = (line || '').trim().toLowerCase();
  if (t.length < 12) return false;

  return /^(prowadzen|zarzadz|koordyn|wdra|optymaliz|analiz|monitor|raport|audyt|tworz|zbudow|standaryz|automatyz|planow|priorytet|manage|led|deliver|own|build|optimi[sz]e|analy[sz]e|report|coordinate|implement)/i.test(
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
  // PL + EN (minimal, MVP-safe)
  return /\b(specjalist|asystent|manager|kierownik|dyrektor|analityk|koordynator|in[żz]ynier|project|account|sales|sprzeda[żz]|e-?commerce|marketplace|owner|lead|consultant|pm\b|po\b)\b/i.test(
    t
  );
}

function looksLikeCompanyLocationLine(line: string) {
  const t = (line || '').trim();
  if (!t) return false;

  // very common pattern: "Firma..., Miasto | 03.2021 – obecnie"
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
 * Header rule (fixed):
 * - never treat company/location line as header
 * - require strong signals:
 *   - date in next line AND (dashSep OR suffix OR ALLCAPS OR titlecase-ish OR jobKeyword)
 *   - OR inline date + dashSep + (suffix OR jobKeyword OR ALLCAPS)
 *   - OR dashSep + suffix
 *   - OR dashSep + jobKeyword
 */
function looksLikeRoleHeaderLine(line: string, nextLine: string) {
  const l = (line || '').trim();
  const n = (nextLine || '').trim();

  if (!l) return false;
  if (isBulletLine(l)) return false;
  if (l.startsWith('(')) return false;
  if (/^[a-ząćęłńóśźż0-9]/.test(l)) return false;
  if (looksLikeActionSentence(l)) return false;
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

  // inline date headers: require more than “pipe + date”
  if (dateInline && dashSep) return co || job || caps;
  if (dashSep && co) return true;
  if (dashSep && job) return true;

  // allow headers without explicit dates (ECOM regression): dashSep + (suffix OR job)
  if (dashSep && (co || job || caps) && l.length <= 180) return true;

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

function parseExperienceIntoRoleBlocks(input: string): ParsedRoleBlock[] {
  const text = preprocessCvSource((input || '').trim());
  if (!text) return [];

  const lines = normalizeNewlines(text).split('\n').map((l) => l.trimEnd());

  const blocks: ParsedRoleBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const lineRaw = (lines[i] || '').trim();
    const nextRaw = (lines[i + 1] || '').trim();

    // Try inline header split first (Role ... 2020 – present body)
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

    // If next line contains date range (even with company/location), attach as datesLine
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
  return /Już wiem, co poprawić/i.test(text) && /Wpisz numer:/i.test(text);
}
function auditHasNumbering(text: string) {
  return /^\s*\d{1,2}[.)]\s+/m.test(text);
}
function countAuditRoles(text: string) {
  return (text.match(/^\s*\d{1,2}[.)]\s+/gm) || []).length;
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

function extractRolesFromCvText(cvText: string): Role[] {
  const t = preprocessCvSource(cvText || '');
  if (!t) return [];

  const blocks = parseExperienceIntoRoleBlocks(t);
  if (!blocks.length) return [];

  const roles = blocks.map((b) => {
    const dates =
      extractDatesFromLine(b.datesLine) ||
      extractDatesFromLine(b.titleLine) ||
      b.datesLine.trim() ||
      'daty do uzupełnienia';

    return {
      title: b.titleLine.trim(),
      dates,
    };
  });

  return dedupeRoles(roles).slice(0, 8);
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
 *  - IMPORTANT: ignore dates so they don’t look like “scale/result numbers”
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

function hasAnyNumber(text: string) {
  const t = stripDateNoise(text || '');
  return /(\d+(?:[.,]\d+)?)/.test(t);
}

function hasActionsSignal(text: string) {
  const raw = preprocessCvSource(text || '');
  const t = stripDateNoise(raw).toLowerCase();

  const verb = /(zarządza|zarzadz|prowadzi|koordyn|wdra|optymaliz|analiz|monitor|negocj|sprzeda|pozysk|raport|audyt|tworz|zbudow|ustaw|konfigur|standaryz|automatyz|planow|priorytet|manage|led|deliver|own|build|optimi[sz]e|analy[sz]e|report|coordinate|implement)/i.test(
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

function hasBaselineContextSignal(text: string) {
  const t = stripDateNoise(text || '').toLowerCase();
  return /(yoy|mom|qoq|vs\.?|wzrost|spadek|z\s+\d|do\s+\d|baseline|benchmark|poprzedn|wcześniej|uprzednio)/i.test(t);
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
  const t = `${roleTitle}\n${allText}`.toLowerCase();

  const strong =
    /(lead|leady|pipeline|prospect|inbound|outbound|cold call|coldcall|bd\b|business development|account(?!ing)|kandydat|rekrut|recruit|hiring|partner|deal|negocj|umow)/i.test(
      t
    );

  const salesOnly = /\bsprzeda\w*\b/i.test(t);
  const salesPlus = salesOnly && /(lead|pipeline|prospect|inbound|outbound|account|bd|deal|pozyskiw|pozyskanie|negocj|umow)/i.test(t);

  return strong || salesPlus;
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

  // context is “nice-to-have”, but ONLY when there is real non-date number
  const missingContext = hasAnyNumber(block) && !hasBaselineContextSignal(block);

  const missingParts: string[] = [];
  if (missingResult) missingParts.push('wynik/proxy (metryka)');
  if (missingScale) missingParts.push('skala (1 liczba/widełki)');
  if (missingActions) missingParts.push('konkret działań (2–3)');
  if (missingProcess) missingParts.push('proces (2–4 etapy)');
  if (!missingResult && !missingScale && !missingActions && missingContext) missingParts.push('kontekst wyniku (baseline/zmiana)');

  const summary =
    missingParts.length === 0
      ? 'nic krytycznego — można od razu zrobić mocny rewrite'
      : missingParts.join(', ');

  return { missingActions, missingScale, missingResult, missingProcess, missingContext, summary } as RoleMissing;
}

/** =========================
 *  Role block extraction
 *  ========================= */
function extractRoleBlock(cvText: string, titleLine: string) {
  const t = preprocessCvSource(cvText || '');
  if (!t.trim() || !titleLine.trim()) return '';

  const blocks = parseExperienceIntoRoleBlocks(t);
  if (!blocks.length) return '';

  const want = keyify(titleLine);

  const exact = blocks.find((b) => keyify(b.titleLine) === want);
  if (exact) return exact.raw;

  const partial = blocks.filter((b) => {
    const k = keyify(b.titleLine);
    return k.includes(want) || want.includes(k);
  });
  if (partial.length === 1) return partial[0].raw;

  const wantTitleOnly = keyify(splitTitleCompany(titleLine).title);
  const byTitle = blocks.filter((b) => keyify(b.title) === wantTitleOnly);
  if (byTitle.length === 1) return byTitle[0].raw;

  return '';
}

/** =========================
 *  Audit builder (improved)
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
 *  Interview logic (fixed loops + better kind inference)
 *  ========================= */
function isJustNumberChoice(text: string) {
  return /^\s*\d{1,2}\s*$/.test((text || '').trim());
}

function userCannotShare(text: string) {
  const t = (text || '').toLowerCase();
  return /(nie mogę|nie moge|nie mogę podać|nie moge podac|poufne|confidential|nie mogę dzielić|nie moge dzielic)/i.test(t);
}

function userNonAnswer(text: string) {
  const t = (text || '').trim().toLowerCase();
  if (!t) return true;

  const nonAnswers = new Set([
    'nie pamiętam',
    'nie pamietam',
    'nie wiem',
    'brak',
    'brak danych',
    'n/a',
    'na',
    '—',
    '-',
    '?',
    '???',
  ]);

  return nonAnswers.has(t) || t.length <= 3;
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
};

function extractInterviewFactsFromText(text: string): InterviewFacts {
  const joined = preprocessCvSource(text || '');
  const stripped = stripDateNoise(joined);
  return {
    hasActions: hasActionsSignal(stripped),
    hasScale: hasScaleSignal(stripped),
    hasProcess: hasAcquisitionProcessSignal(stripped),
    hasResult: hasResultSignal(stripped),
  };
}

type QuestionKind = 'ACTIONS' | 'SCALE' | 'PROCESS' | 'RESULT';

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

function inferQuestionKindFromAssistant(text: string): QuestionKind | null {
  const t = normalizeNewlines(text || '').toLowerCase();

  if (t.includes('co konkretnie') && t.includes('2–3') && t.includes('dział')) return 'ACTIONS';
  if (t.includes('jaka była skala') || t.includes('widełk') || t.includes('wolumen') || t.includes('liczba osób')) return 'SCALE';
  if (t.includes('proces pozyskania') || (t.includes('2–4') && t.includes('etap') && t.includes('finaliz'))) return 'PROCESS';

  // RESULT: detect both normal and SAFE variants
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

function computeInterviewState(messages: Message[], startIdx: number): InterviewState {
  const askedCounts: Record<QuestionKind, number> = { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0 };
  const declinedCounts: Record<QuestionKind, number> = { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0 };

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

function decideNextInterviewStep(
  shouldAskProcess: boolean,
  facts: InterviewFacts,
  state: InterviewState
) {
  const maxQuestions = 6;

  if (state.askedTotal >= maxQuestions) return { kind: 'REWRITE' as const };

  const declined = (k: QuestionKind) => state.declinedCounts[k] >= 1 || state.askedCounts[k] >= 2;

  if (!facts.hasActions && !declined('ACTIONS')) return { kind: 'ASK' as const, question: Q1, qk: 'ACTIONS' as const };
  if (!facts.hasScale && !declined('SCALE')) return { kind: 'ASK' as const, question: Q2, qk: 'SCALE' as const };
  if (shouldAskProcess && !facts.hasProcess && !declined('PROCESS'))
    return { kind: 'ASK' as const, question: Q_PROCESS, qk: 'PROCESS' as const };
  if (!facts.hasResult && !declined('RESULT')) return { kind: 'ASK' as const, question: Q_RESULT, qk: 'RESULT' as const };

  return { kind: 'REWRITE' as const };
}

/** =========================
 *  NEW: deterministic hints based on role text (no model)
 *  ========================= */
function buildHintForQuestion(kind: QuestionKind, roleText: string) {
  const t = preprocessCvSource(roleText || '').toLowerCase();

  const hints: string[] = [];

  if (kind === 'SCALE') {
    if (/(zesp[oó]ł|team)/i.test(t)) hints.push('liczba osób w zespole');
    if (/(bud[żz]et|budget|cost)/i.test(t)) hints.push('budżet / widełki');
    if (/(projekt|project)/i.test(t)) hints.push('liczba projektów');
    if (/(stakeholder|interesariusz)/i.test(t)) hints.push('liczba interesariuszy');
    if (/(zgłosze|incydent|ticket|case)/i.test(t)) hints.push('liczba zgłoszeń/incydentów (np. /tydz.)');
    if (/(shopify|allegro|amazon|marketplace|listing|sku|ofert)/i.test(t)) hints.push('wolumen: liczba listingów/ofert/SKU');
  }

  if (kind === 'RESULT') {
    if (/(oszcz[ęe]d|savings|redukc)/i.test(t)) hints.push('oszczędności / redukcja kosztów');
    if (/(terminow|delay|op[oó][źz]n|sla)/i.test(t)) hints.push('terminowość / SLA / mniej opóźnień');
    if (/(b[łl][ęe]d|incydent|reklamac|error|issue)/i.test(t)) hints.push('mniej błędów/incydentów/reklamacji');
    if (/(shopify|ga4|ctr|cr\b|cvr\b|aov\b|ltv\b|cac\b|roas|acos)/i.test(t))
      hints.push('metryki e-commerce: CR/CTR/AOV/LTV/CAC/ROAS (jeśli masz)');
  }

  if (kind === 'PROCESS') {
    if (/(cold call|coldcall|linkedin|lead|www|formularz|outbound|inbound)/i.test(t))
      hints.push('kanały: cold call / inbound z www / LinkedIn + 2–4 etapy');
  }

  if (!hints.length) return '';
  return `Podpowiedź (na bazie opisu): ${hints.join(', ')}.`;
}

/** =========================
 *  Rewrite guard utils (plus bullet dedupe)
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
  const suspicious = gotRaw.filter((n) => !allowed.has(n) && !allowed.has(n.replace(/,/g, '.')) && !allowed.has(n.replace(/\./g, ',')));
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

  const killMetaBullets = [
    /^\s*-?\s*Doprecyzuj.*$/gim,
    /^\s*-?\s*Dodaj.*$/gim,
  ];
  for (const re of killMetaBullets) t = t.replace(re, '');

  const killPhrases = [
    /zgodnie z opisem w before\.?/gi,
    /z twoich danych:?/gi,
    /jeśli dotyczy\.?/gi,
    /skala\s*:\s*/gi,
  ];
  for (const re of killPhrases) t = t.replace(re, '');

  return t;
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

function enforceDashBulletsStrict(text: string) {
  const lines = normalizeNewlines(text).split('\n');
  const out: string[] = [];
  let mode: 'NONE' | 'A' | 'B' = 'NONE';

  for (const raw of lines) {
    const l = raw.trimEnd();
    const t = l.trim();

    if (/^Wersja A \(bezpieczna\):/i.test(t)) {
      mode = 'A';
      out.push('Wersja A (bezpieczna):');
      continue;
    }
    if (/^Wersja B \(mocniejsza\):/i.test(t)) {
      mode = 'B';
      out.push('Wersja B (mocniejsza):');
      continue;
    }
    if (/^===\s*(BEFORE|AFTER)/i.test(t)) {
      mode = 'NONE';
      out.push(t);
      continue;
    }
    if (/^Chcesz poprawić kolejną rolę\?/i.test(t)) {
      mode = 'NONE';
      out.push('Chcesz poprawić kolejną rolę?');
      continue;
    }

    if (mode === 'A' || mode === 'B') {
      if (!t) continue;
      if (/^(doprecyzuj|dodaj)\b/i.test(t)) continue;
      out.push(`- ${t.replace(/^-+\s*/g, '')}`);
      continue;
    }

    out.push(l);
  }

  return out.join('\n');
}

function dedupeBulletsInAB(text: string) {
  const lines = normalizeNewlines(text).split('\n');
  const out: string[] = [];

  let mode: 'NONE' | 'A' | 'B' = 'NONE';
  const seenA = new Set<string>();
  const seenB = new Set<string>();

  const normBullet = (s: string) =>
    s.replace(/^\s*-\s*/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

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

function ensureRewriteCta(text: string) {
  let t = normalizeNewlines(text).trim();
  t = t.replace(/\s*Chcesz poprawić kolejną rolę\?\s*/gi, '\n');
  t = dedupeConsecutiveLines(t);
  t = t.trim();
  return `${t}\nChcesz poprawić kolejną rolę?`.trim();
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
 *  OpenAI call (better error + timeout)
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

/** =========================
 *  POST handler
 *  ========================= */
export async function POST(req: NextRequest) {
  try {
    const body: RequestBody = await req.json();
    const { messages, cvText, selectedRoleTitle } = body;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Messages array is required' }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key not configured. Please add OPENAI_API_KEY to your .env file.' },
        { status: 500 }
      );
    }

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const modelRewrite = process.env.OPENAI_MODEL_REWRITE || model;

    const cvTextEffective = buildCvTextEffective(cvText, messages);
    const mode = detectMode(messages, cvTextEffective);

    // === AUDIT_ONLY ===
    if (mode === 'AUDIT_ONLY') {
      const firstUser = preprocessCvSource(messages.find((m) => m.role === 'user')?.content || '');
      const effective = cvTextEffective || firstUser;

      const roles = dedupeRoles(extractRolesFromCvText(effective));

      if (roles.length === 1) {
        const roleTitle = roles[0].title;
        const roleBlock = extractRoleBlock(effective, roleTitle) || effective;
        const allText = `${roleBlock}\n${effective}`;

        const factsFromRole = extractInterviewFactsFromText(roleBlock);
        const shouldProcess = shouldAskAcquisitionProcess(roleTitle, allText);
        const state: InterviewState = {
          askedCounts: { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0 },
          declinedCounts: { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0 },
          askedTotal: 0,
        };

        const step = decideNextInterviewStep(shouldProcess, factsFromRole, state);
        const q = step.kind === 'ASK' ? step.question : Q_RESULT;

        const hint = step.kind === 'ASK' ? buildHintForQuestion(step.qk, roleBlock) : '';
        const msg = `Ok, w takim razie zacznijmy od „${roleTitle}”. ${q}${hint ? `\n${hint}` : ''}`;
        return NextResponse.json({ assistantText: normalizeForUI(msg, 1) });
      }

      const audit = buildAudit(effective);
      return NextResponse.json({ assistantText: normalizeForUI(audit, 1) });
    }

    // === NORMAL ===
    const lastUser = preprocessCvSource(messages.slice().reverse().find((m) => m.role === 'user')?.content || '');
    const lastAssistant = messages.slice().reverse().find((m) => m.role === 'assistant')?.content || '';

    const assistantWasAudit = isAudit(lastAssistant) && auditHasNumbering(lastAssistant);
    const rolesInAudit = assistantWasAudit ? countAuditRoles(lastAssistant) : 0;

    const chosenNum = assistantWasAudit ? extractChosenNumber(lastUser, 20) : null;

    let chosenRoleTitle = '';
    if (assistantWasAudit && chosenNum === null) {
      const titles = extractAllRoleTitlesFromAudit(lastAssistant);
      const uKey = keyify(lastUser);
      const hit = titles.find((t) => (uKey && keyify(t).includes(uKey)) || uKey.includes(keyify(t)));
      if (hit) chosenRoleTitle = hit;
    }
    if (assistantWasAudit && chosenNum !== null) {
      chosenRoleTitle = extractRoleTitleFromAuditByNumber(lastAssistant, chosenNum);
    }

    if (assistantWasAudit && !chosenRoleTitle) {
      const msg = rolesInAudit > 0 ? `Wybierz numer roli: 1–${rolesInAudit}` : 'Wybierz numer roli z listy.';
      return NextResponse.json({ assistantText: normalizeForUI(msg, 1) });
    }

    const assistantWasRewrite = isRewrite(lastAssistant);
    const continueNextRole = assistantWasRewrite && userWantsContinueAfterRewrite(lastUser);

    const rolesFromCv = dedupeRoles(extractRolesFromCvText(cvTextEffective || ''));

    const processedKeys = getProcessedRoleKeys(messages);
    const nextRoleTitle = continueNextRole ? findNextUnprocessedRoleTitle(rolesFromCv, processedKeys) : '';
    const hasNextRole = continueNextRole && !!nextRoleTitle;

    if (continueNextRole && !hasNextRole) {
      const msg =
        rolesFromCv.length === 0
          ? 'Ok. Wklej proszę sekcję „Doświadczenie” (stanowiska + opisy).'
          : 'Ok. Przerobiliśmy już wszystkie role, które wkleiłeś. Wklej kolejne stanowisko, a lecimy dalej.';
      return NextResponse.json({ assistantText: normalizeForUI(msg, 1) });
    }

    const roleFromClientResolved = resolveSelectedRoleTitle((selectedRoleTitle || '').trim(), rolesFromCv);
    const roleFromHistory = findLastRoleTitleInConversation(messages);
    const roleFallbackFromCv = rolesFromCv[0]?.title || '';

    const roleTitleForTurn =
      (hasNextRole && nextRoleTitle) ||
      chosenRoleTitle ||
      roleFromClientResolved ||
      roleFromHistory ||
      roleFallbackFromCv ||
      'WYBRANA ROLA';

    const startingNextRoleNow = hasNextRole;
    const startingChosenRoleNow = assistantWasAudit && !!chosenRoleTitle;

    const interviewStartIdxBase = findInterviewStartIndex(messages);
    const interviewStartIdx = startingNextRoleNow || startingChosenRoleNow ? messages.length : interviewStartIdxBase;

    const userFactsText = preprocessCvSource(collectUserAnswers(messages, interviewStartIdx).join('\n'));
    const roleBlock = extractRoleBlock(cvTextEffective || '', roleTitleForTurn);
    const roleBlockText = preprocessCvSource(roleBlock || '');

    const allUserTextForHeuristics = preprocessCvSource(
      messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
    );

    const shouldAskProcess = shouldAskAcquisitionProcess(roleTitleForTurn, `${roleBlockText}\n${allUserTextForHeuristics}`);

    const factsFromRole = extractInterviewFactsFromText(roleBlockText);
    const factsFromUser = extractInterviewFactsFromText(userFactsText);

    const facts: InterviewFacts = {
      hasActions: factsFromRole.hasActions || factsFromUser.hasActions,
      hasScale: factsFromRole.hasScale || factsFromUser.hasScale,
      hasProcess: factsFromRole.hasProcess || factsFromUser.hasProcess,
      hasResult: factsFromRole.hasResult || factsFromUser.hasResult,
    };

    const state =
      startingNextRoleNow || startingChosenRoleNow
        ? {
            askedCounts: { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0 },
            declinedCounts: { ACTIONS: 0, SCALE: 0, PROCESS: 0, RESULT: 0 },
            askedTotal: 0,
          }
        : computeInterviewState(messages, interviewStartIdx);

    const step = decideNextInterviewStep(shouldAskProcess, facts, state);

    if (step.kind === 'ASK') {
      let question = step.question;

      const cant = userCannotShare(lastUser) || userNonAnswer(lastUser);

      if (question === Q2 && cant) question = Q2_SAFE;
      if (question === Q_RESULT && cant) question = Q_RESULT_SAFE;

      const prefix = startingNextRoleNow
        ? `Ok, lecimy dalej — teraz „${roleTitleForTurn}”. `
        : startingChosenRoleNow
          ? `Ok, w takim razie zacznijmy od „${roleTitleForTurn}”. `
          : '';

      const hint = buildHintForQuestion(step.qk, roleBlockText || roleTitleForTurn);
      const deterministic = normalizeForUI(stripLeadingIndentAllLines(`${prefix}${question}${hint ? `\n${hint}` : ''}`), 1);
      return NextResponse.json({ assistantText: deterministic });
    }

    // === REWRITE ===
    const openAIMessages: Array<{ role: string; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: CONTEXT_PROMPT },
      {
        role: 'system',
        content:
          `Wygeneruj gotowy fragment DO WKLEJENIA DO CV (bez meta-komentarzy).\n` +
          `- Tylko rola: „${roleTitleForTurn}”.\n` +
          `- Popraw literówki z inputu (NIE zmieniaj liczb ani sensu faktów).\n` +
          `- Format musi być dokładnie:\n` +
          `=== BEFORE (${roleTitleForTurn}) ===\n(4–12 linii)\n=== AFTER (${roleTitleForTurn}) ===\n` +
          `Wersja A (bezpieczna):\n- ... (3–8 bulletów, 1 linia = 1 bullet)\n` +
          `Wersja B (mocniejsza):\n- ... (3–8 bulletów, 1 linia = 1 bullet)\n` +
          `Chcesz poprawić kolejną rolę?\n\n` +
          `Zasady:\n` +
          `- Każdy bullet zaczyna się od "- " i jest gotowy do CV.\n` +
          `- Wersja B MUSI różnić się od A (inna struktura + inne ujęcie, nie kopia).\n` +
          `- Zero meta-fraz typu: "zgodnie z opisem", "z Twoich danych", "jeśli dotyczy", "Skala:".\n` +
          `- Nie dodawaj faktów ani liczb, których użytkownik nie podał.\n` +
          `- NIE przenoś metryk między rolami (używaj tylko danych tej roli).\n` +
          `- Usuń twarde łamanie w środku zdań (hard-wrap).\n`,
      },
    ];

    const block = roleBlockText || preprocessCvSource(cvTextEffective || '');
    if (block.trim()) {
      openAIMessages.push({ role: 'user', content: `[WYBRANA ROLA — ŹRÓDŁO]\n${block}` });
    }
    if (userFactsText.trim()) {
      openAIMessages.push({ role: 'user', content: `[FAKTY OD UŻYTKOWNIKA — TYLKO DLA TEJ ROLI]\n${userFactsText}` });
    }

    let assistantText = '';
    try {
      assistantText = await callOpenAI(apiKey, modelRewrite, openAIMessages, 0.2);
    } catch (e: any) {
      const msg =
        `Błąd połączenia z OpenAI API: ${e?.message || 'fetch failed'}.\n` +
        `Jeśli uruchamiasz to w preview/webcontainer, możliwe że środowisko blokuje połączenia wychodzące.\n` +
        `Odpal lokalnie albo po deployu (np. Vercel) i spróbuj ponownie.`;
      return NextResponse.json({ assistantText: normalizeForUI(msg, 1) });
    }

    // === GUARD + FORMAT ===
    let allowedFacts = `${roleBlockText}\n\n${userFactsText}`.trim();
    if (!allowedFacts) allowedFacts = roleBlockText || preprocessCvSource(cvTextEffective || '');

    const finalize = (txt: string) => {
      let t = txt;
      t = stripFencedCodeBlock(t);
      t = stripLeadingIndentAllLines(t);
      t = enforceRewriteRoleHeaders(t, roleTitleForTurn);
      t = stripCvMetaAndFiller(t);
      t = repairRewriteBullets(t);
      t = enforceDashBulletsStrict(t);
      t = dedupeBulletsInAB(t);
      t = dedupeConsecutiveLines(t);
      t = ensureRewriteCta(t);
      t = normalizeForUI(t, 1);
      return t;
    };

    assistantText = finalize(assistantText);

    let needsFix =
      !rewriteLooksValid(assistantText) ||
      rewriteVersionsIdentical(assistantText) ||
      hasUnverifiedNumbers(assistantText, allowedFacts) ||
      hasBannedCausalPhrases(assistantText);

    // formatter tries (max 2)
    for (let attempt = 0; attempt < 2 && needsFix; attempt++) {
      const formatterMessages: Array<{ role: string; content: string }> = [
        {
          role: 'system',
          content:
            `Jesteś FORMATTEREM. Napraw tekst do formatu CV bez dodawania faktów.\n` +
            `- Tylko rola: "${roleTitleForTurn}".\n` +
            `- Wersja B musi różnić się od A.\n` +
            `- Zero meta.\n` +
            `- Nie dodawaj liczb spoza źródeł.\n` +
            `- A i B: 3–8 bulletów, każdy w 1 linii i zaczyna się od "- ".\n` +
            `- Usuń hard-wrap.\n` +
            `- Na końcu: Chcesz poprawić kolejną rolę?\n\n` +
            `Wymagany format:\n` +
            `=== BEFORE (${roleTitleForTurn}) ===\n` +
            `(4–12 linii)\n` +
            `=== AFTER (${roleTitleForTurn}) ===\n` +
            `Wersja A (bezpieczna):\n` +
            `- ...\n` +
            `Wersja B (mocniejsza):\n` +
            `- ...\n\n` +
            `Chcesz poprawić kolejną rolę?`,
        },
        { role: 'user', content: `Źródła faktów (tylko ta rola):\n${allowedFacts}\n\nTekst do naprawy:\n${assistantText}` },
      ];

      try {
        assistantText = await callOpenAI(apiKey, modelRewrite, formatterMessages, 0);
      } catch (e: any) {
        const msg = `Błąd połączenia z OpenAI API: ${e?.message || 'fetch failed'}. Spróbuj ponownie.`;
        return NextResponse.json({ assistantText: normalizeForUI(msg, 1) });
      }

      assistantText = finalize(assistantText);

      needsFix =
        !rewriteLooksValid(assistantText) ||
        rewriteVersionsIdentical(assistantText) ||
        hasUnverifiedNumbers(assistantText, allowedFacts) ||
        hasBannedCausalPhrases(assistantText);
    }

    if (needsFix) {
      const msg =
        `Nie udało się wygenerować stabilnego rewritu w wymaganym formacie (guard fail).\n` +
        `Wyślij jeszcze raz tę samą wiadomość albo wklej 1–2 konkrety (actions/scale/result), żeby model miał mocniejszy kontekst.`;
      return NextResponse.json({ assistantText: normalizeForUI(msg, 1) });
    }

    return NextResponse.json({ assistantText });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'An unexpected error occurred. Please try again.';
    console.error('Chat API error:', error);
    return NextResponse.json({ error: `Server error: ${msg}` }, { status: 500 });
  }
}

