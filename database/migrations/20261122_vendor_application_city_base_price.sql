-- Run manually in Supabase SQL Editor after review.
-- Added columns remain nullable so existing applications keep NULL values.
ALTER TABLE public.vendor_applications
  ADD COLUMN IF NOT EXISTS city TEXT;

ALTER TABLE public.vendor_applications
  ADD COLUMN IF NOT EXISTS base_price NUMERIC(12,2);

-- The earlier draft migration used INTEGER; this preserves existing integer values
-- while bringing that column to the requested precision when it already exists.
ALTER TABLE public.vendor_applications
  ALTER COLUMN base_price TYPE NUMERIC(12,2)
  USING base_price::NUMERIC(12,2);

COMMENT ON COLUMN public.vendor_applications.city IS 'Primary service city selected by the applicant.';
COMMENT ON COLUMN public.vendor_applications.base_price IS 'Positive base service price in Indonesian Rupiah.';
