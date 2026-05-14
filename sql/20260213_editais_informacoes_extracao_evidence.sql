-- Evidências por campo (trecho usado na extração + origem topk|window).
-- Executar no SQL editor do Supabase (ou psql) antes de usar process-edital / validate com o novo fluxo.

DO $$
BEGIN
  ALTER TABLE editais ADD COLUMN informacoes_extracao_evidence jsonb DEFAULT '{}'::jsonb;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

COMMENT ON COLUMN editais.informacoes_extracao_evidence IS
  'Por campo extraído: { "valor_projeto": { "source": "topk"|"bulk"|"window", "snippet": "...", "document_id", "document_ids": [], "window_index": n } }';
