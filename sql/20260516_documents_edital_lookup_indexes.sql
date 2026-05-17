-- Acelera queries do process-edital em documents (metadata.edital_id, file_id).
-- Aplicar no Supabase SQL Editor se vir "canceling statement due to statement timeout".

CREATE INDEX IF NOT EXISTS documents_metadata_edital_id_idx
  ON public.documents ((metadata->>'edital_id'))
  WHERE (metadata->>'edital_id') IS NOT NULL AND (metadata->>'edital_id') <> '';

CREATE INDEX IF NOT EXISTS documents_file_id_idx
  ON public.documents (file_id)
  WHERE file_id IS NOT NULL AND file_id <> '';
