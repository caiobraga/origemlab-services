import puppeteer from "puppeteer";

let browserPromise;

function launchOptions() {
  const args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
  const executablePath = String(process.env.PUPPETEER_EXECUTABLE_PATH || "").trim() || undefined;
  return { headless: true, args, executablePath };
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch(launchOptions());
  }
  return browserPromise;
}

/**
 * HTML após renderização JS (SPAs Liferay, etc.).
 */
export async function fetchRenderedHtml(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || process.env.SCRAPER_PUPPETEER_TIMEOUT_MS || "90000") || 90000;
  const waitMs = Number(opts.waitMs || process.env.SCRAPER_PUPPETEER_WAIT_MS || "2500") || 2500;
  const waitForSelector = opts.waitForSelector || null;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: Math.min(timeoutMs, 45000) }).catch(() => {});
    } else if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return await page.content();
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closePuppeteerBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise;
  browserPromise = null;
  await b.close().catch(() => {});
}

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Executa callback com uma Page Puppeteer (fecha ao terminar).
 */
export async function withPuppeteerPage(fn, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || process.env.SCRAPER_PUPPETEER_TIMEOUT_MS || "90000") || 90000;
  const browser = await getBrowser();
  const page = await browser.newPage();
  page.on("dialog", async (d) => {
    try {
      await d.accept();
    } catch {
      // ignore
    }
  });
  try {
    await page.setUserAgent(DEFAULT_UA);
    await page.setViewport({ width: 1280, height: 900 });
    return await fn(page, { timeoutMs });
  } finally {
    await page.close().catch(() => {});
  }
}

export async function gotoPage(page, url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 90000;
  await page.goto(url, {
    waitUntil: opts.waitUntil || "domcontentloaded",
    timeout: timeoutMs,
  });
  const waitMs = Number(opts.waitMs ?? 2500) || 0;
  if (opts.waitForSelector) {
    await page.waitForSelector(opts.waitForSelector, { timeout: Math.min(timeoutMs, 45000) }).catch(() => {});
  } else if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }
}
