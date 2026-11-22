-- LockIn Sengketa 1D: execute an existing admin decision in the simulated ledger.
-- No Midtrans refund, bank transfer, token transfer, or Sepolia transaction.
-- PRECONDITION: Sengketa 1A/1B/1C migrations were applied.
-- Run this migration in Supabase SQL Editor before enabling 1D on the website.
-- Read-only preflight (must return zero rows):
-- SELECT booking_id, COUNT(*) FROM public.ledger_entries
-- WHERE entry_type = 'SIMULATED_REFUND' GROUP BY booking_id HAVING COUNT(*) > 1;
BEGIN;
ALTER TABLE public.disputes ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_simulated_refund_booking_uidx
  ON public.ledger_entries(booking_id) WHERE entry_type = 'SIMULATED_REFUND';

CREATE OR REPLACE FUNCTION public.execute_dispute_simulated_settlement(
  p_dispute_id TEXT, p_executed_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  booking_id_value TEXT;
  booking_row public.bookings%ROWTYPE;
  dispute_row public.disputes%ROWTYPE;
  successful_amount BIGINT;
  held_amount BIGINT;
  incomplete_count BIGINT;
  invalid_count BIGINT;
  service_funds BIGINT;
  refund_amount BIGINT;
  vendor_amount BIGINT;
BEGIN
  SELECT booking_id INTO booking_id_value FROM public.disputes WHERE id = p_dispute_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sengketa tidak ditemukan.' USING ERRCODE = 'P0002'; END IF;

  -- Same lock ordering as dispute creation, decision recording, and normal release.
  SELECT * INTO booking_row FROM public.bookings WHERE id = booking_id_value FOR UPDATE;
  IF NOT FOUND OR booking_row.state <> 'Disputed' THEN
    RAISE EXCEPTION 'Booking tidak lagi dalam sengketa aktif.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO dispute_row FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND OR dispute_row.booking_id <> booking_id_value OR dispute_row.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Penyelesaian sudah tercatat atau sengketa berubah.' USING ERRCODE = 'P0001';
  END IF;
  IF dispute_row.decision IS NULL OR dispute_row.decided_at IS NULL OR dispute_row.refund_percent IS NULL OR
     dispute_row.decision NOT IN ('full','partial','release') OR
     (dispute_row.decision = 'full' AND dispute_row.refund_percent <> 100) OR
     (dispute_row.decision = 'release' AND dispute_row.refund_percent <> 0) OR
     (dispute_row.decision = 'partial' AND dispute_row.refund_percent NOT BETWEEN 1 AND 99) THEN
    RAISE EXCEPTION 'Keputusan admin belum valid atau belum tercatat.' USING ERRCODE = 'P0001';
  END IF;
  IF p_executed_at IS NULL OR p_executed_at < dispute_row.decided_at OR
     p_executed_at > clock_timestamp() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Waktu pelaksanaan tidak valid.' USING ERRCODE = 'P0001';
  END IF;
  IF booking_row.price IS NULL OR booking_row.price <= 0 OR
     COALESCE(booking_row.deposit,0) < 0 OR COALESCE(booking_row.paid,0) <= 0 THEN
    RAISE EXCEPTION 'Nominal booking tidak valid.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_entries WHERE booking_id = booking_id_value
             AND entry_type IN ('SIMULATED_RELEASE','SIMULATED_REFUND')) THEN
    RAISE EXCEPTION 'Dana sudah dialokasikan; diperlukan pemeriksaan manual.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(amount),0)::BIGINT INTO successful_amount
    FROM public.payments WHERE booking_id = booking_id_value AND outcome = 'success';
  SELECT COALESCE(SUM(amount),0)::BIGINT INTO held_amount
    FROM public.ledger_entries WHERE booking_id = booking_id_value AND entry_type = 'SIMULATED_HELD';
  SELECT COUNT(*)::BIGINT INTO incomplete_count FROM (
    SELECT p.id FROM public.payments p
      LEFT JOIN public.ledger_entries le ON le.payment_id = p.id AND le.booking_id = p.booking_id
        AND le.entry_type = 'SIMULATED_HELD'
    WHERE p.booking_id = booking_id_value AND p.outcome = 'success'
    GROUP BY p.id,p.amount
    HAVING COUNT(le.id) <> 1 OR COALESCE(SUM(le.amount),0) <> p.amount
  ) bad;
  SELECT COUNT(*)::BIGINT INTO invalid_count
    FROM public.ledger_entries le
    LEFT JOIN public.payments p ON p.id = le.payment_id AND p.booking_id = le.booking_id AND p.outcome = 'success'
    WHERE le.booking_id = booking_id_value AND le.entry_type = 'SIMULATED_HELD'
      AND (p.id IS NULL OR p.amount <> le.amount OR le.amount <= 0);
  IF successful_amount <> booking_row.paid::BIGINT OR held_amount <> successful_amount OR
     held_amount > booking_row.price::BIGINT + COALESCE(booking_row.deposit,0)::BIGINT OR
     incomplete_count <> 0 OR invalid_count <> 0 THEN
    RAISE EXCEPTION 'Dana jasa dan pembayaran terverifikasi belum konsisten.' USING ERRCODE = 'P0001';
  END IF;

  -- Settle only service funds ACTUALLY collected; an unpaid remainder is not refundable.
  -- Vendor deposit remains outside this settlement and is not released here.
  service_funds := LEAST(booking_row.price::BIGINT,
    GREATEST(0::BIGINT, held_amount - LEAST(COALESCE(booking_row.deposit,0)::BIGINT,held_amount)));
  IF service_funds <= 0 THEN
    RAISE EXCEPTION 'Belum ada dana jasa yang dapat diselesaikan.' USING ERRCODE = 'P0001';
  END IF;
  refund_amount := (service_funds * dispute_row.refund_percent + 50) / 100;
  vendor_amount := service_funds - refund_amount;
  IF refund_amount < 0 OR vendor_amount < 0 OR refund_amount > 2147483647 OR vendor_amount > 2147483647 THEN
    RAISE EXCEPTION 'Jumlah pembagian tidak valid.' USING ERRCODE = '22023';
  END IF;

  IF refund_amount > 0 THEN
    INSERT INTO public.ledger_entries(booking_id,payment_id,entry_type,amount,created_at)
      VALUES(booking_id_value,NULL,'SIMULATED_REFUND',refund_amount::INTEGER,p_executed_at);
  END IF;
  IF vendor_amount > 0 THEN
    INSERT INTO public.ledger_entries(booking_id,payment_id,entry_type,amount,created_at)
      VALUES(booking_id_value,NULL,'SIMULATED_RELEASE',vendor_amount::INTEGER,p_executed_at);
  END IF;

  UPDATE public.disputes SET refund = refund_amount::INTEGER, settled_at = p_executed_at
    WHERE id = p_dispute_id AND settled_at IS NULL RETURNING * INTO dispute_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Penyelesaian sudah tercatat.' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.bookings SET state = 'Resolved', updated_at = p_executed_at
    WHERE id = booking_id_value RETURNING * INTO booking_row;
  INSERT INTO public.audit(booking_id,state,created_at)
    VALUES(booking_id_value,'DisputeSettlementSimulated:REFUND=' || refund_amount || ':VENDOR=' || vendor_amount,p_executed_at);
  RETURN jsonb_build_object('ok',TRUE,'booking',to_jsonb(booking_row),'dispute',to_jsonb(dispute_row),
    'settlement',jsonb_build_object('simulated',TRUE,'status','SETTLED',
      'serviceAmount',service_funds,'refundAmount',refund_amount,'vendorAmount',vendor_amount,
      'refundPercent',dispute_row.refund_percent,'settledAt',p_executed_at));
END;
$$;
REVOKE ALL ON FUNCTION public.execute_dispute_simulated_settlement(TEXT,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.execute_dispute_simulated_settlement(TEXT,TIMESTAMPTZ) FROM anon,authenticated;
GRANT EXECUTE ON FUNCTION public.execute_dispute_simulated_settlement(TEXT,TIMESTAMPTZ) TO service_role;
COMMIT;
NOTIFY pgrst, 'reload schema';
