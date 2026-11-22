-- LockIn Sengketa 1B: backward-compatible fields for persistent vendor response.
-- Run ONCE in Supabase SQL Editor; safe to rerun. No existing rows modified.
-- This is not a refund/release migration.
BEGIN;
ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS vendor_evidence_url TEXT,
  ADD COLUMN IF NOT EXISTS decision_reason TEXT,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

-- Only the trusted backend's service_role may read or submit vendor responses.
-- Do not grant these rights to anon/authenticated.
GRANT SELECT ON TABLE public.disputes TO service_role;
GRANT UPDATE (response, vendor_evidence_url) ON TABLE public.disputes TO service_role;
COMMIT;
NOTIFY pgrst, 'reload schema';
