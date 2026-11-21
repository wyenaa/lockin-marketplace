-- Payment intent idempotency and explicit event execution state.
-- Nullable payment columns preserve all existing transaction rows without rewriting them.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS execution_state TEXT NOT NULL DEFAULT 'NOT_STARTED';

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS final_confirmed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_key_uidx
  ON public.payments(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
