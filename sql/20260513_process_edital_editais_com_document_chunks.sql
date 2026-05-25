-- Ordem de editais por volume de linhas em `documents` com `content` não vazio,
-- alinhada ao agrupamento usado em relatórios (metadata.edital_id ∪ edital_pdfs).
-- Aplicar no Supabase SQL Editor ou migração; o process-edital-service chama via RPC.

CREATE OR REPLACE FUNCTION public.process_edital_editais_com_document_chunks()
RETURNS TABLE (edital_id text, chunks bigint)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT x.edital_id, COUNT(DISTINCT x.id)::bigint AS chunks
  FROM (
    SELECT metadata->>'edital_id' AS edital_id, d.id
    FROM public.documents d
    WHERE NULLIF(TRIM(d.content), '') IS NOT NULL
      AND NULLIF(TRIM(d.metadata->>'edital_id'), '') IS NOT NULL

    UNION ALL

    SELECT ep.edital_id::text AS edital_id, d.id
    FROM public.documents d
    JOIN public.edital_pdfs ep
      ON d.file_id IN (ep.id::text, ep.file_id::text)
      OR (d.metadata ? 'file_id' AND d.metadata->>'file_id' IN (ep.id::text, ep.file_id::text))
    WHERE NULLIF(TRIM(d.content), '') IS NOT NULL
  ) x
  WHERE x.edital_id IS NOT NULL
  GROUP BY x.edital_id
  ORDER BY COUNT(DISTINCT x.id) DESC, x.edital_id ASC;
$$;

COMMENT ON FUNCTION public.process_edital_editais_com_document_chunks() IS
  'Lista edital_id com contagem de chunks (content não vazio), ordem decrescente de chunks — process-edital-service.';

GRANT EXECUTE ON FUNCTION public.process_edital_editais_com_document_chunks() TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_edital_editais_com_document_chunks() TO service_role;
