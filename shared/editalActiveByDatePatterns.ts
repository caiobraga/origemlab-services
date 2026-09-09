/**
 * Edital "ativo" = mesmo critério da busca manual por MM/AAAA (mês atual → dez/ano)
 * + anos inteiros (ano+1 … ano+4), unindo prazo, timeline, encerramento e textos.
 */

export type EditalActiveSearchInput = {
  titulo?: string | null;
  descricao?: string | null;
  sobre_programa?: string | null;
  numero?: string | null;
  prazo_inscricao?: unknown;
  data_encerramento?: string | null;
  timeline_estimada?: unknown;
  status?: string | null;
};

const YEARS_FORWARD = 4;

export function buildActiveEditalDateSearchPatterns(referenceDate = new Date()): string[] {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth() + 1;
  const patterns = new Set<string>();

  for (let m = month; m <= 12; m++) {
    const mm = String(m).padStart(2, "0");
    patterns.add(`${mm}/${year}`);
    patterns.add(`${m}/${year}`);
  }

  for (let y = year + 1; y <= year + YEARS_FORWARD; y++) {
    patterns.add(String(y));
  }

  return [...patterns];
}

export function isDateInActiveCatalogWindow(date: Date, referenceDate = new Date()): boolean {
  if (Number.isNaN(date.getTime())) return false;
  const refYear = referenceDate.getFullYear();
  const refMonth = referenceDate.getMonth() + 1;
  const y = date.getFullYear();
  const m = date.getMonth() + 1;

  if (y > refYear + YEARS_FORWARD) return false;
  if (y >= refYear + 1) return true;
  if (y === refYear && m >= refMonth) return true;
  return false;
}

export function collectEditalTextForActiveDateSearch(input: EditalActiveSearchInput): string {
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (value == null) return;
    const s = typeof value === "string" ? value : JSON.stringify(value);
    if (s.trim()) parts.push(s);
  };

  push(input.titulo);
  push(input.descricao);
  push(input.sobre_programa);
  push(input.numero);
  push(input.prazo_inscricao);
  push(input.data_encerramento);
  push(input.timeline_estimada);

  return parts.join(" ").toLowerCase();
}

/** Evita que "9/2026" case dentro de "39/2026" (número do edital). */
export function textHasActiveDatePattern(text: string, pattern: string): boolean {
  const hay = String(text || "").toLowerCase();
  const needle = String(pattern || "").toLowerCase().trim();
  if (!hay || !needle) return false;

  // Ano isolado (2027): só conta como token, não como substring de outro número.
  if (/^\d{4}$/.test(needle)) {
    return new RegExp(`(?<!\\d)${needle}(?!\\d)`).test(hay);
  }

  // MM/AAAA ou M/AAAA: não pode ter dígito imediatamente antes (bloqueia 39/2026 ⊃ 9/2026).
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\d)${escaped}(?!\\d)`).test(hay);
}

export function editalMatchesActiveDateSearchPatterns(
  input: EditalActiveSearchInput,
  referenceDate = new Date(),
): boolean {
  const text = collectEditalTextForActiveDateSearch(input);
  if (!text) return false;
  return buildActiveEditalDateSearchPatterns(referenceDate).some((pattern) =>
    textHasActiveDatePattern(text, pattern),
  );
}

function parseDateLoose(raw: unknown): Date | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || /invalid date/i.test(s)) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const br = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (br) {
    const d = new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const brShort = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
  if (brShort) {
    const yy = Number(brShort[3]);
    const year = yy <= 69 ? 2000 + yy : 1900 + yy;
    const d = new Date(year, Number(brShort[2]) - 1, Number(brShort[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function unwrapTimeline(value: unknown): { fases: any[] } | null {
  if (value == null) return null;
  let cur: any = value;
  for (let i = 0; i < 3 && cur && typeof cur === "object" && "json" in cur; i++) {
    cur = cur.json;
  }
  if (typeof cur === "string") {
    try {
      cur = JSON.parse(cur);
    } catch {
      return null;
    }
  }
  if (!cur || typeof cur !== "object" || !Array.isArray((cur as any).fases)) return null;
  return { fases: (cur as any).fases };
}

function pushDatesFromText(text: string, out: Date[]): void {
  const s = String(text || "");
  if (!s) return;
  const tokenRe = /\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/g;
  for (const token of s.match(tokenRe) || []) {
    const d = parseDateLoose(token);
    if (d) out.push(d);
  }
}

export function collectEditalDatesForActiveWindow(input: EditalActiveSearchInput): Date[] {
  const dates: Date[] = [];

  const tl = unwrapTimeline(input.timeline_estimada);
  if (tl?.fases?.length) {
    for (const fase of tl.fases) {
      for (const part of [fase?.data_fim, fase?.fim, fase?.prazo, fase?.data_inicio, fase?.nome]) {
        const d = parseDateLoose(part);
        if (d) dates.push(d);
        else if (part) pushDatesFromText(String(part), dates);
      }
    }
  }

  const prazoText = input.prazo_inscricao != null ? String(input.prazo_inscricao) : "";
  if (prazoText && prazoText.toLowerCase() !== "não informado" && prazoText.toLowerCase() !== "nao informado") {
    pushDatesFromText(prazoText, dates);
  }

  const enc = parseDateLoose(input.data_encerramento);
  if (enc) dates.push(enc);

  return dates;
}

function startOfDayLocal(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Datas estruturadas de prazo/encerramento (sem título/descrição).
 * Se a mais recente já passou, o edital não deve permanecer "ativo" só por
 * texto solto (ex.: número "39/2026" ou fase futura de homologação).
 */
export function collectStructuredPrazoEncerramentoDates(input: EditalActiveSearchInput): Date[] {
  const dates: Date[] = [];
  const prazoText = input.prazo_inscricao != null ? String(input.prazo_inscricao) : "";
  if (prazoText && prazoText.toLowerCase() !== "não informado" && prazoText.toLowerCase() !== "nao informado") {
    pushDatesFromText(prazoText, dates);
  }
  const enc = parseDateLoose(input.data_encerramento);
  if (enc) dates.push(enc);
  return dates;
}

export function isEditalAtivoByDatePatterns(
  input: EditalActiveSearchInput,
  referenceDate = new Date(),
): boolean {
  const status = String(input.status || "")
    .toLowerCase()
    .trim();
  if (status === "encerrado" || status === "finalizado") return false;

  const structured = collectStructuredPrazoEncerramentoDates(input);
  if (structured.length > 0) {
    const latest = new Date(Math.max(...structured.map((d) => d.getTime())));
    // Prazo/encerramento conhecido no passado → encerrado (heurística de texto não reabre).
    if (startOfDayLocal(latest).getTime() < startOfDayLocal(referenceDate).getTime()) {
      return false;
    }
    return true;
  }

  if (editalMatchesActiveDateSearchPatterns(input, referenceDate)) return true;

  return collectEditalDatesForActiveWindow(input).some((d) => isDateInActiveCatalogWindow(d, referenceDate));
}
