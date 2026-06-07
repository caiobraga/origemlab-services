/**
 * Deriva `prazo_inscricao` a partir de `timeline_estimada` / `data_encerramento`
 * quando a extração direta falhou ou retornou "Não informado".
 */

import { isEditalAtivoByDatePatterns } from "./editalActiveByDatePatterns.ts";

export function isPrazoInscricaoMissing(value: unknown): boolean {
  if (value == null) return true;
  const t = String(value).replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return true;
  return (
    t === "null" ||
    t === "undefined" ||
    t === "não informado" ||
    t === "nao informado" ||
    t === "não informado pelo edital" ||
    t === "nao informado pelo edital"
  );
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

const MONTH_MAP: Record<string, number> = {
  janeiro: 1,
  jan: 1,
  fevereiro: 2,
  fev: 2,
  marco: 3,
  mar: 3,
  abril: 4,
  abr: 4,
  maio: 5,
  mai: 5,
  junho: 6,
  jun: 6,
  julho: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  setembro: 9,
  set: 9,
  outubro: 10,
  out: 10,
  novembro: 11,
  nov: 11,
  dezembro: 12,
  dez: 12,
};

function parsePtMonthDate(dayStr: string, monthStr: string, yearStr: string): Date | null {
  const day = Number(dayStr);
  let year = Number(yearStr);
  if (yearStr.length === 2) year = expandTwoDigitYear(year);
  const month = MONTH_MAP[normalizeText(monthStr)];
  if (!month || !day || !year) return null;
  const d = new Date(year, month - 1, day);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function expandTwoDigitYear(yy: number, referenceYear = new Date().getFullYear()): number {
  if (!Number.isFinite(yy) || yy >= 100) return yy;
  let year = yy <= 69 ? 2000 + yy : 1900 + yy;
  if (year < referenceYear - 5 && yy <= 30) {
    const alt = 2000 + yy;
    if (alt >= referenceYear - 1) year = alt;
  }
  return year;
}

export function parseDateLoose(raw: unknown): Date | null {
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
    const year = expandTwoDigitYear(Number(brShort[3]));
    const d = new Date(year, Number(brShort[2]) - 1, Number(brShort[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const ptLong = s.match(/^(\d{1,2})\s+de\s+([A-Za-zÀ-ÿçÇ]+)\s+de\s+(\d{4})$/i);
  if (ptLong) return parsePtMonthDate(ptLong[1], ptLong[2], ptLong[3]);

  const ptShort = s.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿçÇ]+)\s+(\d{4})$/i);
  if (ptShort) return parsePtMonthDate(ptShort[1], ptShort[2], ptShort[3]);

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseLatestDateFromText(text: string): Date | null {
  const s = String(text || "").trim();
  if (!s) return null;
  const dates: Date[] = [];
  const pushIf = (v: string) => {
    const d = parseDateLoose(v);
    if (d) dates.push(d);
  };

  for (const m of s.match(/\d{4}-\d{2}-\d{2}/g) || []) pushIf(m);
  for (const m of s.match(/\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}/g) || []) pushIf(m);
  for (const m of s.match(/\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2}\b/g) || []) pushIf(m);
  for (const m of s.match(/\b\d{1,2}\s+de\s+[A-Za-zÀ-ÿçÇ]+\s+de\s+\d{4}\b/gi) || []) pushIf(m);
  for (const m of s.match(/\b\d{1,2}\s+[A-Za-zÀ-ÿçÇ]+\s+\d{4}\b/gi) || []) pushIf(m);

  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

function extractDeadlineFromPhaseText(text: string): Date | null {
  const t = String(text || "");
  const norm = normalizeText(t);

  const fimMatch = norm.match(
    /\bfim\b\s*:?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{4}|\d{1,2}\s+de\s+[a-z]+\s+de\s+\d{4}|\d{1,2}\s+[a-z]+\s+\d{4})/i,
  );
  if (fimMatch?.[1]) {
    const d = parseLatestDateFromText(fimMatch[1]);
    if (d) return d;
  }

  const ateMatch = norm.match(
    /\bate\b(?:\s+o\s+dia)?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4}|\d{1,2}\s+de\s+[a-z]+\s+de\s+\d{2,4}|\d{1,2}\s+[a-z]+\s+\d{2,4})/i,
  );
  if (ateMatch?.[1]) {
    const d = parseLatestDateFromText(ateMatch[1]);
    if (d) return d;
  }

  const rangeBasic = t.match(
    /(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})\s*(?:-|–|—|\ba\b|\bat[eé]\b|\bto\b)\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
  );
  if (rangeBasic?.[2]) {
    const d = parseLatestDateFromText(rangeBasic[2]);
    if (d) return d;
  }

  return parseLatestDateFromText(t);
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

function isFaseSubmissao(fase: any): boolean {
  const nome = normalizeText(fase?.nome);
  return (
    nome.includes("submiss") ||
    nome.includes("envio") ||
    nome.includes("propost") ||
    nome.includes("cadastr") ||
    nome.includes("envio de proposta")
  );
}

function isFaseInscricao(fase: any): boolean {
  const nome = normalizeText(fase?.nome);
  return nome.includes("inscri") || nome.includes("habilit") || nome.includes("registr");
}

export function extractSubmissionDeadlineFromTimeline(timeline: unknown): {
  date: Date;
  fasePrazo?: string;
  faseNome?: string;
} | null {
  const tl = unwrapTimeline(timeline);
  if (!tl?.fases?.length) return null;

  let candidatos = tl.fases.filter(isFaseSubmissao);
  if (!candidatos.length) candidatos = tl.fases.filter(isFaseInscricao);
  if (!candidatos.length) candidatos = tl.fases;

  const deadlines: Array<{ date: Date; fasePrazo?: string; faseNome?: string }> = [];

  for (const fase of candidatos) {
    const dataFim = fase?.data_fim ?? fase?.fim;
    if (dataFim) {
      const parsedFim = parseDateLoose(dataFim) || parseLatestDateFromText(String(dataFim));
      if (parsedFim) {
        deadlines.push({
          date: parsedFim,
          fasePrazo: String(fase?.prazo || dataFim || "").trim() || undefined,
          faseNome: String(fase?.nome || "").trim() || undefined,
        });
        continue;
      }
    }

    const rawText = [fase?.prazo, fase?.fim, fase?.data_fim, fase?.data_inicio, fase?.nome]
      .filter(Boolean)
      .map(String)
      .join(" | ");
    const extracted = extractDeadlineFromPhaseText(rawText);
    if (extracted) {
      deadlines.push({
        date: extracted,
        fasePrazo: String(fase?.prazo || fase?.fim || "").trim() || undefined,
        faseNome: String(fase?.nome || "").trim() || undefined,
      });
    }
  }

  if (deadlines.length === 0) return null;
  deadlines.sort((a, b) => b.date.getTime() - a.date.getTime());
  return deadlines[0];
}

export function formatDatePtBR(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function dateFromEncerramento(dataEnc: unknown): Date | null {
  if (dataEnc == null) return null;
  return parseDateLoose(dataEnc) || parseLatestDateFromText(String(dataEnc));
}

export function derivePrazoInscricaoFromTimeline(
  timeline: unknown,
  dataEncerramento?: unknown,
): string | null {
  const fromTimeline = extractSubmissionDeadlineFromTimeline(timeline);
  if (fromTimeline) {
    if (fromTimeline.fasePrazo) {
      const prazoDate = parseLatestDateFromText(fromTimeline.fasePrazo);
      if (prazoDate) {
        const t = fromTimeline.fasePrazo.trim();
        if (/^at[eé]\s/i.test(t)) return t;
        if (/\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}/.test(t) || /\d{4}-\d{2}-\d{2}/.test(t)) {
          return `Até ${formatDatePtBR(prazoDate)}`;
        }
        return t;
      }
    }
    return `Até ${formatDatePtBR(fromTimeline.date)}`;
  }

  const enc = dateFromEncerramento(dataEncerramento);
  return enc ? `Até ${formatDatePtBR(enc)}` : null;
}

export function extractDeadlineDateFromPrazoText(text: string): Date | null {
  const s = String(text || "").trim();
  if (!s) return null;
  const norm = normalizeText(s);
  const atePatterns = [
    /\bate\b(?:\s+o\s+dia)?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i,
    /\bfim\b\s*:?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i,
  ];
  for (const re of atePatterns) {
    const m = norm.match(re) || s.match(re);
    if (m?.[1]) {
      const d = parseDateLoose(m[1]);
      if (d) return d;
    }
  }
  return parseLatestDateFromText(s);
}

export function normalizePrazoInscricaoFromText(text: unknown): string | null {
  const raw = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw || isPrazoInscricaoMissing(raw)) return null;

  const deadline = extractDeadlineDateFromPrazoText(raw);
  if (!deadline) return raw.length <= 200 ? raw : null;

  const shortYear = /\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2}\b/.test(raw);
  const dd = String(deadline.getDate()).padStart(2, "0");
  const mm = String(deadline.getMonth() + 1).padStart(2, "0");
  const label = shortYear
    ? `${dd}/${mm}/${String(deadline.getFullYear()).slice(-2)}`
    : formatDatePtBR(deadline);
  return `Até ${label}`;
}

export function reconcilePrazoInscricaoFromSources(
  prazoInscricao: unknown,
  timeline: unknown,
  dataEncerramento?: unknown,
): string | null {
  if (!isPrazoInscricaoMissing(prazoInscricao)) {
    return normalizePrazoInscricaoFromText(prazoInscricao) ?? String(prazoInscricao).replace(/\s+/g, " ").trim();
  }
  return derivePrazoInscricaoFromTimeline(timeline, dataEncerramento);
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Descarta datas claramente legadas/OCR (ex.: 2008 em edital indexado em 2024). */
export function isPlausibleCatalogDeadline(date: Date, criadoEm?: string | null): boolean {
  if (date.getFullYear() < 2010) return false;
  if (criadoEm) {
    const c = new Date(criadoEm);
    if (!Number.isNaN(c.getTime()) && date.getFullYear() < c.getFullYear() - 2) return false;
  }
  return true;
}

export type EditalDeadlineInput = {
  timeline_estimada?: unknown;
  prazo_inscricao?: unknown;
  data_encerramento?: string | null;
  criado_em?: string | null;
};

export function collectEditalDeadlineDates(input: EditalDeadlineInput): Date[] {
  const dates: Date[] = [];

  const tl = extractSubmissionDeadlineFromTimeline(input.timeline_estimada);
  if (tl?.date && isPlausibleCatalogDeadline(tl.date, input.criado_em)) dates.push(tl.date);

  const prazoText = input.prazo_inscricao != null ? String(input.prazo_inscricao) : "";
  if (prazoText && !isPrazoInscricaoMissing(prazoText)) {
    const prazo = extractDeadlineDateFromPrazoText(prazoText) || parseLatestDateFromText(prazoText);
    if (prazo && isPlausibleCatalogDeadline(prazo, input.criado_em)) dates.push(prazo);
  }

  const enc = dateFromEncerramento(input.data_encerramento);
  if (enc && isPlausibleCatalogDeadline(enc, input.criado_em)) dates.push(enc);

  return dates;
}

/** Edital ativo: janela MM/AAAA + anos +1…+4 (ver editalActiveByDatePatterns). */
export function editalHasActiveDeadline(input: EditalDeadlineInput & {
  titulo?: string | null;
  descricao?: string | null;
  sobre_programa?: string | null;
  numero?: string | null;
  status?: string | null;
}): boolean {
  return isEditalAtivoByDatePatterns(input);
}
