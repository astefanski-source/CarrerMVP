import { NextRequest, NextResponse } from 'next/server';
import { SYSTEM_PROMPT, CONTEXT_PROMPT } from '@/lib/prompts';

export const runtime = 'nodejs';

/** =========================
 * Types
 * ========================= */
type Role = 'user' | 'assistant';

interface Message {
  role: Role;
  content: string;
}

interface RequestBody {
  messages: Message[];
  cvText?: string;
  selectedRoleTitle?: string;
}

type QuestionKind = 'ACTIONS' | 'SCALE' | 'RESULT';

type RoleItem = {
  title: string;
  headerLine: string;
  startLine: number;
  endLine: number;
};

/** =========================
 * POST
 * ========================= */
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
    const selectedFromBody = selectedRoleTitleFromBody ? String(selectedRoleTitleFromBody) : '';

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key not configured. Please add OPENAI_API_KEY to your .env file.' },
        { status: 500 }
      );
    }

    const modelRewrite = process.env.OPENAI_MODEL_REWRITE || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const lastUser = lastText(messages, 'user');
    const lastAssistant = lastText(messages, 'assistant');

    const cvTextEffective = preprocessCvSource(
      (cvText && String(cvText)) ||
      (pickBestCvChunkFromMessages(messages) || '')
    );

    // ANALIZA RÓL
    const doneRoles = extractDoneRoles(messages);
    const allRoles = dedupeRoles(extractRolesFromCvText(cvTextEffective));
    const roles = allRoles.slice(0, 3); // Max 3 role dla MVP

    // 0. Brak CV -> Instrukcja
    if (!cvTextEffective || roles.length === 0) {
      return NextResponse.json({
        assistantText: normalizeForUI(
          [
            `Gotowy na dopracowanie CV? 🚀 `,
            `Wklej sekcję „Doświadczenie” (stanowiska + opisy), a ja zrobię szybki audyt i dopytam o konkrety, żeby zamienić ogólniki w mocny opis.`,
            `Uwaga: w tej wersji MVP pracujemy tylko na Doświadczeniu.`,
          ].join('\n'),
          1
        ),
      });
    }

    // 1. CTA: "Chcesz poprawić kolejną rolę?" -> TAK
    if (looksLikeRewriteCta(lastAssistant) && isYes(lastUser)) {
      const remaining = roles.filter((r) => !doneRoles.has(r.title));
      if (remaining.length === 0) {
        return NextResponse.json({
          assistantText: normalizeForUI(
            `Ok. Przerobiliśmy już wszystkie role. Wklej kolejne stanowisko, a lecimy dalej.`,
            1
          ),
        });
      }
      // Automatycznie ustawiamy kolejną rolę jako aktywną
      // Nie zwracamy tekstu, tylko puszczamy kod dalej, żeby od razu zadał pytanie lub zrobił rewrite
      // W tym celu musimy zmodyfikować activeRoleTitle poniżej.
    }

    // USTALANIE AKTYWNEJ ROLI (Priorytetowe)
    let activeRoleTitle = '';

    // A. Czy user wybrał numer? (np. "1")
    if (looksLikeRoleChoicePrompt(lastAssistant)) {
      const idx = parseChoiceIndex(lastUser);
      if (idx != null && idx >= 1 && idx <= roles.length) {
        activeRoleTitle = roles[idx - 1].title;
      } else {
        // Zły numer -> Pokaż Audyt ponownie
        return NextResponse.json({ assistantText: normalizeForUI(buildAudit(roles, cvTextEffective), 1) });
      }
    }

    // B. Jeśli to CTA "Kolejna rola?" + TAK -> bierzemy pierwszą nieprzerobioną
    if (!activeRoleTitle && looksLikeRewriteCta(lastAssistant) && isYes(lastUser)) {
       const remaining = roles.filter((r) => !doneRoles.has(r.title));
       if (remaining.length > 0) activeRoleTitle = remaining[0].title;
    }

    // C. Próba ustalenia z historii czatu
    if (!activeRoleTitle) {
      activeRoleTitle = inferActiveRoleTitleFromChat(messages);
    }

    // D. Jeśli jest tylko 1 rola w CV i nie przerobiona -> to ona jest aktywna
    if (!activeRoleTitle && roles.length === 1 && !doneRoles.has(roles[0].title)) {
      activeRoleTitle = roles[0].title;
    }

    // JEŚLI NADAL BRAK ROLI -> POKAŻ AUDYT (Wybór roli)
    if (!activeRoleTitle || (activeRoleTitle && doneRoles.has(activeRoleTitle))) {
       // Chyba że user właśnie wkleił CV (lastUserLooksLikeCvPaste), wtedy zawsze Audyt
       return NextResponse.json({ assistantText: normalizeForUI(buildAudit(roles, cvTextEffective), 1) });
    }

    // ==========================================
    // GŁÓWNA LOGIKA: PYTANIE vs REWRITE
    // ==========================================
    const activeRole = roles.find((r) => eqRole(r.title, activeRoleTitle)) || roles[0];
    const roleBlockText = preprocessCvSource(extractRoleBlock(cvTextEffective, activeRole.title) || activeRole.headerLine);
    
    // Resetujemy stan pytań dla nowej roli (chyba że już o nią pytaliśmy)
    const alreadyStarted = findRoleStartIndex(messages, activeRole.title) > 0;
    const state = computeRoleState(messages, activeRole.title);
    const userFacts = buildUserFactsFromRoleConversation(messages, activeRole.title);

    // 1. BRAKI
    const { missing, notes } = computeMissing(roleBlockText, userFacts);

    // 2. CZY PYTAĆ?
    const nextQ = pickNextQuestion({ missing, notes }, state);
    
    // Sprawdź czy user nie odmówił (Decline)
    const lastAskedKind = inferLastAskedKind(lastAssistant);
    const lastUserRaw = String(messages[messages.length - 1]?.content ?? '');
    const userDeclined = looksLikeDeclineAnswer(lastUserRaw);

    if (userDeclined && (lastAskedKind === 'SCALE' || lastAskedKind === 'RESULT')) {
        const profile = getRoleProfile(activeRole.title, roleBlockText);
        const followup = buildProxyFollowup(lastAskedKind, profile);
        return NextResponse.json({ assistantText: normalizeForUI(followup, 1) });
    }

    // JEŚLI MAMY PYTANIE -> ZADAJ JE
    if (nextQ) {
      const profile = getRoleProfile(activeRole.title, roleBlockText);
      let examples = "";
      let questionText = "";

      if (nextQ === 'RESULT') {
        if (profile === 'SUPPORT') examples = "np. SLA, czas obsługi (AHT), satysfakcja (CSAT), redukcja błędów";
        else if (profile === 'TECH') examples = "np. uptime, czas wdrożenia, wydajność systemu, brak incydentów";
        else examples = "np. ROAS, realizacja celu %, wzrost przychodów, liczba leadów";
        questionText = `Jaki był efekt Twoich działań? Podaj 1–2 twarde wyniki (${examples}).`;
      }
      else if (nextQ === 'SCALE') {
        if (profile === 'SUPPORT') examples = "np. #zgłoszeń/mies., wielkość zespołu, wolumen faktur";
        else if (profile === 'TECH') examples = "np. wielkość bazy danych, #użytkowników, RPS";
        else examples = "np. budżet miesięczny, #leadów/tydz., wielkość pipeline'u";
        questionText = `W jakiej skali działałeś? Podaj 1–2 liczby (${examples}).`;
      }
      else {
        questionText = "W opisie brakuje Twojej bezpośredniej sprawczości. Co dokładnie należało do Twoich zadań, za które brałeś pełną odpowiedzialność?";
      }

      // Jeśli to pierwsze pytanie dla tej roli, dodaj intro
      const intro = alreadyStarted ? '' : `Ok, w takim razie zacznijmy od „${activeRole.title}”.\n\n`;

      return NextResponse.json({
        assistantText: normalizeForUI(`${intro}${questionText}`, 1),
      });
    }

    // 3. JEŚLI NIE MA PYTAŃ -> NATYCHMIASTOWY REWRITE
    // (Tu trafiamy od razu, jeśli nextQ jest null - bez etapu "Lecimy")
    
    const factsText = preprocessCvSource(
      [
        userFacts.ACTIONS ? `ACTIONS: ${userFacts.ACTIONS}` : '',
        userFacts.SCALE ? `SCALE: ${userFacts.SCALE}` : '',
        userFacts.RESULT ? `RESULT: ${userFacts.RESULT}` : '',
      ]
      .filter(Boolean)
      .join('\n')
    );

    const allowedFacts = preprocessCvSource(`${roleBlockText}\n${factsText}`);
    const userPrompt = buildRewritePrompt(activeRole.title, roleBlockText, factsText);

    let llmOut = '';
    try {
      llmOut = await callOpenAI(apiKey, modelRewrite, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ]);
    } catch {
      llmOut = '';
    }

    let out = cleanLlMOutput(llmOut);

    if (out) {
      out = enforceHeadersAndBullets(out, activeRole.title, roleBlockText);
      out = normalizeForUI(out, 1);
      
      const invalid = !rewriteLooksValid(out, activeRole.title) || hasBadArtifacts(out); 

      if (!invalid) {
        return NextResponse.json({ assistantText: out });
      }
    }

    // Fallback
    const fallback = buildDeterministicFallback(activeRole.title, roleBlockText, userFacts);
    const fallbackOut = normalizeForUI(fallback, 1);
    return NextResponse.json({ assistantText: fallbackOut });

  } catch (err: any) {
    const msg = err?.message ? String(err.message).slice(0, 300) : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** =========================
 * Validation
 * ========================= */
function validateRequestBody(raw: any): { ok: true; body: RequestBody } | { ok: false; error: string; status: number } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Invalid body', status: 400 };
  if (!Array.isArray(raw.messages)) return { ok: false, error: 'messages must be an array', status: 400 };
  const messages: Message[] = [];
  for (const m of raw.messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    const content = m.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue;
    messages.push({ role, content });
  }
  return { ok: true, body: { messages, cvText: raw.cvText, selectedRoleTitle: raw.selectedRoleTitle } };
}

/** =========================
 * Core helpers
 * ========================= */
function findCurrentRoleInHistory(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') {
      const match = m.content.match(/zaczni(?:j|my)\s+od\s+(?:„|")([^”"]+)(?:”|")/i);
      if (match) return match[1];
      const match2 = m.content.match(/bierzemy na warsztat kolejną rolę: ([^|]+)/);
      if (match2) return match2[1].trim();
    }
  }
  return '';
}

function getRoleProfile(title: string, text: string): 'BIZ' | 'TECH' | 'SUPPORT' {
  const combined = (title + ' ' + text).toLowerCase();
  
  // 1. TECH (Developerzy, Testerzy, Admini IT)
  // FIX: Usunięto ryzykowne słowa: system, data, analy, tech, test.
  // Dodano konkrety: tester, sql, linux, baza, kod, azure, aws.
  if (/\b(dev|software|engineer|tester|qa|it|cloud|python|java|programis|informatyk|sql|linux|azure|aws|baza|kod)/i.test(combined)) {
    return 'TECH';
  }

  // 2. SALES/BIZ (Tylko stricte sprzedażowe role)
  if (/\b(sprzeda|sales|handlow|b2b|account|revenue|target|przych|negocjac|prospect|lead|funnel|lejek)/i.test(combined)) {
    return 'BIZ';
  }
  
  // 3. SUPPORT (Admin, PM, Obsługa Klienta)
  // Tutaj wpada "Obsługa Klienta" (przez słowo obsługa/klient) oraz PM (project/koordynac)
  if (/\b(obsługa|klient|admin|biur|sekretariat|rezerwacj|wsparcie|support|helpdesk|office|dokument|asysten|recepcj|koordynac|project|projekt)/i.test(combined)) {
    return 'SUPPORT';
  }
  
  // 4. Fallback -> BIZ (Marketing, HR, Management ogólny)
  return 'BIZ';
}

function preprocessCvSource(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeForUI(text: string, _indent = 1): string {
  return preprocessCvSource(text);
}

function lastText(messages: Message[], role: Role): string {
  for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
    if (messages[i]?.role === role) return String(messages[i]?.content ?? '');
  }
  return '';
}

function pickBestCvChunkFromMessages(messages: Message[]): string {
  const users = (messages || []).filter((m) => m.role === 'user').map((m) => String(m.content ?? ''));
  let best = '';
  for (const u of users) {
    const s = preprocessCvSource(u);
    if (s.length < 120) continue;
    if (!looksLikeExperiencePaste(s)) continue;
    if (s.length > best.length) best = s;
  }
  return best;
}

function looksLikeExperiencePaste(text: string): boolean {
  const s = preprocessCvSource(text).toLowerCase();
  if (s.length < 120) return false;
  const hasDates = /\b(0?[1-9]|1[0-2])\.\d{4}\b/.test(s) || /\b(19|20)\d{2}\b/.test(s);
  const hasPipe = s.includes('|');
  const hasDash = s.includes(' - ') || s.includes('–') || s.includes('—');
  const hasBulletsOrLines = s.split('\n').length >= 3;
  return (hasDates && (hasPipe || hasDash) && hasBulletsOrLines) || (hasPipe && hasBulletsOrLines);
}

/** =========================
 * Role parsing
 * ========================= */
function extractRolesFromCvText(text: string): RoleItem[] {
  const lines = preprocessCvSource(text).split('\n').map((l) => l.trim());
  const roles: RoleItem[] = [];
  const isHeader = (l: string) => {
    if (!l) return false;
    const hasTitleDash = /.+\s-\s.+/.test(l);
    const hasPipe = l.includes('|');
    const hasDateSignal = /\b(0?[1-9]|1[0-2])\.\d{4}\b/.test(l) || /\bobecnie\b/i.test(l);
    return (hasTitleDash && (hasPipe || hasDateSignal)) || (hasPipe && hasDateSignal);
  };
  const headerIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHeader(lines[i])) headerIdxs.push(i);
  }
  for (let k = 0; k < headerIdxs.length; k++) {
    const start = headerIdxs[k];
    const end = (k + 1 < headerIdxs.length ? headerIdxs[k + 1] : lines.length) - 1;
    const headerLine = lines[start];
    const title = parseTitleFromHeader(headerLine) || headerLine.split('|')[0].trim();
    if (!title) continue;
    roles.push({ title: cleanupRoleTitle(title), headerLine, startLine: start, endLine: end });
  }
  if (roles.length === 0) {
    for (let i = 0; i < lines.length - 1; i++) {
      const l1 = lines[i];
      const l2 = lines[i + 1];
      if (!l1 || !l2) continue;
      const l2HasDates = l2.includes('|') && (/\b(0?[1-9]|1[0-2])\.\d{4}\b/.test(l2) || /\bobecnie\b/i.test(l2));
      const l1LooksLikeTitle = l1.length >= 6 && l1.length <= 80 && !l1.includes('|') && !/\d{4}/.test(l1);
      if (l1LooksLikeTitle && l2HasDates) {
        roles.push({
          title: cleanupRoleTitle(l1),
          headerLine: `${l1} - ${l2}`,
          startLine: i,
          endLine: i + 1,
        });
      }
    }
  }
  return roles;
}

function parseTitleFromHeader(headerLine: string): string {
  const s = headerLine;
  const dashIdx = s.indexOf(' - ');
  if (dashIdx > 0) return s.slice(0, dashIdx).trim();
  const pipeIdx = s.indexOf('|');
  if (pipeIdx > 0) return s.slice(0, pipeIdx).trim();
  return s.trim();
}

function cleanupRoleTitle(title: string): string {
  return title.replace(/\s{2,}/g, ' ').trim();
}

function dedupeRoles(roles: RoleItem[]): RoleItem[] {
  const seen = new Set<string>();
  const out: RoleItem[] = [];
  for (const r of roles) {
    const key = r.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function extractRoleBlock(fullText: string, roleTitle: string): string {
  const lines = preprocessCvSource(fullText).split('\n');
  const lowerTitle = roleTitle.toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (l.includes(lowerTitle)) {
      if (lines[i].includes('|') || lines[i].includes(' - ') || /\b(0?[1-9]|1[0-2])\.\d{4}\b/.test(lines[i])) {
        start = i;
        break;
      }
    }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const li = lines[i].trim();
    if (!li) continue;
    const looksLikeNextHeader =
      (li.includes(' - ') && li.includes('|')) ||
      (li.includes('|') && /\b(0?[1-9]|1[0-2])\.\d{4}\b/.test(li)) ||
      (li.includes('|') && /\bobecnie\b/i.test(li));
    if (looksLikeNextHeader) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

/** =========================
 * Audit output
 * ========================= */
function computeMissing(roleBlockText: string, userFacts: Partial<Record<QuestionKind, string>>): { missing: QuestionKind[]; notes: string[] } {
  const t = preprocessCvSource(roleBlockText).toLowerCase();
  const textNoDates = t
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/\b\d{1,2}\.\d{4}\b/g, '')
    .replace(/\b\d{1,2}\-\d{4}\b/g, '');
  const hasNum = /\d/.test(textNoDates);
  const hasScaleSignal = /\b(tydz|tydzień|tygodniowo|mies|miesięcznie|budżet|spend|pipeline|kampani|ofert|spotkan|lead|zgłosz|ticket|faktur|zespół|osób|klientów|wolumen)\b/i.test(t);
  const hasResultSignal =
    /\b(roas|cac|cpa|ctr|cr|ltv|mrr|arr|przych[oó]d|win rate|konwersj|nps|csat|sla|kpi|roi|marża|błędów|oszczędn|czas|efektywn)\b/i.test(t) ||
    /\b(wzrost|spadek|popraw|zwiększ|zmniejsz|skróc|zreduk|optymaliz)/i.test(t);
  const strongActionKeywords = /\b(pozyskiwan|prowadzen|wdroż|optymaliz|negocjac|tworzen|analiz|zarz[aą]dz|obsługa|wsparcie|przygotowywan|współpraca|koordynac|rozwój|budowan|sprzedaż|raportowan|testowan|programowan)\b/i.test(t);
  const actionsOk =
    !!(userFacts.ACTIONS && userFacts.ACTIONS.trim()) ||
    strongActionKeywords ||
    t.length > 60;
  const scaleOk = !!(userFacts.SCALE && userFacts.SCALE.trim()) || (hasNum && hasScaleSignal);
  const resultOk = !!(userFacts.RESULT && userFacts.RESULT.trim()) || (hasNum && hasResultSignal);
  const missing: QuestionKind[] = [];
  const notes: string[] = [];
  if (!resultOk) missing.push('RESULT');
  if (!scaleOk) missing.push('SCALE');
  if (!actionsOk) missing.push('ACTIONS');
  if (missing.includes('RESULT')) notes.push('braki: wynik/proxy (efekt pracy)');
  if (missing.includes('SCALE')) notes.push('braki: skala (liczby/wielkość)');
  if (missing.includes('ACTIONS')) notes.push('braki: konkrety (co dokładnie robiłeś)');
  return { missing, notes };
}

function buildAudit(roles: RoleItem[], fullText: string): string {
  const header = [
    `Cel: zamieniamy “obowiązki” na IMPACT.`,
    `W CV liczy się: co zrobiłeś (actions) • w jakiej skali (scale) • jaki efekt (result)`,
    ``,
    `Już wiem, co poprawić. Wybierz rolę do dopracowania:`,
    ``,
  ].join('\n');
  const lines: string[] = [header];
  roles.forEach((r, i) => {
    const block = preprocessCvSource(extractRoleBlock(fullText, r.title) || r.headerLine);
    const { notes } = computeMissing(block, {});
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(notes.length ? `   ${notes.join(' | ')}` : `   braki: (brak oczywistych)`);
    lines.push('');
  });
  lines.push(`Wpisz numer: 1–${roles.length}`);
  return lines.join('\n').trim();
}

/** =========================
 * Role progression
 * ========================= */
function extractDoneRoles(messages: Message[]): Set<string> {
  const done = new Set<string>();
  for (const m of messages || []) {
    if (m.role !== 'assistant') continue;
    const s = String(m.content ?? '');
    const match = s.match(/===\s*AFTER\s*\((.+?)\)\s*===/i);
    if (match?.[1]) done.add(match[1].trim());
  }
  return done;
}

function inferActiveRoleTitleFromChat(messages: Message[]): string {
  for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const s = String(m.content ?? '');
    const m1 = s.match(/zaczni(?:j|my)\s+od\s+„(.+?)”/i);
    if (m1?.[1]) return m1[1].trim();
    const m2 = s.match(/===\s*BEFORE\s*\((.+?)\)\s*===/i);
    if (m2?.[1]) return m2[1].trim();
  }
  return '';
}

function startRoleIntro(roleTitle: string): string {
  return `Ok, w takim razie zacznijmy od „${roleTitle}”.`;
}

function looksLikeRoleChoicePrompt(text: string): boolean {
  const s = String(text ?? '').toLowerCase();
  return s.includes('wybierz rol') || s.includes('wpisz numer');
}

function parseChoiceIndex(text: string): number | null {
  const s = String(text ?? '').trim();
  const m = s.match(/^(\d{1,2})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function looksLikeRewriteCta(text: string): boolean {
  const s = String(text ?? '').toLowerCase();
  return s.includes('chcesz poprawić kolejną rolę?');
}

function isYes(text: string): boolean {
  const s = String(text ?? '').trim().toLowerCase();
  return s === 'tak' || s === 't' || s === 'yes' || s === 'y' || s.includes('lecimy') || s.includes('dalej');
}

function looksLikeDeclineAnswer(text: string): boolean {
  const s = String(text ?? '').toLowerCase().trim();
  return (
    s === '?' ||
    s.includes('nie wiem') ||
    s.includes('brak danych') ||
    s.includes('nie pamiętam') ||
    s.includes('nie pamietam') ||
    s.includes('nie mogę podać') ||
    s.includes('nie moge podac') ||
    s.includes('nie podam') ||
    s.includes('n/a')
  );
}

function eqRole(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** =========================
 * Q/A state per role
 * ========================= */
function inferLastAskedKind(text: string): QuestionKind | null {
  const t = String(text ?? '').toLowerCase();
  if (t.includes('wybierz rolę') || t.includes('1 / 2 / 3') || t.includes('wybierz 1') || t.includes('wpisz numer')) {
    return null;
  }
  if (t.includes('co konkretnie ty zrobi') || t.includes('twoje działani')) return 'ACTIONS';
  if (t.includes('skal') || t.includes('ile tego') || t.includes('wolumen') || t.includes('budżet') || t.includes('#')) return 'SCALE';
  if (t.includes('efekt') || t.includes('wynik') || t.includes('kpi') || t.includes('roas') || t.includes('sla')) return 'RESULT';
  return null;
}

function computeRoleState(messages: Message[], roleTitle: string): { asked: Set<QuestionKind>; declined: Set<QuestionKind>; askedTotal: number } {
  const asked = new Set<QuestionKind>();
  const declined = new Set<QuestionKind>();
  const startIdx = findRoleStartIndex(messages, roleTitle);
  let lastAsked: QuestionKind | null = null;
  let askedTotal = 0;
  for (let i = startIdx; i < (messages?.length || 0); i++) {
    const m = messages[i];
    const role = m.role;
    const text = String(m.content ?? '');
    if (role === 'assistant') {
      const k = inferLastAskedKind(text);
      if (k) {
        asked.add(k);
        lastAsked = k;
        askedTotal += 1;
      } else {
        lastAsked = null;
      }
    }
    if (role === 'user') {
      if (lastAsked && looksLikeDeclineAnswer(text)) {
        declined.add(lastAsked);
        lastAsked = null;
      } else if (lastAsked) {
        lastAsked = null;
      }
    }
  }
  return { asked, declined, askedTotal };
}

function findRoleStartIndex(messages: Message[], roleTitle: string): number {
  for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const s = String(m.content ?? '');
    if (s.includes(`zaczni`) && s.includes(`„${roleTitle}”`)) return i;
  }
  return 0;
}

function buildUserFactsFromRoleConversation(messages: Message[], roleTitle: string): Partial<Record<QuestionKind, string>> {
  const startIdx = findRoleStartIndex(messages, roleTitle);
  const facts: Partial<Record<QuestionKind, string>> = {};
  let pending: QuestionKind | null = null;
  for (let i = startIdx; i < (messages?.length || 0); i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      pending = inferLastAskedKind(m.content);
    } else if (m.role === 'user') {
      if (pending) {
        const ans = preprocessCvSource(m.content);
        if (ans && !looksLikeDeclineAnswer(ans)) {
          if (!facts[pending]) facts[pending] = ans;
        }
        pending = null;
      }
    }
  }
  return facts;
}

/** =========================
 * Questions
 * ========================= */
function computeMissingKinds(roleBlockText: string, userFacts: Partial<Record<QuestionKind, string>>): QuestionKind[] {
  return computeMissing(roleBlockText, userFacts).missing;
}

function pickNextQuestion(
  missing: { missing: QuestionKind[]; notes: string[] },
  state: { asked: Set<QuestionKind>; declined: Set<QuestionKind>; askedTotal: number }
): QuestionKind | null {
  if ((state.askedTotal ?? 0) >= 4) return null;
  const order: QuestionKind[] = ['ACTIONS', 'SCALE', 'RESULT'];
  for (const k of order) {
    if (!missing.missing.includes(k)) continue;
    if (state.declined.has(k)) continue;
    if (state.asked.has(k)) continue;
    return k;
  }
  return null;
}

function buildFirstQuestionForRole(role: RoleItem, fullText: string): string {
  const roleBlockText = preprocessCvSource(extractRoleBlock(fullText, role.title) || role.headerLine);
  // POPRAWKA: Wymuszamy pusty stan dla pierwszego pytania nowej roli,
  // żeby uniknąć pobierania historii z poprzednich ról (bug "Mam już wszystko")
  const state = { asked: new Set<QuestionKind>(), declined: new Set<QuestionKind>(), askedTotal: 0 };
  const facts = {}; 
  const missing = computeMissing(roleBlockText, facts);
  const nextQ = pickNextQuestion(missing, state);

  if (!nextQ) return `Mam już wszystko do rewrite. Lecimy.`;
  const profile = getRoleProfile(role.title, roleBlockText);
  return buildQuestion(nextQ, profile);
}

function buildQuestion(kind: QuestionKind, profile: 'BIZ' | 'TECH' | 'SUPPORT'): string {
  switch (kind) {
    case 'ACTIONS':
      return `Co konkretnie Ty zrobiłeś w tej roli? Podaj 2–4 działania (czasowniki + obiekt), bez ogólników.`;
    case 'SCALE':
      if (profile === 'TECH') return `Podaj skalę: np. wielkość bazy danych, #użytkowników, RPS, liczba serwerów.`;
      if (profile === 'SUPPORT') return `Podaj skalę: np. #zgłoszeń/mies., wielkość zespołu, wolumen dokumentów dziennie.`;
      return `Podaj skalę: np. budżet (widełki), #leadów/mies., #ofert/tydz., #spotkań/mies.`;
    case 'RESULT':
      if (profile === 'TECH') return `Jaki był efekt? Podaj wyniki: np. uptime %, czas wdrożenia, wydajność systemu, brak incydentów.`;
      if (profile === 'SUPPORT') return `Jaki był efekt? Podaj wyniki: np. SLA, CSAT, czas obsługi (AHT), redukcja błędów.`;
      return `Jaki był efekt? Podaj wyniki: np. ROAS/CPA, przychód, win rate, realizacja celu %.`;
    default:
      return `Doprecyzuj proszę 1–2 kluczowe szczegóły.`;
  }
}

function buildProxyFollowup(kind: QuestionKind, profile: 'BIZ' | 'TECH' | 'SUPPORT'): string {
  const base = `OK — jeśli nie pamiętasz dokładnie, podaj rząd wielkości (widełki) albo proxy.`;
  if (kind === 'SCALE') {
    if (profile === 'TECH') {
      return [
        base,
        `Wystarczy: “mało/średnio/dużo” + przykład: #ticketów/tydz., #deploy/msc, #PR/tydz., #użytkowników.`,
        `Jak to szybko sprawdzić: Jira/GitHub (historia), Grafana/Datadog (ruch), backlog/board.`,
      ].join('\n');
    }
    if (profile === 'SUPPORT') {
      return [
        base,
        `Wystarczy: #zgłoszeń/dzień, #klientów/tydz., czas obsługi (AHT widełki).`,
        `Jak to szybko sprawdzić: system ticketowy (Zendesk/Freshdesk), raporty SLA, eksport CSV.`,
      ].join('\n');
    }
    return [
      base,
      `Wystarczy: #leadów/msc, #spotkań/msc, #ofert/tydz., budżet (widełki).`,
      `Jak to szybko sprawdzić: CRM (pipelines), Ads Manager (wydatki), arkusze sprzedażowe.`,
    ].join('\n');
  }
  // RESULT
  if (profile === 'TECH') {
    return [
      base,
      `Wystarczy trend/proxy: “spadek błędów”, “krótszy czas wdrożeń”, “mniej incydentów”, “lepsza wydajność”.`,
      `Jak to szybko sprawdzić: incidenty/monitoring, changelog release’ów, post-mortems.`,
    ].join('\n');
  }
  if (profile === 'SUPPORT') {
    return [
      base,
      `Wystarczy trend/proxy: CSAT/NPS (jeśli był), SLA, krótszy czas odpowiedzi, mniej eskalacji.`,
      `Jak to szybko sprawdzić: raporty SLA/CSAT w helpdesku, logi eskalacji.`,
    ].join('\n');
  }
  return [
    base,
    `Wystarczy trend/proxy: “więcej spotkań”, “wyższy win rate”, “lepszy ROAS/CPA”, “większy MRR” (choćby widełki).`,
    `Jak to szybko sprawdzić: CRM (win rate), Ads Manager/GA4, raporty sprzedaży.`,
  ].join('\n');
}

/** =========================
 * Rewrite prompt + LLM
 * ========================= */
function buildRewritePrompt(roleTitle: string, beforeText: string, userFactsText: string): string {
  const factsSection = userFactsText?.trim() ? userFactsText.trim() : '(brak)';
  return [
    CONTEXT_PROMPT,
    ``,
    `Zadanie: Jesteś ekspertim CV. Twoim celem jest przepisanie sekcji EXPERIENCE.`,
    `Masz oryginalny opis (BEFORE) oraz nowe konkrety od użytkownika (FAKTY).`,
    `Musisz POŁĄCZYĆ te informacje.`,
    ``,
    `Rola: ${roleTitle}`,
    ``,
    `BEFORE (Oryginał):`,
    beforeText,
    ``,
    `NOWE FAKTY OD USERA (Wpleć je w opis!):`,
    factsSection,
    ``,
    `Wymagany format WYJŚCIA (bez markdown):`,
    `=== BEFORE (${roleTitle}) ===`,
    `(wklej 1:1 treść BEFORE, max ~12 linii)`,
    `=== AFTER (${roleTitle}) ===`,
    `Wersja A (Uporządkowana):`,
    `- [Czasownik] + [Zadanie] + [Kontekst/Narzędzia]`,
    `- (Staraj się zachować oryginalne obowiązki, ale napisz je profesjonalnie)`,
    `Wersja B (Impact - z nowymi danymi):`,
    `- [Czasownik Aktywny] + [Co zrobiono] + [WYNIK/SKALA z sekcji Fakty]`,
    `- Jeśli user podał liczby (np. ROAS, budżet), MUSISZ je tutaj zawrzeć.`,
    ``,
    `Zasady krytyczne:`,
    `1. Jeśli user podał fakt (np. "ROAS 4.0"), to ten fakt MUSI znaleźć się w Wersji B połączony z odpowiednim obowiązkiem (np. "Prowadzenie kampanii Ads z ROAS 4.0...").`,
    `2. Nie wyrzucaj oryginalnych obowiązków, jeśli są istotne. Ulepsz je.`,
    `3. Minimum 2, maksimum 5 bulletów na wersję.`,
    `Zakończ linią: "Chcesz poprawić kolejną rolę?"`,
  ].join('\n');
}

async function callOpenAI(apiKey: string, model: string, messages: { role: 'system' | 'user'; content: string }[]) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI error: ${res.status}`);
  }
  const data: any = await res.json();
  const out = data?.choices?.[0]?.message?.content;
  return String(out ?? '');
}

/** =========================
 * Output cleaning + validation
 * ========================= */
function cleanLlMOutput(text: string): string {
  let out = String(text ?? '').trim();
  out = out.replace(/```[\s\S]*?```/g, '').trim();
  out = out.replace(/(^|\n)\s*-\s*Realizacja:\s*/g, '$1- ');
  out = out
    .split('\n')
    .filter((l) => !/^\s*(RESULT|BASELINE\/KONTEXT)\b/i.test(l.trim()))
    .join('\n')
    .trim();
  out = out.replace(/(^|\n)\s*•\s+/g, '$1- ');
  return out;
}

function enforceHeadersAndBullets(out: string, roleTitle: string, beforeText: string): string {
  const beforeHeader = `=== BEFORE (${roleTitle}) ===`;
  const afterHeader = `=== AFTER (${roleTitle}) ===`;
  let body = out;
  if (!new RegExp(escapeRegex(afterHeader), 'i').test(body)) {
    return '';
  }
  const afterIdx = body.toLowerCase().indexOf(afterHeader.toLowerCase());
  const afterPart = body.slice(afterIdx);
  const rebuilt = [
    beforeHeader,
    preprocessCvSource(beforeText).split('\n').slice(0, 12).join('\n'),
    '',
    afterPart.trim(),
  ].join('\n');
  return rebuilt.replace(/(^|\n)\s*•\s+/g, '$1- ').trim();
}

function rewriteLooksValid(out: string, roleTitle: string): boolean {
  const hasHeaders =
    new RegExp(`===\\s*BEFORE\\s*\\(${escapeRegex(roleTitle)}\\)\\s*===`, 'i').test(out) &&
    new RegExp(`===\\s*AFTER\\s*\\(${escapeRegex(roleTitle)}\\)\\s*===`, 'i').test(out);
  const hasA = /Wersja A/i.test(out);
  const hasB = /Wersja B/i.test(out);
  const aBullets = [...baseBullets, ...fromBefore.map((l) => `- ${l}`)].slice(0, 6);
  const bBullets = extractBulletsFromSection(out, 'B');
  return hasHeaders && hasA && hasB && aBullets.length >= 2 && bBullets.length >= 2 && out.includes('Chcesz poprawić kolejną rolę?');
}

function extractBulletsFromSection(out: string, which: 'A' | 'B'): string[] {
  const s = out.split('\n');
  let inSection = false;
  const bullets: string[] = [];
  for (const line of s) {
    const l = line.trim();
    if (/^Wersja A/i.test(l)) inSection = which === 'A';
    if (/^Wersja B/i.test(l)) inSection = which === 'B';
    if (inSection && l.startsWith('- ')) bullets.push(l);
  }
  return bullets;
}

function hasBadArtifacts(out: string): boolean {
  const s = out.toLowerCase();
  return s.includes('baseline/kontekst') || s.includes('realizacja:') || s.includes('z ostatniej odpowiedzi usera');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** =========================
 * Deterministic fallback
 * ========================= */
function buildDeterministicFallback(roleTitle: string, beforeText: string, facts: Partial<Record<QuestionKind, string>>): string {
  const beforeHeader = `=== BEFORE (${roleTitle}) ===`;
  const afterHeader = `=== AFTER (${roleTitle}) ===`;
  const lines = preprocessCvSource(beforeText).split('\n').filter(Boolean);

  const verbify = (x: string) =>
    x
      .replace(/^Pozyskiwanie/i, 'Pozyskiwałem')
      .replace(/^Prowadzenie/i, 'Prowadziłem')
      .replace(/^Realizowanie/i, 'Realizowałem')
      .replace(/^Wsparcie/i, 'Wspierałem')
      .replace(/^Obsługa/i, 'Obsługiwałem')
      .replace(/^Tworzenie/i, 'Tworzyłem')
      .replace(/^Udział/i, 'Uczestniczyłem w')
      .trim();

  // FIX: Definiujemy baseBullets TUTAJ, żeby były dostępne dla aBullets
  const baseBullets = [
    facts.ACTIONS ? `- ${shorten(facts.ACTIONS)}` : '',
    facts.SCALE ? `- Skala: ${shorten(facts.SCALE)}` : '',
    facts.RESULT ? `- Efekt: ${shorten(facts.RESULT)}` : '',
  ].filter(Boolean);

  // Pobranie zdań z oryginału
  const fromBefore = lines.slice(2, 6).map((l) => l.replace(/^\-+\s*/, '').trim()).filter(Boolean);

  // Połączenie: fakty + oryginał
  const aBullets = [...baseBullets, ...fromBefore.map((l) => `- ${l}`)].slice(0, 6);

  // Wersja B na podstawie A
  const bBullets = aBullets
    .map((b) => `- ${verbify(b.replace(/^- /, '').trim())}`)
    .map((b) => b.replace(/- skala:/i, '- Skala:').replace(/- efekt:/i, '- Efekt:'))
    .slice(0, 6);

  return [
    beforeHeader,
    lines.slice(0, 12).join('\n'),
    '',
    afterHeader,
    `Wersja A (bezpieczna):`,
    ...aBullets,
    `Wersja B (mocniejsza):`,
    ...bBullets,
    `Chcesz poprawić kolejną rolę?`,
  ].join('\n');
}

function shorten(s?: string): string {
  const t = preprocessCvSource(s || '');
  if (t.length <= 180) return t;
  return t.slice(0, 177).trim() + '…';
}