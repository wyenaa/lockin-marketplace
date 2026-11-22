import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hasCompleteSimulatedFunds } from '../src/utils/simulated-release.js';

const server = spawn(process.execPath, ['backend/src/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', MIDTRANS_SERVER_KEY: '', CONTRACT_ADDRESS: '', PRIVATE_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let baseUrl;
let output = '';
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Server tidak siap: ${output}`)), 10000);
  server.stdout.on('data', chunk => {
    output += chunk;
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) { clearTimeout(timer); baseUrl = `http://127.0.0.1:${match[1]}`; resolve(); }
  });
  server.once('error', reject);
});

function eventDate(daysAhead = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return new Date(Date.UTC(Number(parts.find(part => part.type === 'year').value), Number(parts.find(part => part.type === 'month').value) - 1, Number(parts.find(part => part.type === 'day').value) + daysAhead)).toISOString().slice(0, 10);
}

async function request(path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('simulated release requires settled funds and OTP, releases service price once, and exposes persistent-style status', async t => {
  await ready;
  t.after(() => server.kill());
  const login = async email => request('/api/auth/login', { method: 'POST', body: { email, password: 'LockInDemo123!' } });
  const customer = await login('user@lockin.demo');
  const vendor = await login('vendor@lockin.demo');
  const vendor2 = await login('vendor2@lockin.demo');
  const admin = await login('admin@lockin.demo');
  const create = async vendorNumber => {
    const result = await request('/api/bookings', { cookie: customer.cookie, method: 'POST', body: {
      vendorId: `e0000000-0000-4000-8000-${String(vendorNumber).padStart(12, '0')}`,
      packageId: '1', date: eventDate(), location: 'Malang', startTime: '08:00', agreed: true
    } });
    assert.equal(result.status, 201);
    return result.data;
  };
  const pay = async (booking, paymentType = 'DP') => request(`/api/bookings/${booking.id}/payment`, {
    cookie: customer.cookie, method: 'POST', body: {
      method: 'QRIS', outcome: 'success', expectedState: booking.state,
      paymentType, confirmedFinal: paymentType === 'FINAL'
    }
  });
  const verifyArrival = (booking, auth = vendor.cookie) => request(`/api/bookings/${booking.id}/verify-arrival`, {
    cookie: auth, method: 'POST', body: { otp: booking.arrival_code }
  });
  const complete = (booking, auth = customer.cookie) => request(`/api/bookings/${booking.id}/complete`, { cookie: auth, method: 'POST', body: {} });

  const legacyBooking = await request('/api/bookings/LK-2611', { cookie: customer.cookie });
  assert.equal(legacyBooking.status, 200);
  assert.deepEqual(legacyBooking.data.release, { simulated: true, status: 'HELD', amount: 0, releasedAt: null });

  const bookingWithDeposit = await create(9);
  assert.equal((await complete(bookingWithDeposit)).status, 409, 'booking belum lunas');
  assert.equal((await request(`/api/bookings/${bookingWithDeposit.id}/complete`)).status, 401, 'tanpa sesi ditolak');
  const paidWithDeposit = await pay(bookingWithDeposit);
  assert.equal(paidWithDeposit.status, 200);
  assert.equal(paidWithDeposit.data.state, 'Paid');
  assert.equal((await complete(paidWithDeposit.data)).status, 409, 'OTP belum diverifikasi');
  assert.equal((await complete(paidWithDeposit.data, vendor2.cookie)).status, 403, 'vendor lain tidak berhak');
  assert.equal((await complete(paidWithDeposit.data, admin.cookie)).status, 403, 'admin tidak memiliki override penyelesaian');
  assert.equal((await verifyArrival(paidWithDeposit.data)).status, 200);

  const concurrent = await Promise.all([
    complete(paidWithDeposit.data),
    complete(paidWithDeposit.data)
  ]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  const released = concurrent.find(result => result.status === 200).data;
  assert.equal(released.state, 'Completed');
  assert.equal(released.execution_state, 'COMPLETED');
  assert.equal(released.paid, 175000);
  assert.deepEqual(released.release, { simulated: true, status: 'RELEASED', amount: 75000, releasedAt: released.release.releasedAt });
  assert.ok(released.release.releasedAt);
  const refreshed = await request(`/api/bookings/${paidWithDeposit.data.id}`, { cookie: customer.cookie });
  assert.deepEqual(refreshed.data.release, released.release);
  assert.equal((await complete(paidWithDeposit.data)).status, 409, 'pencairan kedua ditolak');
  assert.equal((await request('/api/bookings', { cookie: customer.cookie })).data.find(row => row.id === paidWithDeposit.data.id).release.status, 'RELEASED');

  const dpOnly = await create(1);
  const dpPaid = (await pay(dpOnly)).data;
  assert.equal(dpPaid.state, 'DPPaid');
  assert.equal((await complete(dpPaid)).status, 409, 'DP saja belum cukup untuk pencairan');

  const disputed = await create(2);
  let paid = (await pay(disputed)).data;
  paid = (await pay(paid, 'FINAL')).data;
  assert.equal(paid.state, 'Paid');
  assert.equal((await verifyArrival(paid)).status, 200);
  const dispute = await request(`/api/bookings/${paid.id}/dispute`, {
    cookie: customer.cookie, method: 'POST', body: { reason: 'Layanan bermasalah', evidence: 'Bukti layanan belum sesuai.' }
  });
  assert.equal(dispute.status, 201);
  assert.equal((await complete(paid)).status, 409);
  assert.equal((await request(`/api/bookings/${paid.id}`, { cookie: customer.cookie })).data.release.status, 'ON_HOLD');

  const refunded = await create(3);
  let refundedPaid = (await pay(refunded)).data;
  refundedPaid = (await pay(refundedPaid, 'FINAL')).data;
  assert.equal((await verifyArrival(refundedPaid)).status, 200);
  const refundDispute = await request(`/api/bookings/${refundedPaid.id}/dispute`, {
    cookie: customer.cookie, method: 'POST', body: { reason: 'Refund test', evidence: 'Bukti untuk uji status refund.' }
  });
  assert.equal(refundDispute.status, 201);
  const resolvedRefund = await request(`/api/disputes/${refundDispute.data.id}/resolve`, {
    cookie: admin.cookie, method: 'POST', body: { decision: 'penuh', reason: 'Uji refund penuh' }
  });
  assert.equal(resolvedRefund.status, 200);
  assert.equal((await complete(refundedPaid)).status, 409);
  assert.equal((await request(`/api/bookings/${refundedPaid.id}`, { cookie: customer.cookie })).data.release.status, 'ON_HOLD');

  const cancelled = await create(4);
  assert.equal((await request(`/api/bookings/${cancelled.id}/cancel`, { cookie: customer.cookie, method: 'POST', body: {} })).status, 200);
  assert.equal((await complete(cancelled)).status, 409);
  assert.equal((await request(`/api/bookings/${cancelled.id}`, { cookie: customer.cookie })).data.release.status, 'ON_HOLD');
});

test('release migration keeps release/status atomic, unique, and inaccessible to client roles', async () => {
  const migration = await readFile('database/migrations/20261123_simulated_escrow_release.sql', 'utf8');
  const backend = await readFile('backend/src/index.js', 'utf8');
  const completeStart = backend.indexOf("if (action === 'complete') {");
  const completeEnd = backend.indexOf("if (action === 'cancel') {", completeStart);
  const completeRoute = backend.slice(completeStart, completeEnd);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS ledger_simulated_release_booking_uidx/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS evidence_url TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS vendor_response_due TIMESTAMPTZ/);
  assert.match(migration, /SELECT booking_id, COUNT\(\*\)[\s\S]*?SIMULATED_RELEASE/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.complete_booking_with_simulated_release/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /INSERT INTO public\.ledger_entries[\s\S]*SIMULATED_RELEASE/);
  assert.match(migration, /UPDATE public\.bookings[\s\S]*state = 'Completed',[\s\S]*execution_state = 'COMPLETED'/);
  assert.match(migration, /successful_amount <> expected_funds OR held_amount <> expected_funds/);
  assert.match(migration, /HAVING COUNT\(le\.id\) <> 1 OR COALESCE\(SUM\(le\.amount\), 0\) <> p\.amount/);
  assert.match(migration, /booking_row\.price, p_released_at/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.complete_booking_with_simulated_release\(TEXT, TIMESTAMPTZ\) FROM anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.complete_booking_with_simulated_release\(TEXT, TIMESTAMPTZ\) TO service_role/);
  assert.match(migration, /create_booking_dispute_with_hold/);
  assert.match(backend, /Pencairan gagal disimpan secara atomik\. Status booking dan ledger tidak diubah\./);
  assert.match(backend, /function checkAutoRelease\(\) \{\s*return;/);
  assert.doesNotMatch(backend, /Completed:AutoReleased/);
  assert.match(completeRoute, /supabase\.rpc\('complete_booking_with_simulated_release'/);
  assert.match(completeRoute, /if \(error\)[\s\S]*?fail\(503, 'Pencairan gagal disimpan secara atomik/);
  assert.doesNotMatch(completeRoute, /supabase\.from\('bookings'\)\.update/);
});

test('incomplete SIMULATED_HELD ledger cannot satisfy release validation', () => {
  const booking = { price: 100000, deposit: 0, paid: 100000 };
  const successfulPayments = [{ id: 'dp', amount: 30000 }, { id: 'final', amount: 70000 }];
  assert.equal(hasCompleteSimulatedFunds({ booking, successfulPayments, heldEntries: [{ payment_id: 'dp', amount: 30000 }] }), false);
  assert.equal(hasCompleteSimulatedFunds({ booking, successfulPayments, heldEntries: [] }), false);
  assert.equal(hasCompleteSimulatedFunds({ booking, successfulPayments, heldEntries: [{ payment_id: 'dp', amount: 30000 }, { payment_id: 'final', amount: 70000 }] }), true);
  assert.equal(hasCompleteSimulatedFunds({ booking, successfulPayments, heldEntries: [{ payment_id: 'dp', amount: 30000 }, { payment_id: 'final', amount: 69999 }, { payment_id: 'extra', amount: 1 }] }), false);
  assert.equal(hasCompleteSimulatedFunds({ booking: { price: 75000, deposit: 100000, paid: 175000 }, successfulPayments: [{ id: 'all', amount: 175000 }], heldEntries: [{ payment_id: 'all', amount: 175000 }] }), true);
});

test.after(() => server.kill());
