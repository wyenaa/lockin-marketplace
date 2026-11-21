-- Vendor jasa applications are separate from public.vendors and auth users.
-- Run manually in Supabase SQL Editor after review.
CREATE TABLE IF NOT EXISTS public.vendor_applications (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  email TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  category TEXT NOT NULL,
  instagram TEXT NOT NULL DEFAULT '',
  portfolio_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price_range TEXT NOT NULL DEFAULT 'Belum dicantumkan',
  status TEXT NOT NULL DEFAULT 'pending_approval',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vendor_applications_created_at_idx
  ON public.vendor_applications (created_at DESC);
CREATE INDEX IF NOT EXISTS vendor_applications_status_idx
  ON public.vendor_applications (status);

ALTER TABLE public.vendor_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vendor_applications FROM anon, authenticated;
GRANT ALL ON TABLE public.vendor_applications TO service_role;
