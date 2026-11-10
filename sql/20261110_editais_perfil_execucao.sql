-- Perfil de execução do edital, usado nos critérios de seleção do match projeto × editais
-- (duração mínima, nº de parcelas, TransfereGov, obra, CLT, Lei 14.133, natureza P&D).
-- Preenchido por `scripts/extract-perfil-execucao.mjs` a partir dos trechos em `documents`.
-- Formato:
-- {
--   "prazo_execucao_meses": 36,            -- duração máxima de execução do projeto
--   "valor_global_projeto": 2500000,       -- valor máximo por projeto, em reais
--   "num_parcelas": 2,                     -- nº de aportes/desembolsos ao projeto
--   "transferegov": false,                 -- execução/prestação de contas via TransfereGov (+Brasil)
--   "exige_obra": false,                   -- exige construção civil (reforma não conta)
--   "clt": false,                          -- prevê contratação de pessoal CLT com recursos do projeto
--   "lei_14133_integral": false,           -- toda a execução segue a Lei 14.133/2021
--   "pd_inovacao": true,                   -- objeto é pesquisa, desenvolvimento ou inovação
--   "evidencias": { "<campo>": "trecho literal" },
--   "extraido_em": "2026-11-10T00:00:00Z"
-- }
-- Campo null = edital não informa (o match não exclui por ele).
ALTER TABLE public.editais
  ADD COLUMN IF NOT EXISTS perfil_execucao jsonb;

ALTER TABLE public.editais_corretos
  ADD COLUMN IF NOT EXISTS perfil_execucao jsonb;
