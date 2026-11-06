-- Região onde o projeto pode ser executado (siglas de UF). NULL = nacional / sem restrição.
-- Usado no match projeto × editais: editais de FAP de outro estado são ocultados.
ALTER TABLE public.projetos
  ADD COLUMN IF NOT EXISTS abrangencia_ufs text[];

ALTER TABLE public.projetos
  DROP CONSTRAINT IF EXISTS projetos_abrangencia_ufs_valid;

ALTER TABLE public.projetos
  ADD CONSTRAINT projetos_abrangencia_ufs_valid CHECK (
    abrangencia_ufs IS NULL
    OR abrangencia_ufs <@ ARRAY[
      'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA',
      'PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
    ]::text[]
  );
