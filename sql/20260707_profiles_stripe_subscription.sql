-- Stripe / planos: colunas ausentes impediam webhook e sync de gravar assinatura Pro.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_status text,
  ADD COLUMN IF NOT EXISTS subscription_plan_key text,
  ADD COLUMN IF NOT EXISTS subscription_price_id text,
  ADD COLUMN IF NOT EXISTS subscription_current_period_end timestamptz;

CREATE INDEX IF NOT EXISTS profiles_stripe_subscription_id_idx
  ON public.profiles (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS profiles_stripe_customer_id_idx
  ON public.profiles (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
