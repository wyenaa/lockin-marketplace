-- Run manually after vendor_applications and its city/base_price columns exist.
-- Approval inserts the catalog listing and marks the application in one transaction.

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS source_application_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vendors_source_application_id_fkey'
      AND conrelid = 'public.vendors'::regclass
  ) THEN
    ALTER TABLE public.vendors
      ADD CONSTRAINT vendors_source_application_id_fkey
      FOREIGN KEY (source_application_id)
      REFERENCES public.vendor_applications(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS vendors_source_application_id_uidx
  ON public.vendors (source_application_id)
  WHERE source_application_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.process_vendor_application_decision(
  p_application_id TEXT,
  p_status TEXT,
  p_expected_base_price NUMERIC DEFAULT NULL,
  p_expected_category TEXT DEFAULT NULL,
  p_price_max INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  application_row public.vendor_applications%ROWTYPE;
  vendor_row public.vendors%ROWTYPE;
  operator_id UUID;
  catalog_category TEXT;
  catalog_color TEXT;
BEGIN
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Status keputusan tidak valid.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO application_row
  FROM public.vendor_applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pengajuan tidak ditemukan.' USING ERRCODE = 'P0002';
  END IF;
  IF application_row.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Pengajuan sudah diproses.' USING ERRCODE = 'P0001';
  END IF;

  IF p_status = 'rejected' THEN
    UPDATE public.vendor_applications
      SET status = 'rejected'
      WHERE id = p_application_id
      RETURNING * INTO application_row;
    RETURN jsonb_build_object('ok', TRUE, 'application', to_jsonb(application_row), 'vendor', NULL);
  END IF;

  IF application_row.name IS NULL OR btrim(application_row.name) = ''
     OR application_row.owner_name IS NULL OR btrim(application_row.owner_name) = ''
     OR application_row.email IS NULL OR btrim(application_row.email) = ''
     OR application_row.whatsapp IS NULL OR btrim(application_row.whatsapp) = '' THEN
    RAISE EXCEPTION 'Data identitas pengajuan belum lengkap.' USING ERRCODE = '22023';
  END IF;
  IF application_row.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Email pengajuan tidak valid.' USING ERRCODE = '22023';
  END IF;

  catalog_category := CASE application_row.category
    WHEN 'PA Wisuda' THEN 'PA Wisuda'
    WHEN 'Graduation Content Creator' THEN 'GCC'
    WHEN 'GCC' THEN 'GCC'
    WHEN 'Hijab & Hair Stylist' THEN 'Hijab & Hair Stylist'
    WHEN 'MUA' THEN 'MUA'
    WHEN 'Acrylic Standing Sign' THEN 'Standing Sign'
    WHEN 'Standing Sign' THEN 'Standing Sign'
    ELSE NULL
  END;
  IF catalog_category IS NULL THEN
    RAISE EXCEPTION 'Kategori pengajuan tidak didukung katalog LockIn.' USING ERRCODE = '22023';
  END IF;
  IF application_row.city IS NULL OR application_row.city NOT IN ('Malang', 'Surabaya', 'Yogyakarta', 'Semarang', 'Solo', 'Bandung', 'Bogor') THEN
    RAISE EXCEPTION 'Kota layanan pengajuan tidak didukung.' USING ERRCODE = '22023';
  END IF;
  IF application_row.base_price IS NULL OR application_row.base_price <= 0
     OR application_row.base_price > 2147483647
     OR application_row.base_price <> trunc(application_row.base_price)
     OR p_price_max IS NULL OR p_price_max < application_row.base_price OR p_price_max <= 0 THEN
    RAISE EXCEPTION 'Harga dasar atau harga paket tidak sesuai tipe kolom katalog.' USING ERRCODE = '22023';
  END IF;
  IF p_expected_base_price IS DISTINCT FROM application_row.base_price
     OR p_expected_category IS DISTINCT FROM application_row.category THEN
    RAISE EXCEPTION 'Data pengajuan berubah saat diproses. Muat ulang dan coba lagi.' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO operator_id
  FROM public.users
  WHERE lower(email) = lower('vendor@lockin.demo') AND role = 'vendor'
  ORDER BY created_at NULLS FIRST
  LIMIT 1;
  IF operator_id IS NULL THEN
    RAISE EXCEPTION 'Akun vendor operator bersama belum tersedia.' USING ERRCODE = '55000';
  END IF;

  catalog_color := CASE catalog_category
    WHEN 'MUA' THEN 'gold'
    WHEN 'Hijab & Hair Stylist' THEN 'green'
    WHEN 'GCC' THEN 'blue'
    WHEN 'PA Wisuda' THEN 'pink'
    WHEN 'Standing Sign' THEN 'purple'
  END;

  INSERT INTO public.vendors (
    owner_id, name, category, city, instagram, whatsapp, price, price_max,
    price_type, deposit, rating, completed, verified, color, description,
    source_application_id
  ) VALUES (
    operator_id, application_row.name, catalog_category, application_row.city,
    NULLIF(application_row.instagram, ''), NULLIF(application_row.whatsapp, ''),
    application_row.base_price::INTEGER, p_price_max, 'listed', 0, 0, 0, TRUE,
    catalog_color, NULLIF(application_row.description, ''), application_row.id
  ) RETURNING * INTO vendor_row;

  UPDATE public.vendor_applications
    SET status = 'approved'
    WHERE id = p_application_id
    RETURNING * INTO application_row;

  RETURN jsonb_build_object('ok', TRUE, 'application', to_jsonb(application_row), 'vendor', to_jsonb(vendor_row));
END;
$$;

REVOKE ALL ON FUNCTION public.process_vendor_application_decision(TEXT, TEXT, NUMERIC, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_vendor_application_decision(TEXT, TEXT, NUMERIC, TEXT, INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_vendor_application_decision(TEXT, TEXT, NUMERIC, TEXT, INTEGER) TO service_role;
