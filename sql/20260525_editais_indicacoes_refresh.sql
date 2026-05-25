-- Indicações personalizadas para o dashboard.
-- Aplicar no Supabase quando a API retornar:
-- "Could not find the function public.refresh_my_indicacoes(...) in the schema cache".

create table if not exists public.edital_indicacoes (
  user_id uuid not null,
  edital_id uuid not null,
  score integer not null default 0,
  motivos text[] not null default '{}'::text[],
  gerado_em timestamptz not null default now(),
  primary key (user_id, edital_id)
);

create index if not exists edital_indicacoes_user_score_idx
  on public.edital_indicacoes (user_id, score desc, gerado_em desc);

create or replace function public.refresh_my_indicacoes(
  p_user_id uuid,
  p_limit integer default 20
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
  v_profile record;
  v_count integer := 0;
begin
  select *
    into v_profile
    from public.profiles
   where user_id = p_user_id
   limit 1;

  delete from public.edital_indicacoes where user_id = p_user_id;

  with scored as (
    select
      e.id as edital_id,
      greatest(0, least(100,
        10
        + case
            when coalesce(v_profile.user_type, 'pesquisador') = 'pesquisador' and e.is_researcher is true then 45
            when coalesce(v_profile.user_type, 'pesquisador') = 'pesquisador' and e.is_researcher is false then -50
            when coalesce(v_profile.user_type, 'pesquisador') = 'pessoa-empresa' and e.is_company is true then 45
            when coalesce(v_profile.user_type, 'pesquisador') = 'pessoa-empresa' and e.is_company is false then -50
            when coalesce(v_profile.user_type, 'pesquisador') = 'ambos' and (e.is_researcher is true or e.is_company is true) then 35
            else 0
          end
        + case
            when coalesce(v_profile.area, '') <> ''
             and lower(coalesce(e.area, '') || ' ' || coalesce(e.titulo, '') || ' ' || coalesce(e.descricao, '') || ' ' || coalesce(e.sobre_programa, ''))
                 like '%' || lower(v_profile.area) || '%' then 25
            else 0
          end
        + case
            when e.data_encerramento is null then 5
            when e.data_encerramento::date >= current_date then 15
            else -35
          end
        + case when e.valor_projeto is not null or e.valor is not null then 5 else 0 end
        + case when e.sobre_programa is not null or e.criterios_elegibilidade is not null then 5 else 0 end
      ))::integer as score,
      array_remove(array[
        case
          when coalesce(v_profile.user_type, 'pesquisador') = 'pesquisador' and e.is_researcher is true then 'Elegível para pesquisadores/ICTs'
          when coalesce(v_profile.user_type, 'pesquisador') = 'pessoa-empresa' and e.is_company is true then 'Elegível para empresas/startups'
          when coalesce(v_profile.user_type, 'pesquisador') = 'ambos' and (e.is_researcher is true or e.is_company is true) then 'Compatível com seu tipo de perfil'
          else null
        end,
        case
          when coalesce(v_profile.area, '') <> ''
           and lower(coalesce(e.area, '') || ' ' || coalesce(e.titulo, '') || ' ' || coalesce(e.descricao, '') || ' ' || coalesce(e.sobre_programa, ''))
               like '%' || lower(v_profile.area) || '%' then 'Área alinhada ao seu perfil'
          else null
        end,
        case
          when e.data_encerramento is null then 'Prazo não identificado automaticamente'
          when e.data_encerramento::date >= current_date then 'Prazo ainda aberto'
          else 'Prazo possivelmente encerrado'
        end,
        case when e.valor_projeto is not null or e.valor is not null then 'Possui informação de valor/financiamento' else null end
      ], null)::text[] as motivos
    from public.editais_corretos e
    order by e.validado_em desc nulls last, e.criado_em desc nulls last
    limit 500
  ),
  picked as (
    select *
      from scored
     where score >= 25
     order by score desc
     limit v_limit
  ),
  inserted as (
    insert into public.edital_indicacoes (user_id, edital_id, score, motivos, gerado_em)
    select p_user_id, edital_id, score, motivos, now()
      from picked
    on conflict (user_id, edital_id) do update
      set score = excluded.score,
          motivos = excluded.motivos,
          gerado_em = excluded.gerado_em
    returning 1
  )
  select count(*) into v_count from inserted;

  return coalesce(v_count, 0);
end;
$$;

grant execute on function public.refresh_my_indicacoes(uuid, integer) to authenticated;
