export type BndesEdital = {
  titulo: string;
  descricao?: string;
  fonte: string;
  orgao?: string;
  link: string;
  dataPublicacao?: string;
  dataEncerramento?: string;
  status?: string;
  pdfUrls: string[];
  processadoEm?: string;
};

export const BNDES_BASE: string;
export const BNDES_HUBS: string[];
export function bndesPageKey(url: string): string;
export function extractBndesDates(text: string): {
  dataPublicacao: string | null;
  dataEncerramento: string | null;
  maxYear: number | null;
};
export function extractBndesHubLinks(html: string, hubUrl: string): Array<{ url: string; text: string }>;
export function extractBndesDetail(
  html: string,
  pageUrl: string,
  opts?: { today?: string },
): (BndesEdital & { _maxYear: number | null }) | null;
export function isBndesChamadaCurrent(e: Partial<BndesEdital> & { _maxYear?: number | null }, year?: number): boolean;
export function scrapeBndesChamadas(opts: {
  fetchText: (url: string) => Promise<string>;
  hubs?: string[];
  extraUrls?: string[];
  maxDetail?: number;
  concurrency?: number;
  log?: (msg: string) => void;
}): Promise<BndesEdital[]>;
