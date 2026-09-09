-- Empresa como workspace: propostas e indicações passam a poder ser escopadas por empresa_id.
-- Pesquisador: empresa_id NULL. Consultor: empresa_id da empresa ativa.

-- 1) propostas.empresa_id
ALTER TABLE public.propostas
  ADD COLUMN IF NOT EXISTS empresa_id uuid REFERENCES public.empresas (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS propostas_empresa_id_idx
  ON public.propostas (empresa_id)
  WHERE empresa_id IS NOT NULL;

-- Backfill a partir do projeto vinculado
UPDATE public.propostas p
SET empresa_id = pr.empresa_id
FROM public.projetos pr
WHERE p.projeto_id = pr.id
  AND p.empresa_id IS NULL
  AND pr.empresa_id IS NOT NULL;

-- 2) edital_indicacoes: PK surrogada + empresa_id + uniques parciais
ALTER TABLE public.edital_indicacoes
  ADD COLUMN IF NOT EXISTS id uuid;

UPDATE public.edital_indicacoes
SET id = gen_random_uuid()
WHERE id IS NULL;

ALTER TABLE public.edital_indicacoes
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN id SET NOT NULL;

ALTER TABLE public.edital_indicacoes
  DROP CONSTRAINT IF EXISTS edital_indicacoes_pkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'edital_indicacoes_pkey'
      AND conrelid = 'public.edital_indicacoes'::regclass
  ) THEN
    ALTER TABLE public.edital_indicacoes ADD PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE public.edital_indicacoes
  ADD COLUMN IF NOT EXISTS empresa_id uuid REFERENCES public.empresas (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS edital_indicacoes_user_empresa_idx
  ON public.edital_indicacoes (user_id, empresa_id);

CREATE UNIQUE INDEX IF NOT EXISTS edital_indicacoes_user_null_empresa_edital_uidx
  ON public.edital_indicacoes (user_id, edital_id)
  WHERE empresa_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS edital_indicacoes_user_empresa_edital_uidx
  ON public.edital_indicacoes (user_id, empresa_id, edital_id)
  WHERE empresa_id IS NOT NULL;

-- 3) RPC refresh com escopo de empresa (consultor) ou perfil (pesquisador)
DROP FUNCTION IF EXISTS public.refresh_my_indicacoes(uuid, integer);
DROP FUNCTION IF EXISTS public.refresh_my_indicacoes(uuid, integer, uuid);

CREATE OR REPLACE FUNCTION public.refresh_my_indicacoes(
  p_user_id uuid,
  p_limit integer DEFAULT 20,
  p_empresa_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
  v_profile record;
  v_empresa record;
  v_user_type text;
  v_area text;
  v_count integer := 0;
BEGIN
  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE user_id = p_user_id
   LIMIT 1;

  v_user_type := coalesce(v_profile.user_type, 'pesquisador');
  IF v_user_type IN ('pessoa-empresa', 'ambos') THEN
    v_user_type := 'consultor';
  END IF;
  v_area := coalesce(v_profile.area, '');

  IF p_empresa_id IS NOT NULL THEN
    SELECT *
      INTO v_empresa
      FROM public.empresas
     WHERE id = p_empresa_id
       AND owner_user_id = p_user_id
     LIMIT 1;

    IF v_empresa.id IS NULL THEN
      RAISE EXCEPTION 'empresa_id inválido ou sem permissão';
    END IF;

    v_user_type := 'consultor';
    v_area := coalesce(nullif(trim(v_empresa.area), ''), v_area);
  END IF;

  IF p_empresa_id IS NULL THEN
    DELETE FROM public.edital_indicacoes
     WHERE user_id = p_user_id
       AND empresa_id IS NULL;
  ELSE
    DELETE FROM public.edital_indicacoes
     WHERE user_id = p_user_id
       AND empresa_id = p_empresa_id;
  END IF;

  WITH scored AS (
    SELECT
      e.id AS edital_id,
      greatest(0, least(100,
        10
        + CASE
            WHEN v_user_type = 'pesquisador' AND e.is_researcher IS TRUE THEN 45
            WHEN v_user_type = 'pesquisador' AND e.is_researcher IS FALSE THEN -50
            WHEN v_user_type = 'consultor' AND e.is_company IS TRUE THEN 45
            WHEN v_user_type = 'consultor' AND e.is_company IS FALSE THEN -50
            ELSE 0
          END
        + CASE
            WHEN coalesce(v_area, '') <> ''
             AND lower(coalesce(e.area, '') || ' ' || coalesce(e.titulo, '') || ' ' || coalesce(e.descricao, '') || ' ' || coalesce(e.sobre_programa, ''))
                 LIKE '%' || lower(v_area) || '%' THEN 25
            ELSE 0
          END
        + CASE
            WHEN e.data_encerramento IS NULL THEN 5
            WHEN e.data_encerramento::date >= current_date THEN 15
            ELSE -35
          END
        + CASE WHEN e.valor_projeto IS NOT NULL OR e.valor IS NOT NULL THEN 5 ELSE 0 END
        + CASE WHEN e.sobre_programa IS NOT NULL OR e.criterios_elegibilidade IS NOT NULL THEN 5 ELSE 0 END
      ))::integer AS score,
      array_remove(ARRAY[
        CASE
          WHEN v_user_type = 'pesquisador' AND e.is_researcher IS TRUE THEN 'Elegível para pesquisadores/ICTs'
          WHEN v_user_type = 'consultor' AND e.is_company IS TRUE THEN 'Elegível para empresas/startups'
          ELSE NULL
        END,
        CASE
          WHEN coalesce(v_area, '') <> ''
           AND lower(coalesce(e.area, '') || ' ' || coalesce(e.titulo, '') || ' ' || coalesce(e.descricao, '') || ' ' || coalesce(e.sobre_programa, ''))
               LIKE '%' || lower(v_area) || '%' THEN
            CASE WHEN p_empresa_id IS NOT NULL THEN 'Área alinhada à empresa' ELSE 'Área alinhada ao seu perfil' END
          ELSE NULL
        END,
        CASE
          WHEN e.data_encerramento IS NULL THEN 'Prazo não identificado automaticamente'
          WHEN e.data_encerramento::date >= current_date THEN 'Prazo ainda aberto'
          ELSE 'Prazo possivelmente encerrado'
        END,
        CASE WHEN e.valor_projeto IS NOT NULL OR e.valor IS NOT NULL THEN 'Possui informação de valor/financiamento' ELSE NULL END
      ], NULL)::text[] AS motivos
    FROM public.editais_corretos e
    ORDER BY e.validado_em DESC NULLS LAST, e.criado_em DESC NULLS LAST
    LIMIT 500
  ),
  picked AS (
    SELECT *
      FROM scored
     WHERE score >= 25
     ORDER BY score DESC
     LIMIT v_limit
  ),
  inserted AS (
    INSERT INTO public.edital_indicacoes (user_id, empresa_id, edital_id, score, motivos, gerado_em)
    SELECT p_user_id, p_empresa_id, edital_id, score, motivos, now()
      FROM picked
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM inserted;

  RETURN coalesce(v_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_my_indicacoes(uuid, integer, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_my_indicacoes(uuid, integer, uuid) TO service_role;
