// LockIn — Webhook handler Midtrans
// Menerima notifikasi pembayaran dari Midtrans, verifikasi signature,
// update status di Supabase, lalu queue blockchain job.
import { verifySignature, interpretNotification } from '../services/midtrans.js';
import { supabase } from '../db/supabase.js';

export async function handleMidtransWebhook(req, res, body) {
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
    const result = await recordNotification(body);
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
 * Proses notifikasi Midtrans dan update status di Supabase.
 * Idempotent — aman dipanggil lebih dari sekali untuk order yang sama.
 */
export async function recordNotification(notification) {
  const { data: payments } = await supabase
    .from('payments')
    .select('*')
    .eq('provider_order_id', notification.order_id)
    .limit(1);

  const payment = payments?.[0];
  if (!payment) return { status: 'ignored', reason: 'Unknown order_id' };

  const amount = Number(notification.gross_amount);
  if (!Number.isFinite(amount) || amount !== payment.amount)
    return { status: 'rejected', reason: 'Jumlah pembayaran tidak cocok.' };

  if (!['DP', 'FINAL'].includes(payment.payment_type))
    return { status: 'rejected', reason: 'Jenis pembayaran tidak dikenal.' };

  if (payment.payment_type === 'FINAL') {
    const { data: booking } = await supabase.from('bookings').select('id').eq('id', payment.booking_id).single();
    const { data: dpPaid } = await supabase.from('payments').select('id').eq('booking_id', payment.booking_id).eq('payment_type', 'DP').eq('outcome', 'success').limit(1);
    if (!booking || !dpPaid?.length) return { status: 'rejected', reason: 'Syarat pelunasan tidak terpenuhi.' };
  }

  const nextStatus = interpretNotification(notification);

  // Idempotency: sudah success, abaikan
  if (payment.outcome === 'success') return { status: 'duplicate', reason: 'Sudah tercatat PAID.' };
  if (nextStatus === 'PENDING' && payment.outcome !== 'pending') return { status: 'ignored', reason: 'Status lebih lama.' };

  const outcomeMap = { PAID: 'success', EXPIRED: 'expired', FAILED: 'failed', PENDING: 'pending' };
  const outcome = outcomeMap[nextStatus] || 'pending';
  const now = new Date().toISOString();

  // Update payment
  await supabase.from('payments').update({
    outcome,
    paid_at: outcome === 'success' ? now : undefined
  }).eq('id', payment.id);

  if (nextStatus === 'PAID') {
    // Ambil booking terkini
    const { data: bk } = await supabase.from('bookings').select('*').eq('id', payment.booking_id).single();
    const state = bk.deposit || bk.state === 'DPPaid' ? 'Paid' : 'DPPaid';

    // Update booking state + paid amount
    await supabase.from('bookings').update({
      paid: (bk.paid || 0) + payment.amount,
      state,
      updated_at: now
    }).eq('id', payment.booking_id);

    // Catat ke audit trail
    await supabase.from('audit').insert({
      booking_id: payment.booking_id,
      state,
      created_at: now
    });

    // Catat ledger entry (simulasi escrow)
    await supabase.from('ledger_entries').insert({
      booking_id: payment.booking_id,
      payment_id: payment.id,
      entry_type: 'SIMULATED_HELD',
      amount: payment.amount,
      created_at: now
    });

    // Queue blockchain job
    await supabase.from('blockchain_jobs').upsert({
      booking_id: payment.booking_id,
      payment_id: payment.id,
      status: 'QUEUED',
      retry_after: 0
    }, { onConflict: 'booking_id,payment_id', ignoreDuplicates: true });

  } else if (nextStatus === 'EXPIRED') {
    await supabase.from('bookings').update({ state: 'Expired', updated_at: now }).eq('id', payment.booking_id);
    await supabase.from('audit').insert({ booking_id: payment.booking_id, state: 'Expired', created_at: now });
  }

  return { status: 'updated', paymentStatus: nextStatus };
}
