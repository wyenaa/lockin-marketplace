-- Run manually in Supabase SQL Editor after reviewing existing vendor applications.
-- New nullable columns intentionally leave all existing application records NULL.
ALTER TABLE public.vendor_applications
  ADD COLUMN IF NOT EXISTS city TEXT;

ALTER TABLE public.vendor_applications
  ADD COLUMN IF NOT EXISTS base_price INTEGER;

COMMENT ON COLUMN public.vendor_applications.city IS 'Primary service city selected by the applicant.';
COMMENT ON COLUMN public.vendor_applications.base_price IS 'Positive integer base service price in Indonesian Rupiah.';
