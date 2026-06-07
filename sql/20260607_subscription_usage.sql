-- Contadores de uso por plano (ex.: 3 editais/mês no gratuito)
CREATE TABLE IF NOT EXISTS public.subscription_usage (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  metric text NOT NULL,
  period_key text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  unique_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, metric, period_key)
);

CREATE INDEX IF NOT EXISTS subscription_usage_period_idx
  ON public.subscription_usage (period_key);

ALTER TABLE public.subscription_usage ENABLE ROW LEVEL SECURITY;
