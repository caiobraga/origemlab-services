-- Novo modelo: pesquisador | consultor + empresas + projetos
-- Backfill: pessoa-empresa/ambos → consultor; CNPJ do perfil vira 1ª empresa.

-- 1) Tabelas
CREATE TABLE IF NOT EXISTS public.empresas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  razao_social text NOT NULL DEFAULT '',
  nome_fantasia text,
  cnpj text,
  area text,
  dados jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS empresas_owner_user_id_idx
  ON public.empresas (owner_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS empresas_owner_cnpj_unique
  ON public.empresas (owner_user_id, cnpj)
  WHERE cnpj IS NOT NULL AND length(trim(cnpj)) > 0;

CREATE TABLE IF NOT EXISTS public.projetos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  empresa_id uuid REFERENCES public.empresas (id) ON DELETE SET NULL,
  titulo text NOT NULL DEFAULT '',
  resumo text,
  objetivos text,
  area text,
  publico_alvo text NOT NULL DEFAULT 'ambos'
    CHECK (publico_alvo IN ('pesquisador', 'empresa', 'ambos')),
  status text NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho', 'ativo', 'arquivado')),
  conteudo jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projetos_owner_user_id_idx
  ON public.projetos (owner_user_id);

CREATE INDEX IF NOT EXISTS projetos_empresa_id_idx
  ON public.projetos (empresa_id);

-- Hook para próximo milestone (proposta a partir do projeto)
ALTER TABLE public.propostas
  ADD COLUMN IF NOT EXISTS projeto_id uuid REFERENCES public.projetos (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS propostas_projeto_id_idx
  ON public.propostas (projeto_id)
  WHERE projeto_id IS NOT NULL;

-- 2) Liberar user_type para incluir 'consultor' (constraint antiga bloqueava)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_user_type_check;

UPDATE public.profiles
SET user_type = 'consultor'
WHERE user_type IN ('pessoa-empresa', 'ambos');

-- Só pesquisador | consultor daqui pra frente
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_user_type_check
  CHECK (user_type IS NULL OR user_type IN ('pesquisador', 'consultor'));

-- 3) Backfill empresas a partir do CNPJ no perfil (consultores)
INSERT INTO public.empresas (owner_user_id, razao_social, nome_fantasia, cnpj, area, dados)
SELECT
  p.user_id,
  COALESCE(NULLIF(trim(p.cnpj), ''), 'Empresa'),
  NULL,
  NULLIF(regexp_replace(COALESCE(p.cnpj, ''), '\D', '', 'g'), ''),
  p.area,
  jsonb_build_object('migrated_from_profile', true)
FROM public.profiles p
WHERE p.user_type = 'consultor'
  AND p.has_cnpj IS TRUE
  AND NULLIF(regexp_replace(COALESCE(p.cnpj, ''), '\D', '', 'g'), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.empresas e
    WHERE e.owner_user_id = p.user_id
      AND e.cnpj = regexp_replace(p.cnpj, '\D', '', 'g')
  );

-- 4) RLS (service role bypassa; policies para client direto se usado)
ALTER TABLE public.empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projetos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS empresas_owner_all ON public.empresas;
CREATE POLICY empresas_owner_all ON public.empresas
  FOR ALL
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

DROP POLICY IF EXISTS projetos_owner_all ON public.projetos;
CREATE POLICY projetos_owner_all ON public.projetos
  FOR ALL
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);
