import { Agent } from "undici";

let dispatcher;

/**
 * Node's global fetch uses Undici; default TCP connect timeout is often 10s.
 * AWS Fargate → slow gov.br hosts frequently hits ConnectTimeoutError before AbortController fires.
 *
 * Env (optional):
 *   SCRAPER_FETCH_CONNECT_TIMEOUT_MS  (default 45000)
 *   SCRAPER_FETCH_HEADERS_TIMEOUT_MS  (default 120000)
 *   SCRAPER_FETCH_BODY_TIMEOUT_MS     (default 120000)
 */
export function getScraperDispatcher() {
  if (dispatcher) return dispatcher;
  const connectTimeout = Math.max(1000, Number(process.env.SCRAPER_FETCH_CONNECT_TIMEOUT_MS || "45000") || 45000);
  const headersTimeout = Math.max(5000, Number(process.env.SCRAPER_FETCH_HEADERS_TIMEOUT_MS || "120000") || 120000);
  const bodyTimeout = Math.max(5000, Number(process.env.SCRAPER_FETCH_BODY_TIMEOUT_MS || "120000") || 120000);
  dispatcher = new Agent({
    connectTimeout,
    headersTimeout,
    bodyTimeout,
  });
  return dispatcher;
}

/** Same as global fetch but with longer Undici timeouts (gov.br / cross-region). */
export function fetchWithScraperAgent(url, init = {}) {
  return fetch(url, { ...init, dispatcher: getScraperDispatcher() });
}
