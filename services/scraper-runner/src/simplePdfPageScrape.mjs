import { fetchWithScraperAgent } from "./fetchAgent.mjs";
import { describeFetchError } from "./httpFetch.mjs";

export function extractNumeroFromText(t) {
  const s = String(t || "");
  const m =
    s.match(/n[º°]?\s*(\d+)\s*\/\s*(\d{4})/i) ||
    s.match(/(\d{1,4})\s*\/\s*(\d{4})/);
  if (m) return `${m[1]}/${m[2]}`;
  return "";
}

export async function fetchHtml(url, timeoutMs = 90000) {
  const retries = Number(process.env.SCRAPER_FETCH_RETRIES || "2") || 2;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetchWithScraperAgent(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
      return await r.text();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retryable =
        msg.includes("fetch failed") ||
        msg.includes("aborted") ||
        msg.includes("ECONNRESET") ||
        msg.includes("Connection reset") ||
        msg.includes("Timeout") ||
        msg.includes("ConnectTimeout");
      if (!retryable || attempt >= retries) break;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  const base = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  throw new Error(`${describeFetchError(base)} for ${url}`);
}

export function absoluteUrl(href, base) {
  const h = String(href || "").trim();
  if (!h || h.startsWith("file:") || h.startsWith("#") || h.startsWith("javascript:")) return "";
  try {
    return new URL(h, base).toString();
  } catch {
    if (h.startsWith("/")) return `${String(base).replace(/\/$/, "")}${h}`;
    return h;
  }
}

export function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function scrapePdfAnchorsFromSinglePage(opts) {
  return async () => {
    const { scrapeEditaisFromListPage } = await import("./editalListScrape.mjs");
    return scrapeEditaisFromListPage({ ...opts, isEditalLink: null })();
  };
}

