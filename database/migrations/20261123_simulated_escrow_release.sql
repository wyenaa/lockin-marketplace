-- Run manually after reviewing. This migration does not transfer real funds.
-- Existing booking and ledger rows are preserved; only future release records
-- are protected by the unique partial index below.

-- Read-only preflight query: resolve any reported duplicates before applying
-- the unique index. This migration intentionally does not delete legacy rows.
-- SELECT booking_id, COUNT(*) AS release_count, ARRAY_AGG(id ORDER BY id) AS ledger_ids
-- FROM public.ledger_entries
-- WHERE entry_type = 'SIMULATED_RELEASE'
-- GROUP BY booking_id
-- HAVING COUNT(*) > 1
-- ORDER BY booking_id;

-- Older Supabase installations may predate these nullable dispute fields.
-- Adding them preserves existing rows and makes the dispute RPC compatible.
ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS evidence_url TEXT;

ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS vendor_response_due TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_simulated_release_booking_uidx
  ON public.ledger_entries (booking_id)
  WHERE entry_type = 'SIMULATED_RELEASE';

-- Persist new disputes and move their booking to Disputed atomically. Using the
-- same booking row lock as release prevents a dispute/release race.
CREATE OR REPLACE FUNCTION public.create_booking_dispute_with_hold(
  p_dispute_id TEXT,
  p_booking_id TEXT,
  p_reason TEXT,
  p_evidence TEXT,
  p_evidence_url TEXT,
  p_vendor_response_due TIMESTAMPTZ,
  p_created_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  booking_row public.bookings%ROWTYPE;
  dispute_row public.disputes%ROWTYPE;
BEGIN
  SELECT * INTO booking_row
  FROM public.bookings
  WHERE id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking tidak ditemukan.' USING ERRCODE = 'P0002';
  END IF;
  IF booking_row.state NOT IN ('DPPaid', 'Paid') THEN
    RAISE EXCEPTION 'Booking tidak memenuhi syarat sengketa.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.disputes WHERE booking_id = p_booking_id) THEN
    RAISE EXCEPTION 'Sengketa untuk booking ini sudah tercatat.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.disputes (
    id, booking_id, reason, evidence, evidence_url, response,
    vendor_response_due, created_at
  ) VALUES (
    p_dispute_id, p_booking_id, p_reason, p_evidence, p_evidence_url, '',
    p_vendor_response_due, p_created_at
  ) RETURNING * INTO dispute_row;

  UPDATE public.bookings
    SET state = 'Disputed', updated_at = p_created_at
    WHERE id = p_booking_id
    RETURNING * INTO booking_row;

  INSERT INTO public.audit (booking_id, state, created_at)
    VALUES (p_booking_id, 'Disputed', p_created_at);

  RETURN jsonb_build_object('ok', TRUE, 'booking', to_jsonb(booking_row), 'dispute', to_jsonb(dispute_row));
END;
$$;

-- Completion and payout record share one transaction. Only successful funds
-- confirmed by both payments and SIMULATED_HELD entries can be released.
-- Release amount is the service price; vendor deposit remains held for its own
-- workflow, and the separately displayed 3% platform fee is never subtracted.
CREATE OR REPLACE FUNCTION public.complete_booking_with_simulated_release(
  p_booking_id TEXT,
  p_released_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  booking_row public.bookings%ROWTYPE;
  release_row public.ledger_entries%ROWTYPE;
  expected_funds BIGINT;
  successful_amount BIGINT;
  held_amount BIGINT;
  unmatched_held_count BIGINT;
  invalid_held_count BIGINT;
BEGIN
  SELECT * INTO booking_row
  FROM public.bookings
  WHERE id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking tidak ditemukan.' USING ERRCODE = 'P0002';
  END IF;
  IF booking_row.state <> 'Paid' OR booking_row.execution_state <> 'IN_PROGRESS'
     OR booking_row.vendor_arrived IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Booking belum lunas atau kehadiran vendor belum terverifikasi.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.disputes
    WHERE booking_id = p_booking_id AND decision IS NULL
  ) OR booking_row.state = 'Disputed' THEN
    RAISE EXCEPTION 'Pencairan ditahan selama sengketa aktif.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ledger_entries
    WHERE booking_id = p_booking_id AND entry_type = 'SIMULATED_RELEASE'
  ) THEN
    RAISE EXCEPTION 'Pencairan booking sudah tercatat.' USING ERRCODE = 'P0001';
  END IF;
  IF booking_row.price IS NULL OR booking_row.price <= 0 THEN
    RAISE EXCEPTION 'Harga jasa booking tidak valid.' USING ERRCODE = '22023';
  END IF;

  expected_funds := booking_row.price::BIGINT + GREATEST(COALESCE(booking_row.deposit, 0), 0)::BIGINT;
  SELECT COALESCE(SUM(amount), 0)::BIGINT INTO successful_amount
    FROM public.payments
    WHERE booking_id = p_booking_id AND outcome = 'success';
  SELECT COALESCE(SUM(amount), 0)::BIGINT INTO held_amount
    FROM public.ledger_entries
    WHERE booking_id = p_booking_id AND entry_type = 'SIMULATED_HELD';
  SELECT COUNT(*)::BIGINT INTO unmatched_held_count
    FROM (
      SELECT p.id
      FROM public.payments p
      LEFT JOIN public.ledger_entries le
        ON le.payment_id = p.id
       AND le.booking_id = p.booking_id
       AND le.entry_type = 'SIMULATED_HELD'
      WHERE p.booking_id = p_booking_id
        AND p.outcome = 'success'
      GROUP BY p.id, p.amount
      HAVING COUNT(le.id) <> 1 OR COALESCE(SUM(le.amount), 0) <> p.amount
    ) AS incomplete_payments;
  SELECT COUNT(*)::BIGINT INTO invalid_held_count
    FROM public.ledger_entries le
    LEFT JOIN public.payments p
      ON p.id = le.payment_id
     AND p.booking_id = le.booking_id
     AND p.outcome = 'success'
    WHERE le.booking_id = p_booking_id
      AND le.entry_type = 'SIMULATED_HELD'
      AND (p.id IS NULL OR p.amount <> le.amount OR le.amount <= 0);

  IF COALESCE(booking_row.paid, 0)::BIGINT <> expected_funds
     OR successful_amount <> expected_funds OR held_amount <> expected_funds
     OR unmatched_held_count <> 0 OR invalid_held_count <> 0 THEN
    RAISE EXCEPTION 'Dana escrow belum tercatat lunas.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.ledger_entries (booking_id, payment_id, entry_type, amount, created_at)
    VALUES (p_booking_id, NULL, 'SIMULATED_RELEASE', booking_row.price, p_released_at)
    RETURNING * INTO release_row;

  UPDATE public.bookings
    SET state = 'Completed', execution_state = 'COMPLETED', updated_at = p_released_at
    WHERE id = p_booking_id
    RETURNING * INTO booking_row;

  INSERT INTO public.audit (booking_id, state, created_at)
    VALUES (p_booking_id, 'Completed:SIMULATED_RELEASE', p_released_at);

  RETURN jsonb_build_object('ok', TRUE, 'booking', to_jsonb(booking_row), 'release', to_jsonb(release_row));
END;
$$;

REVOKE ALL ON FUNCTION public.create_booking_dispute_with_hold(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_booking_dispute_with_hold(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking_dispute_with_hold(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

REVOKE ALL ON FUNCTION public.complete_booking_with_simulated_release(TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_booking_with_simulated_release(TEXT, TIMESTAMPTZ) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_booking_with_simulated_release(TEXT, TIMESTAMPTZ) TO service_role;
