/**
 * Campos e “vocabulário” alinhados ao api:process-edital-info / RAG em processEditalInfo.ts
 * (fieldRagQueries + temas das extrações).
 */
export const PROCESS_EDITAL_FIELDS = [
  "valor_projeto",
  "prazo_inscricao",
  "localizacao",
  "vagas",
  "is_researcher",
  "is_company",
  "sobre_programa",
  "criterios_elegibilidade",
  "timeline_estimada",
];

export const FIELD_KEYWORD_HINTS = {
  valor_projeto:
    "orçamento, teto, dotação, valor máximo/mínimo, bolsa, auxílio, subsídio, repasse, subvenção, financiamento, R$, cronograma desembolso",
  prazo_inscricao:
    "prazo de inscrição, submissão, cadastro, envio de proposta, portal, último dia, prorrogação, DD/MM, encerramento",
  localizacao: "abrangência, estado, município, país, território, sede",
  vagas: "número de vagas, bolsas, beneficiários, quantitativo, seleção",
  is_researcher: "pesquisador, ICT, universidade, titulação, vínculo, Lattes",
  is_company: "CNPJ, empresa, PJ, startup, MEI",
  sobre_programa:
    "objetivos do programa, público-alvo, escopo, eixo temático, modalidade, introdução ao edital",
  criterios_elegibilidade:
    "requisitos, elegibilidade, documentação obrigatória, impedimentos, contrapartida, habilitação",
  timeline_estimada: "fases, cronograma, etapas, datas do processo, homologação, recurso",
};
