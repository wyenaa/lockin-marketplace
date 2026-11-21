// LockIn — Webhook handler Midtrans
// Menerima notifikasi pembayaran dari Midtrans, verifikasi signature,
// update status di Supabase, lalu queue blockchain job.
import { verifySignature, interpretNotification } from '../services/midtrans.js';
import { supabase } from '../db/supabase.js';

export async function handleMidtransWebhook(req, res, body, localStores = null) {
  const key = process.env.MIDTRANS_SIGNATURE_SECRET_KEY;
  if (!key) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Signature Secret Key belum diatur.' }));
  }

  // 1. Verifikasi signature — tolak jika tidak valid
  if (!verifySignature(body, key)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Signature Midtrans tidak valid.' }));
  }

  try {
    const result = await recordNotification(body, localStores);
    if (result.status === 'rejected') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[Webhook Midtrans]', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Webhook tidak dapat diproses.' }));
  }
}

/**
 * Proses notifikasi Midtrans dan update status di Supabase & Local Store.
 * Idempotent — aman dipanggil lebih dari sekali untuk order yang sama.
 */
export async function recordNotification(notification, localStores = null) {
  let payment = null;
  if (supabase) {
    const { data: payments, error } = await supabase
      .from('payments')
      .select('*')
      .eq('provider_order_id', notification.order_id)
      .limit(1);
    if (error) throw new Error(`Gagal membaca pembayaran: ${error.message}`);
    if (payments?.length) payment = payments[0];
  } else if (localStores?.localPayments) {
    payment = Array.from(localStores.localPayments.values()).find(p => p.provider_order_id === notification.order_id);
  }

  if (!payment) return { status: 'ignored', reason: 'Unknown order_id' };

  const amount = Number(notification.gross_amount);
  if (!Number.isFinite(amount) || amount !== payment.amount)
    return { status: 'rejected', reason: 'Jumlah pembayaran tidak cocok.' };

  if (!['DP', 'FINAL'].includes(payment.payment_type))
    return { status: 'rejected', reason: 'Jenis pembayaran tidak dikenal.' };

  if (payment.payment_type === 'FINAL') {
    if (!payment.final_confirmed_at) return { status: 'rejected', reason: 'Pelunasan tidak memiliki konfirmasi pelanggan.' };
    let booking = null;
    let dpPaid = false;
    if (supabase) {
      const { data: bk, error: bookingError } = await supabase.from('bookings').select('id').eq('id', payment.booking_id).maybeSingle();
      if (bookingError) throw new Error(`Gagal membaca booking pelunasan: ${bookingError.message}`);
      const { data: dp, error: paymentError } = await supabase.from('payments').select('id').eq('booking_id', payment.booking_id).eq('payment_type', 'DP').eq('outcome', 'success').limit(1);
      if (paymentError) throw new Error(`Gagal memeriksa DP: ${paymentError.message}`);
      booking = bk;
      dpPaid = Boolean(dp?.length);
    } else if (localStores?.localBookings) {
      booking = localStores.localBookings.get(payment.booking_id);
      const dpPayment = Array.from(localStores.localPayments.values()).find(p => p.booking_id === payment.booking_id && p.payment_type === 'DP' && p.outcome === 'success');
      dpPaid = Boolean(dpPayment);
    }
    if (!booking || !dpPaid) return { status: 'rejected', reason: 'Syarat pelunasan tidak terpenuhi.' };
  }

  const nextStatus = interpretNotification(notification);

  // Idempotency: sudah success, abaikan
  if (payment.outcome === 'success') return { status: 'duplicate', reason: 'Sudah tercatat PAID.' };
  if (nextStatus === 'PENDING' && payment.outcome !== 'pending') return { status: 'ignored', reason: 'Status lebih lama.' };

  const outcomeMap = { PAID: 'success', EXPIRED: 'expired', FAILED: 'failed', PENDING: 'pending' };
  const outcome = outcomeMap[nextStatus] || 'pending';
  const now = new Date().toISOString();

  // Treat provider status as accepted only after the database update succeeds.
  if (supabase) {
    const { data, error } = await supabase.from('payments').update({
      outcome,
      paid_at: outcome === 'success' ? now : undefined
    }).eq('id', payment.id).eq('outcome', payment.outcome).select('id').maybeSingle();
    if (error) throw new Error(`Gagal menyimpan status pembayaran: ${error.message}`);
    if (!data) {
      const { data: latest, error: latestError } = await supabase.from('payments').select('outcome').eq('id', payment.id).maybeSingle();
      if (latestError) throw new Error(`Gagal memeriksa callback duplikat: ${latestError.message}`);
      if (latest?.outcome === 'success') return { status: 'duplicate', reason: 'Sudah tercatat PAID.' };
      return { status: 'ignored', reason: 'Status pembayaran telah berubah.' };
    }
  }
  payment.outcome = outcome;
  if (outcome === 'success') payment.paid_at = now;

  if (nextStatus === 'PAID') {
    let bk = null;
    if (supabase) {
      const { data, error } = await supabase.from('bookings').select('*').eq('id', payment.booking_id).maybeSingle();
      if (error) throw new Error(`Gagal membaca booking pembayaran: ${error.message}`);
      bk = data;
      if (!bk) throw new Error('Booking pembayaran tidak ditemukan di database.');
    } else if (localStores?.localBookings) {
      bk = localStores.localBookings.get(payment.booking_id);
    }

    if (bk) {
      const state = bk.deposit || bk.state === 'DPPaid' ? 'Paid' : 'DPPaid';
      const paid = (bk.paid || 0) + payment.amount;

      if (supabase) {
        const { error: bookingError } = await supabase.from('bookings').update({
            paid,
            state,
            updated_at: now
          }).eq('id', payment.booking_id);
        if (bookingError) throw new Error(`Gagal menyimpan status booking: ${bookingError.message}`);
        const { error: auditError } = await supabase.from('audit').insert({
            booking_id: payment.booking_id,
            state,
            created_at: now
          });
        if (auditError) throw new Error(`Gagal menyimpan audit pembayaran: ${auditError.message}`);
        const { error: ledgerError } = await supabase.from('ledger_entries').insert({
            booking_id: payment.booking_id,
            payment_id: payment.id,
            entry_type: 'SIMULATED_HELD',
            amount: payment.amount,
            created_at: now
          });
        if (ledgerError) throw new Error(`Gagal menyimpan ledger pembayaran: ${ledgerError.message}`);
        const { error: blockchainError } = await supabase.from('blockchain_jobs').upsert({
            booking_id: payment.booking_id,
            payment_id: payment.id,
            status: 'QUEUED',
            retry_after: 0
          }, { onConflict: 'booking_id,payment_id', ignoreDuplicates: true });
        if (blockchainError) throw new Error(`Gagal mengantrekan blockchain: ${blockchainError.message}`);
      }
      bk.paid = paid;
      bk.state = state;
      bk.updated_at = now;
      if (localStores?.localAudit) localStores.localAudit.push({ booking_id: payment.booking_id, state, created_at: now });
    }
  } else if (nextStatus === 'EXPIRED') {
    let bk = null;
    if (!supabase && localStores?.localBookings) bk = localStores.localBookings.get(payment.booking_id);
    if (supabase) {
      const { data, error: bookingError } = await supabase.from('bookings').update({ state: 'Expired', updated_at: now }).eq('id', payment.booking_id).select('*').maybeSingle();
      if (bookingError) throw new Error(`Gagal menyimpan status booking kedaluwarsa: ${bookingError.message}`);
      if (!data) throw new Error('Booking kedaluwarsa tidak ditemukan di database.');
      bk = data;
      const { error: auditError } = await supabase.from('audit').insert({ booking_id: payment.booking_id, state: 'Expired', created_at: now });
      if (auditError) throw new Error(`Gagal menyimpan audit kedaluwarsa: ${auditError.message}`);
    }
    if (bk) {
      bk.state = 'Expired';
      bk.updated_at = now;
      if (localStores?.localAudit) localStores.localAudit.push({ booking_id: payment.booking_id, state: 'Expired', created_at: now });
    }
  }

  return { status: 'updated', paymentStatus: nextStatus };
}
