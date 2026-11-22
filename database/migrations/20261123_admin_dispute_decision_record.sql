-- LockIn Sengketa 1C: ONLY records the administrator's mediation decision.
-- No ledger entry, refund, release, blockchain update, or booking state transition.
-- Apply in Supabase SQL Editor before using the admin decision form.
BEGIN;
ALTER TABLE public.disputes ADD COLUMN IF NOT EXISTS refund_percent SMALLINT;

CREATE OR REPLACE FUNCTION public.record_dispute_admin_decision(
  p_dispute_id TEXT, p_decision TEXT, p_decision_reason TEXT,
  p_refund_percent INTEGER, p_decided_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  booking_id_value TEXT;
  booking_row public.bookings%ROWTYPE;
  dispute_row public.disputes%ROWTYPE;
BEGIN
  SELECT booking_id INTO booking_id_value FROM public.disputes WHERE id = p_dispute_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sengketa tidak ditemukan.' USING ERRCODE = 'P0002'; END IF;

  -- Match lock ordering of booking completion/dispute creation: booking first.
  SELECT * INTO booking_row FROM public.bookings WHERE id = booking_id_value FOR UPDATE;
  IF NOT FOUND OR booking_row.state <> 'Disputed' THEN
    RAISE EXCEPTION 'Booking tidak dalam sengketa aktif.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO dispute_row FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND OR dispute_row.booking_id <> booking_id_value OR dispute_row.decision IS NOT NULL THEN
    RAISE EXCEPTION 'Sengketa sudah berubah atau diputuskan.' USING ERRCODE = 'P0001';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('release', 'full', 'partial') OR p_refund_percent IS NULL OR
     (p_decision = 'release' AND p_refund_percent <> 0) OR
     (p_decision = 'full' AND p_refund_percent <> 100) OR
     (p_decision = 'partial' AND p_refund_percent NOT BETWEEN 1 AND 99) THEN
    RAISE EXCEPTION 'Pilihan keputusan atau persentase tidak valid.' USING ERRCODE = 'P0001';
  END IF;
  IF p_decision_reason IS NULL OR length(btrim(p_decision_reason)) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'Alasan keputusan tidak valid.' USING ERRCODE = 'P0001';
  END IF;
  IF p_decided_at IS NULL OR p_decided_at > clock_timestamp() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Waktu keputusan tidak valid.' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(btrim(dispute_row.response), '') = '' AND
     (dispute_row.vendor_response_due IS NULL OR dispute_row.vendor_response_due > clock_timestamp()) THEN
    RAISE EXCEPTION 'Tanggapan vendor belum tersedia dan tenggat belum lewat.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_entries
             WHERE booking_id = booking_id_value AND entry_type = 'SIMULATED_RELEASE') THEN
    RAISE EXCEPTION 'Dana sudah dicairkan; sengketa memerlukan pemeriksaan manual.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.disputes SET decision = p_decision,
    decision_reason = btrim(p_decision_reason), refund_percent = p_refund_percent,
    decided_at = p_decided_at
    WHERE id = p_dispute_id AND decision IS NULL
    RETURNING * INTO dispute_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Keputusan sudah tercatat.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.audit (booking_id, state, created_at)
    VALUES (booking_id_value, 'DisputeDecisionRecorded:' || p_decision || ':' || p_refund_percent, p_decided_at);
  RETURN jsonb_build_object('ok', TRUE, 'dispute', to_jsonb(dispute_row), 'pendingExecution', TRUE);
END;
$$;

REVOKE ALL ON FUNCTION public.record_dispute_admin_decision(TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_dispute_admin_decision(TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_dispute_admin_decision(TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ) TO service_role;
COMMIT;
NOTIFY pgrst, 'reload schema';
