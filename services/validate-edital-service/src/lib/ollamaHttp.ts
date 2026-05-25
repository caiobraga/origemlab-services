import { Agent, fetch as undiciFetch, type RequestInit } from "undici";

const agents = new Map<number, Agent>();

function agentFor(timeoutMs: number): Agent {
  // Margem acima do AbortController para o erro vir do abort (mensagem clara) e não UND_ERR_HEADERS_TIMEOUT antes.
  const slack = 120_000;
  const agentKey = timeoutMs + slack;
  let agent = agents.get(agentKey);
  if (!agent) {
    const undiciMs = Math.min(1_800_000, timeoutMs + slack);
    agent = new Agent({
      connectTimeout: Math.min(60_000, undiciMs),
      headersTimeout: undiciMs,
      bodyTimeout: undiciMs,
    });
    agents.set(agentKey, agent);
  }
  return agent;
}

export function ollamaFetch(url: string, init: RequestInit, timeoutMs: number): ReturnType<typeof undiciFetch> {
  return undiciFetch(url, { ...init, dispatcher: agentFor(timeoutMs) });
}
