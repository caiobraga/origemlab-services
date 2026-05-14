-- Vetor de embedding só da parte “contexto para busca / perguntas exemplo” (sem [TRECHO DO EDITAL]),
-- usado pelo process-edital-service no top-k; `embedding` continua a ser o texto completo do chunk.
-- A dimensão deve coincidir com a coluna `documents.embedding` (ex.: 1024 para mxbai-embed-large).
-- Se a tua coluna `embedding` for outra dimensão, ajusta o literal em ADD COLUMN antes de correr.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS embedding_perguntas vector(1024);

COMMENT ON COLUMN public.documents.embedding_perguntas IS
  'Embedding só do cabeçalho de retrieval (até antes de [TRECHO DO EDITAL]); top-k no process-edital-service.';
