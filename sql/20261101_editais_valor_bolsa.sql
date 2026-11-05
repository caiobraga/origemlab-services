-- Valor mensal por bolsa (ex.: "ATP-B: R$ 560,00/mês"). Preenchido por extração dirigida
-- a partir dos trechos indexados em `documents`; NULL quando o edital não define valor de bolsa.
ALTER TABLE public.editais
  ADD COLUMN IF NOT EXISTS valor_bolsa text;
