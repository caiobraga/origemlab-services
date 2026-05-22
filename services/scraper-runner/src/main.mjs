import { scrapeFinepCurrentYear } from "./finepScrape.mjs";
import { scrapeRotadofomentoCurrentYear } from "./rotadofomentoScrape.mjs";
import { scrapePlataformaInovacaoCurrentYear } from "./plataformaInovacaoScrape.mjs";
import { scrapeFapernCurrentYear } from "./fapernScrape.mjs";
import { scrapeCaptaCurrentYear } from "./captaScrape.mjs";
import { scrapeFapacCurrentYear } from "./fapacScrape.mjs";
import { scrapeSectiCurrentYear } from "./sectiScrape.mjs";
import { scrapeFuncapCurrentYear } from "./funcapScrape.mjs";
import { scrapeFacepeCurrentYear } from "./facepeScrape.mjs";
import { scrapeFapdfCurrentYear } from "./fapdfScrape.mjs";
import { scrapeFapealCurrentYear } from "./fapealScrape.mjs";
import { scrapeFapemaCurrentYear } from "./fapemaScrape.mjs";
import { scrapeFapepiCurrentYear } from "./fapepiScrape.mjs";
import { scrapeFapergsCurrentYear } from "./fapergsScrape.mjs";
import { scrapeFaperjCurrentYear } from "./faperjScrape.mjs";
import { scrapeFapescCurrentYear } from "./fapescScrape.mjs";
import { scrapeFapespaCurrentYear } from "./fapespaScrape.mjs";
import { scrapeFapesqCurrentYear } from "./fapesqScrape.mjs";
import { scrapeFapitecCurrentYear } from "./fapitecScrape.mjs";
import { scrapeFaptCurrentYear } from "./faptScrape.mjs";
import { scrapeCnpqCurrentYear } from "./cnpqScrape.mjs";
import { scrapeFapemigCurrentYear } from "./fapemigScrape.mjs";
import { scrapeFapematCurrentYear } from "./fapematScrape.mjs";
import { scrapeFapesCurrentYear } from "./fapesScrape.mjs";
import { scrapeProsasCurrentYear } from "./prosasScrape.mjs";
import { scrapeSigfapesCurrentYear } from "./sigfapesScrape.mjs";
import { getSupabaseFromEnv, upsertEditaisAndPdfs } from "./supabaseUpsert.mjs";
import { makeEventBase, publishDomainEvent } from "./eventbridge.mjs";
import { loadEnv } from "./loadEnv.mjs";
import { closePuppeteerBrowser } from "./puppeteerHtml.mjs";
import { describeFetchError } from "./httpFetch.mjs";
import dns from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = { source: "all" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source" && argv[i + 1]) args.source = argv[++i];
  }
  return args;
}

loadEnv();

if (String(process.env.NODE_DNS_IPV4FIRST || "").trim()) {
  dns.setDefaultResultOrder("ipv4first");
}

function nowMs() {
  return Date.now();
}

function fmtMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${String(rem).padStart(2, "0")}s`;
}

function toErrorMessage(e) {
  if (e instanceof Error) {
    const msg = e.message;
    if (msg === "fetch failed" || msg.startsWith("fetch failed")) return describeFetchError(e);
    return msg;
  }
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

async function withTimeout(promise, ms, label) {
  const timeoutMs = Number(ms || 0) || 0;
  if (timeoutMs <= 0) return await promise;
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms${label ? ` (${label})` : ""}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

function envFlag(name) {
  const v = String(process.env[name] || "").trim();
  return v && v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "no";
}

function summarizeScraped(source, editais) {
  const list = Array.isArray(editais) ? editais : [];
  const editaisCount = list.length;
  const pdfLinksTotal = list.reduce((acc, e) => acc + (Array.isArray(e?.pdfUrls) ? e.pdfUrls.length : 0), 0);
  const uniquePdf = new Set();
  for (const e of list) {
    for (const u of e?.pdfUrls || []) {
      if (u) uniquePdf.add(String(u));
    }
  }
  console.log(
    `[scraper-runner] scraped: ${source} -> editais=${editaisCount}, pdf_links=${pdfLinksTotal}, pdf_urls_unique=${uniquePdf.size}`,
  );
  const maxSamples = Math.min(50, Number(process.env.SCRAPER_LOG_MAX_SAMPLES || "5") || 5);
  const maxTitulo = Number(process.env.SCRAPER_LOG_MAX_TITULO || "90") || 90;
  const maxUrl = Number(process.env.SCRAPER_LOG_MAX_URL || "140") || 140;
  const maxPdfUrl = Number(process.env.SCRAPER_LOG_MAX_PDF_URL || "120") || 120;
  for (let i = 0; i < Math.min(maxSamples, list.length); i++) {
    const e = list[i];
    const titulo = String(e?.titulo || "").slice(0, maxTitulo);
    const link = String(e?.link || "").slice(0, maxUrl);
    const pdfs = Array.isArray(e?.pdfUrls) ? e.pdfUrls : [];
    const pdfPreview = pdfs.slice(0, 3).map((u) => String(u).slice(0, maxPdfUrl));
    const pdfExtra = pdfs.length > pdfPreview.length ? ` (+${pdfs.length - pdfPreview.length} more)` : "";
    console.log(
      `[scraper-runner] scraped: ${source} [${i + 1}/${editaisCount}] titulo=${titulo || "(sem titulo)"} link=${link || "-"}`,
    );
    if (pdfPreview.length) {
      console.log(`[scraper-runner] scraped: ${source} [${i + 1}] pdfs=${pdfPreview.join(" | ")}${pdfExtra}`);
    }
  }
  if (editaisCount > maxSamples) {
    console.log(`[scraper-runner] scraped: ${source} ... (${editaisCount - maxSamples} editais adicionais omitidos do log)`);
  }
}

function summarizeUpsert(source, upserts) {
  const rows = Array.isArray(upserts) ? upserts : [];
  const createdRows = rows.filter((r) => r.created);
  const newPdfs = rows.reduce((acc, r) => acc + (r.newPdfs || 0), 0);
  const failedPdfs = rows.reduce((acc, r) => acc + (r.failedPdfs || 0), 0);
  console.log(
    `[scraper-runner] db: ${source} -> rows=${rows.length}, editais_novos=${createdRows.length}, pdfs_novos=${newPdfs}, pdfs_falha=${failedPdfs}`,
  );
  if (envFlag("SCRAPER_REPORT")) {
    const maxSamples = Math.min(20, Number(process.env.SCRAPER_LOG_MAX_SAMPLES || "5") || 5);
    for (let i = 0; i < Math.min(maxSamples, rows.length); i++) {
      const r = rows[i];
      console.log(
        `[scraper-runner] db: ${source} [${i + 1}/${rows.length}] titulo=${String(r.titulo || "").slice(0, 120)} created=${Boolean(r.created)} new_pdfs=${r.newPdfs || 0} failed_pdfs=${r.failedPdfs || 0}`,
      );
    }
  }
}

const SOURCES = {
  finep: { component: "scraper.finep", fn: scrapeFinepCurrentYear },
  rotadofomento: { component: "scraper.rotadofomento", fn: scrapeRotadofomentoCurrentYear },
  "plataforma-inovacao-industria": {
    component: "scraper.plataforma-inovacao-industria",
    fn: scrapePlataformaInovacaoCurrentYear,
  },
  fapern: { component: "scraper.fapern", fn: scrapeFapernCurrentYear },
  capta: { component: "scraper.capta", fn: scrapeCaptaCurrentYear },
  fapac: { component: "scraper.fapac", fn: scrapeFapacCurrentYear },
  secti: { component: "scraper.secti", fn: scrapeSectiCurrentYear },
  funcap: { component: "scraper.funcap", fn: scrapeFuncapCurrentYear },
  facepe: { component: "scraper.facepe", fn: scrapeFacepeCurrentYear },
  fapdf: { component: "scraper.fapdf", fn: scrapeFapdfCurrentYear },
  fapeal: { component: "scraper.fapeal", fn: scrapeFapealCurrentYear },
  fapema: { component: "scraper.fapema", fn: scrapeFapemaCurrentYear },
  fapepi: { component: "scraper.fapepi", fn: scrapeFapepiCurrentYear },
  fapergs: { component: "scraper.fapergs", fn: scrapeFapergsCurrentYear },
  faperj: { component: "scraper.faperj", fn: scrapeFaperjCurrentYear },
  fapesc: { component: "scraper.fapesc", fn: scrapeFapescCurrentYear },
  fapespa: { component: "scraper.fapespa", fn: scrapeFapespaCurrentYear },
  fapesq: { component: "scraper.fapesq", fn: scrapeFapesqCurrentYear },
  fapitec: { component: "scraper.fapitec", fn: scrapeFapitecCurrentYear },
  fapt: { component: "scraper.fapt", fn: scrapeFaptCurrentYear },
  cnpq: { component: "scraper.cnpq", fn: scrapeCnpqCurrentYear },
  fapemig: { component: "scraper.fapemig", fn: scrapeFapemigCurrentYear },
  fapemat: { component: "scraper.fapemat", fn: scrapeFapematCurrentYear },
  fapes: { component: "scraper.fapes", fn: scrapeFapesCurrentYear },
  prosas: { component: "scraper.prosas", fn: scrapeProsasCurrentYear },
  sigfapes: { component: "scraper.sigfapes", fn: scrapeSigfapesCurrentYear },
};

async function runOne(source) {
  const src = SOURCES[source];
  if (!src) throw new Error(`Unknown source: ${source}`);
  const component = src.component;
  const supabase = getSupabaseFromEnv();
  const perSourceTimeoutMs = Number(process.env.SCRAPER_SOURCE_TIMEOUT_MS || "0") || 0;
  const editais = await withTimeout(src.fn(), perSourceTimeoutMs, source);
  if (!envFlag("SCRAPER_LOG_QUIET")) summarizeScraped(source, editais);
  // Guarantee fonte is set.
  let normalized = (editais || []).map((e) => ({ ...e, fonte: e.fonte || source }));
  if (envFlag("SCRAPER_REQUIRE_PDF")) {
    const before = normalized.length;
    normalized = normalized.filter((e) => Array.isArray(e.pdfUrls) && e.pdfUrls.length > 0);
    const skipped = before - normalized.length;
    if (skipped > 0 && !envFlag("SCRAPER_LOG_QUIET")) {
      console.log(`[scraper-runner] filter: ${source} -> skipped ${skipped} editais sem pdfUrls (SCRAPER_REQUIRE_PDF=1)`);
    }
  }
  const upserts = await upsertEditaisAndPdfs(supabase, normalized);
  if (!envFlag("SCRAPER_LOG_QUIET")) summarizeUpsert(source, upserts);

  const newEditais = upserts.filter((r) => r.created);
  const newPdfs = upserts.reduce((acc, r) => acc + (r.newPdfs || 0), 0);

  if (newEditais.length > 0) {
    try {
      await publishDomainEvent(
        makeEventBase({
          name: "NewEditaisFound",
          severity: "info",
          message: `${source}: ${newEditais.length} novo(s) edital(is) (${newPdfs} PDF(s) novos)`,
          component,
          props: {
            fonte: source,
            new_editais: newEditais.slice(0, 20),
            new_pdfs: newPdfs,
            total_seen: upserts.length,
          },
        }),
      );
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.log(`[scraper-runner] warn: failed to publish NewEditaisFound (${source}) - ${err.message}`);
    }
  }

  return { ok: true, fonte: source, total: upserts.length, new_editais: newEditais.length, new_pdfs: newPdfs };
}

export async function runScraperBatch(argv = process.argv.slice(2)) {
  const { source } = parseArgs(argv);
  if (source === "all") {
    const out = {};
    const keys = Object.keys(SOURCES);
    const startedAt = nowMs();
    console.log(`[scraper-runner] starting ${keys.length} source(s)`);
    for (let i = 0; i < keys.length; i++) {
      const s = keys[i];
      const t0 = nowMs();
      console.log(`[scraper-runner] (${i + 1}/${keys.length}) start: ${s}`);
      try {
        out[s] = await runOne(s);
        console.log(`[scraper-runner] (${i + 1}/${keys.length}) done: ${s} (${fmtMs(nowMs() - t0)})`);
      } catch (e) {
        const msg = toErrorMessage(e);
        const err = e instanceof Error ? e : new Error(msg);
        out[s] = { ok: false, fonte: s, error: msg };
        console.log(`[scraper-runner] (${i + 1}/${keys.length}) fail: ${s} (${fmtMs(nowMs() - t0)}) - ${msg}`);
        // Best-effort: emit an error event but keep going with other sources.
        try {
          await publishDomainEvent(
            makeEventBase({
              name: "JobFailed",
              severity: "error",
              message: `Scraper failed (${s}): ${msg}`,
              component: SOURCES[s]?.component || "scraper.runner",
              error: { type: err.name, message: msg, stack: err.stack },
              props: { fonte: s },
            }),
          );
        } catch {
          // ignore
        }
      }
    }
    console.log(`[scraper-runner] finished all sources in ${fmtMs(nowMs() - startedAt)}`);
    const summary = Object.entries(out).reduce(
      (acc, [k, v]) => {
        if (v && typeof v === "object" && "ok" in v && v.ok === false) acc.failed += 1;
        else acc.ok += 1;
        const ne = v && typeof v === "object" && "new_editais" in v ? Number(v.new_editais || 0) : 0;
        const np = v && typeof v === "object" && "new_pdfs" in v ? Number(v.new_pdfs || 0) : 0;
        acc.new_editais += Number.isFinite(ne) ? ne : 0;
        acc.new_pdfs += Number.isFinite(np) ? np : 0;
        return acc;
      },
      { ok: 0, failed: 0, new_editais: 0, new_pdfs: 0 },
    );
    if (!envFlag("DISABLE_EVENTBRIDGE")) {
      try {
        await publishDomainEvent(
          makeEventBase({
            name: "ScraperRunCompleted",
            severity: summary.failed > 0 ? "warn" : "info",
            message: `Scraper run finished: ${summary.ok} ok, ${summary.failed} failed, ${summary.new_editais} new editais, ${summary.new_pdfs} new pdfs`,
            component: "scraper.runner",
            props: {
              duration_ms: nowMs() - startedAt,
              summary,
              sources: Object.keys(out).length,
            },
          }),
        );
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.log(`[scraper-runner] warn: failed to publish ScraperRunCompleted - ${err.message}`);
      }
    }
    await closePuppeteerBrowser().catch(() => {});
    return { ok: true, sources: out, run_summary: summary };
  }
  try {
    return await runOne(source);
  } finally {
    await closePuppeteerBrowser().catch(() => {});
  }
}

const isDirectCliRun =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectCliRun) {
  try {
    const res = await runScraperBatch();
    console.log(JSON.stringify(res));
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const component = "scraper.runner";
    try {
      await publishDomainEvent(
        makeEventBase({
          name: "JobFailed",
          severity: "error",
          message: `Scraper runner failed: ${err.message}`,
          component,
          error: { type: err.name, message: err.message, stack: err.stack },
        }),
      );
    } catch {
      // Best-effort: don't hide the original error.
    }
    console.error(err);
    process.exit(1);
  }
}

