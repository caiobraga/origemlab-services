import { Agent, fetch as undiciFetch, type RequestInit } from "undici";

const agents = new Map<number, Agent>();

function agentFor(timeoutMs: number): Agent {
  let agent = agents.get(timeoutMs);
  if (!agent) {
    agent = new Agent({
      connectTimeout: Math.min(60_000, timeoutMs),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    agents.set(timeoutMs, agent);
  }
  return agent;
}

export function ollamaFetch(url: string, init: RequestInit, timeoutMs: number): ReturnType<typeof undiciFetch> {
  return undiciFetch(url, { ...init, dispatcher: agentFor(timeoutMs) });
}
