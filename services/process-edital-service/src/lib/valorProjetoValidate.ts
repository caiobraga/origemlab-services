import {
  flattenValorProjetoLines,
  isSuspiciousValorProjeto,
  valorLineDefinitelyInvalid,
  valorLineHasMonetarySignal,
} from "../../../../shared/editalValorExtract.ts";
import { ollamaGenerate } from "./ollama";

function extractJsonBlock(s: string): string {
  const t = String(s || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced?.[1]) return fenced[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function llmValidateValorEnabled(): boolean {
  return String(process.env.PROCESS_EDITAL_LLM_VALIDATE_VALOR ?? "1").trim() !== "0";
}

export async function llmValidateValorProjeto(
  candidate: string,
): Promise<{ valid: boolean; reason?: string }> {
  const prompt = [
    "Classifique se o texto abaixo descreve VALOR FINANCEIRO de um edital brasileiro",
    "(orçamento, teto, bolsa, financiamento, contrapartida, recursos em R$).",
    'Inválido: número de edital/chamada (ex. "046/2026", "00001946/2026"), datas, códigos,',
    "títulos ou processos sem valor monetário.",
    'Responda SOMENTE JSON: {"valido":true} ou {"valido":false,"motivo":"..."}',
    "",
    "TEXTO:",
    candidate.slice(0, 600),
  ].join("\n");

  try {
    const llmOut = await ollamaGenerate(prompt);
    const json = safeJsonParse(extractJsonBlock(llmOut));
    if (!json) return { valid: false, reason: "resposta_llm_invalida" };
    const valido = json.valido === true || json.valid === true;
    const motivo =
      typeof json.motivo === "string"
        ? json.motivo
        : typeof json.reason === "string"
          ? json.reason
          : undefined;
    return { valid: valido, reason: motivo };
  } catch (e) {
    return {
      valid: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Decide se `valor_projeto` pode ser persistido (heurística + LLM opcional para casos ambíguos). */
export async function isValorProjetoAcceptable(
  value: unknown,
  opts?: { editalNumero?: string | null },
): Promise<boolean> {
  const lines = flattenValorProjetoLines(value);
  if (lines.length === 0) return false;

  if (isSuspiciousValorProjeto(value, opts?.editalNumero)) {
    const allDefinitelyInvalid = lines.every((l) => valorLineDefinitelyInvalid(l));
    if (allDefinitelyInvalid) return false;

    if (!llmValidateValorEnabled()) return false;

    const text = lines.join("; ");
    const llm = await llmValidateValorProjeto(text);
    return llm.valid;
  }

  const allMonetary = lines.every((l) => valorLineHasMonetarySignal(l));
  if (allMonetary) return true;

  if (!llmValidateValorEnabled()) return true;

  const text = lines.join("; ");
  const llm = await llmValidateValorProjeto(text);
  return llm.valid;
}
