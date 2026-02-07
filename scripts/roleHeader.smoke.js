const DATE_RANGE_RE =
  /\b(?:(?:0?[1-9]|1[0-2])\s*[./-]\s*(?:19|20)\d{2}|(?:19|20)\d{2})\s*(?:–|-|—|to|do)\s*(?:(?:0?[1-9]|1[0-2])\s*[./-]\s*(?:19|20)\d{2}|(?:19|20)\d{2}|present|obecnie|current)\b/i;

function clean(s) { return String(s||"").replace(/\s+/g," ").trim(); }
function normalize(s){ return clean(s).replace(/[•·]/g,"|").replace(/\s*\|\s*/g," | ").replace(/\s*(—|–)\s*/g," - "); }
function stripDates(line){
  const m=line.match(DATE_RANGE_RE);
  if(!m) return {head:clean(line)};
  const idx=line.toLowerCase().lastIndexOf(m[0].toLowerCase());
  if(idx===-1) return {head:clean(line)};
  return {head:clean(line.slice(0,idx)), dates:clean(line.slice(idx))};
}
function looksCompanyOrLocation(s){
  s=clean(s);
  if(!s) return true;
  const roleWords=/\b(manager|specialist|developer|engineer|analyst|lead|head|consultant|designer|marketing|sales|support|qa|admin|assistant|coordinator|director|executive|intern|trainee|junior|senior|specjalista|kierownik|inżynier|analityk|lider|dyrektor|asystent|koordynator|stażysta|praktykant)\b/i;
  if(roleWords.test(s)) return false;
  if(s.includes(",")) return true;
  if(/\b(sp\.?\s*z\.?\s*o\.?\s*o\.?|s\.?\s*a\.?|ltd|inc|gmbh|ag|plc)\b/i.test(s)) return true;
  return true;
}
function roleScore(s){
  s=clean(s); if(!s) return -999;
  let sc=0;
  if(/\b(manager|specialist|developer|engineer|analyst|specjalista|kierownik|inżynier|analityk)\b/i.test(s)) sc+=4;
  if(s.length<=30) sc+=2;
  if(s.includes(",")) sc-=3;
  return sc;
}

function tryParseOneLineRoleHeader(lineRaw){
  const line=normalize(lineRaw);
  if(!line) return null;
  const {head, dates}=stripDates(line);
  const parts=head.split(" | ").map(clean).filter(Boolean);
  const left=parts[0]||"";
  let a="", b="";

  const dash=left.split(" - ").map(clean).filter(Boolean);
  if(dash.length>=2){ a=dash[0]; b=dash.slice(1).join(" - "); }
  else {
    const at=left.split(/\s+@\s+/).map(clean).filter(Boolean);
    if(at.length>=2){ a=at[0]; b=at.slice(1).join(" @ "); }
    else return null;
  }

  let title=a, company=b;
  if(looksCompanyOrLocation(title) && roleScore(company)>roleScore(title)){
    title=company; company=a;
  }
  if(looksCompanyOrLocation(title)) return null;
  return { title, dates: dates || "daty do uzupełnienia" };
}

function tryParseTwoLineRoleHeader(titleLine, metaLine){
  const title=clean(titleLine);
  const meta=normalize(metaLine);
  if(!title || !meta) return null;
  if(!meta.includes("|") && !DATE_RANGE_RE.test(meta)) return null;
  const m=meta.match(DATE_RANGE_RE);
  const dates=m ? clean(m[0]) : "";
  if(looksCompanyOrLocation(title)) return null;
  return { title, dates: dates || "daty do uzupełnienia" };
}

const cases = [
  { in: "Marketing Specialist - Papaka, Warszawa | 06.2022 – 12.2024", out: "Marketing Specialist" },
  { in: "Junior Developer - FooBar Sp. z o.o., Kraków | 2023-2024", out: "Junior Developer" },
  { in: "Papaka, Warszawa | 06.2022 – 12.2024", out: null },

  // TWÓJ DWULINIOWY FORMAT:
  { two: ["Marketing Specialist", "Papaka, Warszawa | 06.2022 – 12.2024"], out: "Marketing Specialist" },
];

let ok = 0;
for (const c of cases) {
  const r = c.two
    ? tryParseTwoLineRoleHeader(c.two[0], c.two[1])
    : tryParseOneLineRoleHeader(c.in);

  const got = r ? r.title : null;
  if (got !== c.out) {
    console.error("FAIL:", c, "got:", r);
    process.exit(1);
  }
  ok++;
}

console.log("OK tests:", ok);
