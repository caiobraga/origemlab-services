import { Agent, fetch as undiciFetch } from "undici";

const agents = new Map();

function agentFor(timeoutMs) {
  const key = timeoutMs;
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({
      connectTimeout: Math.min(30_000, Math.max(5_000, timeoutMs)),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    agents.set(key, agent);
  }
  return agent;
}

/** fetch com timeouts alinhados ao Ollama (evita hang em NLB inacessível). */
export function ollamaFetch(url, init, timeoutMs = 120_000) {
  return undiciFetch(url, { ...init, dispatcher: agentFor(timeoutMs) });
}
