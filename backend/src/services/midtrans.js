// LockIn — Integrasi Midtrans Sandbox (Snap Redirect + Webhook)
// Dipindahkan dari src/midtrans.js (repo asal) tanpa perubahan logika.
import { createHash, timingSafeEqual } from 'node:crypto';

/** Buat transaksi Midtrans Snap dan kembalikan redirect_url */
export async function createSnapPayment({ orderId, amount }) {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  if (!serverKey) throw new Error('MIDTRANS_SERVER_KEY belum diisi di .env');
  const auth = Buffer.from(`${serverKey}:`).toString('base64');
  const port = process.env.PORT || 4000;
  const finishUrl = `http://127.0.0.1:${port}/#status`;
  const response = await fetch('https://app.sandbox.midtrans.com/snap/v1/transactions', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transaction_details: { order_id: orderId, gross_amount: amount },
      callbacks: { finish: finishUrl }
    }),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.redirect_url) {
    throw new Error(`Midtrans sandbox HTTP ${response.status}: ${JSON.stringify(result).slice(0, 500)}`);
  }
  if (!result.redirect_url.startsWith('https://app.sandbox.midtrans.com/')) {
    throw new Error('URL checkout bukan domain Midtrans Sandbox yang diharapkan.');
  }
  return result.redirect_url;
}

/**
 * Verifikasi signature SHA-512 dari webhook Midtrans.
 * Menggunakan timingSafeEqual untuk mencegah timing attack.
 */
export function verifySignature(notification, serverKey) {
  const { order_id, status_code, gross_amount, signature_key } = notification || {};
  if (![order_id, status_code, gross_amount, signature_key, serverKey].every(x => typeof x === 'string' && x.length > 0)) return false;
  const expected = createHash('sha512').update(order_id + status_code + gross_amount + serverKey).digest('hex');
  if (!/^[0-9a-f]{128}$/i.test(signature_key)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature_key, 'hex'));
}

/** Memetakan status notifikasi Midtrans ke status internal */
export function interpretNotification(n) {
  const status = n.transaction_status;
  if (status === 'settlement') return 'PAID';
  if (status === 'capture' && n.fraud_status === 'accept') return 'PAID';
  if (status === 'expire') return 'EXPIRED';
  if (['deny', 'cancel', 'failure'].includes(status)) return 'FAILED';
  return 'PENDING';
}

/** Ambil status transaksi dari Midtrans Status API */
export async function fetchMidtransStatus(orderId) {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  if (!serverKey) throw new Error('MIDTRANS_SERVER_KEY belum diatur');
  const auth = Buffer.from(`${serverKey}:`).toString('base64');
  const response = await fetch(
    `https://api.sandbox.midtrans.com/v2/${encodeURIComponent(orderId)}/status`,
    { method: 'GET', headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.status_message || 'Gagal mengecek pembayaran');
  return result;
}

export const isMidtransConfigured = () => !!process.env.MIDTRANS_SERVER_KEY;
